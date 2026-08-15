// L3 · 收件箱，以及 turn 与 step 的分层
//
// 相对 L2 变了三件事：
//   1. 输入不再是函数参数，而是一个收件箱：任何时候都能往里投递
//   2. 循环分成两层——turn 是"排空一次输入"，step 是"一次模型请求 + 它引发的工具"
//   3. Ctrl-C 中断的是当前这个 turn，不是整个进程
//
// 运行: node l3-inbox.mjs "统计一下这个目录里有几个 .mjs 文件"
// 跑起来之后可以随时打字回车插话；Ctrl-C 打断当前任务；Ctrl-D 退出。
// 非交互跑一次: node l3-inbox.mjs "任务" --once

import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

const TOOL_TIMEOUT_MS = 5000
const MAX_STEPS_PER_TURN = 10
const once = process.argv.includes('--once')

// ---------- 工具与管线（与 L2 相同，此处不再解释） ----------

const registry = new Map()
const guards = []
const observers = []

function tool(name, description, properties, required, run) {
  registry.set(name, { name, description, properties, required, run })
}

tool('read_file', '读取一个文本文件的内容', { path: { type: 'string', description: '文件路径' } }, ['path'],
  async ({ path }) => await readFile(path, 'utf8'))
tool('list_dir', '列出一个目录下的条目', { path: { type: 'string', description: '目录路径' } }, ['path'],
  async ({ path }) => (await readdir(path)).join('\n'))
tool('sleep', '睡指定的秒数', { seconds: { type: 'number', description: '秒数' } }, ['seconds'],
  ({ seconds }, signal) => new Promise((done, fail) => {
    const timer = setTimeout(done, seconds * 1000)
    signal.addEventListener('abort', () => { clearTimeout(timer); fail(new Error('已取消')) }, { once: true })
  }))

guards.push(({ name }, args) => {
  if (name !== 'read_file' && name !== 'list_dir') return
  if (!resolve(args.path).startsWith(process.cwd())) return { deny: '只允许访问当前目录内的路径' }
})
observers.push(({ name }, args, result) => {
  console.log(`  ${result.isError ? '✗' : '✓'} ${name}(${JSON.stringify(args)}) → ${result.content.length} 字`)
})

const schemas = [...registry.values()].map(({ name, description, properties, required }) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
}))

async function execute(call, turnSignal) {
  const definition = registry.get(call.function.name)
  if (!definition) return { call, isError: true, content: `没有名为 ${call.function.name} 的工具` }
  let args
  try {
    args = JSON.parse(call.function.arguments)
  } catch {
    return { call, isError: true, content: '参数不是合法 JSON，请重新调用' }
  }
  for (const guard of guards) {
    const verdict = await guard(definition, args)
    if (verdict?.deny) {
      const denied = { call, isError: true, content: `拒绝执行：${verdict.deny}` }
      for (const observe of observers) observe(definition, args, denied)
      return denied
    }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`超过 ${TOOL_TIMEOUT_MS}ms 未返回`)), TOOL_TIMEOUT_MS)
  // 打断整个 turn 时，正在跑的工具也要跟着停：取消必须向下传递。
  const relay = () => controller.abort(new Error('turn 已被打断'))
  turnSignal.addEventListener('abort', relay, { once: true })
  let result
  try {
    const output = await Promise.race([
      definition.run(args, controller.signal),
      new Promise((_, fail) => controller.signal.addEventListener('abort',
        () => fail(controller.signal.reason ?? new Error('已取消')), { once: true })),
    ])
    result = { call, isError: false, content: String(output) }
  } catch (error) {
    result = { call, isError: true, content: `执行失败：${error.message}` }
  } finally {
    clearTimeout(timer)
    turnSignal.removeEventListener('abort', relay)
  }
  for (const observe of observers) observe(definition, args, result)
  return result
}

// ---------- 1. 收件箱：投递与认领是两件事 ----------

class Inbox {
  #queue = []
  #waiting = null

  /** 任何人、任何时候都可以投递。投递方从不等待。 */
  push(text) {
    this.#queue.push({ role: 'user', content: text })
    if (this.#waiting) {
      const wake = this.#waiting
      this.#waiting = null
      wake()
    }
  }

  /** 有就立刻拿走全部；没有就等到有为止。 */
  async claimBlocking() {
    if (this.#queue.length === 0) await new Promise((wake) => { this.#waiting = wake })
    return this.claimPending()
  }

  /** 有就拿走，没有就返回空——step 之间用这个，不能在这里卡住。 */
  claimPending() {
    return this.#queue.splice(0, this.#queue.length)
  }

  get size() { return this.#queue.length }
}

const inbox = new Inbox()

// ---------- 2. 两层循环 ----------

const messages = []
let turnNumber = 0
let currentTurn = null // 正在跑的 turn 的 AbortController

async function runTurn(claimed) {
  turnNumber += 1
  const controller = new AbortController()
  currentTurn = controller
  const { signal } = controller
  messages.push(...claimed)
  console.log(`\n[turn ${turnNumber}] 开始，认领了 ${claimed.length} 条输入`)

  try {
    for (let step = 1; step <= MAX_STEPS_PER_TURN; step++) {
      signal.throwIfAborted()
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({ model: 'deepseek-chat', messages, tools: schemas }),
      })
      const payload = await response.json()
      if (!payload.choices) throw new Error(`模型请求失败：${JSON.stringify(payload)}`)
      const message = payload.choices[0].message
      messages.push(message)

      if (message.tool_calls?.length) {
        console.log(`[turn ${turnNumber} · step ${step}] ${message.tool_calls.length} 个工具调用`)
        const results = await Promise.all(message.tool_calls.map((call) => execute(call, signal)))
        for (const { call, content } of results) {
          messages.push({ role: 'tool', tool_call_id: call.id, content })
        }
      } else {
        console.log(`\n${message.content}\n`)
      }

      // step 之间的边界：这里是插话唯一被接住的地方。
      // 中途投递的消息不会打断正在跑的工具，它排队等到这里。
      const injected = inbox.claimPending()
      if (injected.length > 0) {
        console.log(`[turn ${turnNumber}] 认领了 ${injected.length} 条插话，继续下一步`)
        messages.push(...injected)
        continue
      }
      if (!message.tool_calls?.length) break // 没话说也没插话 → 这个 turn 结束
    }
  } catch (error) {
    if (signal.aborted) console.log(`[turn ${turnNumber}] 已中断`)
    else console.log(`[turn ${turnNumber}] 出错：${error.message}`)
  } finally {
    currentTurn = null
    console.log(`[turn ${turnNumber}] 结束`)
  }
}

// ---------- 3. 驱动：一直等收件箱 ----------

const input = createInterface({ input: process.stdin, terminal: false })
input.on('line', (line) => {
  const text = line.trim()
  if (!text) return
  inbox.push(text)
  if (currentTurn) console.log(`[收件箱] 已收到，等当前 step 结束再交给模型（队列 ${inbox.size}）`)
})
input.on('close', () => { if (!currentTurn) process.exit(0) })

process.on('SIGINT', () => {
  if (currentTurn) currentTurn.abort(new Error('用户中断'))
  else process.exit(0)
})

if (process.argv[2] && !process.argv[2].startsWith('--')) inbox.push(process.argv[2])

while (true) {
  const claimed = await inbox.claimBlocking()
  await runTurn(claimed)
  if (once) break
}
