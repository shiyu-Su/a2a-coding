# v0.1.0 A2A 最小闭环 改造文档

## 0. 需求信息
- **REQ-ID**: REQ-v0.1.0-2026-09-10-01
- **需求来源**: 产品规划
- **原始需求**: 见 [需求确认单](A2A最小闭环-需求确认单.md)。核心：以 orch 为统一入口；**事先配置「项目 → 机器」分布**；orch 派任务时**按需启动对应项目的 Agent**，在目标机器的 workspace 执行并回传结果；**不使用中心注册**。
- **优先级**: P0

## 1. 背景

### 1.1 现状
- 项目无任何实现。
- 前后端项目**分散在不同机器**（Windows / Mac）。
- orch 既不知道「哪个项目在哪台机器」，也无法按需把某项目的执行 Agent 拉起来。

### 1.2 目标
- 事先显式维护「项目 → 机器」分布（**静态配置，非自注册**）。
- orch 收到任务 → 判定目标项目 → 定位机器 → **按需启动该项目 Agent（幂等）** → 目标 workspace 执行 → 结果回传。
- Agent **用完退出**，但**会话持久化、可继承上下文**。
- **一台机器可挂多个项目**。

### 1.3 需求评估（结论内嵌）
| 评估项 | 结论 |
|---|---|
| 与架构冲突？ | 与《实施方案 v2（方案B）》的**中心注册中心冲突**。经用户决策，改为「**静态分布配置 + 每机启动器**」，去掉注册中心。方案文档与 `CLAUDE.md` 的「注册中心约束」需同步修订（本需求范围内完成）。 |
| 依赖？ | 依赖 OpenCode CLI；执行层包装复用 `a2a-wrapper` 的 `a2a-opencode`。 |
| 是否有更简方案？ | 有——本方案即比注册中心更简（少一个服务，无 TTL/心跳/一致性）。 |
| 与现有需求冲突？ | 无（首个需求）。 |
| **结论** | **合理（按调整后的形态）** |

## 2. 方案设计

### 2.1 总体结构（无中心注册）

```
                          ┌──────────┐
                          │   用户    │
                          └────┬─────┘
                               ▼
                  ┌─────────────────────────┐
                  │ orch Agent              │
                  │  + 机器清单(machines)    │
                  └────────────┬────────────┘
                               │ MCP（泛型工具）
                               ▼
                  ┌─────────────────────────┐
                  │ MCP 薄桥                 │
                  │  a2a_projects / a2a_call │
                  └────────────┬────────────┘
             ┌─────────────────┼─────────────────┐
             ▼                                   ▼
   ┌───────────────────┐               ┌───────────────────┐
   │ Launcher (win)    │               │ Launcher (mac)    │  ← 常驻
   │ 本机项目配置       │               │ 本机项目配置       │
   └─────┬───────┬─────┘               └─────────┬─────────┘
         │按需    │按需                           │按需
         ▼       ▼                               ▼
   ┌──────────┐ ┌──────────┐              ┌──────────┐
   │ 项目A     │ │ 项目B     │              │ 项目C     │
   │ Agent    │ │ Agent    │              │ Agent    │  ← 用完退出
   │(A2A Srv) │ │(A2A Srv) │              │(A2A Srv) │
   └────┬─────┘ └────┬─────┘              └────┬─────┘
        ▼            ▼                        ▼
   workspace A   workspace B              workspace C

        ┌──────────────────────────────────────────┐
        │ 会话/任务存储 (SQLite)                     │
        │  contextId ↔ sessionId · 任务态 · artifacts │
        └──────────────────────────────────────────┘
```

### 2.2 机器本地配置（每机自维护，Q2）
每台机器持有一份本机配置（记录了本机有哪些项目、用哪个 Agent、在哪个 workspace）。其中 `agentKind ∈ {opencode, codex, claude}` 决定使用哪个 A2A 包装器与 CLI 参数：

```json
{
  "machineId": "win-dev",
  "launcher": { "port": 3100 },
  "projects": [
    { "projectId": "frontend-app", "workspace": "G:/proj/frontend-app", "agentKind": "opencode", "a2aPort": 3010 },
    { "projectId": "frontend-web", "workspace": "G:/proj/web",          "agentKind": "codex",    "a2aPort": 3011 }
  ]
}
```

### 2.3 orch 侧机器清单
orch 只知道「有哪些机器、启动器地址」，项目明细由各机自持：

```json
{
  "machines": [
    { "machineId": "win-dev", "launcherUrl": "http://win-dev:3100" },
    { "machineId": "mac-dev", "launcherUrl": "https://mac-dev:3101" }
  ]
}
```

### 2.4 启动器（Launcher，常驻，Q1=(a)）
每台机器一个常驻进程，负责本机项目 Agent 的**生命周期**（不做发现）：

| 接口 | 作用 |
|------|------|
| `GET  /projects` | 本机项目清单（含运行态） |
| `POST /projects/{projectId}/ensure` | **幂等启动**：已在跑则复用，否则拉起 → 返回 Agent 的 A2A 端点 |
| `POST /projects/{projectId}/stop` | 停止该项目 Agent |
| `GET  /health` | 健康检查 |

- 本地运行态：记录每个 `projectId` 的 Agent 进程 + 端口。
- 启动动作（按各包装器**真实 CLI**）：
  - `opencode`：**先确保 `opencode serve`** 在跑（cwd=workspace，本机分配空闲端口），再拉起 `a2a-opencode --port <a2aPort> --hostname 127.0.0.1 --advertise-host localhost --directory <workspace> --opencode-url http://127.0.0.1:<servePort>`；停止时一并回收 serve。
  - `codex`（暂缓）：`a2a-codex --config <f> --port <a2aPort> --workspace <workspace>`。
  - `claude`（暂缓）：`a2a-claude --config <f> --port <a2aPort>`（workspace 进配置 `workingDirectory`）。
- **包装器配置（生成，关闭 trace）**：launcher 启动前由 `MachineConfig` 渲染 `agents/<kind>.<projectId>.json` 并 `--config` 传入；默认含 `events.enabled=false`（**不产生中间调用**），并合并每项目的 `agent` 配置块（`model` / `mcp` / `systemPrompt` / `events` …）；与包装器内置默认**深合并**（只写覆盖项，实测可行）。
- **bridge 兜底过滤 trace**：即便包装器仍发出，桥丢弃 `trace.*` artifacts（`trace.mcp` / `trace.thought` / `trace.delegation`）；`text` 回落到 artifacts 时同样排除——观测数据不喂给 orch。
- **幂等**：`ensure` 已运行则直接返回端点，不重复拉起（含其前置 `opencode serve`）。
- **用完退出（空闲回收）**：`ensure` 记录 `lastUsed`；超过 `launcher.idleStopMs`（默认 5 分钟，`0` 关闭）无调用 → **自动 `stop`**（回收包装器 + `opencode serve`）；日志打印「空闲超时，自动回收」；下次调用重新 `ensure`（冷启动 ~4s）。配合方案 P 的会话落盘，退出后仍可按 `contextId` 恢复。
- **任务期间续约（防误回收）**：`a2a_call` 仅开始时 `ensure` 一次，任务执行/轮询 `tasks/get` 不经过 launcher → 长任务会被误判"空闲"。故桥在**轮询期间周期性 re-ensure 续约**（`LEASE_RENEW_INTERVAL_MS`，默认 5s）刷新 `lastUsed`；任务终态/超预算后停止续约。**要求 `idleStopMs` > 续约间隔**。

### 2.5 MCP 泛型桥
| 工具 | 作用 |
|------|------|
| `a2a_projects()` | 聚合各机 `GET /projects`，列出已知项目及所在机器 |
| `a2a_call(project, message, contextId?)` | 派发一轮任务 |
| `a2a_task_status(taskId)` / `a2a_cancel(taskId)` | 异步任务查询/取消 |

`a2a_call` 流程：
1. 解析 `project → machine`（机器清单；项目→机器索引可静态配置或懒加载缓存）。
2. `POST {launcherUrl}/projects/{projectId}/ensure` → 拿 Agent 端点。
3. 以 A2A Client 发 `message/send`（携带 `contextId`）。
4. 返回文本结果 + artifacts；超 `syncBudgetMs` 则返回 `taskId` 供轮询。

### 2.6 会话与上下文（Q3）
- **上层只传 `contextId`**；底层 CLI 会话（`sessionId`，如 `ses_*`）由**包装器内部**持有，对 orch / bridge 不透明。
- **包装器需持久化 `contextId → sessionId`**：`a2a-opencode` 默认仅**内存映射**（`contextMap = new Map()`，进程退出即丢）→ 以 **patch** 方式补齐：把映射**落盘**到 `<workspace>/.a2a/sessions.json` 并在启动时载入。此后 agent 退出/重启，同一 `contextId` 仍恢复原会话。
- **桥的职责**：生成/传递 `contextId`（缺省则新建并回传），持久化 A2A 任务态；**不自定义 sessionId 传输协议**（sessionId 不暴露给 orch）。
- Agent 仍遵循"用完退出"；上下文由**包装器持久化的映射** + A2A `contextId` 串联。

> 底层 resume 命令（供包装器内部使用/诊断参考）：opencode `--session <id>` / `--continue`；codex `codex exec resume <id>` / `--last`；claude `--resume <id>` / `--continue`。

### 2.7 多项目并存与并发模型（Q4）

**多项目并存**
- 启动器按 `projectId` 管理多个 Agent 实例（各自 workspace + 各自端口），互不干扰。
- 同一机器并发启动多个项目 Agent 时，端口/进程隔离。

**同一项目的并发模型（本需求采用模型 A：单实例）**
- **单实例**：每个 `projectId` 只有一个 Agent 实例；该实例内的多个 `contextId` 靠 **OpenCode 原生并发 session** 处理（能"同时聊"）。
- **执行语义**：任务在实例内调度；"用完退出"指**全部任务空闲后**实例才退出——**有活跃任务期间保持常驻**，避免退化成多实例。
- **不做多开**：不为并发而多开进程，规避共享 workspace 的文件冲突。

**预留扩展（模型 C：多实例 + 工作区隔离，本需求不实现）**
设计预留以下扩展点，未来可平滑升级：
1. **端口**：`a2aPort` 由"每项目一个"扩展为"每实例一个"（base + index）。
2. **工作区隔离**：每实例一个 git worktree / 独立 checkout。
3. **Launcher 池化**：`project → N 实例`；`ensure` 由"确保单个"扩展为"确保有可用实例（按占用选）"。
4. **会话绑定**：`contextId↔sessionId` 增加实例维度，绑定到具体实例（实例回收后 session 仍可恢复）。

### 2.8 数据模型（SQLite）
- `sessions(project_id, context_id, session_id, created_at, last_used_at)`（`session_id` 由包装器在响应中回传时记录；会话本体在包装器侧）
- `tasks(task_id, project_id, context_id, state, artifacts_json, updated_at)`，`state ∈ working | completed | failed | input-required`
- **预留**：为模型 C 预留 `instance_id` 字段（本需求恒为单实例，可空/固定值），避免将来迁移。

## 3. 变更范围

### 3.1 In Scope（涉及文件 + 改动量评估）
| 文件/模块 | 改动类型 | 改动量 | 说明 |
|-----------|----------|--------|------|
| `src/machine/launcher/` | 新增 | 中 | 每机常驻：HTTP + 进程管理 + 本地配置读取 + 幂等 ensure |
| `src/orch/bridge/` | 新增 | 中 | 泛型工具 + 路由 + A2A Client；读机器清单 |
| `orch/config/config.json` | 新增 | 小 | orch 侧机器清单（模板 `config.json.default` 入库，实际配置 git 忽略） |
| `machine/config/config.json` | 新增 | 小 | 每机项目配置（随机器分发；模板 `config.json.default` 入库，实际配置 git 忽略） |
| `src/orch/session/` | 新增 | 中 | `node:sqlite`：contextId↔任务态（CLI 会话由包装器持有） |
| `agents/<agentKind>.<project>.json` | 新增 | 小 | A2A 包装配置（每项目；本轮打样 opencode，由 MachineConfig 生成） |
| `package.json` 依赖 | 修改 | 小 | 新增 `a2a-opencode`（本轮打样；codex/claude 后续） |
| Launcher 前置服务 | 修改 | 中 | opencode 项目：ensure/回收 `opencode serve`（cwd=workspace，空闲端口） |
| 包装器配置生成 | 新增 | 中 | launcher 渲染 `agents/<kind>.<projectId>.json`（默认 `events.enabled=false` + 合并 `agent` 块）并 `--config` 传入 |
| trace 兜底过滤 | 新增 | 小 | bridge 丢弃 `trace.*` artifacts（观测数据不回传 orch） |
| **patch：a2a-opencode 会话持久化** | 新增 | 小 | `patch-package` 补丁：`session-manager.js` 落盘/载入 `contextId→sessionId`（`<workspace>/.a2a/sessions.json`），满足"用完退出后仍可复用" |
| 用完退出（空闲回收） | 新增 | 小 | launcher 空闲超时自动 `stop`（回收包装器 + serve）；配置 `launcher.idleStopMs`（默认 5 分钟）；打印回收日志 |
| CLI 适配（三端） | 新增 | 中 | 按 `agentKind` 分派：无头调用、session resume、输出解析、权限参数（本轮修 opencode） |
| `CLAUDE.md` 架构约束 | 修订 | 小 | 「注册中心约束」→「静态分布 + 启动器」 |
| `A2A协作实施方案-v2-方案B.md` | 修订 | 中 | 同步改为无中心注册形态 |

### 3.2 Out of Scope（显式声明本次不做的事）
- 中心注册中心 / 自注册 / 服务发现 / TTL 心跳（**明确不做**）。
- 跨机鉴权（反向代理 TLS + Bearer/mTLS）——下阶段。
- iOS / Android 等多环境——下阶段。
- 后端 Agent（本需求先用单类项目打通；多机多项目作为架构预留）。
- **多实例 + 工作区隔离（模型 C）** —— 仅预留扩展点（§2.7），本需求不实现。
- **Codex / Claude Code 包装器集成** —— 本轮先 OpenCode 打样；`a2a-codex` / `a2a-claude` 的依赖安装、配置生成、生命周期随后补（adapter 骨架已在）。
- 实现过程中发现的新问题（非本次 In Scope）→ 登记到 planlog.md，不在此次实现。

## 4. 验收标准

### 4.1 实现级（单元场景）
| 场景 | 输入 | 预期输出 |
|------|------|----------|
| 本机项目清单 | 配置 win-dev 含 2 个项目 | `GET /projects` 返回 2 条 |
| 首次按需启动 | `POST /projects/frontend-app/ensure`（未运行） | 拉起 Agent，返回 A2A 端点，状态 online |
| 幂等启动 | 再次 `ensure`（运行中） | 返回同一端点，**不重复拉起** |
| 停止 | `POST /projects/frontend-app/stop` | Agent 退出，状态 offline |
| 上下文继承 | 用 `contextId` 二次派发（Agent 已退出） | Agent 重启，`opencode run --session <id>` 恢复上下文 |
| 多项目并存 | 同机 `ensure` 两个项目 | 两个 Agent 独立运行、端口不同 |

### 4.2 场景级（用户视角）
- 在 orch 里说「给前端项目 frontend-app 加个功能」→ orch 判定项目 → **自动启动其 Agent** → 在 `G:/proj/frontend-app` 执行 → 结果回到 orch。
- 继续追问（同 `contextId`）→ 即便 Agent 已退出，重启后**仍记得上次上下文**。
- 一台机器挂 2 个项目，分别派任务**互不干扰**。

### 4.3 回归级（不破坏现有功能）
- 本需求为首个实现，暂无既有功能可破坏；建立基础回归脚手架（见 planlog「回归测试脚手架」）。

## 5. 目录结构（按部署位置拆分，单元自包含）

代码按**部署单元**组织，两个单元位于仓根且**各自完全自包含**：各自的 `package.json` / `tsconfig.json` / `node_modules/` / `dist/` / `config/`。**无 `src/`、无 `src/shared/`**（线协议类型两侧各自声明，方案 a）。

```
a2a-coding/
├─ orch/                        # 部署单元 1（orch 机器）：作为 orch 的 MCP server 运行
│  ├─ package.json              # @a2a-coding/orch（@a2a-js/sdk / @modelcontextprotocol/sdk / zod）
│  ├─ tsconfig.json  node_modules/  dist/
│  ├─ config/config.json        # 本单元：机器清单（实际，git 忽略）
│  ├─ config/config.json.default # 本单元：机器清单模板（入库）
│  ├─ types.ts  config.ts  app-root.ts
│  ├─ bridge/index.ts           # MCP 薄桥
│  └─ session/store.ts          # 会话/任务库
├─ machine/                     # 部署单元 2（每台执行机器）：每机常驻
│  ├─ package.json              # @a2a-coding/machine（express / a2a-opencode）
│  ├─ tsconfig.json  node_modules/  dist/
│  ├─ config/config.json        # 本单元：本机项目配置（实际，git 忽略）
│  ├─ config/config.json.default # 本单元：本机项目配置模板（入库）
│  ├─ types.ts  config.ts
│  ├─ launcher/{index,server,manager,ports,process,app-root}.ts
│  └─ adapters/{index,types,json,opencode,codex,claude}.ts
├─ .omo/skills/regression-test/ # 回归测试 skill（纯 node，无依赖）
├─ package.json                 # 仓级 dev manifest（version / type，无依赖）
└─ doc/  planlog.md  CLAUDE.md …
```

- **部署**：把 `orch/` 复制到 orch 机器、`machine/` 复制到各执行机器；各自 `npm install && npm run build`（互不需要对方）。
- **单元间只通过线协议耦合**：`orch ↔ machine` = HTTP JSON（`GET /projects`、`POST ensure/stop`）；`machine ↔ CLI` = 命令行参数；`orch ↔ 包装器` = A2A。
- **线协议类型重复**：`AgentKind` / `ProjectStatus` / `EnsureResult` / `StopResult` / `ApiError` 在 `machine/types.ts` 与 `orch/types.ts` 各声明一份；修改时必须两侧同步。
- **入口**：`cd machine && npm run launcher`；`cd orch && npm run bridge`（脚本**先 `tsc` 构建再跑 `dist/**.js`**；因 Node 的 `--experimental-strip-types` 不会把源码里的 `.js` 说明符改写成 `.ts`，直接跑源码会 `ERR_MODULE_NOT_FOUND`）。
- **仓根定位**：`app-root.ts` 向上查找最近的 `package.json` → 现指向**本单元根**（用于本单元的 `node_modules/.bin` 与 `config/`）。
- 约束：orch 不得 import machine 代码，machine 不得 import orch 代码。

## 6. 修订历史
| 版本 | 日期 | 修订人 | 说明 |
|------|------|--------|------|
| v1 | 2026-09-10 | - | 初稿（据需求确认单 REQ-v0.1.0-2026-09-10-01；形态：静态分布 + 每机启动器 + 按需启动，无中心注册） |
| v2 | 2026-09-10 | - | 补充并发模型：同一项目采用模型 A（单实例，靠 OpenCode 并发 session），预留模型 C（多实例 + 工作区隔离）；数据模型预留 `instance_id` |
| v3 | 2026-09-10 | - | 执行层由「仅 OpenCode」扩展为**覆盖三端**（OpenCode / Codex / Claude Code）：新增 §2.6 三端会话/权限对照表；包装配置与 CLI 适配按 `agentKind` 分派 |
| v4 | 2026-09-11 | - | 对齐实现：明确包装器启动参数（`--config/--workspace/--port` + resume）；补充桥↔包装器的 `sessionId` wire 约定（A2A metadata） |
| v5 | 2026-09-11 | - | **增补：A2A 包装器真实集成**。按各包装器真实 CLI 修正启动参数（opencode 无 `--workspace`）；opencode 项目由 Launcher 拉起前置 `opencode serve`；由 MachineConfig 生成 `agents/<kind>.<projectId>.json`；**会话改由包装器按 contextId 持有**，桥不再自造 sessionId 协议。本轮先 OpenCode 打样，Codex/Claude 随后 |
| v6 | 2026-09-11 | - | 对齐集成实现：opencode 打样采用内置默认配置 + CLI 参数（`--directory` / `--opencode-url` / `--port`），`--config` 可选、**暂不生成** `agents/*.json`；`opencode serve` 由 Launcher 拉起/回收；桥仅依赖 contextId |
| v7 | 2026-09-11 | - | **结构重构（按部署位置）**：拆为 `src/orch/`（桥+会话）与 `src/machine/`（launcher+adapters），**删除 `src/shared/`**，线协议类型两侧各自声明（方案 a，无跨单元 import）；config 拆为 `config/orch/` + `config/machine/`；新增 §5 目录结构 |
| v8 | 2026-09-11 | - | 部署单元**提到仓根**（`orch/`、`machine/`，删除 `src/`）；`tsconfig` 改 `rootDir "."` + `include ["orch/**","machine/**"]`；因源码与构建深度不同，新增 `app-root.ts`（向上查找 `package.json`）替代固定相对深度 |
| v9 | 2026-09-11 | - | **单元完全自包含**：`orch/` 与 `machine/` 各自 `package.json` / `tsconfig.json` / `node_modules/` / `dist/` / `config/`；依赖按单元拆分（orch: @a2a-js/sdk+MCP SDK+zod；machine: express+a2a-opencode）；根目录瘦身为无依赖 dev manifest |
| v10 | 2026-09-11 | - | 修复入口脚本：`launcher` / `bridge` 改为**先 `npm run build` 再跑 `dist/**.js`**（Node `--experimental-strip-types` 不解析 `.js`→`.ts`，源码直跑会 `ERR_MODULE_NOT_FOUND`） |
| v11 | 2026-09-11 | - | **增补：中间调用（trace）处理**。源头：launcher 生成 `agents/<kind>.<projectId>.json`（默认 `events.enabled=false`，含每项目 `agent` 配置块：model/mcp/…）并 `--config`；兜底：bridge 过滤 `trace.*` artifacts。实测确认「部分 config 与内置默认深合并」可行 |
| v12 | 2026-09-11 | - | **增补：会话跨退出复用（方案 P）**。查明包装器 `contextId→sessionId` 仅内存、不落盘、不吃外部 sessionId → 需 patch；实测 OpenCode session 跨 `opencode serve` 重启持久，故以 patch-package 让包装器把映射落盘/载入 `<workspace>/.a2a/sessions.json`；上层仍只传 `contextId` |
| v13 | 2026-09-11 | - | **增补：用完退出（空闲回收）**。launcher 记 `lastUsed`，超 `launcher.idleStopMs`（默认 5 分钟）无调用自动 `stop`（回收包装器 + serve）；新增回收日志便于确认；用 OpenCode 打样，为 Q3 落地 |
| v14 | 2026-09-11 | - | **修复：空闲回收误杀执行中的任务**。根因：`a2a_call` 仅开始时 `ensure`，任务轮询不经过 launcher → 长任务被判"空闲"。修：bridge 轮询期间周期性 re-ensure 续约（`LEASE_RENEW_INTERVAL_MS`=5s），任务结束/超预算后停止 |
| final | 2026-09-11 | - | 用户测试通过；文档与实现对齐。本需求（OpenCode 打样）交付：静态分布 + 每机启动器、A2A 包装器集成（生成 config / events 关 trace）、trace 源头 + bridge 兜底过滤、会话跨退出复用（方案 P）、用完退出（空闲回收）+ 轮询续约 |
| v15 | 2026-09-11 | - | 回归测试合并为 `.omo/skills/regression-test/`（移除 `scripts/regression/`）；同步 CLAUDE.md / package.json 命令与 §5 目录结构 |
| v16 | 2026-09-11 | - | 配置约定统一为每单元 `config/config.json`（本地，git 忽略）+ `config/config.json.default`（模板，入库）；代码默认路径同步 |
