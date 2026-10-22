# orch —— 编排薄桥单元

> 线协议 2.4（Runner ⇄ Bridge 契约全文见 [PROTOCOL.md](../PROTOCOL.md)）；执行面归执行机侧 —— Runner 拉起**仓内 ACP 桥**驱动底层 CLI，桥自己只解析 / 入队 / 落库。

## 是什么

> orch = 编排入口 + 派发中枢

- **薄桥**：只做「项目 → 机器」解析、任务入队 / claim、结果落库与会话映射；真正的执行由执行机侧 Runner 拉起仓内 ACP 桥、驱动底层 CLI 完成。
- **pull 连接（Runner 反向注册）**：执行机 Runner 主动出站连桥 —— `/runner/register` 注册 / 刷新投影，`/runner/connect` 长轮询拉命令，`/runner/result` 回传结果。桥不再向 Launcher 拨号；命令族三类 = `dispatch`（派发任务）/ `stop`（停本机单个项目 Agent）/ `cancel-task`（取消在飞任务）。
- **回传与幂等**：任务派发与结果回传都走 `本地 A2A message/send`；任务终态先落盘 `outbox` 再回传，HTTP 2xx = ack ⇒ 删文件，桥按 `(machineId, taskId)` 幂等落库（首个终态胜出）。
- **接入面**：常驻 stateless Streamable HTTP（唯一形态，stdio 已退役）—— `POST /mcp`、`GET /health`、`POST /shutdown`；配组后端点亦可写成 `POST /<组名>/mcp`。
- **工具面**：泛型 7（`a2a_projects` / `a2a_call` / `a2a_task_status` / `a2a_tasks` / `a2a_cancel` / `a2a_events` / `a2a_wait`）+ Feature 6（`a2a_feature_create` / `a2a_feature_status` / `a2a_feature_advance` / `a2a_feature_approve` / `a2a_feature_cancel` / `a2a_feature_trace`）+ 配置面 1（`a2a_config_write_group`），静态注册、零重连。
- **单实例 / 单调度权**：靠 `core.lock` 租约 —— 仅持有者（`GET /health` 报 `role: owner`）运行 scheduler 与 task-watcher；同一 data dir 的第二个实例降级为 `follower`，照常提供 MCP 工具但不跑后台循环。

## 有什么用

> 宿主 agent 只连一个桥，就能跨机派活、跟需求、收结果。

- **跨机派发**：`a2a_call` 登记后入队，Runner 按项目领取；无 Runner 在线照常入队、不拒绝。
- **需求全流程**：Feature 走主链（创建 → 审批 → 版本规划 / 分解 → 执行 → 集成 / 回归 / 验收），任务作为 DAG 节点挂载，按依赖推进。
- **多编排 agent 隔离**：组身份 = URL 首段；配组后每个连接只见本组、只能向本组派发，未配组时全量接纳。
- **可续接、可追溯**：任务态与会话映射落本机 SQLite，按 `(machineId, taskId)` 幂等落库；`contextId` 可续接，`a2a_feature_trace` 可查「为什么还没完成」。
- **运行观测**：`a2a_events` / `a2a_wait` 读事件收件箱，`GET /health` 看角色与就绪。

## 怎么用

### 起（前台 / 后台）

前台起（调试用 · 日志直接进终端）：

```bash
npm install
# 首次：cp config/config.json.example config/config.json —— 这是**可运行起点**
#（config/config.json.default 只作**缺省值参照**，不是复制源）
npm run bridge            # = npm run build && node dist/bridge/index.js（Ctrl+C 优雅停机）
```

后台起（日常用 · 静默脱离终端）：

```bash
npm run bridge:start      # 后台启动常驻桥（已在运行则提示并退出 0）
npm run bridge:status     # 查看 pid / host:port / health / role / startedAt
npm run bridge:logs       # 日志全文（--lines N / --follow）
npm run bridge:stop       # 优先 POST /shutdown 优雅停机，超时强杀兜底
npm run bridge:restart    # stop + start
```

- pidfile：`data/bridge.pid`（**由桥自己写**，非锁，陈旧无害）；日志：`data/logs/bridge.log`。
- 桥恒常驻 http（stdio 已退役）。端口读配置 `transport.http`；`MACHINES_CONFIG` / `SESSION_DB` 可指定其他配置文件与会话库路径。
- `bridge:start` / `bridge:restart` 支持 `--no-wait`（发起即返，`exit 0` = 已发起 ≠ 已就绪，须另起 `bridge:status` 确认）；缺省 `start` 等到 `/health` 报 `status:"ok"` 才返，超时退 1。退出码恒 `{0,1}`：`0` = 已发起 / 已就绪 / 已在运行，`1` = 超时 / 被非本桥占用 / spawn 失败。

### 连接

- 先配置好项目组和成员关联信息
- MCP url 写 `http://<host>:8787/<组名>/mcp`；不带组名的裸 `/mcp` ⇒ **403 `group_identity_required`**（fail-closed，不回退全量接纳）
- 执行机侧 Runner 按 `launcher.bridge.url` 连桥，`launcher.bridge.token` 须与 orch 侧 `machines[].token` 一致；注册载荷 `protocolVersion` 主版本须符（2.0 硬切，当前 `[2]`），不符 ⇒ 403 `protocol_version_mismatch`

### 配置

- 配置只从文件读（`MACHINES_CONFIG` 所指，缺省 `config/config.json`）；顶层 `projectGroup` 段写成**组数组** `[{ name, members: [{ machineId, projectId }] }]`，**段缺省 = 全量接纳**。
- `runner.orphanTimeoutMs` 缺省 30 min，是一条**跨单元不变量**：须大于机器侧最坏总框（= 窗上限 + 结构余量 + `min(续跑余量, 窗)`），故 orch 不读 machine 配置。
- 逐键语义与两份模板的分工见 [`config/配置说明.md`](config/配置说明.md)。
