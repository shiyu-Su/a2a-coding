# scripts —— 宿主侧脚本（非部署单元）

> 这些脚本是**宿主Agent**使用的本地工具，**不是部署单元**：不参与任何单元的 `npm install` / 构建，也不在 orch / machine / board 的运行链路里。

## 功能

日常使用面是三个**只读**看护脚本 —— 只访问编排侧的只读查询面，不读 SQLite、不写状态、不写文件、不触发调度：

| 脚本 | 干什么 | 输出 | 退出码 |
|---|---|---|---|
| `watch-feature.mjs` | 监视一个 Feature 到「需宿主动作」时点（完成侧 / 失败静止 / 待澄清 / 已取消 / DAG 非法），或观察窗口耗尽 | 计数变化时打一行快照 + 退出前判定行 | `0` 完成侧 · `10` 静止且有失败 · `11` 待澄清 · `12` 已取消 · `13` DAG 非法 · `20` 窗口耗尽 · `1` 错误 |
| `watch-feature-loud.mjs` | 同上，但**失败即叫**：一旦检出 `failed` 任务立刻打印清单并退出，不等「静止」 | 快照行 + 失败清单块 + 判定行 | `30` 检出失败（早退）· 其余同上（`0` / `10` / `11` / `12` / `13` / `20` / `1`） |
| `watch-task.mjs` | 等一个或多个常规 `a2a_call` 任务的终态；只打印状态 | 退出时每 id 一行（单 id = `state`；多 id = `<taskId> <state>`） | `0` 已达成（**≠ 成功**，failed / blocked 也退 0）· `20` 窗口耗尽 · `1` 脚本错误 |

三点口径：

- `watch-feature.mjs` 的「静止」= 有 `failed` / `blocked` **且没有任何活跃任务**。因此超时型失败（其它节点还在飞）它等不到静止、只能退 `20` —— 这正是 `watch-feature-loud.mjs` 的由来：早一个窗口重派，就省一次完整的观察窗口。
- `watch-task.mjs` 的多 id 语义是**等全部**（没有「等任意一个」，要那个语义就单 id 分开跑）；未知 taskId 记一行 `not_found` 后继续等其余 id，最终退 `1`。它刻意不按任务状态细分退出码，状态由 stdout 行承载；结果文本 / 失败原因 / artifacts 一律不打印，详情另用 MCP 工具 `a2a_task_status` 取一次即可。
- 三个脚本都用「置 `process.exitCode` 后自然退出」，不调 `process.exit()` —— 避免句柄关闭期把已写输出截断。


## 部署方案

不需要部署，随仓使用：

```bash
node scripts/watch-feature.mjs <featureId>
node scripts/watch-feature-loud.mjs <featureId>      # 后台看护：检出失败即非零退出
node scripts/watch-task.mjs <taskId> [<taskId>...]
```

- **运行时** = Node.js（ESM + 内置 `fetch`），与仓根 `engines` 一致（Node ≥ 22.5）。
- **前置** = 编排桥已就绪：脚本读的是编排侧的只读工作台 / 数据面（默认 `127.0.0.1:3300`），桥没起或端口不通就按「错误」退 `1`，不静默等待。
- **典型用法** = 把 `watch-feature-loud.mjs` 挂后台看护，非零退出即告警；`watch-task.mjs` 用于等一批常规派发任务到终态。

## 配置说明

没有配置文件，**命令行参数即全部配置**：

| 参数 | 含义 | 默认 |
|---|---|---|
| `<featureId>` / `<taskId...>` | 必填：监视目标 | — |
| `--base <url>` | 只读工作台地址 | `http://127.0.0.1:3300` |
| `--interval <ms>` | 轮询间隔，下限 `2000` | `10000` |
| `--max <loops>` | 最多观察轮数，下限 `1`；观察窗口 = `--interval` × `--max` | `180` |
| `--help` / `-h` | 打印用法并退出 `0`（`watch-task.mjs`） | — |

`--base` 的取值优先级：`--base` > 环境变量 `WATCH_BASE_URL` > 默认值。唯一用到的环境变量就是 `WATCH_BASE_URL`。
