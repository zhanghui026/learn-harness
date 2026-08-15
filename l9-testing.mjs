// L9 · 测试阶梯与回放
//
// 这门课自己就是最好的教材：L2 的超时原因被工具错误覆盖、L4 删一行日志就 API 报错、
// L6 的压缩边界回退导致越压越大、L6 的口径不一致导致压完迷路、L8 的溢出文件被再次溢出——
// 五个 bug，没有一个是靠"想"发现的，全是跑起来才暴露的。这一课把它们变成回归测试。
//
// 五级阶梯，从便宜到贵，越靠下越少写：
//   ① 纯函数     微秒级，最该多写（投影、边界、估算）
//   ② 插件行为   假内核里装一个插件，断言它做了什么、拦了什么
//   ③ 生命周期   卸载之后注册是否真的归零
//   ④ 回放       录一次真跑，之后零成本重放整个循环
//   ⑤ 快照       把模型看见的字节整份存下来，改动时 diff
//   （⑥ 真 API e2e 不在这个文件里：贵、慢、不确定，只用来确认"契约还在"）
//
// 运行: node --test l9-testing.mjs
//      SNAPSHOT=update node --test l9-testing.mjs    # 行为确实变了，重录快照

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { Kernel, tools, permission, spill } from './l8-plugins.mjs'

// ============ ① 纯函数：投影 ============
//
// 这是 L4 那个 bug 的回归测试：日志停在"说了要调工具、结果还没写下来"的地方时，
// 投影必须补一条占位，否则 API 会拒绝整份历史。

function deriveMessages(events) {
  const answered = new Set(events.filter((e) => e.type === 'tool/result').map((e) => e.callId))
  const messages = []
  for (const event of events) {
    if (event.type === 'user/message') messages.push({ role: 'user', content: event.content })
    if (event.type === 'assistant/message') {
      messages.push(event.message)
      for (const call of event.message.tool_calls ?? []) {
        if (!answered.has(call.id)) messages.push({ role: 'tool', tool_call_id: call.id, content: '(工具没有返回结果：会话在这一步中断了)' })
      }
    }
    if (event.type === 'tool/result') messages.push({ role: 'tool', tool_call_id: event.callId, content: event.content })
  }
  return messages
}

const CALL = { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }

test('投影：每个 tool_call 都必须有回应，缺的补占位', () => {
  const crashed = [
    { type: 'user/message', content: '读一下' },
    { type: 'assistant/message', message: { role: 'assistant', tool_calls: [CALL] } },
    // 这里断电了：tool/result 没写下来
  ]
  const messages = deriveMessages(crashed)
  const answers = messages.filter((m) => m.role === 'tool' && m.tool_call_id === 'call_1')
  assert.equal(answers.length, 1, '断在半路的会话必须仍然投影出合法历史')
  assert.match(answers[0].content, /中断/)
})

test('投影：纯函数——同样的日志永远得到同样的历史', () => {
  const events = [{ type: 'user/message', content: 'x' }]
  assert.deepEqual(deriveMessages(events), deriveMessages(events))
})

// ============ ① 纯函数：压缩边界 ============
//
// L6 那个 bug 的回归测试：边界一旦回退，已折叠的事件会被放回历史，越压越大。

const nextBoundary = (previous, computed) => Math.max(previous, computed)

test('压缩：边界只能右移，绝不回退', () => {
  assert.equal(nextBoundary(15, 22), 22)
  assert.equal(nextBoundary(22, 9), 22, '算出来更靠左时必须保持不动，否则历史会反向增长')
})

// ============ ② 插件行为：拒绝要从执行器那一端测 ============
//
// 不是断言"策略函数返回了 deny"，而是断言"真正会动文件的那个函数根本没被调用"。

test('权限：命中凭据时，终点从未被执行', async () => {
  const kernel = new Kernel()
  kernel.use(permission)
  let terminalRan = false
  const result = await kernel.waterfall('tools/execute',
    { name: 'read_file', args: { path: '.env' } },
    async () => { terminalRan = true; return { isError: false, content: 'secret' } })

  assert.equal(terminalRan, false, '短路的含义就是它不该发生')
  assert.equal(result.isError, true)
  assert.match(result.content, /凭据文件/)
})

test('权限：普通路径要放行到终点', async () => {
  const kernel = new Kernel()
  kernel.use(permission)
  const result = await kernel.waterfall('tools/execute',
    { name: 'read_file', args: { path: 'README.md' } },
    async () => ({ isError: false, content: 'ok' }))
  assert.equal(result.content, 'ok')
})

// ============ ② 插件行为：溢出不吃自己 ============
//
// L8 那个 bug 的回归测试：溢出写出来的文件，被读的时候不能再溢出一次。

test('溢出：超长结果被截短并落盘', async () => {
  const kernel = new Kernel()
  kernel.use(spill, { limit: 100 })
  const result = await kernel.waterfall('tools/execute',
    { id: 'call_abc123', name: 'read_file', args: { path: 'big.txt' }, sessionId: 'test' },
    async () => ({ isError: false, content: 'x'.repeat(5000) }))
  assert.ok(result.content.length < 5000)
  assert.match(result.content, /已写入 runs\//)
})

test('溢出：读溢出文件本身时不再溢出（否则模型永远读不到后面）', async () => {
  const kernel = new Kernel()
  kernel.use(spill, { limit: 100 })
  const result = await kernel.waterfall('tools/execute',
    { id: 'call_x', name: 'read_file', args: { path: 'runs/test-abc.txt' }, sessionId: 'test' },
    async () => ({ isError: false, content: 'y'.repeat(5000) }))
  assert.equal(result.content.length, 5000, '溢出文件必须原样返回')
})

// ============ ③ 生命周期：卸载要卸干净 ============

test('生命周期：dispose 之后，注册的一切归零', () => {
  const kernel = new Kernel()
  const dispose = kernel.use(tools)
  assert.ok(kernel.services.has('tools'))
  dispose()
  assert.equal(kernel.services.has('tools'), false, '服务必须消失')
  assert.equal([...kernel.listeners.values()].flat().length, 0, '监听器必须清空')
})

// ============ ④ 回放 + ⑤ 快照 ============
//
// 回放实现顶替掉模型那一侧，其余全部真跑：工具真读文件、权限真判定、溢出真落盘。
// 于是整条链路是确定的——同一份日志永远得到同一份 transcript。
// 注意它的边界：回放能证明"给定同样的模型输出，我的代码行为不变"，
// 不能证明"模型还会那样输出"。后者只有 e2e 能答，所以 e2e 少而精。

function llmReplay(logPath) {
  return (ctx) => {
    const events = readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const answers = events.filter((e) => e.type === 'llm/response' && e.message).map((e) => e.message)
    let cursor = 0
    ctx.provide('llm', {
      async chat() {
        assert.ok(cursor < answers.length, '回放耗尽：这次跑的步数比录制时多，说明行为变了')
        return answers[cursor++]
      },
    })
  }
}

// 归一化：会话 id、时间戳、路径每次都不同，它们不是行为。
// 但字节数、工具名、拒绝与否是行为——绝不能归一化掉，否则快照就测不出东西了。
const normalize = (line) => line
  .replace(/runs\/[0-9a-f]{8}-\w+\.txt/g, 'runs/<session>-<call>.txt')
  .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<time>')

function transcriptOf(logPath) {
  const lines = []
  const kernel = new Kernel()
  kernel.use(tools)
  kernel.use(permission)
  kernel.use(spill, { limit: 4000 })
  kernel.use(llmReplay(logPath))
  kernel.use((ctx) => {
    ctx.on('tool/called', ({ name, args }) => lines.push(`调用 ${name} ${JSON.stringify(args)}`))
    ctx.on('tool/result', ({ name, isError, length }) => lines.push(`结果 ${name} ${isError ? '拒绝/失败' : '成功'} ${length} 字`))
    ctx.on('permission/denied', ({ name }) => lines.push(`拦截 ${name}`))
  })
  return { kernel, lines }
}

test('回放：同一份日志跑出同一份 transcript（快照）', async () => {
  // 录制这份日志时，所有工具调用都只碰 fixtures/ —— 那个目录不许随便改。
  // 第一版录的是当前工作目录，于是快照里混进了"这个目录有几个文件"，
  // 加一个文件就红。修 fixture，不要放宽 normalizer。
  // 录制的日志和期望的快照都必须进版本库：测试的输入和输出都是资产。
  // 它放在 snapshots/ 而不是 fixtures/，因为 fixtures/ 会被那次录制 list_dir 列举——
  // 往里加任何文件都会让这份快照红。
  const logPath = process.env.REPLAY_LOG ?? 'snapshots/replay-input.jsonl'
  const snapshotPath = 'snapshots/replay.txt'
  const { kernel, lines } = transcriptOf(logPath)

  // 用 L8 的 loop 插件驱动，但模型那一侧是回放的
  const { loop } = await import('./l8-plugins.mjs')
  kernel.use(loop, { sessionId: 'test' })
  await kernel.services.get('agent').run('（任务来自录制）')

  const actual = lines.map(normalize).join('\n')
  mkdirSync('snapshots', { recursive: true })
  if (process.env.SNAPSHOT === 'update' || !existsSync(snapshotPath)) {
    writeFileSync(snapshotPath, actual + '\n')
    console.log('  （已录制快照，请把它提交进版本库并在 review 时逐行读一遍）')
    return
  }
  assert.equal(actual, readFileSync(snapshotPath, 'utf8').trim(),
    '模型看见的字节变了。要么是回归，要么是你有意改的行为——后者请连快照一起改，并在 PR 里说明为什么。')
})
