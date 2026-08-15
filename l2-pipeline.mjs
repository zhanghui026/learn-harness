// L2 · 工具执行管线的雏形
//
// 相对 L1 变了四件事：
//   1. 工具从一串 if 变成一张表（注册表）
//   2. 每个工具调用都走同一条路：查表 → 守卫 → 带超时执行 → 观察
//   3. 工具失败变成"给模型的一条结果"，而不是让进程崩溃
//   4. 同一批工具调用并行执行
//
// 运行: node l2-pipeline.mjs "读一下 README.md，再看看这个目录里有什么"

import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

// 超时是"随部署变化的选择"，不是常量：同一份代码在本机和在 CI 里该等的时间不一样。
// 焊死一个数字，就等于逼所有人接受你机器上的手感。
const TOOL_TIMEOUT_MS = Number(process.env.TOOL_TIMEOUT_MS ?? 5000)

// ---------- 1. 注册表：一张表，不是一串 if ----------

const registry = new Map()

function tool(name, description, properties, required, run) {
  registry.set(name, { name, description, properties, required, run })
}

tool('read_file', '读取一个文本文件的内容', { path: { type: 'string', description: '文件路径' } }, ['path'],
  async ({ path }) => await readFile(path, 'utf8'))

tool('list_dir', '列出一个目录下的条目', { path: { type: 'string', description: '目录路径' } }, ['path'],
  async ({ path }) => (await readdir(path)).join('\n'))

// 这个工具存在的唯一目的，是让你看见超时真的会发生。
tool('sleep', '睡指定的秒数', { seconds: { type: 'number', description: '秒数' } }, ['seconds'],
  ({ seconds }, signal) => new Promise((done, fail) => {
    const timer = setTimeout(done, seconds * 1000)
    // 工具自己响应取消：这是"好公民"的写法。原因由取消方给，不要自己编。
    signal.addEventListener('abort', () => { clearTimeout(timer); fail(signal.reason) }, { once: true })
  }))

const schemas = [...registry.values()].map(({ name, description, properties, required }) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
}))

// ---------- 2. 管线：策略挂在这里，工具本身什么都不知道 ----------

const guards = []     // 前置：可以拒绝执行
const observers = []  // 后置：只看，不改

// 一条守卫的样子。L5 会把审批、沙箱挂在同一个位置。
guards.push(({ name }, args) => {
  if (name !== 'read_file' && name !== 'list_dir') return
  if (!resolve(args.path).startsWith(process.cwd())) return { deny: '只允许访问当前目录内的路径' }
})

// 练习：一条拒绝读密钥的守卫。注意它在 execute 里的位置——在工具执行之前。
// 判定放在这里，read_file 才可以对"什么算秘密"一无所知。
const SECRET_FILES = /(^|\/)\.env(\.|$)|\.pem$|(^|\/)id_rsa$/
guards.push(({ name }, args) => {
  if (name !== 'read_file') return
  if (SECRET_FILES.test(args.path)) return { deny: '这是凭据文件，不允许读取' }
})

observers.push(({ name }, args, result) => {
  console.log(`  ${result.isError ? '✗' : '✓'} ${name}(${JSON.stringify(args)}) → ${result.content.length} 字`)
})

async function execute(call) {
  const definition = registry.get(call.function.name)
  // 从这里往下，任何失败都必须变成一条"结果"，而不是异常：
  // 模型读得到错误才能自己纠正，进程崩了就什么都没了。
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
      const result = { call, isError: true, content: `拒绝执行：${verdict.deny}` }
      for (const observe of observers) observe(definition, args, result)
      return result
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`超过 ${TOOL_TIMEOUT_MS}ms 未返回`)), TOOL_TIMEOUT_MS)
  let result
  try {
    // 光把 signal 传进去不够——工具可能根本不理它，所以还要 race 一个定时器。
    const output = await Promise.race([
      definition.run(args, controller.signal),
      new Promise((_, fail) => controller.signal.addEventListener('abort',
        () => fail(controller.signal.reason), { once: true })),
    ])
    result = { call, isError: false, content: String(output) }
  } catch (error) {
    result = { call, isError: true, content: `执行失败：${error.message}` }
  } finally {
    clearTimeout(timer)
  }

  for (const observe of observers) observe(definition, args, result)
  return result
}

// ---------- 3. 循环 ----------

const messages = [{ role: 'user', content: process.argv[2] ?? '这个目录里有什么？' }]

for (let step = 1; step <= 10; step++) {
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
  messages.push(message)

  if (!message.tool_calls?.length) {
    console.log('\n' + message.content)
    break
  }

  console.log(`\n[step ${step}] 本批 ${message.tool_calls.length} 个工具调用，并行执行`)
  // 同一批调用之间没有先后依赖——模型是一次性提出来的，所以并行。
  const results = await Promise.all(message.tool_calls.map(execute))
  for (const { call, content } of results) {
    messages.push({ role: 'tool', tool_call_id: call.id, content })
  }
}
