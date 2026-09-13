# a2a-coding

基于 A2A 的 Code Agent 协作：以 orch Agent 为统一入口，按「项目」组织 Code Agent，**三端均支持**（OpenCode / Codex / Claude Code），让需求讨论留在 orch、执行交给各项目自己的 Agent。

目标是开发协作时 orch 只管派发任务；目标项目的执行 Agent 按需拉起，在对应 workspace 实际执行，结果回传 orch，用完退出但会话可继承。架构不依赖「必须跨机器」：同一台机器上跑 orch 与 Launcher 同样成立，链路只是简化为本机调用，详见「部署形态」。

## 架构

三段式：orch 侧的 MCP 薄桥只做「项目 → 机器」解析与转发；每台执行机器常驻一个 Launcher，负责本机项目 Agent 的生命周期；Launcher 拉起 A2A 包装器，包装器再驱动底层 CLI。跨机通信走 A2A，orch 的工具面走 MCP，全程无中心注册。

```
用户
  │ 需求讨论 / 任务派发
  ▼
orch Agent（任意 MCP host，示例为 opencode）
  │ MCP stdio，固定 4 个泛型工具
  ▼
MCP 薄桥（orch/）
  │  · 解析「项目 → 机器」（静态机器清单 + 懒加载索引）
  │  · 幂等 ensure + A2A Client + 任务态落库
  ▼  HTTP JSON（GET /projects、POST ensure/stop、GET /health）
每机 Launcher（machine/）
  │  · 本机项目配置 + Agent 生命周期 + 空闲回收
  ▼  拉起包装器（a2a-opencode / a2a-codex / a2a-claude，按 agentKind）
A2A 包装器（opencode 另需前置 opencode serve，codex / claude 无前置后端）
  │  CLI（opencode run / codex exec / claude -p）
  ▼
目标 workspace 执行，结果经 A2A 回传 orch
```

- 静态分布：项目到机器的映射来自配置，没有自注册、心跳、TTL 或服务发现。
- 按需幂等：派发任务才 `ensure`，已在运行直接复用端点。
- 用完退出：项目 Agent 空闲超时自动回收，会话靠 `contextId` 续接。

## 部署形态

「机器」是一个逻辑单位，可以是远端主机，也可以是本机；「项目 → 机器」的映射全部来自静态配置，因此同一套架构天然支持以下形态：

| 形态 | 说明 |
|------|------|
| 跨机跨环境 | orch 在一台机器上讨论，执行 Agent 在另一台机器上运行（例：Windows 的 orch + Mac 上的执行 Agent），跨机通信走 A2A。 |
| 同机多项目 | 同一台机器上一份 Launcher 管理多个项目，各项目独立 `workspace` 与 A2A 端口，前后端 / 多项目并行协作。 |
| 多角色 | 同一项目或不同项目分别绑定开发 / 审查 / 测试 Agent，按任务选择派发目标。 |

同机即「机器 = 本机」：项目照样解析到本机的 Launcher，只是链路从跨机 A2A 简化为本机调用，架构与跨机完全一致。反向代理带来的网络可达性、认证与安全边界等额外注意事项只在跨机时出现，详见「已知边界」。

## 目录结构

代码按部署单元组织，`orch/` 与 `machine/` 各自完全自包含（各自的 `package.json` / `tsconfig.json` / `node_modules/` / `dist/` / `config/`）。单元之间只通过线协议耦合：线协议以仓库根 [PROTOCOL.md](PROTOCOL.md) 为单一事实源，类型两侧各自声明、由契约测试（`test-protocol-version`）锁定一致；修改协议时先改 PROTOCOL.md 再同步两侧实现。

```
a2a-coding/
├─ orch/                          # 部署单元 1（orch 机器）：作为 orch 的 MCP server 运行
│  ├─ package.json                # @a2a-coding/orch：@a2a-js/sdk / @modelcontextprotocol/sdk / zod
│  ├─ tsconfig.json
│  ├─ config/config.json          # 机器清单（实际，git 忽略）
│  ├─ config/config.json.default  # 机器清单模板（入库）
│  ├─ opencode.json               # 样例：把 mcp.a2a 配进 orch 的 opencode
│  ├─ types.ts  config.ts  app-root.ts
│  ├─ bridge/index.ts             # MCP 薄桥：a2a_projects / a2a_call / a2a_task_status / a2a_cancel
│  ├─ bridge/task-watcher.ts      # 任务后台看护（结果保障：轮询 + 续约至终态并落库）
│  ├─ session/store.ts            # 会话/任务库（node:sqlite；tasks 含 state/artifacts/text）
│  └─ data/                       # 运行态：sessions.sqlite（git 忽略）
├─ machine/                       # 部署单元 2（每台执行机器）：每机常驻
│  ├─ package.json                # @a2a-coding/machine：express / a2a-opencode / a2a-codex / a2a-claude
│  ├─ tsconfig.json
│  ├─ config/config.json          # 本机项目配置（实际，git 忽略）
│  ├─ config/config.json.default  # 本机项目配置模板（入库）
│  ├─ types.ts  config.ts
│  ├─ launcher/{index,server,manager,ports,process,agent-config,self-check,config-snapshot,app-root}.ts
│  ├─ adapters/{index,types,json,opencode,codex,claude}.ts
│  ├─ patches/                    # 会话落盘补丁（patch-package）：a2a-opencode / a2a-codex / a2a-claude
│  ├─ scripts/                    # 验证脚本：verify-session-persist{,-codex,-claude}.mjs、verify-config-precedence.mjs
│  ├─ agents/                     # 运行态：launcher 生成的包装器配置（git 忽略）
│  └─ .a2a/                       # 运行态：包装器会话映射 sessions.json（git 忽略）
├─ package.json                   # 仓级 dev manifest（version / type）
└─ CHANGELOG.md  README.md
```

## 前置要求

- Node.js ≥ 22.5（会话/任务库用内置 `node:sqlite`）。
- **orch agent 与 `orch/`（MCP 桥）必须同机**：桥是本地 stdio MCP server，由 orch agent 作为子进程拉起。执行机器（Launcher + 项目 Agent）可在本机或远端。
- 执行机器按项目 `agentKind` 准备对应的 CLI 与认证（Launcher 从自身进程环境继承）：
  - `opencode`：PATH 上有 `opencode` CLI（三端中**唯一**需要预装 CLI 的 kind）；Launcher 会先拉起 `opencode serve` 作为前置后端。
  - `codex`：**无需在 PATH 安装全局 `codex` CLI**——`a2a-codex` 依赖已内置 codex 运行时（`@openai/codex` + 对应平台包，`npm install` 按 OS/arch 自动选择，SDK 自动解析）；仅需认证（`OPENAI_API_KEY`，或 `codex login` 生成的 `~/.codex/auth.json`），无前置后端。自定义网关经 `~/.codex/config.toml` 的 `[model_providers.*]` 配置：`base_url` 须为 **OpenAI 兼容**地址，注意 codex 会在其后拼接 `/responses`（`wire_api = "responses"`），网关地址需含版本段（如 `https://…/v1`）。如需指定其它 codex 版本/二进制，可用 `agentConfig.codex.codexPathOverride`。
  - `claude`：**无需在 PATH 安装全局 `claude` CLI**——`a2a-claude` 依赖已内置 Claude Code 运行时（`@anthropic-ai/claude-agent-sdk` + 对应平台包，`npm install` 按 OS/arch 自动选择）。默认**加载用户级配置**（`settingSources: ["user"]`，读取 `~/.claude/settings.json` 的模型 / 网关 / 认证 `env`），交互式 Claude Code 已配好的用户开箱即用。项目可显式覆盖：`agentConfig.claude.settingSources: []` 恢复完全隔离（此时需把 `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` 注入 **Launcher 进程环境**）；模型可写在该项目 `agentConfig.claude.model`（优先于用户配置）。如需指定其它 Claude Code 版本/二进制，可用 `agentConfig.claude.executablePathOverride`。
- codex 项目的 `workspace` 默认只需指向一个目录，不必是 Git 仓库（Launcher 默认注入 `codex.skipGitRepoCheck: true`）；若要强制 Git 校验，可在该项目的 `agentConfig.codex` 里覆盖为 `false`。
- orch（**任意支持本地 stdio MCP 的 agent**，如 opencode / Claude Code / Codex / Cursor）与执行机器的 CLI 都已配好模型 provider，否则无法调用模型。
- Windows / macOS 均可，单元内的 CLI 参数已做跨平台处理。

## 快速开始

### 1. 执行机器：安装并启动 Launcher

```bash
cd machine
npm install          # postinstall 自动执行 patch-package，应用会话落盘补丁
npm run launcher     # 先 tsc 构建，再运行 dist/launcher/index.js
```

Launcher 按 `machine/config/config.json` 监听（模板见 `machine/config/config.json.default`；可用环境变量 `MACHINE_CONFIG` 指定其他文件），暴露这些接口：

> 同机部署时，orch 与 Launcher 在同一台机器上按下面同样的步骤安装，orch 的 `launcherUrl` 指向 `http://localhost:<port>` 即可。

| 接口 | 作用 |
|------|------|
| `GET  /health` | 健康检查（自报线协议版本 `protocolVersion`） |
| `GET  /projects` | 本机项目清单 + 运行态 |
| `POST /projects/{projectId}/ensure` | 幂等启动，返回 A2A 端点 |
| `POST /projects/{projectId}/stop` | 停止项目 Agent |

> **线协议版本化（Bridge ⇄ Launcher，v0.1.2）**：Launcher 在 `GET /health` 自报 `protocolVersion`（`"major.minor"`，单一事实源见 [PROTOCOL.md](PROTOCOL.md)）；桥**首触一台机器**（首个 `/projects` / `ensure` 前）先握手校验，机器主版本不在桥侧可支持清单（`SUPPORTED_PEER_PROTOCOL_MAJORS`）内即**拒绝派发**并给出升级指引——杜绝「新请求体被旧 Launcher 静默忽略」的假象。成功校验进程内缓存（后续调用不再握手，`grep "\[a2a-bridge\] protocol handshake"` 可见各机版本台账）；失败不缓存负项，机器升级后下一轮调用自动恢复，无需重启桥。版本规则：加可选字段 → minor+1；删字段 / 改语义 / 加必填请求体 → major+1（详见 PROTOCOL.md 的版本规则、握手语义与演进记录表）。

> **启动自检**（缺省开，`launcher.startupCheck=false` 跳过）：监听端口前对本机全部项目逐个 `ensure` 拉起 → 经 A2A 发送一条真实最小任务 → 校验任务完成且响应非空 → `stop` 回收。全部通过才进入对外服务；任一失败即打印项目 / 阶段 / 原因并**退出（非零）**，从源头避免「机器看似起来、一用就废」。每个项目消耗一次极小模型调用；自检与真实任务同链路，因此能暴露认证 / 模型 / provider 缺配。
>
> 另外每次拉起 Agent 时，Launcher 日志会打印该项目的**配置快照**：配置获取层级（项目 agentConfig / 用户级配置文件路径）+ endpoint / 模型 id（值标注来源 agentConfig / env / 用户配置），便于核对项目实际生效的模型与网关。

> **任务执行日志（三端统一，v0.1.2）**：任一端真实任务（orch 派发或自检触发）在 Launcher 日志中可见统一的三段观测——
> `[a2a-task] start taskId=… contextId=… promptLen=…` → `[a2a-task] end taskId=… contextId=… state=completed|failed|canceled responseChars=… durationMs=…`（failed 行附单行截断 `error=`）→ 自检路径另有 `[self-check] <projectId> 通过：taskId=… contextId=… state=… responseChars=… durationMs=…`（同套字段，耗时口径为发送 → 终态）；settle 失败行附带任务错误文本。三端格式逐字段一致，`grep "\[a2a-task\]"` 可直接对齐观测；该日志由三端 wrapper 补丁直写 stdout，不受 wrapper `logging.level` 影响。

### 2. orch 机器：安装桥并构建

```bash
cd orch
npm install
npm run build        # 产出 dist/bridge/index.js
```

### 3. 把 MCP 桥配进 orch agent

把下面这段加入 orch 宿主的 MCP 配置后重启 orch。下例为 opencode 的 `opencode.json`；**任何支持本地 stdio MCP 的 agent**（Claude Code、Codex、Cursor 等）同理，仅配置位置与格式不同：

> ⚠️ **同机约束**：桥（`orch/` 单元）是**本地 stdio MCP server**，由 orch agent 作为子进程拉起，因此**必须与 orch agent 部署在同一台机器**（当前版本不支持把桥放远端用 HTTP 连）。

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "a2a": {
      "type": "local",
      "command": ["node", "G:/code/a2a-coding/orch/dist/bridge/index.js"],
      "environment": {
        "MACHINES_CONFIG": "G:/code/a2a-coding/orch/config/config.json",
        "SESSION_DB": "G:/code/a2a-coding/orch/data/sessions.sqlite"
      },
      "enabled": true
    }
  }
}
```

把 `command` 的路径换成实际部署路径即可。`MACHINES_CONFIG` 与 `SESSION_DB` 缺省时分别回退到 orch 单元根的 `config/config.json` 与 `./data/sessions.sqlite`。

> 桥的同步等待预算由环境变量 `SYNC_BUDGET_MS`（默认 30000ms）控制：任务超过该时长未完成即返回 `working + taskId`（桥转后台看护至终态并落库），由调用方 `a2a_task_status` 轮询。**该值必须小于 orch agent 的 MCP 客户端请求超时**（`@modelcontextprotocol/sdk` 默认 60s，超时抛 -32001），否则长任务的句柄返回会被客户端超时截断，调用方拿不到 taskId、重试还会重复执行任务。

> 若 orch 不是 opencode，按该 agent 的方式登记同一个 stdio MCP server（`command` 与环境变量一致）即可——桥本身不绑定任何宿主。

### 4. 通过 MCP 工具派发任务

工具面固定为 4 个泛型工具：

- `a2a_projects()`：列出所有已配置机器及其本机项目（含运行态与 A2A 端点）。
- `a2a_call(project, message, contextId?)`：解析项目到机器，幂等 ensure，经 A2A 派发一轮任务。≤30s 完成的任务直接返回文本结果与 artifacts；更长的任务返回 `working + taskId`（桥转后台看护至终态并落库），按返回文案用 `a2a_task_status` 轮询。
- `a2a_task_status(taskId)`：查询任务态并回写本地任务存储。已终结任务（completed / failed）由桥本地存档直接作答（不唤醒远端 Agent）；未终结任务走远端实时查询。
- `a2a_cancel(taskId)`：取消任务，并回写本地任务存储。

示例（在 orch 里）：

```
a2a_projects()
a2a_call(project="machine", message="列出当前目录的顶层文件")
a2a_call(project="machine", message="把刚才的结果按类型分组", contextId="<上一轮返回的 contextId>")
```

`a2a_call` 省略 `contextId` 时自动新建并在返回中给出；续接同一上下文时把它带回来即可。

## 配置

### machine：`config/config.json`

每台机器自维护本机项目（实际配置 `config/config.json` 不入库，首次部署从 `config/config.json.default` 复制并填入本机真实值）。字段说明：

- `machineId`：机器标识，需与 orch 机器清单一致。
- `launcher.port`：Launcher 监听端口。
- `launcher.idleStopMs`：空闲回收时长（毫秒）。项目 Agent 超过该时长没有 `ensure` 调用就自动 `stop`；缺省 300000（5 分钟），`0` 或负值表示禁用。
- `launcher.startupCheck`（可选）：启动自检开关，缺省 `true`（见「快速开始」的自检说明）；`false` 跳过自检直接进入服务。
- `launcher.startupCheckTimeoutMs`（可选）：每个项目自检的总超时（毫秒），缺省 `120000`。
- `launcher.startupCheckPrompt`（可选）：自检 prompt，缺省 `Reply with exactly: OK`。
- `projects[]`：本机项目列表，每项含：
  - `projectId`：项目标识，全局唯一。
  - `workspace`：执行目录。
  - `agentKind`：`opencode` / `codex` / `claude`。
  - `a2aPort`：该项目 A2A Server 监听端口。
  - `risk`（可选）：项目风险档位，`read` / `write` / `full`，缺省 `write`。决定包装器传给底层 CLI 的权限 / 沙箱参数，遵循「最小权限」。
  - `agentConfig`（可选）：包装器配置片段，顶层键如 `model` / `mcp` / `events` / `systemPrompt`。launcher 会把它与默认项 `{ "events": { "enabled": false } }` 深合并，写入 `agents/<agentKind>.<projectId>.json`，经 `--config` 传给包装器，再与包装器内置默认值深合并。

`risk` 到各端权限参数的映射（`write` 为默认，恰等于三端包装器内置默认；opencode 只有自动放行开 / 关一个旋钮，`write` 与 `full` 相同）：

| risk | opencode | codex（`--sandbox`） | claude（`--permission-mode`） |
|------|----------|----------------------|-------------------------------|
| `read` | `--no-auto-approve` | `read-only` | `plan` |
| `write`（默认） | `--auto-approve` | `workspace-write` | `acceptEdits` |
| `full` | `--auto-approve` | `danger-full-access` | `bypassPermissions` + 配置 `claude.dangerouslyAllowBypassPermissions=true` |

样例：

```json
{
  "machineId": "win-dev",
  "launcher": { "port": 3100, "idleStopMs": 300000 },
  "projects": [
    {
      "projectId": "machine",
      "workspace": "G:/code/a2a-coding/machine",
      "agentKind": "opencode",
      "a2aPort": 3010,
      "agentConfig": {
        "events": { "enabled": false }
      }
    }
  ]
}
```

环境变量 `MACHINE_CONFIG` 可指定其他配置文件；缺省为 `config/config.json`（模板 `config/config.json.default`）。

### orch：`config/config.json`

orch 只持有「有哪些机器、Launcher 地址」，项目明细由各机自持（实际配置 `config/config.json` 不入库，首次部署从 `config/config.json.default` 复制并填入真实机器地址）。字段为 `machines[]`，每项含 `machineId` + `launcherUrl`。

```json
{
  "machines": [
    { "machineId": "win-dev", "launcherUrl": "http://localhost:3100" }
  ]
}
```

环境变量 `MACHINES_CONFIG` 可指定其他清单文件；缺省为 `config/config.json`（模板 `config/config.json.default`）。

### 同机多项目示例

同一台机器上跑两个项目时，只需在**一份** machine 配置里多写几个 `projects[]`，各自用不同 `workspace` 与 `a2aPort`：

`machine/config/config.json`：

```json
{
  "machineId": "local",
  "launcher": { "port": 3100, "idleStopMs": 300000 },
  "projects": [
    { "projectId": "frontend", "workspace": "/abs/path/to/frontend", "agentKind": "opencode", "a2aPort": 3010 },
    { "projectId": "backend",  "workspace": "/abs/path/to/backend",  "agentKind": "opencode", "a2aPort": 3011 }
  ]
}
```

`orch/config/config.json`（同机：只需一条机器项，指向本机 Launcher）：

```json
{ "machines": [ { "machineId": "local", "launcherUrl": "http://localhost:3100" } ] }
```

orch 用 `project`（如 `frontend` / `backend`）派发到对应项目；同机多项目仅需在**一份** machine 配置里多写几个 `projects[]`。

## 文档索引

- [PROTOCOL.md](PROTOCOL.md)：Bridge ⇄ Launcher 线协议契约（端点/字段、版本规则、握手语义、可支持对端版本维护流程、演进记录表）
- [CHANGELOG.md](CHANGELOG.md)：版本变更记录

## 已知边界

- 执行层入站鉴权依赖反向代理补足（`a2a-wrapper` 默认没有入站鉴权）。
- 跨机鉴权尚未实现（计划反向代理 TLS + Bearer，预留 mTLS）。
- 三端均已完成真实模型端到端验证（拉起 → 派发 → 执行 → 回传，退出后携带同一 `contextId` 续接）：opencode（v0.1.0）、claude（用户级 `~/.claude/settings.json` 网关认证，无需注入 env）、codex（`~/.codex/config.toml` 自定义 provider + 兼容网关）。
- 任务结果保障的边界：终态结果持久在桥的 SQLite（两侧进程重启均不丢）；**执行中（未终态）任务跨 wrapper / 桥任一侧重启会中断丢失**（任务态仅存于 wrapper 进程内存；彻底消除需 wrapper 任务态持久化，未来项）。
- 设备本身当 Agent 需自建中继，非本期范围。
- 多实例 + 工作区隔离（模型 C）仅预留扩展点，本版本不实现。
