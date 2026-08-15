// L8 · 插件与事件派发：一个不到 60 行的微内核
//
// 到 L7 为止，循环里塞满了不属于它的东西：日志、权限、溢出、计量、装配。
// 每加一个功能就要改那个函数，而且它们开始互相认识——压缩要知道日志长什么样，
// 审批要知道工具管线在哪一步。这一课把它们全部搬出去，核心只剩三件事：
//
//   注册（provide / on）· 派发（emit / waterfall）· 生命周期（use 返回 disposer）
//
// 然后 L2–L7 的每一个功能——连工具和循环本身——都成了插件。
//
// 运行:
//   node l8-plugins.mjs "读一下 .env 和 README.md"
//   node l8-plugins.mjs --without permission "读一下 .env"     # 卸掉一个插件，核心不动
//   node l8-plugins.mjs --without spill "读一下 README.md"     # 看溢出插件在与不在的区别
//   node l8-plugins.mjs --trace "读一下 README.md"             # 打印每一次派发

import { readFile, readdir, appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'

// ============ 内核 ============
//
// 内核不知道什么是工具、什么是权限、什么是模型。它只知道三件事：
// 谁提供了服务、谁在听什么事件、以及怎么把一个插件连根拔掉。

class Kernel {
  services = new Map()
  listeners = new Map()
  trace = process.argv.includes('--trace')

  provide(name, impl) {
    this.services.set(name, impl)
    return () => this.services.delete(name)          // 注册即 effect：返回怎么撤销它
  }

  on(event, listener) {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return () => list.splice(list.indexOf(listener), 1)
  }

  // 广播：每个听众都收到，谁也改不了别人看到的东西，返回值被忽略。
  emit(event, payload) {
    if (this.trace) console.log(`    · emit ${event}`)
    for (const listener of this.listeners.get(event) ?? []) listener(payload)
  }

  // 并发派发：全部跑起来，等它们都完成。emit 是"发完就走"，
  // 而有些监听器必须在下一步之前跑完（L10 的压缩就是），那时候就得用它。
  async parallel(event, payload) {
    if (this.trace) console.log(`    · parallel ${event}`)
    await Promise.all((this.listeners.get(event) ?? []).map((listener) => listener(payload)))
  }

  // 环绕中间件：每一层都能改参数、改结果，也能直接短路——不调 next() 就到此为止。
  // 这是整个内核唯一"有权力"的机制，权限、审批、溢出全部挂在它上面。
  async waterfall(event, payload, terminal) {
    const chain = [...(this.listeners.get(event) ?? [])]
    const step = async (index, value) => {
      if (index === chain.length) return terminal(value)
      if (this.trace) console.log(`    · waterfall ${event} [${index}] ${chain[index].pluginName ?? ''}`)
      return chain[index](value, (next = value) => step(index + 1, next))
    }
    return step(0, payload)
  }

  // 装载一个插件：它注册的一切都记在案，返回的函数能把它连根拔掉。
  use(plugin, config = {}) {
    const undo = []
    const scoped = {
      get: (name) => this.services.get(name),
      provide: (name, impl) => undo.push(this.provide(name, impl)),
      on: (event, listener) => {
        listener.pluginName = plugin.name
        undo.push(this.on(event, listener))
      },
      emit: (event, payload) => this.emit(event, payload),
      parallel: (event, payload) => this.parallel(event, payload),
      waterfall: (event, payload, terminal) => this.waterfall(event, payload, terminal),
      config,
    }
    plugin(scoped)
    return () => { for (const dispose of undo.reverse()) dispose() }
  }
}

// ============ 插件：以下每一个都可以单独删掉 ============

// —— 工具也是插件。它把自己注册进一张表，别人只通过服务拿到它。
function tools(ctx) {
  const registry = new Map()
  const add = (name, description, properties, required, run) =>
    registry.set(name, { name, description, properties, required, run })

  // offset/limit 不是为模型加的，是为 spill 插件加的：它把结果截短之后，
  // 必须有办法让模型接着往下读。契约要为所有现有消费者设计——溢出插件也是消费者。
  add('read_file', '读取一个文本文件，可用 offset/limit 按行分段',
    { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, ['path'],
    async ({ path, offset = 1, limit }) => {
      const lines = (await readFile(path, 'utf8')).split('\n')
      const slice = lines.slice(offset - 1, limit ? offset - 1 + limit : undefined)
      return slice.join('\n') + (offset - 1 + slice.length < lines.length ? `\n…（共 ${lines.length} 行）` : '')
    })
  add('list_dir', '列出一个目录', { path: { type: 'string' } }, ['path'],
    async ({ path }) => (await readdir(path)).join('\n'))

  ctx.provide('tools', {
    // 别的插件要能往这张表里加工具——不然"加一个工具"就得改这个文件，
    // 而"加功能不用改已有文件"正是 L8 那条规矩。
    add,
    get: (name) => registry.get(name),
    schemas: () => [...registry.values()].map(({ name, description, properties, required }) => ({
      type: 'function',
      function: { name, description, parameters: { type: 'object', properties, required } },
    })),
  })
}

// —— 权限（L5）：挂在 tools/execute 上。拒绝的做法就是"不调 next()"。
function permission(ctx) {
  const SECRET = /(^|\/)\.env(\.|$)|\.pem$/
  ctx.on('tools/execute', async (call, next) => {
    if (call.name === 'read_file' && SECRET.test(call.args.path ?? '')) {
      ctx.emit('permission/denied', call)
      return { isError: true, content: '拒绝执行：这是凭据文件' }   // ← 不 next()，链到此为止
    }
    if (!resolve(call.args.path ?? '.').startsWith(process.cwd())) {
      return { isError: true, content: '拒绝执行：超出工作区' }
    }
    return next()
  })
}

// —— 溢出（L6）：挂在同一条链上，但它关心的是结果，所以先 next() 再改。
function spill(ctx) {
  const LIMIT = Number(ctx.config.limit ?? 4000)
  ctx.on('tools/execute', async (call, next) => {
    const result = await next()
    if (result.isError || result.content.length <= LIMIT) return result
    // 溢出文件自己不能再被溢出，否则模型永远读不到第 600 字之后的内容——
    // 上一版就是这么让它白跑两步的。插件之间的相互作用是一类新的 bug。
    if (String(call.args.path ?? '').startsWith('runs/')) return result
    const path = join('runs', `${call.sessionId}-${call.id.slice(-6)}.txt`)
    // 目录可能还不存在（比如刚克隆下来就跑测试）：自己建，别指望调用方替你建好。
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, result.content)
    ctx.emit('tool/spilled', { path, bytes: result.content.length })
    return { ...result, content: `${result.content.slice(0, 600)}\n\n…太长（${result.content.length} 字符），已写入 ${path}。用 read_file 带 offset/limit 继续读它。` }
  })
}

// —— 日志（L4）：只听不改。它对工具、权限、模型一无所知，只认事件。
function log(ctx) {
  let seq = 0
  const path = join('runs', `${ctx.config.sessionId}.jsonl`)
  const write = (type, payload) =>
    appendFile(path, JSON.stringify({ seq: ++seq, at: new Date().toISOString(), type, ...payload }) + '\n')
  for (const event of ['turn/start', 'turn/end', 'llm/response', 'tool/called', 'tool/result', 'permission/denied', 'tool/spilled']) {
    ctx.on(event, (payload) => write(event, payload ?? {}))
  }
  ctx.provide('log', { path })
}

// —— 计量（L6）：同样只听不改，账记在自己身上。
function meter(ctx) {
  const bill = { prompt: 0, completion: 0, cached: 0, steps: 0 }
  ctx.on('llm/response', ({ usage }) => {
    bill.steps += 1
    bill.prompt += usage.prompt_tokens ?? 0
    bill.completion += usage.completion_tokens ?? 0
    bill.cached += usage.prompt_cache_hit_tokens ?? 0
  })
  ctx.provide('meter', bill)
}

// —— 模型（L7 的接缝，这里是它的插件形态）
function deepseek(ctx) {
  ctx.provide('llm', {
    async chat(messages, schemas) {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
        body: JSON.stringify({ model: 'deepseek-chat', messages, tools: schemas }),
      })
      const payload = await response.json()
      if (!payload.choices) throw new Error(`模型请求失败：${JSON.stringify(payload)}`)
      // 事件里必须带上模型说的话：不记下来，L9 的回放就无从谈起（模型可见 ⟺ 已记录）。
      ctx.emit('llm/response', { usage: payload.usage, message: payload.choices[0].message })
      return payload.choices[0].message
    },
  })
}

// —— 终端输出：打印是副作用，所以它也是一个插件。
// 循环里留一行 console.log，测试就得连着它的噪音一起跑——L9 就是被这一点逼出来的。
function terminal(ctx) {
  ctx.on('tool/result', ({ name, args, isError, length }) =>
    console.log(`  ${isError ? '✗' : '✓'} ${name} ${JSON.stringify(args)} → ${length} 字`))
  ctx.on('agent/answer', ({ content }) => console.log(`\n${content}\n`))
}

// —— 循环：它也只是一个插件，没有任何特权。别的插件不许依赖它。
function loop(ctx) {
  ctx.provide('agent', {
    async run(task) {
      const llm = ctx.get('llm')
      const tools = ctx.get('tools')
      const messages = [{ role: 'user', content: task }]
      ctx.emit('turn/start', { task })
      for (let step = 1; step <= 8; step++) {
        const message = await llm.chat(messages, tools.schemas())
        messages.push(message)
        if (!message.tool_calls?.length) { ctx.emit('agent/answer', { content: message.content }); break }
        for (const call of message.tool_calls) {
          const args = JSON.parse(call.function.arguments)
          ctx.emit('tool/called', { name: call.function.name, args })
          // 唯一的执行入口。所有策略都挂在这条 waterfall 上，绕过它就等于绕过一切。
          const result = await ctx.waterfall('tools/execute',
            { id: call.id, name: call.function.name, args, sessionId: ctx.config.sessionId },
            async ({ name, args }) => {
              const definition = tools.get(name)
              if (!definition) return { isError: true, content: `没有名为 ${name} 的工具` }
              try {
                return { isError: false, content: String(await definition.run(args)) }
              } catch (error) {
                return { isError: true, content: `执行失败：${error.message}` }
              }
            })
          ctx.emit('tool/result', { name: call.function.name, args, isError: result.isError, length: result.content.length })
          messages.push({ role: 'tool', tool_call_id: call.id, content: result.content })
        }
      }
      ctx.emit('turn/end', { reason: 'completed' })
    },
  })
}

export { Kernel, tools, permission, spill, log, meter, deepseek, loop, terminal }

// 模块在被 import 时不能自己跑起来——这是"能不能测"的第一道门槛。
// 只有直接 node 这个文件时，下面这段装配才执行。
if (process.argv[1]?.endsWith('l8-plugins.mjs')) {
  // ============ 装配：一张清单，不是一段代码 ============

  await mkdir('runs', { recursive: true })
  const sessionId = randomUUID().slice(0, 8)
  const without = process.argv.includes('--without') ? process.argv[process.argv.indexOf('--without') + 1] : null

  const kernel = new Kernel()
  const catalog = { tools, permission, spill, log, meter, deepseek, terminal, loop }
  const loaded = new Map()

  for (const [name, plugin] of Object.entries(catalog)) {
    if (name === without) { console.log(`[跳过] ${name}`); continue }
    loaded.set(name, kernel.use(plugin, { sessionId }))
  }
  console.log(`[装配] ${[...loaded.keys()].join(' · ')}`)

  const task = process.argv.slice(2).filter((a) => !a.startsWith('--') && a !== without).at(-1)
  await kernel.services.get('agent').run(task ?? '这个目录里有什么？')

  const bill = kernel.services.get('meter')
  if (bill) console.log(`[账单] ${bill.steps} 步，prompt ${bill.prompt} token（缓存 ${bill.cached}）`)
  if (kernel.services.get('log')) console.log(`[日志] ${kernel.services.get('log').path}`)

  // 生命周期：卸载一个插件，它注册过的一切当场消失——这就是 HMR 和"每个 agent 一份作用域"的地基。
  if (process.argv.includes('--prove-dispose')) {
    console.log(`\n[验证] 卸载 log 插件前，listeners 上共有 ${[...kernel.listeners.values()].flat().length} 个监听器`)
    loaded.get('log')()
    console.log(`[验证] 卸载后 ${[...kernel.listeners.values()].flat().length} 个，服务表里还有 log 吗：${kernel.services.has('log')}`)
  }
}
