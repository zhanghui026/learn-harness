// L6 · 上下文：计量、溢出、压缩
//
// L4 的日志跑真实仓库时暴露了三件事：历史涨到 92k、十步累计发出 580k、正好踩着步数上限交卷。
// 这一课加三样东西，全部建立在 L4 的"日志 + 投影"上：
//
//   1. 计量 metering —— 别猜。响应里的 usage 是实测值，还能看到前缀缓存命中了多少。
//   2. 溢出 spill    —— 超长工具结果写进文件，历史里只留头部 + 一个句柄。
//   3. 压缩 compaction —— 历史超预算时，把中间那段总结成一条摘要事件。
//      注意日志仍然只追加：压缩产生的是一条新事件，旧事件一个字节都没改。
//
// 运行: node l6-context.mjs "分析 repo 这个代码库的架构，写一份架构说明"
//      node l6-context.mjs --show <id>
//      node l6-context.mjs --stats <id>     # 这次跑的账单

import { readFile, readdir, appendFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const RUNS = 'runs'
// 三个阈值都是"随部署变化的选择"，不是常量：仓库大小、模型上下文窗口、价格都会改变它们。
const MAX_STEPS = Number(process.env.MAX_STEPS ?? 16)
const SPILL_CHARS = Number(process.env.SPILL_CHARS ?? 4000)   // 单条结果超过这么长就溢出到文件
const SPILL_HEAD_LINES = 30                                   // 留在历史里的头部行数
const COMPACT_AT = Number(process.env.COMPACT_AT ?? 24000)     // 估算 token 超过这个数就压缩
const KEEP_RECENT_STEPS = Number(process.env.KEEP_RECENT_STEPS ?? 3)  // 压缩时保留最近这么多个 step
const SYSTEM_PROMPT = '你是一个在命令行里工作的助手。回答简短，必要时用工具核实，不要编造文件内容。'

// token 估算：用于"要不要压缩"这种事前决策。实测值以响应里的 usage 为准。
// 中文和代码混排时，一个 token 大致 2–3 个字符；估高不估低，因为估低会导致超限。
const estimate = (text) => Math.ceil(text.length / 2.5)

// ---------- 工具 ----------

const registry = new Map()
const tool = (name, description, properties, required, run) =>
  registry.set(name, { name, description, properties, required, run })

tool('read_file', '读取一个文本文件。文件很大时用 offset/limit 分段读', {
  path: { type: 'string' },
  offset: { type: 'number', description: '从第几行开始，默认 1' },
  limit: { type: 'number', description: '读多少行，默认全部' },
}, ['path'], async ({ path, offset = 1, limit }) => {
  const lines = (await readFile(path, 'utf8')).split('\n')
  const slice = lines.slice(offset - 1, limit ? offset - 1 + limit : undefined)
  const tail = offset - 1 + slice.length < lines.length ? `\n…（共 ${lines.length} 行，还有更多）` : ''
  return slice.join('\n') + tail
})

tool('list_dir', '列出一个目录', { path: { type: 'string' } }, ['path'],
  async ({ path }) => (await readdir(path)).join('\n'))

const schemas = [...registry.values()].map(({ name, description, properties, required }) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
}))

// ---------- 日志（与 L4 相同：只追加） ----------

let sessionId = null
let seq = 0

const logPath = (id) => join(RUNS, `${id}.jsonl`)
const readLog = (id) => readFileSync(logPath(id), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

async function append(type, payload) {
  seq += 1
  const event = { seq, at: new Date().toISOString(), type, ...payload }
  await appendFile(logPath(sessionId), JSON.stringify(event) + '\n')
  return event
}

// ---------- 1. 溢出：完整字节进文件，历史里只留头部和句柄 ----------
//
// 「模型可见 ⟺ 已记录」在这里的含义是：日志里存的是模型<b>看见的那一版</b>（截短版），
// 完整字节存在旁边的文件里，日志记一个指针。两者都在，重放才能还原同一份历史。

async function spill(content, callId) {
  const dir = join(RUNS, `${sessionId}-spill`)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${callId.slice(-8)}.txt`)
  await writeFile(path, content)
  const lines = content.split('\n')
  const head = lines.slice(0, SPILL_HEAD_LINES).join('\n')
  return {
    path,
    visible: `${head}\n\n…结果太长（${content.length} 字符 / ${lines.length} 行），已完整写入 ${path}。`
      + `\n需要后面的内容时用 read_file 读它，带 offset/limit。`,
  }
}

// ---------- 2. 投影：多了一条压缩边界 ----------

function deriveMessages(events) {
  const compacted = events.filter((e) => e.type === 'context/compacted').at(-1)
  const boundary = compacted?.through ?? 0
  const answered = new Set(events.filter((e) => e.type === 'tool/result').map((e) => e.callId))
  const messages = []

  for (const event of events) {
    // 被压缩掉的那一段：整段跳过，摘要顶替它。system/prompt 与最初的任务永远保留。
    const dropped = event.seq <= boundary && event.type !== 'system/prompt' && !event.firstTask
    if (dropped) continue
    switch (event.type) {
      case 'system/prompt':
        messages.push({ role: 'system', content: event.content })
        if (compacted) messages.push({ role: 'user', content: `【之前工作的摘要】\n${compacted.summary}` })
        break
      case 'user/message':
        messages.push({ role: 'user', content: event.content })
        break
      case 'context/notice':
        // 预算提示追加在历史末尾，而不是改写 system prompt——改写会让整个前缀缓存失效。
        messages.push({ role: 'user', content: event.content })
        break
      case 'assistant/message':
        messages.push(event.message)
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
        break
    }
  }
  return messages
}

// ---------- 3. 压缩：一次模型调用，产出一条新事件 ----------

async function compact(events) {
  const previous = events.filter((e) => e.type === 'context/compacted').at(-1)?.through ?? 0
  // 先定边界，再由边界推出"折叠哪些、保留哪些"——两者必须来自同一个数，
  // 否则你总结的内容和你实际丢掉的内容对不上（第一次写这段时就是这么错的）。
  const cut = events.filter((e) => e.type === 'assistant/message').at(-KEEP_RECENT_STEPS)
  // 边界只能前进，不能后退：否则第二次压缩会把第一次折叠过的事件重新放回历史，越压越大。
  const boundary = Math.max(previous, cut ? cut.seq - 1 : events.at(-1).seq)
  if (boundary <= previous) return null   // 没有可折叠的新内容，压了也是白花一次调用

  const folded = deriveMessages(events.filter((e) => e.seq <= boundary))
  const transcript = folded
    .map((m) => `${m.role}: ${(m.content ?? JSON.stringify(m.tool_calls)).slice(0, 1200)}`).join('\n')
  const response = await ask([
    { role: 'system', content: '你在压缩一个 agent 的工作记录。保留：任务目标、已确认的事实、读过哪些文件及其要点、下一步该做什么。丢掉：寒暄、重复、失败尝试的细节。用要点列表，不超过 600 字。' },
    { role: 'user', content: transcript },
  ], [])
  const summary = response.choices[0].message.content
  await append('context/compacted', {
    through: boundary,
    summary,
    foldedMessages: folded.length,
    tokensBefore: estimate(JSON.stringify(deriveMessages(events))),
  })
  return summary
}

// ---------- 模型调用：每次都记账 ----------

const bill = []

async function ask(messages, tools) {
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages, ...(tools.length ? { tools } : {}) }),
  })
  const payload = await response.json()
  if (!payload.choices) throw new Error(`模型请求失败：${JSON.stringify(payload)}`)
  // usage 是实测值，不用猜。cache_hit 是"这次请求有多少前缀命中了缓存"——
  // 只追加不改写的历史命中率高，一次压缩会把它清零。
  bill.push(payload.usage)
  return payload
}

// ---------- 循环 ----------

async function runTurn(turn) {
  await append('turn/start', { turn })
  let reason = 'completed'
  try {
    for (let step = 1; step <= MAX_STEPS; step++) {
      let events = readLog(sessionId)
      let messages = deriveMessages(events)
      const before = estimate(JSON.stringify(messages))

      if (before > COMPACT_AT) {
        console.log(`\n[压缩] 历史约 ${before} token，超过 ${COMPACT_AT}，开始压缩…`)
        if (await compact(events)) {
          events = readLog(sessionId)
          messages = deriveMessages(events)
          console.log(`[压缩] 完成：约 ${before} → ${estimate(JSON.stringify(messages))} token`)
        } else {
          console.log('[压缩] 跳过：没有可折叠的新内容')
        }
      }

      // 预算是你的代码的私事，除非你把它写进模型看得见的字节里。只在跨过门槛时追加一次。
      const left = MAX_STEPS - step
      if (left === 4 && !events.some((e) => e.type === 'context/notice')) {
        await append('context/notice', { content: `【预算提示】还剩 ${left} 步就必须交付。请停止探索，用现有信息给出结论。` })
        messages = deriveMessages(readLog(sessionId))
      }

      const payload = await ask(messages, schemas)
      const message = payload.choices[0].message
      await append('assistant/message', { turn, step, message, usage: payload.usage })
      const u = payload.usage
      console.log(`[step ${step}] prompt ${u.prompt_tokens}（缓存命中 ${u.prompt_cache_hit_tokens ?? 0}）· 输出 ${u.completion_tokens}`)

      if (!message.tool_calls?.length) { console.log(`\n${message.content}\n`); break }

      for (const call of message.tool_calls) {
        await append('tool/call', { turn, step, call })
        const result = await execute(call)
        let content = result.content
        let spilled = null
        if (!result.isError && content.length > SPILL_CHARS) {
          const out = await spill(content, call.id)
          spilled = out.path
          content = out.visible
        }
        console.log(`  ${result.isError ? '✗' : '✓'} ${call.function.name} ${call.function.arguments}`
          + (spilled ? ` → 溢出到 ${spilled}` : ''))
        await append('tool/result', { turn, step, callId: call.id, isError: result.isError, content, spilled })
      }
    }
  } catch (error) {
    reason = `error: ${error.message}`
    console.error(reason)
  } finally {
    await append('turn/end', { turn, reason })
  }
}

async function execute(call) {
  const definition = registry.get(call.function.name)
  if (!definition) return { isError: true, content: `没有名为 ${call.function.name} 的工具` }
  let args
  try { args = JSON.parse(call.function.arguments) } catch { return { isError: true, content: '参数不是合法 JSON' } }
  if (!resolve(args.path ?? '.').startsWith(process.cwd())) {
    return { isError: true, content: '拒绝执行：只允许访问当前目录内的路径' }
  }
  try {
    return { isError: false, content: String(await definition.run(args)) }
  } catch (error) {
    return { isError: true, content: `执行失败：${error.message}` }
  }
}

// ---------- 入口 ----------

await mkdir(RUNS, { recursive: true })
const args = process.argv.slice(2)
const flag = args[0]?.startsWith('--') ? args[0] : null

if (flag === '--show') {
  for (const event of readLog(args[1])) {
    const detail = event.type === 'assistant/message'
      ? (event.message.content?.slice(0, 60) || `${event.message.tool_calls?.length} 个工具调用`)
      : (event.summary ?? event.content ?? event.call?.function?.name ?? event.reason ?? '')
    console.log(`${String(event.seq).padStart(3)}  ${event.type.padEnd(18)} ${String(detail).replace(/\n/g, ' ').slice(0, 70)}`)
  }
  process.exit(0)
}

if (flag === '--stats') {
  const events = readLog(args[1])
  const asked = events.filter((e) => e.usage)
  const sent = asked.reduce((n, e) => n + e.usage.prompt_tokens, 0)
  const hit = asked.reduce((n, e) => n + (e.usage.prompt_cache_hit_tokens ?? 0), 0)
  const spills = events.filter((e) => e.spilled)
  console.log(`步数 ${asked.length}`)
  console.log(`累计 prompt token ${sent}（其中缓存命中 ${hit}，${(hit / sent * 100).toFixed(0)}%）`)
  console.log(`最后一步的 prompt token ${asked.at(-1).usage.prompt_tokens}`)
  console.log(`溢出 ${spills.length} 次；压缩 ${events.filter((e) => e.type === 'context/compacted').length} 次`)
  // 压缩后的大小不必存进事件里：日志在手，投影一遍就能算出来（L4 的老道理）。
  for (const e of events.filter((e) => e.type === 'context/compacted')) {
    const after = estimate(JSON.stringify(deriveMessages(events.filter((x) => x.seq <= e.seq))))
    console.log(`  压缩 seq≤${e.through}：折叠 ${e.foldedMessages} 条消息，约 ${e.tokensBefore} → ${after} token`)
  }
  process.exit(0)
}

const task = args[0]
if (!task) throw new Error('请给一句任务')
sessionId = randomUUID().slice(0, 8)
console.log(`[new] ${sessionId}`)
await append('system/prompt', { content: SYSTEM_PROMPT })
await append('user/message', { content: task, firstTask: true })
await runTurn(1)
console.log(`日志: ${logPath(sessionId)}    账单: node l6-context.mjs --stats ${sessionId}`)
