// L11 · 形态：CLI、库、还是服务？
//
// 这一课几乎全是判断题，但有一件事可以直接证明：
// 如果你按 L7/L8 做了接缝和插件，**形态只是最外面那一层的替换**。
//
// 下面同一份插件清单（工具、权限、溢出、计量、模型、循环）不动一个字，
// 只换最外层那一个插件，就得到三种形态：
//
//   --shape cli    终端里一问一答（装 terminal 插件）
//   --shape serve  一个 HTTP 服务，多客户端、多会话（装 http 插件）
//   （库形态不需要插件：直接把 kernel.services.get('agent') 交出去就是库）
//
// 运行:
//   node l11-shapes.mjs --shape cli "读一下 fixtures/notes.md"
//   node l11-shapes.mjs --shape serve      然后另开一个终端：
//     curl -s localhost:7717/run -d '{"task":"读一下 fixtures/notes.md"}' -H 'content-type: application/json'

import { createServer } from 'node:http'
import { Kernel, tools, permission, spill, meter, deepseek, terminal, loop } from './l8-plugins.mjs'

// ---------- 形态一：CLI ----------
// 就是 L8 那个 terminal 插件：往 stdout 打字，用 Ctrl-C 中断。

// ---------- 形态二：服务 ----------
//
// 注意它加了什么、又暴露了什么问题：
//   加了：一个端口、一个请求到会话的映射、一份 JSON 响应
//   暴露了：认证是谁的事？并发跑两个任务会不会互相踩？凭据属于服务还是用户？
//           这三个问题在 CLI 形态里根本不存在——它们是形态带来的，不是 agent 带来的。

function http(ctx) {
  const port = Number(ctx.config.port ?? 7717)
  const sessions = new Map()
  // 隔离：每个请求自己一份内核和插件。
  // 不这么做的后果是实测出来的——两个请求同时进来时，A 拿到空 transcript，
  // B 拿到了 A 的工具结果：监听器注册在共享内核上，"当前会话"这个全局概念在服务形态下不成立。
  const isolate = ctx.config.isolate
  const buildScope = () => {
    const own = new Kernel()
    for (const plugin of [tools, permission, spill, meter, deepseek, loop]) own.use(plugin, { sessionId: 'req' })
    return own
  }

  const server = createServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/run') {
      const body = JSON.parse(await new Promise((done) => {
        let text = ''
        request.on('data', (chunk) => { text += chunk })
        request.on('end', () => done(text || '{}'))
      }))
      const transcript = []
      // 每个请求要有自己的一份记录——服务形态下"当前会话"这个全局概念不再成立。
      const scope = isolate ? buildScope() : ctx
      const off = scope.on('tool/result', ({ name, isError, length }) =>
        transcript.push(`${isError ? '✗' : '✓'} ${name} → ${length} 字`))
      const offAnswer = scope.on('agent/answer', ({ content }) => transcript.push(`答：${content}`))
      try {
        const agent = isolate ? scope.services.get('agent') : ctx.get('agent')
        await agent.run(body.task ?? '这个目录里有什么？')
        const id = Math.random().toString(36).slice(2, 10)
        sessions.set(id, transcript)
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ id, transcript }, null, 2))
      } catch (error) {
        // 错误要变成响应，不能打印到服务器的终端上——没人在那儿看着。
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: error.message }))
      } finally {
        off(); offAnswer()
      }
      return
    }
    if (request.method === 'GET' && request.url?.startsWith('/session/')) {
      const id = request.url.slice('/session/'.length)
      response.writeHead(sessions.has(id) ? 200 : 404, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(sessions.get(id) ?? { error: 'no such session' }))
      return
    }
    response.writeHead(404)
    response.end()
  })

  server.listen(port, () => console.log(`[serve] http://localhost:${port}  POST /run  GET /session/<id>`))
  ctx.provide('http', { close: () => server.close() })
}

// ---------- 装配：只有这一行随形态变化 ----------

const argv = process.argv.slice(2)
const shape = argv.includes('--shape') ? argv[argv.indexOf('--shape') + 1] : 'cli'

const kernel = new Kernel()
for (const plugin of [tools, permission, spill, meter, deepseek, loop]) kernel.use(plugin, { sessionId: 'l11' })
kernel.use(shape === 'serve' ? http : terminal, { port: process.env.PORT, isolate: argv.includes('--isolate') })
console.log(`[形态] ${shape}　插件清单其余部分一字未改`)

if (shape === 'cli') {
  const task = argv.filter((a) => !a.startsWith('--') && a !== shape).at(-1)
  await kernel.services.get('agent').run(task ?? '这个目录里有什么？')
  const bill = kernel.services.get('meter')
  console.log(`[账单] ${bill.steps} 步，prompt ${bill.prompt} token`)
}
// 库形态：把 agent 交出去就完了——const agent = kernel.services.get('agent'); export { agent }
