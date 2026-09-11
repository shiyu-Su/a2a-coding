# a2a-coding

基于 A2A 的分布式 Code Agent 协作：以 orch Agent 为统一入口，把分布在不同机器上的 Code Agent（OpenCode / Codex / Claude Code）组织起来，让需求讨论留在本地、执行放到远端。

目标是在多机、多环境协作开发时，orch 只管派发任务；目标机器的执行 Agent 按需拉起，在对应 workspace 实际执行，结果回传 orch，用完退出但会话可继承。

## 架构

三段式：orch 侧的 MCP 薄桥只做「项目 → 机器」解析与转发；每台执行机器常驻一个 Launcher，负责本机项目 Agent 的生命周期；Launcher 拉起 A2A 包装器，包装器再驱动底层 CLI。跨机通信走 A2A，orch 的工具面走 MCP，全程无中心注册。

```
用户
  │ 需求讨论 / 任务派发
  ▼
orch Agent（opencode）
  │ MCP stdio，固定 4 个泛型工具
  ▼
MCP 薄桥（orch/）
  │  · 解析「项目 → 机器」（静态机器清单 + 懒加载索引）
  │  · 幂等 ensure + A2A Client + 任务态落库
  ▼  HTTP JSON（GET /projects、POST ensure/stop、GET /health）
每机 Launcher（machine/）
  │  · 本机项目配置 + Agent 生命周期 + 空闲回收
  ▼  拉起包装器（a2a-opencode）
A2A 包装器 + 前置 opencode serve
  │  CLI（opencode run）
  ▼
目标 workspace 执行，结果经 A2A 回传 orch
```

- 静态分布：项目到机器的映射来自配置，没有自注册、心跳、TTL 或服务发现。
- 按需幂等：派发任务才 `ensure`，已在运行直接复用端点。
- 用完退出：项目 Agent 空闲超时自动回收，会话靠 `contextId` 续接。

## 目录结构

代码按部署单元组织，`orch/` 与 `machine/` 各自完全自包含（各自的 `package.json` / `tsconfig.json` / `node_modules/` / `dist/` / `config/`）。单元之间只通过线协议耦合，线协议类型两侧各自声明，修改时必须同步。

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
│  ├─ session/store.ts            # 会话/任务库（node:sqlite）
│  └─ data/                       # 运行态：sessions.sqlite（git 忽略）
├─ machine/                       # 部署单元 2（每台执行机器）：每机常驻
│  ├─ package.json                # @a2a-coding/machine：express / a2a-opencode
│  ├─ tsconfig.json
│  ├─ config/config.json          # 本机项目配置（实际，git 忽略）
│  ├─ config/config.json.default  # 本机项目配置模板（入库）
│  ├─ types.ts  config.ts
│  ├─ launcher/{index,server,manager,ports,process,agent-config,app-root}.ts
│  ├─ adapters/{index,types,json,opencode,codex,claude}.ts
│  ├─ patches/a2a-opencode+1.7.2.patch     # 会话落盘补丁（patch-package）
│  ├─ scripts/verify-session-persist.mjs
│  ├─ agents/                     # 运行态：launcher 生成的包装器配置（git 忽略）
│  └─ .a2a/                       # 运行态：包装器会话映射 sessions.json（git 忽略）
├─ .omo/skills/regression-test/   # 回归测试 skill（纯 node，无依赖）
├─ package.json                   # 仓级 dev manifest（version / type / regression）
├─ CHANGELOG.md  README.md  planlog.md  CLAUDE.md
└─ doc/v0.1.0/                    # 需求确认单 + 改造文档
```

## 前置要求

- Node.js ≥ 22.5（会话/任务库用内置 `node:sqlite`）。
- 执行机器需在 PATH 上有 `opencode` CLI（launcher 会拉起 `opencode serve` 与包装器）。
- orch 与执行机器的 opencode 已配好模型 provider（`opencode auth login` 或 opencode 配置），否则执行 Agent 无法调用模型。
- Windows / macOS 均可，单元内的 CLI 参数已做跨平台处理。

## 快速开始

### 1. 执行机器：安装并启动 Launcher

```bash
cd machine
npm install          # postinstall 自动执行 patch-package，应用会话落盘补丁
npm run launcher     # 先 tsc 构建，再运行 dist/launcher/index.js
```

Launcher 按 `machine/config/config.json` 监听（模板见 `machine/config/config.json.default`；可用环境变量 `MACHINE_CONFIG` 指定其他文件），暴露这些接口：

| 接口 | 作用 |
|------|------|
| `GET  /health` | 健康检查 |
| `GET  /projects` | 本机项目清单 + 运行态 |
| `POST /projects/{projectId}/ensure` | 幂等启动，返回 A2A 端点 |
| `POST /projects/{projectId}/stop` | 停止项目 Agent |

### 2. orch 机器：安装桥并构建

```bash
cd orch
npm install
npm run build        # 产出 dist/bridge/index.js
```

### 3. 把 MCP 桥配进 orch 的 opencode

在 orch 机器的 `opencode.json` 里加入 `mcp.a2a`，然后重启 orch：

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

### 4. 通过 MCP 工具派发任务

工具面固定为 4 个泛型工具：

- `a2a_projects()`：列出所有已配置机器及其本机项目（含运行态与 A2A 端点）。
- `a2a_call(project, message, contextId?)`：解析项目到机器，幂等启动 Agent，经 A2A 派发一轮任务，返回文本结果与 artifacts。
- `a2a_task_status(taskId)`：查询任务态，并回写本地任务存储。
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
- `projects[]`：本机项目列表，每项含：
  - `projectId`：项目标识，全局唯一。
  - `workspace`：执行目录。
  - `agentKind`：`opencode` / `codex` / `claude`。
  - `a2aPort`：该项目 A2A Server 监听端口。
  - `agentConfig`（可选）：包装器配置片段，顶层键如 `model` / `mcp` / `events` / `systemPrompt`。launcher 会把它与默认项 `{ "events": { "enabled": false } }` 深合并，写入 `agents/<agentKind>.<projectId>.json`，经 `--config` 传给包装器，再与包装器内置默认值深合并。

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

## 回归测试

```bash
node .omo/skills/regression-test/index.js
# 或
npm run regression
```

skill 只做静态检查（不联网、不启动 launcher / bridge / `opencode serve`），覆盖项目结构、单元自包含、无跨单元 import、配置样例、会话补丁、trace 处理、空闲回收与租约续约、入口脚本、两单元 `tsc --noEmit`、文档收尾，共 60 条断言。执行后写入 `reports/v0.1.0/regression-report.json`。

## 文档索引

- [doc/v0.1.0/A2A最小闭环-需求确认单.md](doc/v0.1.0/A2A最小闭环-需求确认单.md)
- [doc/v0.1.0/A2A最小闭环-改造文档.md](doc/v0.1.0/A2A最小闭环-改造文档.md)
- [planlog.md](planlog.md)：版本待办与已实现清单
- [CHANGELOG.md](CHANGELOG.md)：版本变更记录
- [CLAUDE.md](CLAUDE.md)：项目规范与需求/发版流程

## 已知边界

- 执行层入站鉴权依赖反向代理补足（`a2a-wrapper` 默认没有入站鉴权）。
- 跨机鉴权尚未实现（计划反向代理 TLS + Bearer，预留 mTLS）。
- Codex / Claude Code 暂缓：`machine/adapters/` 已有骨架，依赖安装、配置生成与生命周期随后续版本补齐。
- 设备本身当 Agent 需自建中继，非本期范围。
- 多实例 + 工作区隔离（模型 C）仅预留扩展点，本版本不实现。
