# orch 单元（MCP 薄桥）

> orch 侧的 MCP 薄桥：只做「项目 → 机器」解析与转发，把请求经 HTTP 线协议交给目标机器的 Launcher，再由 Launcher 拉起 A2A 包装器驱动底层 CLI；任务态与会话映射落本机 SQLite。启停一律经 `scripts/bridgectl.mjs`（纯 Node ESM，零第三方依赖、无需构建），入口 `dist/bridge/index.js`。

## 整体形态

- **接入面**：缺省 stdio（桥由 orch 宿主 agent 作为子进程拉起，须与宿主同机）；亦可常驻，以 **stateless Streamable HTTP** 暴露 MCP（路由 `POST /mcp`、`GET /health`、`POST /shutdown`），宿主经 MCP `type: "remote"` 连接。
- **工具面**：泛型工具 7（`a2a_projects` / `a2a_call` / `a2a_task_status` / `a2a_tasks` / `a2a_cancel` / `a2a_events` / `a2a_wait`）+ Feature 工具组 5（`a2a_feature_create` / `a2a_feature_status` / `a2a_feature_advance` / `a2a_feature_approve` / `a2a_feature_cancel`），静态注册、零重连。
- **单实例与单调度权**：靠 core 租约（`core.lock`）—— 只有租约持有者运行 scheduler 与 task-watcher；同一 data dir 的第二个实例降级为 `follower`，照常提供 MCP 工具但不跑后台循环。`GET /health` 报当前 `role`（`owner` / `follower`）。
- **只读工作台**：常驻形态下可另起只读 HTTP 服务（默认仅 `owner`、绑 loopback），只读自桥的 SQLite 与 Launcher `GET /projects`，不做第二编排入口。

## 服务启停

```bash
npm run bridge:start     # 后台启动常驻桥（已在运行则提示并退出 0）
npm run bridge:status    # 查看 pid / host:port / health / role / startedAt
npm run bridge:stop      # 停止（优先 POST /shutdown 优雅停机，超时兜底强杀）
npm run bridge:restart   # 停止后重新后台拉起
npm run bridge:logs      # 输出日志全文（支持 --lines N / --follow）
```

- `start` / `restart` 支持 `--no-wait`（语义见下）。缺省形态为 stdio 时桥无常驻端口，脚本只提示需先切换 `transport.mode=http`。
- 端口读配置 `transport.http`；`MACHINES_CONFIG` 可指定其他配置文件，`SESSION_DB` 可指定会话库路径。
- pidfile：`data/bridge.pid`（**由桥自己写**，JSON `{ pid, mode, role, startedAt }`，非锁，陈旧无害）；日志：`data/logs/bridge.log`。
- 前台入口 `npm run bridge` 仅作调试，不作为启停手段。

## 配置

| 环境变量 | 说明 | 缺省 |
|----------|------|------|
| `MACHINES_CONFIG` | 机器清单文件路径（`machines[]`，可选 `projectGroup` / `callback` / `web` / `transport`） | `config/config.json` |
| `SESSION_DB` | 会话 / 任务库 SQLite 路径；**其所在目录即桥的 data dir**（`bridge.pid` / `logs/` / `core.lock` 均落此，便于隔离实测） | `data/sessions.sqlite` |

> 实际配置 `config/config.json` 不入库，首次部署从 `config/config.json.default` 复制并填入本机真实值。

## 启停与就绪语义（统一口径锚点）

> 本段是启停 / 就绪语义的**持久锚点**：与 machine 侧同口径、各单元独立实现、不共享代码。运维、编排与根 README 的启停说明均以本段为准。

- **`--no-wait`：发起即返**（不等待任何就绪判据）；`exit 0` = **已发起（≠ 已就绪）**，仅 spawn 同步失败才 `exit 1`。
- **缺省 `start` 的等待目标 = 服务可答**；桥侧即 `GET /health` 返回 **HTTP 200 且 `status:"ok"`**（≤ `READY_TIMEOUT_MS` 30s；启动自检 `recover()` 为本地同步，30s 为宽裕上界）。超时 ⇒ `exit 1`。
- **`--no-wait` 后须另起 `npm run bridge:status` 确认就绪**；`--no-wait` 输出的 **pid 仅供参考**（并发竞态下可能指向被接管的败者子进程）。
- **调用拼写**：`npm run bridge:start -- --no-wait`（npm 会吞掉 script 名后的**裸** `--no-*`，必须用 `--` 分隔）。`restart` 同理：`npm run bridge:restart -- --no-wait`。
- **`restart --no-wait` 仅作用 start 段**；stop 段仍阻塞（`POST /shutdown` ≤5s + 等待端口释放 ≤15s×2，极端 ≤35s），整体重启**非瞬时返回**。
- **占用判定以 `/health` 的 `status` 为键**（不依赖 HTTP 状态码）：
  - 端口在监听但 `/health` 不可答 / 不可解析，或 `status` 缺失 / 非白名单（`ok` / `starting`）⇒ **端口被非本桥进程占用** ⇒ `exit 1`；
  - `status === "ok"` ⇒ **已在运行且已就绪** ⇒ `exit 0`；
  - `status === "starting"` ⇒ **本服务启动中（已在运行但未就绪）** —— 缺省 / `--no-wait` 均即返 `0`。
- **退出码恒 `{0,1}`**：`0` = 已发起 / 已就绪 / 已在运行；`1` = 超时 / 被非本桥占用 / spawn 失败。
- **桥不提供 `--wait-ready`**：orch 缺省 `start` 的等待目标已等价于「业务就绪」（`status:"ok"`），故无需该开关；这是与 machine 侧分层判据（缺省 L1 + opt-in L2）的**有意差异**。
