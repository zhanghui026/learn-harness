// L5 · 权限、审批、沙箱
//
// L2 那条守卫只挡住了 read_file。这一课给 agent 一个 bash 工具——真正危险的东西——
// 然后你会发现同一条守卫立刻被绕过去：cat .env 根本不经过 read_file。
//
// 三道防线，位置不同，信任假设也不同：
//   1. 判定 policy   —— 执行之前的纯函数。看得懂的坏事直接拒绝。
//   2. 审批 approval —— 判不了的交给人。一次一授，不记住。
//   3. 围栏 sandbox  —— 不相信前两道：让操作系统来拦，拒绝变成一条结果。
//
// 运行:
//   node l5-permission.mjs "读一下 .env 里有什么"                    # 判定拒绝
//   node l5-permission.mjs "用 bash 把 hello 写进 /tmp/l5.txt"        # 沙箱拦下 → 问你 → 升级重试
//   node l5-permission.mjs --policy never "删掉 runs 目录"            # 不问人，一律拒绝
//   node l5-permission.mjs --yes "..."                                # 非交互：一律批准（CI 用，危险）

import { readFile, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { resolve } from 'node:path'

const WORKSPACE = process.cwd()
const TOOL_TIMEOUT_MS = Number(process.env.TOOL_TIMEOUT_MS ?? 15000)
const approvalPolicy = process.argv.includes('--policy') ? process.argv[process.argv.indexOf('--policy') + 1]
  : process.argv.includes('--yes') ? 'always' : 'ask'   // dsh 只有 ask / never 两种，always 是这里为了非交互演示加的

// ---------- 工具 ----------

const registry = new Map()
const tool = (name, description, properties, required, run) =>
  registry.set(name, { name, description, properties, required, run })

tool('read_file', '读取一个文本文件', { path: { type: 'string' } }, ['path'],
  ({ path }) => readFile(path, 'utf8'))
tool('list_dir', '列出一个目录', { path: { type: 'string' } }, ['path'],
  async ({ path }) => (await readdir(path)).join('\n'))
tool('bash', '在 shell 里执行一条命令', { command: { type: 'string' } }, ['command'],
  ({ command }, signal, mode) => runConfined(command, signal, mode))

const schemas = [...registry.values()].map(({ name, description, properties, required }) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
}))

// ---------- 第一道：判定 ----------
//
// 纯函数，只看名字和参数，不产生任何副作用——所以它可以被单测、被日志、被复述给人看。
// 注意 bash 那一支：用正则去判断一条 shell 命令是不是危险，是注定漏的
// （$(...)、别名、base64、换个写法都能绕）。所以这里默认 ask，真正的拦截交给第三道。

const SECRET = /(^|\/)\.env(\.|$)|\.pem$|(^|\/)id_rsa$/
const FORBIDDEN = [
  [/\brm\s+-[rf]/, '递归删除'],
  [/\bsudo\b/, '提权'],
  [/\bcurl\b[^|]*\|\s*(ba)?sh/, '把网上下载的东西直接喂给 shell'],
  [/(^|\s)>\s*\/(etc|usr|bin|System)\//, '往系统目录写文件'],
]

function policy(name, args) {
  if (name === 'read_file' && SECRET.test(args.path ?? '')) return { decision: 'deny', reason: '这是凭据文件' }
  if (name === 'bash') {
    for (const [pattern, why] of FORBIDDEN) if (pattern.test(args.command)) return { decision: 'deny', reason: why }
    return { decision: 'ask', reason: '要在 shell 里执行命令' }
  }
  if (!resolve(args.path ?? '.').startsWith(WORKSPACE)) return { decision: 'deny', reason: '超出工作区' }
  return { decision: 'allow', reason: '只读，且在工作区内' }
}

// ---------- 第二道：审批 ----------
//
// 一次一授：批准只对"这一次这个动作"生效，不写进任何持久的规则表。
// 没人能回答就拒绝（fail closed）——沉默绝不等于同意。

const audit = []   // 用 L4 的话说，这些就是 approval/asked 与 approval/decided 事件：进日志，但模型看不见
let rl = null

async function approve(question) {
  audit.push({ at: new Date().toISOString(), type: 'approval/asked', question })
  let granted
  if (approvalPolicy === 'never') granted = false
  else if (approvalPolicy === 'always') granted = true
  else if (!process.stdin.isTTY) granted = false
  else {
    rl ??= createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question(`\n  ⚠ ${question}  [y/N] `)
    granted = answer.trim().toLowerCase() === 'y'
  }
  audit.push({ at: new Date().toISOString(), type: 'approval/decided', granted, policy: approvalPolicy })
  return granted
}

// ---------- 第三道：围栏 ----------
//
// 前两道都建立在"我看得懂这条命令"之上；这一道不需要看懂任何东西。
// macOS 用 seatbelt(sandbox-exec)，Linux 上对应的是 landlock/bwrap，dsh 两个都有。
// 关键不是用了哪个内核特性，而是：被拒绝之后，我们拿到的是一条结果，不是一个异常。

// 凭据是绝对禁令：它不在"模式"这张表里，两种模式都读不到，升级也打不开。
// 判定那一层拦的是 read_file 这个名字，这一层拦的是"读到那些字节"这件事——
// 所以 cat、grep、python、base64、随便什么绕法，全都撞在同一堵墙上。
const SEALED = `(deny file-read* (literal ${JSON.stringify(`${WORKSPACE}/.env`)}) (regex #"\\.pem$") (regex #"/id_rsa$"))`
const WRITABLE_DEVICES = '(literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty")'
const PROFILES = {
  'read-only': `(version 1)(allow default)${SEALED}(deny file-write*)
    (allow file-write* ${WRITABLE_DEVICES})`,
  'workspace-write': `(version 1)(allow default)${SEALED}(deny file-write*)
    (allow file-write* (subpath ${JSON.stringify(WORKSPACE)}) (subpath "/private/tmp") ${WRITABLE_DEVICES})`,
}
const DENIAL = /Operation not permitted|Read-only file system|EPERM|EACCES/

// 交给沙箱的，是我们本来就要 spawn 的那一串 argv 原样包一层——不是一个我们重新拼过的字符串。
function runConfined(command, signal, mode = 'read-only') {
  const argv = ['-p', PROFILES[mode], 'bash', '-c', command]
  return new Promise((done) => {
    execFile('sandbox-exec', argv, { signal, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      const output = (stdout + stderr).trim()
      if (!error) return done({ ok: true, mode, output: output || '(无输出)' })
      // 沙箱拦下来了，还是命令自己失败了？分辨这个是围栏这一层的职责。
      // 读的是 stdout+stderr 合流：模型很爱写 2>&1，只盯 stderr 的分类器会当场瞎掉。
      // 就算这样，靠文本方言认拒绝仍然只是启发式——所以模式本身要作为事实一起报上去。
      done({ ok: false, mode, denied: DENIAL.test(output), output: output || error.message })
    })
  })
}

// ---------- 管线：三道防线依次落位 ----------

async function execute(call) {
  const definition = registry.get(call.function.name)
  if (!definition) return { isError: true, content: `没有名为 ${call.function.name} 的工具` }
  let args
  try { args = JSON.parse(call.function.arguments) } catch { return { isError: true, content: '参数不是合法 JSON' } }

  const verdict = policy(definition.name, args)
  audit.push({ at: new Date().toISOString(), type: 'policy/decided', tool: definition.name, ...verdict })
  console.log(`  · ${definition.name} ${JSON.stringify(args)} → ${verdict.decision}（${verdict.reason}）`)

  if (verdict.decision === 'deny') return { isError: true, content: `拒绝执行：${verdict.reason}` }
  if (verdict.decision === 'ask') {
    const granted = await approve(`允许执行 ${definition.name}: ${args.command ?? args.path}？`)
    if (!granted) return { isError: true, content: '用户拒绝了这次执行' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`超过 ${TOOL_TIMEOUT_MS}ms 未返回`)), TOOL_TIMEOUT_MS)
  try {
    if (definition.name !== 'bash') return { isError: false, content: String(await definition.run(args, controller.signal)) }

    let result = await definition.run(args, controller.signal, 'read-only')
    if (!result.ok && result.denied) {
      // 升级重试：沙箱说不行 → 问人 → 换一个更宽的围栏重跑同一条命令。
      // 注意被放宽的只有这一次调用的模式，会话的默认值一个字节都没动。
      console.log(`  ⛔ 沙箱拦下（${result.mode}）：${result.output.split('\n').at(-1)}`)
      if (await approve('沙箱以 read-only 拒绝了它。允许放宽到 workspace-write 再试一次吗？')) {
        result = await definition.run(args, controller.signal, 'workspace-write')
      }
    }
    return { isError: !result.ok, content: `[sandbox: ${result.mode}]\n${result.output}` }
  } catch (error) {
    return { isError: true, content: `执行失败：${error.message}` }
  } finally {
    clearTimeout(timer)
  }
}

// ---------- 循环 ----------

const task = process.argv.slice(2).filter((a) => !a.startsWith('--') && a !== approvalPolicy).at(-1)
const messages = [
  { role: 'system', content: `你在一台机器上工作，工作区是 ${WORKSPACE}。有些操作会被拒绝或需要用户批准；被拒绝时不要重试同一条命令，直接如实汇报。` },
  { role: 'user', content: task ?? '这个目录里有什么？' },
]

for (let step = 1; step <= 8; step++) {
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages, tools: schemas }),
  })
  const payload = await response.json()
  if (!payload.choices) throw new Error(`模型请求失败：${JSON.stringify(payload)}`)
  const message = payload.choices[0].message
  messages.push(message)
  if (!message.tool_calls?.length) { console.log(`\n${message.content}\n`); break }

  console.log(`\n[step ${step}]`)
  // 审批是串行的：并行弹三个框，人根本不知道自己在批什么。
  for (const call of message.tool_calls) {
    const result = await execute(call)
    messages.push({ role: 'tool', tool_call_id: call.id, content: result.content })
  }
}

rl?.close()
console.log('审计（模型看不见这些）：')
for (const record of audit) console.log(`  ${record.type.padEnd(16)} ${JSON.stringify(record).slice(0, 110)}`)
