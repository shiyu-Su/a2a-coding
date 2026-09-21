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

## Agent 类型与 ACP 桥（四条 kind 同构）

本机 `projects[].agentKind` 取值集合 = `opencode` / `codex` / `claude` / `qoder`（单一事实源 `agent-kinds.ts`）。

v0.8.5 起四条 kind **同构**：适配器 `protocol` 恒为 `"acp"`，`buildLaunch` 一律拉起**仓内自持 ACP 桥** `machine/acp-bridge/`（构建产物 `dist/acp-bridge/index.js`），桥再以 **stdio NDJSON** 拉起**外部安装的 ACP 后端**（各家 CLI 的 ACP 入口）：

- 桥由 Launcher 每项目 spawn，**绑定该项目的 `a2aPort`**（就绪判定 = TCP listen，与既有 endpoint 推导一致）；
- 对外暴露 **`POST /a2a/jsonrpc`**（`message/send` / `tasks/get` / `tasks/cancel`），形状逐字兼容 `launcher/a2a-client.ts`；
- `buildLaunch` 形态（`--backend-args` / `--model` / `--mode` / `--session-meta-json` 等按 kind 与 risk 选配）：

  ```
  node <appRoot>/dist/acp-bridge/index.js
    --port <a2aPort> --workspace <ws> --project-id <id>
    --backend-cmd <后端命令> [--backend-args <JSON 数组>]
    [--model <value>] [--system-prompt <文本> [--system-prompt-mode <append|replace>]]
    --risk <read|write|full> [--mode <modeId>] [--collaboration-mode <value>]
    [--session-meta-json <JSON 对象>]
  ```

### 后端命令：外部安装 + `backendCmd` 必填

machine **不内联任何后端**（`package.json` 零新增依赖）：ACP 后端由**适配器包各自外部安装**，命令**必须**由项目配置的**顶层平铺键** `agentConfig.backendCmd` 给出 —— 代码零硬编码缺省，未配置（缺键 / 非字符串 / 空串）⇒ `buildLaunch` 抛错。

| kind | ACP 后端（外部安装） | `--backend-args` | `backendCmd` 形态 |
|---|---|---|---|
| `opencode` | `opencode` CLI（自带 ACP 入口） | `["acp"]`（**子命令**，适配器内置；非 `--acp` 旗标） | `…\node_modules\opencode-ai\bin\opencode.exe`（**`.exe` 绝对路径**，实测可用） |
| `qoder` | `qodercn` CLI（CN 版） | 缺省 `["--acp"]`（走桥缺省） | `qoderclicn.exe` 的 `.exe` 绝对路径（或可补全为 `.exe` 的裸名） |
| `codex` | `@agentclientprotocol/codex-acp` | 可执行体 `[]` / 脚本入口 `[<入口路径>]` | `…\@agentclientprotocol\codex-acp\dist\index.js`（**脚本入口**，推荐） |
| `claude` | `@agentclientprotocol/claude-agent-acp` | 可执行体 `[]` / 脚本入口 `[<入口路径>]` | `…\@agentclientprotocol\claude-agent-acp\dist\index.js`（**脚本入口**，推荐） |

**`backendCmd` 的语义与归一（v0.8.5，真机实测）**：`backendCmd` 填的是**适配器入口**，由适配器归一为桥可直调的形态：

- **入口是脚本**（`.js` / `.mjs` / `.cjs`）⇒ 适配器组 `--backend-cmd <node 绝对路径（`process.execPath`）>` + `--backend-args [<脚本绝对路径>]`；
- **入口是可执行体**（`.exe` 等）⇒ **直调**：`--backend-cmd <原样>` + `--backend-args []`。

**为什么必须归一**：桥的 `--backend-cmd` 是**单 token** 参数、原样交给 `shell:false` 的 `spawn(command, args)` ⇒ **不能承载「命令 + 参数」的命令串** —— `node <script>` 这类含空格的取值在 win32 必 `ENOENT`（本机经**桥的真实 spawn 路径**实测）。另：**`.cmd` / `.bat` / `.ps1` 结尾 ⇒ 桥显式报错拒收**（`EINVAL` / `EFTYPE`，不退回 `shell:true`）；裸 `.js` 路径直调 ⇒ `EFTYPE`。`process.execPath` 虽可能含空格（如 `C:\Program Files\nodejs\node.exe`），但它是**单个 argv 元素**、桥按整条路径 spawn ⇒ 无引号雷。

**Windows 形态（真机证据）**：codex / claude 适配器本体是 **JS 入口**（包 `bin` → `dist/index.js`），故按上面的**脚本归一**落地。实测（本机 win32，跑真实 `dist/acp-bridge/index.js`）：以 `--backend-cmd <node.exe 绝对路径>` + `--backend-args ["<适配器入口>.js"]` 起桥 ⇒ 后端成功 spawn、`initialize` 往返成功、桥 ready（`[acp-bridge] … listening`）；同一入口若按旧写法塞进单 token（`node <入口>`）则 `spawn … ENOENT`。**§4.2-10 的判据即此路径。**

> 改后端版本 = 默认跑**适配器自带的 `@openai/codex`**（版本由适配器依赖锁定）；如需钉版本或用本机已装的 codex，可经 env `CODEX_PATH` 指向外部 codex（`PATH` 上的裸 `codex` **无**此效果：主路径只读该 env、无 `?? "codex"` 兜底）。claude 侧对应 env 是 `CLAUDE_CODE_EXECUTABLE`（适配器经它把 SDK 的 `pathToClaudeCodeExecutable` 转出；且 claude 的平台二进制在 SDK 的 `optionalDependencies` ⇒ `--omit=optional` 可省 ≈222.8 MiB）。
>
> 依据（源码行号 + 上游 README）：`codex-acp` 的 `dist/index.js:35150` 在 `startAcpServer()` 内直接读 `process.env["CODEX_PATH"]` → `:35167` 传入 `startCodexConnection` → `:22101` 存在 `if (codexPath)` 分支（以 `<codexPath> app-server` 拉起）；上游 README 原文 *"`CODEX_PATH` — run a specific Codex executable instead of the bundled package dependency."*

### 权限：risk 三档 → 会话模式（映射唯一落点 = 适配器）

risk 恒经 `permission(risk)` **单一出口**下发（桥对 kind 无知、只收原样值）：

**`risk` 是可选键；项目不写该键 ⇒ 缺省 `write`**（三处同口径：`launcher/manager.ts:411` 与 `launcher/runner.ts:265` 均为 `project.risk ?? "write"`；`acp-bridge/index.ts:122` 桥侧 `--risk` 解析亦缺省 `"write"`）。配置侧（`config.ts:80-84`）：**不写即缺省；一旦写了必须是 `read` / `write` / `full` 三值之一**（否则解析期报错）。

| kind | `read` | `write` | `full` |
|---|---|---|---|
| `opencode` / `qoder` | `--risk read` | `--risk write` | `--risk full` |
| `codex` | `--mode read-only` **+ `--collaboration-mode plan`** | `--mode agent` | `--mode agent-full-access` |
| `claude` | `--mode plan` | `--mode acceptEdits` | `--mode bypassPermissions` **+ `--session-meta-json`** |

- `--mode` 经桥 `applyMode()`：优先 `session/set_mode`，**仅 `-32601`** 才回落 `set_config_option{configId:"mode"}`，其余错误 fail-fast；`session/new` / `load` / `resume` **三路同发**（恢复路径不假设后端保持该模式）。
- **codex `read` 档 = 可读不可写**（决定性组合探针实测：`mode=read-only` + `collaboration_mode=plan` + 桥「全拒」+ 带写意图 ⇒ **文件未落盘**）。写意图止于 `plan_review` 门，桥拒（`revise_plan`）后后端只给计划；⚠ **终态是 `end_turn`**（后端把拒绝释为「保持 plan 模式」）⇒ **上层不得把「只出计划」误当成功**（§4.2-17 判据，真机待验）。
- `claude` `full` 档的 `bypassPermissions` 依赖会话建立期 `_meta`（`params._meta.claudeCode.options.allowDangerouslySkipPermissions`，缺省即 `true`），由 `--session-meta-json` 承载（替代旧段内开关）。
- **三档的实质差别在「沙箱范围」与「桥对 `session/request_permission` 的应答」两个维度**（四 kind 一致），**不是**「写要不要审」：
  - **沙箱范围**：`read` = **只读**（codex 另加 `--collaboration-mode plan`，把写意图止于计划评审门）；`write` = **工作区内可写**、区外与联网受沙箱管；`full` = **无沙箱**。
  - **桥的应答**：`read` = **一律拒绝**；`write` = **取第一个 allow**（≈ 自动放行）；`full` = **优先 `allow_always`**（放行并记住）。
- **桥不向人提问，它是按档自动应答** ⇒ 当前三档**没有**「每次写都问人」的档位。

### model 通路（协议面）

**四 kind 统一读顶层平铺 `agentConfig.model`** ⇒ 适配器原样透传 `--model` ⇒ 桥在**每次会话建立后**（`session/new` / `load` / `resume` 三路）发一次 ACP `session/set_config_option {configId:"model", value:<原样>}`（set 是 per-session，恢复路径不假设后端保持模型）。值**不校验、不映射**（`-m` 吃显示名、协议面吃 modelId ⇒ 统一只走协议面，后端 argv 不再拼 `-m`）；未配 / 空串 ⇒ 桥完全不发该请求。**可填值清单见 `config/model-catalog.json`**（含四 kind 全清单与枚举方式）。

### 键位口径与自定义注入

- **`agentConfig.<kind>` 段与配置通道整体退役**（v0.8.5）：`--config-file` / `--config-segment` / `writeAgentConfig` / `agents/` 产物全部退役 ⇒ 段内键（wrapper 族契约键、ACP 族段内 `model` 等）**不再被任何人消费**，写了无效、也不再告警。
- 键位口径 = **自消费键顶层平铺**：`backendCmd`（**必填**）· `model` · `systemPrompt` / `systemPromptMode`（自定义注入 ⇒ 桥 `--system-prompt` / `--system-prompt-mode`，缺省 `append`）。
- **「保留」≠ 提供读点**：命名空间保留键清单见 `agent-kinds.ts` 的 `RESERVED_AGENT_CONFIG_FLAT_KEYS`。
- **outcome 约定注入的唯一落点 = ACP 桥缺省**（单一源 `agent-outcome.ts`），不随项目配置覆盖。
- **opencode serve 前置后端（sidecar）已随迁 ACP 退役**：桥直接 spawn 后端，无独立后端进程、无端口预分配。

### 认证

- `opencode` / `codex` / `claude`：沿用各自 CLI 的用户级凭据（`~/.codex/config.toml`、`~/.claude/settings.json`）；
- `qoder`：优先文件凭据 `~/.qoder-cn/.auth`（`qodercn` CLI 登录），备选 env `QODERCN_PERSONAL_ACCESS_TOKEN`（经 Launcher 进程环境透传）。

四 kind 项目示例 + 「适配器安装与后端命令示例」见 `config/config.json.default`。