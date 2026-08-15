# learn-harness

《从三十行到 Harness》的动手目录。每一课一个独立可跑的文件，后一课在前一课上加一件事，故意不做成一个库——你要能一眼看完整个文件。

十二课按「疼痛驱动」推进：每一课先摆出一个具体做不到的场景，再补上解决它的那一件事——所以每个抽象在被命名之前，你已经先欠过它的债。下面的文件表就是这条债务链。

## 准备

需要 Node 22+ 和一个 DeepSeek API key：

```sh
export DEEPSEEK_API_KEY=sk-...
```

## 文件

| 文件 | 这一课加了什么 | 试试 |
|---|---|---|
| `l1-agent.mjs` | 循环、工具、状态：一个 agent 的最小形态 | `node l1-agent.mjs "读一下 README.md 讲了什么"` |
| `l2-pipeline.mjs` | 工具注册表、守卫、超时、失败变结果、并行执行 | `node l2-pipeline.mjs "睡 8 秒然后告诉我睡够了"` |
| `l3-inbox.mjs` | 收件箱、turn/step 两层循环、Ctrl-C 中断 turn | `node l3-inbox.mjs "统计这个目录里有几个 mjs 文件"` 然后随时打字插话 |
| `l4-log.mjs` | 追加式事件日志、投影出模型历史、续跑与分叉 | 见下 |
| `l5-permission.mjs` | 判定 / 审批 / 围栏三道防线，沙箱拒绝与升级重试 | `node l5-permission.mjs "用 bash 把 hello 写进 /tmp/l5.txt"` |
| `l6-context.mjs` | token 计量（实测 usage + 缓存命中）、结果溢出到文件、压缩成摘要事件 | `node l6-context.mjs "分析这个目录并写份说明"`，然后 `--stats <id>` |
| `l7-seams.mjs` + `l7-world.mjs` | 两条接缝：llm（deepseek/replay）与 world（local/subprocess） | `node l7-seams.mjs --world subprocess "读一下 README.md"` |
| `l8-plugins.mjs` | 60 行微内核（注册/派发/生命周期），L2–L7 的功能全部变成插件 | `node l8-plugins.mjs --without permission "读一下 .env"` |
| `l9-testing.mjs` | 9 个测试覆盖前八课踩过的坑：纯函数 / 插件行为 / 生命周期 / 回放 / 快照 | `node --test l9-testing.mjs`（51 毫秒） |
| `l10-harness.mjs` | **成品**：十个插件拼起来，new / resume / fork / replay / show 五个入口 | `node l10-harness.mjs "读一下 fixtures 目录并总结"` |
| `l11-shapes.mjs` | 形态：同一套插件换最外一层 → CLI / HTTP 服务；`--isolate` 修会话串台 | `node l11-shapes.mjs --shape serve --isolate` |

`l10-harness.mjs` 现在**能写文件**了：`writePolicy`（判定）+ `approval`（审批，ask/never/always）+ `fsWrite`（工具与沙箱模式栅栏）三个插件，循环一行没改。写入默认走 `read-only` → 问人 → 只放宽这一次；`--yes` 一律批准，`--policy never` 一律拒绝，没有 TTY 也失败关死。

**`fixtures/` 禁止写入**（`writePolicy` 里的一条规则）：那是快照测试的夹具，往里写东西会让 `l9-testing.mjs` 立刻红——这条规则就是被快照抓出来之后补的。演示产物写到 `out/`。

## L4 的四条命令

```sh
node l4-log.mjs "读一下 README.md 并总结"      # 新建会话，打印一个 id
node l4-log.mjs --show <id>                    # 回看这次跑了什么
node l4-log.mjs --resume <id> "还有哪些文件"   # 从日志接着跑
node l4-log.mjs --fork <id>@6 "换个方向"       # 从第 6 个事件分叉出一条新线
```

日志在 `runs/<id>.jsonl`，一行一个事件，只追加不改写。想确认「模型历史是算出来的」，把某个 `tool/result` 行删掉再 `--resume`，模型会重新去读那个文件——它是真的不记得了。

## 每课的练习

- **L2**（已做）：造一个假 `.env` 让它念出来，再加一条守卫拒绝读凭据文件，看模型收到的是结果不是异常；然后 `TOOL_TIMEOUT_MS=1000` 重跑一个 `sleep(2)` 的任务，看合法的慢被误伤。
- **L3**：跑一个要好几步的任务，中途打字插一句「先别管那个，先看 README」，观察它在哪一刻被接住；再按 Ctrl-C，看进程是不是还活着。
- **L4**（已做）：让它读两个文件，`cp` 一份日志出来删掉其中一个 `tool/result`，`--resume` 那份问被删掉的内容；对照组直接答，动过手的重新去读。也可以从中间 `--fork` 出两条方向，比较两个 jsonl 的公共前缀。
- **课后（已做）**：给 `l10-harness.mjs` 加 `write_file`，五种情况都验过——新建要升级、覆盖要审批、`.env` 直接拒、越界直接拒、无人值守一律拒。
- **L12**：把你想做的东西按那张四层判定图走一遍，诚实地在每一层停一下；再用六个问题审一遍你每天在用的 agent 产品。
- **L11**：给自己的场景答四个问题（谁触发 / 文件在哪 / 凭据属于谁 / 会话活多久）；再加第三种壳：stdin/stdout JSON 行（MCP、ACP、LSP 共同的形状）。
- **L10**：给它加一个 `write_file` 工具（L5 会当场全部登场）；用六个问题去审一个真实 agent 项目；把最早和最晚的日志 `--show` 出来对比。
- **L9**：给 `llmReplay` 加请求指纹；把 L2 的超时 bug 写成回归测试；故意改一个行为，决定该改代码还是改快照。
- **L8**：加一个 `audit` 插件而不改任何已有文件；把 `permission` 和 `spill` 在清单里对调看结果；再写个 `loopOnce` 把主循环换掉。
- **L7**：写第三个 world（`readonly` / `docker` / `ssh`），只许改装配那两行；再给 `llmReplay` 加请求指纹校验。
- **L6**：把压缩抖动修掉（压到阈值 60% 或加冷却期）；再跑两次同一任务，一次往 `SYSTEM_PROMPT` 里拼 `Date.now()`，对比 `--stats` 的缓存命中率。
- **L5**：把 `SEALED`（沙箱里封死 `.env` 的那行）删掉重跑"读一下 .env"，看模型多久找到绕路；再想清楚"以后都允许"该存在哪、谁能撤销、fork 出去跟不跟着走。

## 练习跑出来的两处修改

- `l2-pipeline.mjs`：加了拒绝读凭据文件的守卫；`TOOL_TIMEOUT_MS` 改成读环境变量——超时是随部署变的选择，不该焊死。
- `l4-log.mjs`：`deriveMessages()` 现在会给没有结果的 `tool_call_id` 补一条占位 tool 消息。不补的话，任何在工具执行途中断掉的会话都 `--resume` 不回来（API 要求每个 `tool_call_id` 都有回应，少一条整份历史被拒）。修补在投影里，日志仍然只追加。

`l5-permission.mjs` 用 macOS 的 `sandbox-exec`(seatbelt)；Linux 上把 `runConfined` 换成 `bwrap`/landlock，其余不动。`--policy never` 一律拒绝，`--yes` 一律批准（非交互演示用）。

`fixtures/` 是快照测试的夹具目录，**内容不许随便改**（改了快照就红）；`snapshots/replay.txt` 是录好的 transcript，要提交进版本库。

L8 的开关：`--without <插件名>` 少装一个、`--trace` 打印每一次派发、`--prove-dispose` 证明卸载真的把注册撤干净了。

L7 的三种组合：默认 `local`+`deepseek`；`--world subprocess` 换到另一个进程（pid 会变）；`--llm replay --from runs/<id>.jsonl` 零成本回放（工具仍然真跑，只有模型那侧被顶替）。

L6 的三个阈值都走环境变量：`COMPACT_AT=6000 node l6-context.mjs "…"` 可以逼它压缩给你看；`SPILL_CHARS`、`MAX_STEPS`、`KEEP_RECENT_STEPS` 同理。

`.env` 是练习用的假文件（假密钥），已被 `.gitignore` 忽略；真的 key 走 `export`。`runs/cut.jsonl` 是那次手术的现场，可以留着对照。
