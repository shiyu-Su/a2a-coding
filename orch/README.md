# orch 单元（MCP 薄桥）

> orch 侧的 MCP 薄桥：连接模型已反转为 **pull**（线协议 2.0）—— 执行机 Launcher 升格为 **Runner**，主动出站连桥（`/runner/register` → `/runner/connect` 长轮询拉命令 → `/runner/result` 回传结果）；桥只做「项目 → 机器」解析、任务入队 / claim 与结果落库，任务态与会话映射落本机 SQLite，再由执行机侧拉起 A2A 包装器驱动底层 CLI。启停一律经 `scripts/bridgectl.mjs`（纯 Node ESM、零第三方依赖、无需构建），入口 `dist/bridge/index.js`。

## 整体形态

- **接入面**：缺省 stdio（桥由 orch 宿主 agent 作为子进程拉起，须与宿主同机）；亦可常驻，以 **stateless Streamable HTTP** 暴露 MCP（路由 `POST /mcp`、`GET /health`、`POST /shutdown`），宿主经 MCP `type: "remote"` 连接。
- **工具面**：泛型工具 7（`a2a_projects` / `a2a_call` / `a2a_task_status` / `a2a_tasks` / `a2a_cancel` / `a2a_events` / `a2a_wait`）+ Feature 工具组 5（`a2a_feature_create` / `a2a_feature_status` / `a2a_feature_advance` / `a2a_feature_approve` / `a2a_feature_cancel`），静态注册、零重连。
- **单实例与单调度权**：靠 core 租约（`core.lock`）—— 只有租约持有者运行 scheduler 与 task-watcher；同一 data dir 的第二个实例降级为 `follower`，照常提供 MCP 工具但不跑后台循环。`GET /health` 报当前 `role`（`owner` / `follower`）。
- **只读工作台**：常驻形态下可另起只读 HTTP 服务（默认仅 `owner`、绑 loopback），只读自桥的 SQLite（含 Runner 注册投影 `runners` / `runner_projects`），不做第二编排入口。

## Runner 反向注册（pull）

执行机在目标部署形态下**无入口**（无公网 / NAT 后），桥不再向 Launcher 拨号；改由 Runner **主动出站**连桥。

```
Runner（machine，出站）                        Bridge（orch，http transport）
  │  POST /runner/register  ─────────────────▶  Bearer 鉴权 → machineId ∈ machines[]
  │    （machineId / projects / capabilities / selfCheck / protocolVersion）→ 注册投影
  │  POST /runner/connect   ─────────────────▶  长轮询（hold 缺省 25s）：空 = 204 心跳
  │  ◀─────────────────  命令族三类：dispatch / stop / cancel-task（有则立即返回）
  │    本地 ensure（幂等复用）→ 本地 A2A message/send → 轮询至终态 → outbox 落盘
  │  POST /runner/result    ─────────────────▶  claimToken 校验 → 按 (machineId, taskId) 幂等落库 → ack
```

- **端点**：`/runner/register`（注册 / 刷新投影）、`/runner/connect`（长轮询；新任务 / 事件 `wake` 立即唤醒；空超时 204 心跳）、`/runner/result`（结果回传 + ack）。挂载于常驻 HTTP transport（复用 MCP 端口，不引第二接入面）；stdio 形态**不注册**路由（404）。
- **门闩**：仅 core 租约 `owner` 提供端点；follower 一律 503 `runner_not_owner`（不抢调度权，也不给 Runner 下发命令）。
- **鉴权**：per-machine 静态 Bearer token（machine 侧 `launcher.bridge.token` ↔ orch 侧 `machines[].token`）；该机未配置 token 一律拒绝（绝不 fail-open）。
- **版本准入**：注册载荷必携 `protocolVersion`，主版本须 ∈ `SUPPORTED_PEER_PROTOCOL_MAJORS`（2.0 硬切，当前 `[2]`）；不符 ⇒ 403 `protocol_version_mismatch`（含升级指引）。
- **命令族三类**：`dispatch`（派发任务）/ `stop`（停本机**单个项目** Agent）/ `cancel-task`（取消在飞任务）；三类载荷一律携 `commandId`（桥侧 uuid，回执原样带回），`stop` / `cancel-task` 另携 `projectId`；控制命令优先于 claim 下发。
- **结果回传**：Runner 先落盘 outbox 再回传，**2xx = ack ⇒ 删文件**；桥按 `(machineId, taskId)` 幂等落库（首个终态胜出）；`stop` / `cancel-task` 的回执随下一轮 `connect` 的 `acks[]` 带回（观测通道）。
- **调度语义**：`a2a_call(mode="execute")` 登记 Feature DAG 节点后**入队**（不直接拨机器），由 Runner 领取；`mode="inquiry"` 同样经队列、`wake` 后尽快下发；无 Runner 在线照常入队、不拒绝（成员 / 配置错仍同步零 I/O fail-fast）。
- 契约全文见 [PROTOCOL.md](../PROTOCOL.md)（Runner ⇄ Bridge 线协议契约 2.0）。

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

- 机器清单 `machines[]`：每项 `machineId` + 可选 `launcherUrl`（出站指挥通道已退役，仅作观测 / 兼容占位）+ `token`（Runner 出站 Bearer，须与 machine 侧 `launcher.bridge.token` 一致）；顶层可选 `runner { holdMs, heartbeatTimeoutMs }`（缺省 `25000` / `60000`）。

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
