// L4 · 事件日志与投影
//
// 相对 L2 只变了一件事，但这一件改变了一切：
//   messages 数组不再是"状态"，它降级成一个从日志算出来的临时值。
//   唯一真相源是 runs/<id>.jsonl —— 只能追加，不能改写。
//
// 于是这些能力全部免费到手：崩溃续跑、回看、分叉。
//
// 新建会话: node l4-log.mjs "读一下 README.md 并总结"
// 查看日志: node l4-log.mjs --show <id>
// 续跑:     node l4-log.mjs --resume <id> "再看看还有哪些文件"
// 分叉:     node l4-log.mjs --fork <id>@<seq> "换个方向：只看代码文件"
//
// 为了让日志看得清楚，这一课暂时去掉了 L3 的交互收件箱；L10 组装时再合回来。

import { readFile, readdir, appendFile, mkdir } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const RUNS = 'runs'
const TOOL_TIMEOUT_MS = 5000
const SYSTEM_PROMPT = '你是一个在命令行里工作的助手。回答简短，必要时用工具核实，不要编造文件内容。'

// ---------- 工具与管线（与 L2 相同） ----------

const registry = new Map()
function tool(name, description, properties, required, run) {
  registry.set(name, { name, description, properties, required, run })
}
tool('read_file', '读取一个文本文件的内容', { path: { type: 'string', description: '文件路径' } }, ['path'],
  async ({ path }) => await readFile(path, 'utf8'))
tool('list_dir', '列出一个目录下的条目', { path: { type: 'string', description: '目录路径' } }, ['path'],
  async ({ path }) => (await readdir(path)).join('\n'))

const schemas = [...registry.values()].map(({ name, description, properties, required }) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
}))

async function execute(call) {
  const definition = registry.get(call.function.name)
  if (!definition) return { isError: true, content: `没有名为 ${call.function.name} 的工具` }
  let args
  try {
    args = JSON.parse(call.function.arguments)
  } catch {
    return { isError: true, content: '参数不是合法 JSON，请重新调用' }
  }
  if (!resolve(args.path ?? '.').startsWith(process.cwd())) {
    return { isError: true, content: '拒绝执行：只允许访问当前目录内的路径' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS)
  try {
    const output = await Promise.race([
      definition.run(args, controller.signal),
      new Promise((_, fail) => controller.signal.addEventListener('abort',
        () => fail(new Error(`超过 ${TOOL_TIMEOUT_MS}ms 未返回`)), { once: true })),
    ])
    return { isError: false, content: String(output) }
  } catch (error) {
    return { isError: true, content: `执行失败：${error.message}` }
  } finally {
    clearTimeout(timer)
  }
}

// ---------- 1. 日志：只能追加 ----------

let sessionId = null
let seq = 0

function logPath(id) { return join(RUNS, `${id}.jsonl`) }

function readLog(id) {
  return readFileSync(logPath(id), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

async function append(type, payload) {
  seq += 1
  const event = { seq, at: new Date().toISOString(), type, ...payload }
  await appendFile(logPath(sessionId), JSON.stringify(event) + '\n')
  return event
}

// ---------- 2. 投影：模型历史是算出来的，不是攒出来的 ----------
//
// 这个函数是整课的核心。它是纯函数：同样的日志永远得到同样的历史。
// 「模型可见 ⟺ 已记录」——凡是模型看得到的，这里都得有对应的事件；
// 反过来，任何没进日志的东西都不可能出现在请求里。

function deriveMessages(events) {
  const messages = []
  const answered = new Set(events.filter((e) => e.type === 'tool/result').map((e) => e.callId))
  for (const event of events) {
    switch (event.type) {
      case 'system/prompt':
        messages.push({ role: 'system', content: event.content })
        break
      case 'user/message':
        messages.push({ role: 'user', content: event.content })
        break
      case 'assistant/message':
        messages.push(event.message)
        // 日志可能停在"已经说要调工具、结果还没写下来"的地方：进程被 Ctrl-C、断电、
        // 或者分叉边界正好落在这一步中间。API 规定每个 tool_call_id 都必须有回应，
        // 少一条整份历史就是废的。修补放在投影里，不放在日志里——
        // 日志只记发生过的事，投影负责把它变成一份合法的历史。
        for (const call of event.message.tool_calls ?? []) {
          if (!answered.has(call.id)) {
            messages.push({ role: 'tool', tool_call_id: call.id, content: '(工具没有返回结果：会话在这一步中断了)' })
          }
        }
        break
      case 'tool/result':
        messages.push({ role: 'tool', tool_call_id: event.callId, content: event.content })
        break
      default:
        break // turn/start、turn/end、tool/call 等只用于回看与调试，不进模型历史
    }
  }
  return messages
}

// ---------- 3. 循环：每一步都先写日志，再从日志投影 ----------

async function runTurn(turn) {
  await append('turn/start', { turn })
  let reason = 'completed'
  try {
    for (let step = 1; step <= 10; step++) {
      const messages = deriveMessages(readLog(sessionId))
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({ model: 'deepseek-chat', messages, tools: schemas }),
      })
      const payload = await response.json()
      if (!payload.choices) throw new Error(`模型请求失败：${JSON.stringify(payload)}`)
      const message = payload.choices[0].message
      await append('assistant/message', { turn, step, message })

      if (!message.tool_calls?.length) {
        console.log(`\n${message.content}\n`)
        break
      }
      for (const call of message.tool_calls) {
        await append('tool/call', { turn, step, call })
        const result = await execute(call)
        console.log(`  ${result.isError ? '✗' : '✓'} ${call.function.name} ${call.function.arguments}`)
        // 先执行、后记录：只有真的发生了的事才进日志。
        await append('tool/result', { turn, step, callId: call.id, ...result })
      }
    }
  } catch (error) {
    reason = `error: ${error.message}`
    console.error(reason)
  } finally {
    await append('turn/end', { turn, reason })
  }
}

// ---------- 4. 三种入口：新建 / 续跑 / 分叉 ----------

await mkdir(RUNS, { recursive: true })
const args = process.argv.slice(2)
const flag = args[0]?.startsWith('--') ? args[0] : null
const task = args[flag ? 2 : 0]

if (flag === '--show') {
  for (const event of readLog(args[1])) {
    const detail = event.type === 'assistant/message'
      ? (event.message.content?.slice(0, 60) || `${event.message.tool_calls?.length} 个工具调用`)
      : (event.content ?? event.call?.function?.name ?? event.reason ?? '')
    console.log(`${String(event.seq).padStart(3)}  ${event.type.padEnd(18)} ${String(detail).replace(/\n/g, ' ').slice(0, 70)}`)
  }
  process.exit(0)
}

if (flag === '--resume') {
  sessionId = args[1]
  if (!existsSync(logPath(sessionId))) throw new Error(`没有这个会话：${sessionId}`)
  const events = readLog(sessionId)
  seq = events.at(-1).seq
  console.log(`[resume] ${sessionId}，已有 ${events.length} 个事件`)
} else if (flag === '--fork') {
  const [sourceId, boundary] = args[1].split('@')
  const kept = readLog(sourceId).filter((event) => event.seq <= Number(boundary))
  sessionId = randomUUID().slice(0, 8)
  // 分叉 = 把日志前半段复制成一个新会话。父会话一个字节都没被改动。
  await appendFile(logPath(sessionId), kept.map((event) => JSON.stringify(event)).join('\n') + '\n')
  seq = kept.at(-1).seq
  console.log(`[fork] ${sourceId}@${boundary} → ${sessionId}，继承 ${kept.length} 个事件`)
} else {
  sessionId = randomUUID().slice(0, 8)
  console.log(`[new] ${sessionId}`)
  await append('system/prompt', { content: SYSTEM_PROMPT })
}

if (!task) throw new Error('请给一句任务，例如: node l4-log.mjs "读一下 README.md"')

const previousTurns = existsSync(logPath(sessionId))
  ? readLog(sessionId).filter((event) => event.type === 'turn/start').length
  : 0
await append('user/message', { content: task })
await runTurn(previousTurns + 1)
console.log(`日志: ${logPath(sessionId)}    回看: node l4-log.mjs --show ${sessionId}`)
