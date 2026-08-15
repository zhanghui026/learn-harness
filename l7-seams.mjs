// L7 · 接缝：契约 / 实现 / 消费者
//
// 到 L6 为止，"跟哪个模型说话"和"在哪台机器上干活"是焊死在循环里的两段代码：
// 一段 fetch，一段 readFile。想换模型、想让执行发生在别处，就得改循环。
//
// 这一课把它们各自剖成三个角色：
//   契约 Service Definition —— 只说做什么，不说怎么做
//   实现 Service Provider   —— 说怎么做，可以有很多个
//   消费者 Consumer         —— 只认契约，永远不认某个实现
//
// 两条接缝，四个实现，循环一个字都不用改：
//   llm   : deepseek（真调用） / replay（从日志回放，零成本、可离线、确定性）
//   world : local（本进程） / subprocess（另一个进程，见 l7-world.mjs）
//
// 运行:
//   node l7-seams.mjs "读一下 README.md 并总结"
//   node l7-seams.mjs --world subprocess "读一下 README.md 并总结"
//   node l7-seams.mjs --llm replay --from runs/<id>.jsonl "（任务从日志里取）"

import { readFile, readdir } from 'node:fs/promises'
import { readFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

// ============ 契约（Service Definition）============
//
// 契约只有两件事要说清楚：调用者能问什么，以及回来的东西长什么样。
// JS 没有 interface，所以这里用注释加一个校验函数把契约写下来——
// 真实项目里这是类型，但"契约是一份被所有实现共同遵守的约定"这件事不变。
//
//   llm.chat(messages, tools) -> { message, usage: { prompt_tokens, completion_tokens } }
//   world.describe()          -> string
//   world.readFile({ path, offset?, limit? }) -> string
//   world.listDir({ path })   -> string
//
// 契约要为"所有现有消费者"设计，而不是为某一个。offset/limit 在这里，
// 是因为 L6 的溢出需要它；如果只为 L1 设计，这个契约就会被第一个消费者绑架。

const REQUIRED = { llm: ['chat'], world: ['describe', 'readFile', 'listDir'] }

function checkContract(kind, impl) {
  const missing = REQUIRED[kind].filter((method) => typeof impl[method] !== 'function')
  // 失配要在装配时就炸，而不是等到半夜某次工具调用才炸。
  if (missing.length) throw new Error(`${kind} 实现 ${impl.name} 缺少契约方法: ${missing.join(', ')}`)
  return impl
}

// ============ 实现 A：llm ============

function llmDeepSeek() {
  return {
    name: 'deepseek',
    async chat(messages, tools) {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
        body: JSON.stringify({ model: 'deepseek-chat', messages, tools }),
      })
      const payload = await response.json()
      if (!payload.choices) throw new Error(`模型请求失败：${JSON.stringify(payload)}`)
      return { message: payload.choices[0].message, usage: payload.usage }
    },
  }
}

// 从 L4/L6 留下的日志里回放模型的回答。零 token、可离线、完全确定。
// 它之所以能存在，正是因为「模型可见 ⟺ 已记录」：模型说过的每句话都在日志里。
function llmReplay(logPath) {
  // 配错要在装配时炸，而且要说人话：等到第一次模型调用才发现，问题已经跑远了。
  if (!logPath || !existsSync(logPath)) throw new Error(`--llm replay 需要 --from <日志文件>，收到的是 ${logPath || '(空)'}`)
  const events = readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const answers = events.filter((e) => e.type === 'assistant/message').map((e) => e.message)
  let cursor = 0
  return {
    name: `replay(${logPath})`,
    async chat() {
      if (cursor >= answers.length) throw new Error('日志放完了：这次跑的步数比录制时多')
      // 回放不校验"你问的和当初问的是不是同一件事"——真要做，就得比对请求指纹。
      // 这是回放测试的已知边界，L9 会把它补上。
      return { message: answers[cursor++], usage: { prompt_tokens: 0, completion_tokens: 0, replayed: true } }
    },
  }
}

// ============ 实现 B：world ============

function worldLocal(root) {
  const inside = (path) => {
    // 默认与边界检查属于实现，不属于契约：契约只说"读一个文件"。
    if (!resolve(path).startsWith(root)) throw new Error('拒绝执行：只允许访问工作区内的路径')
    return path
  }
  return {
    name: 'local',
    async describe() { return `本进程 pid=${process.pid}, cwd=${root}` },
    async readFile({ path, offset = 1, limit }) {
      const lines = (await readFile(inside(path), 'utf8')).split('\n')
      const slice = lines.slice(offset - 1, limit ? offset - 1 + limit : undefined)
      return slice.join('\n') + (offset - 1 + slice.length < lines.length ? `\n…（共 ${lines.length} 行）` : '')
    },
    async listDir({ path }) { return (await readdir(inside(path))).join('\n') },
  }
}

// 同一份契约，另一侧是一个真正独立的进程。协议是 JSON 行，一问一答。
function worldSubprocess(script) {
  const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'inherit'] })
  const lines = createInterface({ input: child.stdout })
  const pending = new Map()
  let nextId = 0
  lines.on('line', (line) => {
    const { id, ok, error } = JSON.parse(line)
    const settle = pending.get(id)
    pending.delete(id)
    error ? settle.reject(new Error(error)) : settle.resolve(ok)
  })
  const call = (method, args) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ id, method, args }) + '\n')
  })
  return {
    name: 'subprocess',
    close: () => child.kill(),
    describe: () => call('describe'),
    readFile: (args) => call('readFile', args),
    listDir: (args) => call('listDir', args),
  }
}

// ============ 消费者（Consumer）============
//
// 工具是模型面前的那一层，它只认 world 契约。注意这里没有一行代码知道
// "world 是本地还是子进程"——这正是接缝存在的意义。

function toolsOver(world) {
  const registry = new Map()
  const tool = (name, description, properties, required, run) =>
    registry.set(name, { name, description, properties, required, run })

  tool('read_file', '读取一个文本文件，可用 offset/limit 分段',
    { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, ['path'],
    (args) => world.readFile(args))
  tool('list_dir', '列出一个目录', { path: { type: 'string' } }, ['path'],
    (args) => world.listDir(args))

  const schemas = [...registry.values()].map(({ name, description, properties, required }) => ({
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required } },
  }))
  return { registry, schemas }
}

// ============ 装配：选实现只发生在这一个地方 ============

const argv = process.argv.slice(2)
const pick = (flag, fallback) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : fallback)

const llm = checkContract('llm', pick('--llm', 'deepseek') === 'replay'
  ? llmReplay(pick('--from', ''))
  : llmDeepSeek())
const world = checkContract('world', pick('--world', 'local') === 'subprocess'
  ? worldSubprocess(new URL('./l7-world.mjs', import.meta.url).pathname)
  : worldLocal(process.cwd()))
const { registry, schemas } = toolsOver(world)

// ============ 循环：与 L4 相同，一个字都没为接缝改过 ============

const task = argv.filter((a) => !a.startsWith('--') && a !== pick('--llm', null) && a !== pick('--world', null) && a !== pick('--from', null)).at(-1)
console.log(`[装配] llm=${llm.name}  world=${world.name}`)
console.log(`[世界] ${await world.describe()}`)

const messages = [{ role: 'user', content: task ?? '这个目录里有什么？' }]
let billed = 0

for (let step = 1; step <= 8; step++) {
  const { message, usage } = await llm.chat(messages, schemas)
  billed += usage.prompt_tokens ?? 0
  messages.push(message)
  if (!message.tool_calls?.length) { console.log(`\n${message.content}\n`); break }

  console.log(`[step ${step}] prompt ${usage.prompt_tokens}${usage.replayed ? '（回放，不花钱）' : ''}`)
  for (const call of message.tool_calls) {
    const definition = registry.get(call.function.name)
    let content
    try {
      content = String(await definition.run(JSON.parse(call.function.arguments)))
    } catch (error) {
      content = `执行失败：${error.message}`
    }
    console.log(`  ${content.startsWith('执行失败') ? '✗' : '✓'} ${call.function.name} ${call.function.arguments} → ${content.length} 字`)
    messages.push({ role: 'tool', tool_call_id: call.id, content })
  }
}

console.log(`[账单] 累计 prompt token ${billed}`)
world.close?.()
