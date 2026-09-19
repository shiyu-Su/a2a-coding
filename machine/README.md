# machine 单元（Launcher）

> 每台执行机器常驻一个 Launcher，v0.7.0 起升格为 **Runner**：以**反向注册（出站）**连到 orch 桥（注册 → 长轮询拉命令 → 本地 `ensure` + 本地 A2A 执行 → 结果回传），管理本机项目 Agent 的生命周期；**不做服务发现**。启停一律经 `scripts/launcherctl.mjs`（纯 Node ESM，零第三方依赖、无需构建），入口 `dist/launcher/index.js`。

## HTTP 接口（v2.0 起）

Launcher 的**入站指挥端点已于 v2.0 退役**（连接模型反转为 pull，见下节）；保留的本机面只有 `/health` 与可选 `/shutdown`：

| 方法 | 路径 | 状态 | 说明 |
|------|------|------|------|
| GET | `/health` | 保留 | **本机内部接口，非跨机契约面**（loopback；绑定由 `launcher.listenHost` 决定，v0.7.0 缺省 `127.0.0.1`）。响应 `{ ok, protocolVersion, status, bridge }`；`status ∈ {ok, starting}`（自检通过前为 `starting`）；`bridge` = Runner 注册态快照 `{ registered, lastHeartbeatAt, lastError }`（未启用 `launcher.bridge` 时恒为 `{ registered:false, lastHeartbeatAt:null, lastError:null }`）。就绪判定键 = `status`（`launcherctl` / `reaper` 同口径）。 |
| POST | `/shutdown` | 保留（可选） | 仅 `launcher.shutdownEndpoint=true` 时注册；**仅接受 loopback 来源**；可选 Bearer（`launcher.shutdownToken`）。反代转发后源地址亦为 loopback ⇒ 反代必须 deny `/shutdown`。 |
| GET | `/projects` | **已退役（v2.0）** | 命中 404。项目清单改由 Runner 注册载荷上报（桥侧注册视图承载）。 |
| POST | `/projects/{id}/ensure` | **已退役（v2.0）** | 命中 404。启动改由 Runner 命令族 `dispatch` 触发（本地 `ensure`，幂等复用）。 |
| POST | `/projects/{id}/stop` | **已退役（v2.0）** | 命中 404。停止改由 Runner 命令族 `stop` 驱动。 |

> 退役原因：目标部署形态下执行机**无入口**（无公网 / NAT 后），入站 HTTP 不可达；v0.7.0 把连接模型整体反转为 Runner **主动出站**（决策 D1/D6）。

## Runner 反向注册（v0.7.0，出站）

**启用条件**：`launcher.bridge { url, token }` **整段省略 = 不启动 Runner 出站**（零出站，同现状）；**一旦写出该段，`url` 与 `token` 必须同时为非空字符串 —— 缺一即启动 fail-fast**（配置解析期抛错、进程退出）。

**出站循环**（启动自检通过后才进入，注册载荷因此携带真实自检结论）：

1. `POST {bridge.url}/runner/register` —— 携 `machineId` / `projects[]`（`projectId` / `agentKind` / `risk` / `a2aPort`）/ `capabilities` / `selfCheck` / `protocolVersion`；
2. `POST {bridge.url}/runner/connect` —— **长轮询**（桥端 hold ~25s）：空响应 = 心跳；非空 = 命令。命令族三类：
   - `dispatch` → 本地 `ensure`（幂等复用）→ 本地 A2A `message/send` → 轮询至终态 → 组装结果；
   - `stop` → 本机**有在飞任务即拒收**（回执 `error:"in-flight"`），否则停项目 → 回执；
   - `cancel-task` → 台账定位项目 → 本地 A2A `tasks/cancel`（台账无此 taskId ⇒ 回执 `error:"unknown-task"`；句柄尚未取得 ⇒ `error:"not-started"`）；
3. **结果回传**：任务终态**先落盘** `.a2a/outbox/<taskId>.json`（durable）→ `POST {bridge.url}/runner/result`（Bearer + `claimToken`）→ **HTTP 2xx = ack ⇒ 删文件**；否则保留并退避重试（1s → 2s → … cap 30s，±20% jitter）。`stop` / `cancel-task` 的回执随下一轮长轮询带回；`dispatch` 的结果不走回执。

**鉴权**：per-machine 静态 Bearer token（machine 侧 `launcher.bridge.token` ↔ orch 侧 `machines[].token`）；401/403 结构化进退避，**绝不崩进程**。

**运行态落盘**：`.a2a/runner-state.json`（原子写；`scripts/reaper.mjs` 判活 Runner 的事实源）。新鲜度窗口 `N = max(2 × 30s, 90s) = 90s`（时钟回拨视为新鲜）；子进程账本 `.a2a/children/<pid>.json` 不变。

## 服务启停

```bash
npm run start     # 后台启动（已在运行则提示并退出 0）
npm run status    # 查看 pid / host:port / health / startedAt
npm run stop      # 停止（POSIX 发 SIGTERM 优雅退出；Windows taskkill /T /F 强制树杀）
npm run restart   # 停止后重新后台拉起
npm run logs      # 输出日志全文（支持 --lines N / --follow）
```

- 端口读配置 `launcher.port`；`MACHINE_CONFIG` 可指定其他配置文件。
- pidfile：`.a2a/launcher.pid`（由 Launcher 写，JSON `{ pid, port, host, startedAt }`，非锁，陈旧无害）；日志：`.a2a/logs/launcher.log`。
- 前台入口 `npm run launcher` 仅作调试，不作为启停手段。

## 启停与就绪语义（统一口径锚点）

> 本段是启停 / 就绪语义的**持久锚点**：与 orch 侧同口径、各单元独立实现、不共享代码。运维、编排与根 README 的启停说明均以本段为准。

- **`--no-wait`：发起即返**（不等待任何就绪判据）；`exit 0` = **已发起（≠ 已就绪）**，仅 spawn 同步失败才 `exit 1`。
- **缺省 `start` 的等待目标 = L1（`/health` 可答 = HTTP 200）**，**不含启动自检**；因此**缺省 `exit 0` ≠ 业务就绪** —— 自检未过时 `/health` 报 `status:"starting"`；自检失败则 fail-fast 退出。入站业务路由已于 v2.0 退役，就绪态现仅由 `/health` 的 `status` 表达（不再有 503 业务路由）。
- 需要业务就绪时用 **`--wait-ready`**：等待 `/health` 的 `status === "ok"` 才 `exit 0`；超时 / 自检失败 ⇒ `exit 1`。
  - 缺省整段硬上限 = `max(60s, N × startupCheckTimeoutMs + 60s)`（`N` = 本机 `projects` 数，`startupCheckTimeoutMs` 缺省 120s；该上界未计入启动对账清理耗时）；`--ready-timeout <ms>` 可覆盖。
  - `--wait-ready` 与 `--no-wait` **互斥**（同传 ⇒ 显式报错）；`--ready-timeout` 仅在 `--wait-ready` 下有效。
  - 失败诊断按 `自检失败` / `[self-check]` **过滤行**输出（非 tail N）。
- **`--no-wait` 后须另起 `npm run status` 确认**运行态；`--no-wait` 输出的 **pid 仅供参考**（并发竞态下可能指向被接管的败者子进程）。
- **调用拼写**：`npm run start -- --no-wait`（npm 会吞掉 script 名后的**裸** `--no-*`，必须用 `--` 分隔）。
- **`restart --no-wait` 仅作用 start 段**；stop 段仍阻塞（`POST /shutdown` ≤5s + 等待端口释放 ≤15s，machine 实测 ≈ ≤20s），整体重启**非瞬时返回**。
- **占用判定以 `/health` 的 `status` 为键**（不依赖 HTTP 状态码）：
  - 端口在监听但 `/health` 不可答，或 `status` 缺失 / 非白名单（`ok` / `starting`）⇒ **端口被非本 Launcher 占用** ⇒ `exit 1`；
  - `status === "ok"` ⇒ **已在运行且已就绪** ⇒ `exit 0`；
  - `status === "starting"` ⇒ **本服务启动中（已在运行但未就绪）** —— 缺省 / `--no-wait` 即返 `0`，`--wait-ready` 续等至 `ok`。
- **退出码恒 `{0,1}`**：`0` = 已发起 / 已就绪 / 已在运行；`1` = 超时 / 被非本服务占用 / spawn 失败。

## 空闲回收（idleStopMs，v0.7.0 新口径）

项目 Agent 的本地回收判据 = **本机无在飞任务（`inflight == 0`）且静默 ≥ `idleStopMs`**：

- 静默基准由 **`ensure`**（含 Runner 命令族 `dispatch` 触发的本地 `ensure`）复位；
- `launcher.idleStopMs` 缺省 `300000`（5 分钟）；`0` 或负值 = **禁用**空闲回收（启动日志显示 `[launcher] idleStopMs=disabled`）；
- **桥心跳失败只降 Runner 注册态**（`/health` 的 `bridge.registered` / `bridge.lastError`），**绝不触发 stop**（决策 D8，根治「桥停 5 分钟误杀在飞任务」缺陷）。

## Agent 类型与 ACP 桥（v0.8.0）

本机 `projects[].agentKind` 取值集合 = `opencode` / `codex` / `claude` / `qoder`（单一事实源 `agent-kinds.ts`）。

- **wrapper 族**（opencode / codex / claude）：`buildLaunch` 拉起仓外 npm 包装器 `a2a-<kind>`（见 `adapters/`）。
- **ACP 族**（qoder，CN 版 `qodercn`）：**无仓外包装器**，由**仓内自持 ACP 桥** `machine/acp-bridge/`（构建产物 `dist/acp-bridge/index.js`）承担 A2A 服务面：
  - 桥由 Launcher 每项目 spawn，**绑定该项目的 `a2aPort`**（就绪判定 = TCP listen，与既有 endpoint 推导一致）；
  - 对外暴露 **`POST /a2a/jsonrpc`**（`message/send` / `tasks/get` / `tasks/cancel`），形状逐字兼容 `launcher/a2a-client.ts`；
  - 内部以 **stdio NDJSON** 拉起 ACP 后端 `qodercn --acp`（`initialize` 握手 / `session/*`；详见 `acp-bridge/acp/`）。
  - `buildLaunch` 形态：`node <appRoot>/dist/acp-bridge/index.js --port <a2aPort> --workspace <ws> --project-id <id> --backend-cmd <qodercn> --risk <read|write|full>`。
- **认证**：优先文件凭据 `~/.qoder-cn/.auth`（`qodercn` CLI 登录）；备选 env `QODERCN_PERSONAL_ACCESS_TOKEN`（经 Launcher 进程环境透传）。
- qoder 项目示例见 `config/config.json.default`。
