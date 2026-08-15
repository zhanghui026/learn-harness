// L7 的"另一个世界"：一个独立进程，通过 stdin/stdout 收发 JSON 行。
//
// 它存在的唯一目的，是证明 world 接缝的另一侧真的可以不在你这个进程里。
// 真实 harness 里这一侧是 SSH、是容器、是 E2B 那样的远程沙箱；协议会更正经，
// 但形状是一样的：一问一答，参数进去、结果回来，中间是一道真实的进程边界。

import { readFile, readdir } from 'node:fs/promises'
import { createInterface } from 'node:readline'

const handlers = {
  describe: async () => `子进程世界 pid=${process.pid}, cwd=${process.cwd()}`,
  readFile: async ({ path, offset = 1, limit }) => {
    const lines = (await readFile(path, 'utf8')).split('\n')
    const slice = lines.slice(offset - 1, limit ? offset - 1 + limit : undefined)
    return slice.join('\n') + (offset - 1 + slice.length < lines.length ? `\n…（共 ${lines.length} 行）` : '')
  },
  listDir: async ({ path }) => (await readdir(path)).join('\n'),
}

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, args } = JSON.parse(line)
  try {
    process.stdout.write(JSON.stringify({ id, ok: await handlers[method](args ?? {}) }) + '\n')
  } catch (error) {
    // 错误要跨过进程边界送回去，而不是让子进程自己崩掉——边界两侧都要遵守"失败是一条结果"。
    process.stdout.write(JSON.stringify({ id, error: error.message }) + '\n')
  }
}
