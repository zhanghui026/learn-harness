// L1 · 三十行的最小 agent
//
// 三样东西，一样不少：循环、工具、状态。
// 运行: node l1-agent.mjs "读一下 README.md，这个目录是干什么的"

import { readFile } from 'node:fs/promises'

const tools = [{
  type: 'function',
  function: {
    name: 'read_file',
    description: '读取一个文本文件的内容',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '文件路径' } },
      required: ['path'],
    },
  },
}]

async function runTool(name, args) {
  if (name === 'read_file') return await readFile(args.path, 'utf8')
  return `unknown tool: ${name}`
}

const messages = [{ role: 'user', content: process.argv[2] ?? '这个目录里有什么？' }]

for (let step = 1; step <= 10; step++) {          // ← 循环
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({ model: 'deepseek-chat', messages, tools }),
  })
  const message = (await res.json()).choices[0].message
  messages.push(message)                           // ← 状态

  if (!message.tool_calls?.length) {               // 没有意图 = 它说完了
    console.log(message.content)
    break
  }

  for (const call of message.tool_calls) {         // ← 工具
    console.log(`→ ${call.function.name}(${call.function.arguments})`)
    const result = await runTool(call.function.name, JSON.parse(call.function.arguments))
    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: String(result).slice(0, 4000),
    })
  }
}
