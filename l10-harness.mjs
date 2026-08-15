// L10 · 把 L2–L9 拼成一个小 harness
//
// 这一课几乎没有新概念，只有一个检验：前九课的东西能不能拼起来。
// 拼不起来，说明接缝留错了地方。
//
// 直接复用 L8 的内核和插件（工具、权限、溢出、计量、模型、终端输出），
// 这里只补三个前面缺的插件，外加一个换掉的主循环：
//
//   session      L4 的事件日志 + 投影 + 续跑 / 分叉
//   compaction   L6 的压缩（挂在 step/start 上，不碰循环）
//   inbox        L3 的收件箱：跑到一半可以插话，Ctrl-C 只中断这一轮
//   loopSession  换掉 L8 那个用内存数组的循环 —— 这正是"能不能换掉主循环"的验金石
//
// 运行:
//   node l10-harness.mjs "读一下 fixtures 目录并总结"        # 跑起来后随时打字插话
//   node l10-harness.mjs --resume <id> "再看看别的"
//   node l10-harness.mjs --fork <id>@6 "换个方向"
//   node l10-harness.mjs --show <id>
//   node l10-harness.mjs --replay <id>                        # 零成本重放，不联网
//   node l10-harness.mjs --without compaction "…"

import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { writeFile, mkdir } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { createInterface as createPrompt } from 'node:readline/promises'
import { join, dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Kernel, tools, permission, spill, meter, deepseek, terminal } from './l8-plugins.mjs'

const RUNS = 'runs'
const MAX_STEPS = Number(process.env.MAX_STEPS ?? 12)
const COMPACT_AT = Number(process.env.COMPACT_AT ?? 24000)
const KEEP_RECENT_STEPS = 3
const SYSTEM_PROMPT = '你是一个在命令行里工作的助手。回答简短，必要时用工具核实，不要编造文件内容。'
const estimate = (text) => Math.ceil(text.length / 2.5)
const logPath = (id) => join(RUNS, `${id}.jsonl`)
const readLog = (id) => readFileSync(logPath(id), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

// ---------- 插件：session（L4） ----------

function session(ctx) {
  const id = ctx.config.sessionId
  const events = existsSync(logPath(id)) ? readLog(id) : []
  let seq = events.at(-1)?.seq ?? 0

  const append = (type, payload = {}) => {
    const event = { seq: ++seq, at: new Date().toISOString(), type, ...payload }
    events.push(event)
    appendFileSync(logPath(id), JSON.stringify(event) + '\n')
    ctx.emit('session/appended', event)
    return event
  }

  // 投影：L4 的补全 + L6 的压缩边界，一个函数管两件事
  const messages = () => {
    const compacted = events.filter((e) => e.type === 'context/compacted').at(-1)
    const boundary = compacted?.through ?? 0
    const answered = new Set(events.filter((e) => e.type === 'tool/result').map((e) => e.callId))
    const out = []
    for (const event of events) {
      if (event.seq <= boundary && event.type !== 'system/prompt' && !event.firstTask) continue
      if (event.type === 'system/prompt') {
        out.push({ role: 'system', content: event.content })
        if (compacted) out.push({ role: 'user', content: `【之前工作的摘要】\n${compacted.summary}` })
      }
      if (event.type === 'user/message') out.push({ role: 'user', content: event.content })
      if (event.type === 'assistant/message') {
        out.push(event.message)
        for (const call of event.message.tool_calls ?? []) {
          if (!answered.has(call.id)) out.push({ role: 'tool', tool_call_id: call.id, content: '(工具没有返回结果：会话在这一步中断了)' })
        }
      }
      if (event.type === 'tool/result') out.push({ role: 'tool', tool_call_id: event.callId, content: event.content })
    }
    return out
  }

  ctx.provide('session', { id, append, messages, events: () => events })
}

// ---------- 插件：compaction（L6） ----------
//
// 它只监听 step/start，然后往日志里追加一条摘要事件。循环不知道它存在。

function compaction(ctx) {
  ctx.on('step/start', async () => {
    const s = ctx.get('session')
    const before = estimate(JSON.stringify(s.messages()))
    if (before <= COMPACT_AT) return
    const events = s.events()
    const previous = events.filter((e) => e.type === 'context/compacted').at(-1)?.through ?? 0
    const cut = events.filter((e) => e.type === 'assistant/message').at(-KEEP_RECENT_STEPS)
    const boundary = Math.max(previous, cut ? cut.seq - 1 : 0)   // 只能右移（L6 的教训）
    if (boundary <= previous) return
    const folded = s.messages().slice(0, -KEEP_RECENT_STEPS * 2)
    const summary = await ctx.get('llm').summarize(folded)
    s.append('context/compacted', { through: boundary, summary })
    console.log(`  [压缩] ${before} → ${estimate(JSON.stringify(s.messages()))} token`)
  })
}

// ---------- 插件：inbox（L3） ----------
//
// 投递随时可以发生，认领只在两个 step 之间。Ctrl-C 只中断这一轮，不杀进程。

function inbox(ctx) {
  const queue = []
  const reader = createInterface({ input: process.stdin })
  reader.on('line', (line) => {
    if (!line.trim()) return
    queue.push(line)
    console.log(`  [收件箱] 收到插话，将在下一个 step 之间送进去`)
  })
  ctx.provide('inbox', { claim: () => queue.splice(0, queue.length), close: () => reader.close() })
}


// ---------- 插件：approval（L5 的审批，一次一授） ----------
//
// 三种策略与 L5 一致：ask 问人、never 一律拒绝、always 一律批准（非交互演示用）。
// 没有人可问时（不是 TTY）失败关死——沉默绝不等于同意。

function approval(ctx) {
  const policy = ctx.config.approvalPolicy ?? 'ask'
  let prompt = null
  ctx.provide('approval', {
    async request(question) {
      ctx.emit('approval/asked', { question, policy })
      let granted
      if (policy === 'never') granted = false
      else if (policy === 'always') granted = true
      else if (!process.stdin.isTTY) granted = false
      else {
        prompt ??= createPrompt({ input: process.stdin, output: process.stdout })
        granted = (await prompt.question(`\n  ⚠ ${question}  [y/N] `)).trim().toLowerCase() === 'y'
      }
      ctx.emit('approval/decided', { question, granted, policy })
      return granted
    },
    close: () => prompt?.close(),
  })
}

// ---------- 插件：writePolicy（L5 的判定，挂在同一条 waterfall 上） ----------

function writePolicy(ctx) {
  // fixtures/ 是快照测试的夹具，写进去会让快照永远红——
  // 测试资产也是一条值得写进权限规则的不变量（这一条是被 L9 的快照抓出来后补的）。
  const FORBIDDEN = /(^|\/)\.env(\.|$)|(^|\/)\.git\/|\.pem$|^fixtures\//
  ctx.on('tools/execute', async (call, next) => {
    if (call.name !== 'write_file') return next()
    // 判定：看得懂的坏事直接拒绝，连问都不问
    if (FORBIDDEN.test(call.args.path ?? '')) return { isError: true, content: '拒绝执行：这个路径不允许写入' }
    if (!resolve(call.args.path ?? '.').startsWith(process.cwd())) return { isError: true, content: '拒绝执行：超出工作区' }
    // 判不了的交给人：覆盖已有文件要一次一授
    if (existsSync(call.args.path)) {
      const granted = await ctx.get('approval').request(`覆盖已存在的文件 ${call.args.path}？`)
      if (!granted) return { isError: true, content: '用户拒绝了覆盖' }
    }
    return next()
  })
}

// ---------- 插件：fsWrite（工具本身 + 沙箱模式栅栏） ----------
//
// 这一层的栅栏和 dsh 的 fs-sandbox 是同一个做法：写入前检查本次调用的模式。
// 注意它保护的是"agent 的工具"，不是"任意子进程"——后者要靠 L5 那种内核围栏。
// 升级是一次性的：这次批准只放宽这一次调用，会话默认值始终是 read-only。

function fsWrite(ctx) {
  const sessionMode = ctx.config.sandboxMode ?? 'read-only'
  ctx.get('tools').add('write_file', '把内容写入一个文件（会覆盖）',
    { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content'],
    async ({ path, content }) => {
      let mode = sessionMode
      if (mode === 'read-only') {
        const granted = await ctx.get('approval').request(`沙箱是 read-only，放宽到 workspace-write 写这一次吗？（${path}）`)
        if (!granted) throw new Error('沙箱以 read-only 拒绝了写入')
        mode = 'workspace-write'   // 只是这一次调用的模式；会话默认值一个字节都没动
      }
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content)
      ctx.emit('file/written', { path, bytes: content.length, mode })
      return `已写入 ${path}（${content.length} 字符，本次模式 ${mode}）`
    })
}

// ---------- 插件：loopSession（换掉 L8 的 loop） ----------

function loopSession(ctx) {
  ctx.provide('agent', {
    async run(task) {
      const s = ctx.get('session')
      const controller = new AbortController()
      const onInterrupt = () => { console.log('\n  [中断] 结束当前 turn，进程还活着'); controller.abort() }
      process.on('SIGINT', onInterrupt)

      if (!s.events().some((e) => e.type === 'system/prompt')) s.append('system/prompt', { content: SYSTEM_PROMPT })
      s.append('user/message', { content: task, firstTask: s.events().filter((e) => e.type === 'user/message').length === 0 })
      s.append('turn/start', {})
      let reason = 'completed'

      try {
        for (let step = 1; step <= MAX_STEPS; step++) {
          if (controller.signal.aborted) { reason = 'aborted'; break }
          // 扩展点：压缩挂在这里，循环对它一无所知。
          // 用 parallel 而不是 emit，因为压缩必须在请求发出之前完成。
          await ctx.parallel('step/start', { step })
          // 认领插话：只在 step 之间
          for (const line of ctx.get('inbox')?.claim() ?? []) s.append('user/message', { content: line })

          const message = await ctx.get('llm').chat(s.messages(), ctx.get('tools').schemas())
          s.append('assistant/message', { step, message })
          if (!message.tool_calls?.length) { ctx.emit('agent/answer', { content: message.content }); break }

          for (const call of message.tool_calls) {
            const args = JSON.parse(call.function.arguments)
            ctx.emit('tool/called', { name: call.function.name, args })
            const result = await ctx.waterfall('tools/execute',
              { id: call.id, name: call.function.name, args, sessionId: s.id },
              async ({ name, args }) => {
                const definition = ctx.get('tools').get(name)
                if (!definition) return { isError: true, content: `没有名为 ${name} 的工具` }
                try { return { isError: false, content: String(await definition.run(args)) } }
                catch (error) { return { isError: true, content: `执行失败：${error.message}` } }
              })
            ctx.emit('tool/result', { name: call.function.name, args, isError: result.isError, length: result.content.length })
            s.append('tool/result', { callId: call.id, isError: result.isError, content: result.content })
          }
        }
      } finally {
        s.append('turn/end', { reason })
        process.off('SIGINT', onInterrupt)
      }
    },
  })
}

// ---------- 模型：真调用 / 回放（L7 的接缝，两个实现） ----------

function llmReplay(ctx) {
  const answers = readLog(ctx.config.replayOf).filter((e) => e.type === 'assistant/message').map((e) => e.message)
  let cursor = 0
  ctx.provide('llm', {
    async chat() {
      if (cursor >= answers.length) throw new Error('回放耗尽：这次跑的步数比录制时多')
      return answers[cursor++]
    },
    summarize: async () => '（回放模式不做压缩）',
  })
}

function llmWithSummary(ctx) {
  deepseek(ctx)
  const base = ctx.get('llm')
  ctx.provide('llm', {
    chat: base.chat,
    async summarize(messages) {
      const transcript = messages.map((m) => `${m.role}: ${(m.content ?? JSON.stringify(m.tool_calls)).slice(0, 800)}`).join('\n')
      const message = await base.chat([
        { role: 'system', content: '压缩这段 agent 工作记录：保留目标、已确认的事实、读过什么、下一步。不超过 400 字。' },
        { role: 'user', content: transcript },
      ], [])
      return message.content
    },
  })
}

// ---------- 装配 ----------

mkdirSync(RUNS, { recursive: true })
const argv = process.argv.slice(2)
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null)
const without = flag('--without')

if (flag('--show')) {
  for (const e of readLog(flag('--show'))) {
    const detail = e.type === 'assistant/message'
      ? (e.message.content?.slice(0, 56) || `${e.message.tool_calls?.length} 个工具调用`)
      : (e.summary ?? e.content ?? e.reason ?? '')
    console.log(`${String(e.seq).padStart(3)}  ${e.type.padEnd(18)} ${String(detail).replace(/\n/g, ' ').slice(0, 66)}`)
  }
  process.exit(0)
}

let sessionId = randomUUID().slice(0, 8)
let replayOf = null
if (flag('--resume')) {
  sessionId = flag('--resume')
  console.log(`[resume] ${sessionId}`)
} else if (flag('--fork')) {
  const [source, boundary] = flag('--fork').split('@')
  const kept = readLog(source).filter((e) => e.seq <= Number(boundary))
  appendFileSync(logPath(sessionId), kept.map((e) => JSON.stringify(e)).join('\n') + '\n')
  console.log(`[fork] ${source}@${boundary} → ${sessionId}，继承 ${kept.length} 个事件`)
} else if (flag('--replay')) {
  replayOf = flag('--replay')
  console.log(`[replay] 重放 ${replayOf}，不联网、不花钱`)
} else {
  console.log(`[new] ${sessionId}`)
}

const catalog = {
  session,
  tools,
  approval,
  writePolicy,
  fsWrite,
  permission,
  spill,
  compaction,
  meter,
  llm: replayOf ? llmReplay : llmWithSummary,
  terminal,
  inbox: process.stdin.isTTY ? inbox : null,     // 没有终端就不装收件箱
  loop: loopSession,
}

const kernel = new Kernel()
const loaded = []
for (const [name, plugin] of Object.entries(catalog)) {
  if (!plugin || name === without) { if (plugin) console.log(`[跳过] ${name}`); continue }
  kernel.use(plugin, { sessionId, replayOf, approvalPolicy: flag('--policy') ?? (argv.includes('--yes') ? 'always' : 'ask') })
  loaded.push(name)
}
console.log(`[装配] ${loaded.join(' · ')}`)

const task = argv.filter((a) => !a.startsWith('--') && a !== flag('--resume') && a !== flag('--fork') && a !== flag('--replay') && a !== without).at(-1)
await kernel.services.get('agent').run(task ?? '这个目录里有什么？')

const bill = kernel.services.get('meter')
if (bill?.steps) console.log(`[账单] ${bill.steps} 步，prompt ${bill.prompt} token（缓存 ${bill.cached}）`)
console.log(`[会话] ${logPath(sessionId)}    回看: node l10-harness.mjs --show ${sessionId}`)
kernel.services.get('inbox')?.close()
kernel.services.get('approval')?.close()
process.exit(0)
