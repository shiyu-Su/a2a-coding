# 基于 A2A 的分布式 Code Agent 协作 — 实施方案 v2（方案 B）

> 形态：**静态分布 + 每机启动器 + 泛型工具 + 按需启动 + 零中心注册**
> 范围：本版本只做 **OpenCode / Codex / Claude Code** 三类执行 Agent。
> `pi 家族` / `deepseek-harness` / `zcode` 见 §15（暂缓记录，本期不实现）。

> ⚠️ **P0 权威文档**：P0（A2A 最小闭环）以 [`doc/v0.1.0/A2A最小闭环-改造文档.md`](doc/v0.1.0/A2A最小闭环-改造文档.md) 为准；本文件为 v2 总体设计与演进方向，与 P0 改造文档冲突时以改造文档为准。

---

## 1. 目标与成功标准

**目标**：以 orch Agent 为统一入口，把分布在各环境（Windows / Mac / 多平台）的 Code Agent 通过**静态项目分布**组织起来（orch 持机器清单、每机自持项目配置），经每机启动器**按需启动**，通过 MCP 泛型工具派发任务，实现「讨论在本地、执行在远端/异环境」。

**成功标准（可验证）**
1. 「项目 → 机器」分布**静态可查**；orch 能通过 `a2a_projects` 看到目标项目及其所在机器/运行态。
2. orch 通过 `a2a_call` 派发任务，目标 Agent 按需拉起并在其 workspace 真实执行、回传结果。
3. 多轮对话靠 `contextId ↔ sessionId` 保持；桥/启动器重启后可恢复。
4. **新增/移除项目不需要 orch 重连**（工具面恒定）；机器清单变更由桥重载配置即可，orch 无须刷新工具面。
5. 需澄清时回传 A2A `input-required`；越权操作直接失败。
6. 一条端到端 demo：「改前端 → 改后端 → 联调」跑通。

---

## 2. 核心设计决策

| 决策 | 选定 | 理由 |
|---|---|---|
| orch ↔ 执行 Agent 通信 | **MCP 泛型工具**（`a2a_projects` / `a2a_call`），不是「每 skill 一个工具」 | 工具面恒定 → **零重连**、零工具列表刷新 |
| 项目发现与路由 | **静态分布配置**（orch 持机器清单，每机持项目配置）+ 启动器运行态 | 项目归属稳定、机器数量有限；去掉注册中心，少一个服务与 TTL/心跳/一致性 |
| 执行层包装 | A2A Server 包装各 CLI（优先复用现成） | 不碰 Agent 内部，只包 CLI/headless |
| 会话映射 | 桥/启动器侧维护 `contextId ↔ sessionId`（`node:sqlite`） | 支持多轮 + 重启可恢复 |
| 跨机鉴权 | 反向代理（TLS + Bearer/mTLS） | A2A 包装器入站默认无鉴权，边界补足 |
| 协议 | A2A v1.0（+ v0.3 兼容） | 官方现行规范 |

---

## 3. 总体架构

```
                                   ┌──────────┐
                                   │   用户    │
                                   └────┬─────┘
                                        ▼
                        ┌───────────────────────────────┐
                        │ orch Agent                    │
                        │  + 机器清单(machines)          │
                        └───────────────┬───────────────┘
                                        │ MCP（泛型工具，工具面恒定）
                                        ▼
                        ┌───────────────────────────────┐
                        │ MCP 薄桥                       │
                        │  a2a_projects / a2a_call       │
                        │  按 project→machine 解析        │
                        └───────────────┬───────────────┘
                     ┌──────────────────┼──────────────────┐
                     ▼                  ▼                  ▼
        （跨机链路经反代：TLS + Bearer/mTLS）
          ┌───────────────────┐  ┌───────────────────┐
          │ Launcher (win)    │  │ Launcher (mac)    │   ← 常驻，不做发现
          │ 本机项目配置        │  │ 本机项目配置       │
          │ ensure/stop/health │  │ ensure/stop/health │
          └─────┬───────┬─────┘  └─────────┬─────────┘
                │按需    │按需               │按需
                ▼       ▼                  ▼
          ┌──────────┐ ┌──────────┐   ┌──────────┐
          │ 项目A     │ │ 项目B     │   │ 项目C     │     ← 用完退出
          │ Agent    │ │ Agent    │   │ Agent    │
          │(A2A Srv) │ │(A2A Srv) │   │(A2A Srv) │
          └────┬─────┘ └────┬─────┘   └────┬─────┘
               ▼            ▼              ▼
          workspace A  workspace B    workspace C

        ┌────────────────────────────────────────────┐
        │ 会话/任务存储 (node:sqlite)                 │
        │  contextId ↔ sessionId · 任务态 · artifacts │
        └────────────────────────────────────────────┘
```

---

## 4. 组件选型

| 位置 | 选定 | 说明 / 备选 |
|---|---|---|
| 执行层 A2A Server 包装 | **`shashikanth-gs/a2a-wrapper`**（`a2a-opencode` / `a2a-codex` / `a2a-claude`，MIT） | 一仓覆盖三家、统一 core、JSON 配置；备选 OpenCode 节点用 `Intelligent-Internet/opencode-a2a`（自带鉴权 + SQLite） |
| MCP 桥 | **自建薄桥**（基于官方 `@a2a-js/sdk` 或 `a2a-sdk`） | 只暴露泛型工具；**不采用「每 skill 一工具」的 skillmap** |
| 每机启动器 | **轻量常驻服务**（Node.js/TypeScript + express） | 管理本机项目 Agent 生命周期（`ensure` 幂等拉起 / `stop` / `health`）+ 本机项目清单；不做发现 |
| 会话/任务存储 | **`node:sqlite`**（桥/启动器侧） | `contextId↔sessionId`、任务态、artifacts；Agent 退出后仍可继承上下文 |
| 跨机鉴权 | **反向代理 Caddy/Nginx**（TLS + Bearer/mTLS） | 在 A2A 端点前 |
| 协议 | A2A **v1.0**（开 v0.3 兼容层） | 官方 SDK |

---

## 5. 静态分布与启动器设计

### 5.1 职责划分
- **orch 侧**：维护机器清单（`orch/config/config.json`）——有哪些机器、启动器地址。
- **每机启动器（Launcher，常驻）**：维护本机项目配置（`machine/config/config.json`）——本机有哪些项目、`agentKind`、workspace、A2A 端口；负责本机项目 Agent 的**生命周期**。
- **无中心注册**：不做自注册 / 心跳 / TTL / 服务发现；「项目 → 机器」映射来自静态配置。

### 5.2 数据结构
每机本地配置（`machine/config/config.json`，每机自维护；模板 `config.json.default` 入库）：
```
machine_config {
  machineId : string        # 如 "win-dev"
  launcher  : { port: number }
  projects  : [
    { projectId, workspace, agentKind: "opencode"|"codex"|"claude", a2aPort }
  ]
}
```
orch 侧机器清单（`orch/config/config.json`；模板 `config.json.default` 入库）：
```
machines_config {
  machines: [ { machineId, launcherUrl } ]
}
```

### 5.3 接口（启动器控制面）
```
GET  /projects                  # 本机项目清单（含运行态）
POST /projects/{id}/ensure      # 幂等启动：已在跑则复用，否则拉起 → 返回 A2A 端点
POST /projects/{id}/stop        # 停止该项目 Agent
GET  /health                    # 健康检查
```

### 5.4 幂等与生命周期
- **`ensure` 幂等**：已运行直接返回同一端点，不重复拉起；避免多实例 / 端口冲突。
- Agent **用完退出**（全部任务空闲后回收），有活跃任务期间保持常驻。
- 单实例模型（每个 `projectId` 一个实例），同实例的多个 `contextId` 靠 CLI 原生并发 session。
- 启动动作：按 `agentKind` 拉起对应包装器（`a2a-opencode` / `a2a-codex` / `a2a-claude`）。

---

## 6. MCP 桥设计（方案 B 核心）

### 6.1 只暴露泛型工具（关键）
```
a2a_projects()                              # 聚合各机 GET /projects，列出项目 + 所在机器 + 运行态
a2a_call(project, message, contextId?)      # 派发一轮任务（内部 ensure 拉起 + A2A 调用）
a2a_task_status(taskId)                     # 异步任务查询
a2a_cancel(taskId)                          # 取消
```
**不再**为每个 skill 生成工具 → orch 的工具列表**恒定**。

### 6.2 零重连原理
```
项目/机器增减 ──► 只影响静态配置与各机 Launcher ──► 桥的工具面不变 ──► orch 无需重连/刷工具
orch 每次 a2a_call ──► 桥按静态分布解析 project→machine ──► Launcher ensure（幂等）──► A2A 调用
```
- 不使用 MCP `tools/list_changed`（不依赖宿主的动态刷新能力）。
- 不依赖启动期缓存 Agent 列表（改用「静态分布 + 启动器实时状态」解析）。

### 6.3 a2a_call 处理流程
1. 解析 `project → machine`（机器清单 + 项目索引）。
2. `POST {launcherUrl}/projects/{projectId}/ensure` → 幂等拉起并返回 Agent 的 A2A 端点。
3. 带入 `contextId`（桥/启动器侧查 `contextId↔sessionId` 映射，命中则 resume 底层会话）。
4. 以 A2A Client 发 `message/send`（或 stream）。
5. 结果：文本 + artifacts；若目标返回需澄清 → 冒泡为 `input-required`。
6. 若超过 `syncBudgetMs` → 返回 `taskId`，orch 用 `a2a_task_status` 轮询。

### 6.4 与既有方案的区别（记录）
| | 方案 A（skillmap，每 skill 一工具） | **方案 B（本方案）** |
|---|---|---|
| agent 增减 | 工具列表变 → 可能需重连桥 | **工具面不变 → 零重连** |
| 发现时机 | 启动期读配置/探测 | **每次调用按静态分布 + 启动器状态解析** |
| 实现 | 现成 | 自建薄桥（官方 SDK） |

---

## 7. 三端适配器（OpenCode / Codex / Claude Code）

统一接口：`createSession(contextId) → sessionId` / `sendTurn(sessionId, prompt)` / `resume(sessionId)`。

| 维度 | OpenCode | Codex | Claude Code |
|---|---|---|---|
| 无头调用 | `opencode run "…"`（可 `--attach http://localhost:4096`） | `codex exec "…"` | `claude -p "…"` |
| 结构化输出 | `--format json`（事件含 `sessionID`） | `--json`（首行 `thread.started`→`thread_id`） | `--output-format json`（含 `session_id`） |
| 首轮取 ID | 首个 JSON 事件 `sessionID` | 首行 `thread_id` | `.session_id`（或预置 `--session-id`） |
| 续接 | `--session <id>` / `--continue` / `--fork` | `codex exec resume <id>` / `--last` | `--resume <id>` / `--continue` / `--fork-session` |
| 权限 | `--auto`（否则自动拒绝） | **审批恒 `never`，只有 `--sandbox`** | `--permission-mode …` / `--allowedTools` |
| 备注 | ID 形如 `ses_*` | UUID | **唯一可预置 ID**：`--session-id` |

> 分叉（fork）会更换底层 ID，映射需同步更新。

---

## 8. 会话映射（`contextId ↔ sessionId`）

**数据模型（SQLite）**
- `sessions(project_id, context_id, session_id, agent_kind, created_at, last_used_at)`
- `tasks(task_id, project_id, context_id, state, artifacts_json, updated_at)`
  - `state ∈ working | completed | failed | input-required`

**生命周期**
1. 无绑定 → 新建会话，首轮解析底层 ID 入库。
2. 同 `contextId` → 续接 `sessionId`。
3. 分叉 → 更新绑定为新 ID。
4. 桥/启动器重启 → 从 SQLite 恢复绑定。
5. 超 TTL → 标记过期，不删历史。

按 `agent_kind` 分派 ID 形态（`ses_*` / UUID / UUID）。

---

## 9. 权限策略（headless 安全）

| 任务风险 | OpenCode | Codex | Claude Code |
|---|---|---|---|
| 只读/分析 | 默认（自动拒绝写） | `--sandbox read-only` | `--permission-mode plan` / `--allowedTools Read,Grep` |
| 常规开发 | `--auto` + 限定工具集 | `--sandbox workspace-write` | `--permission-mode acceptEdits` |
| 高权限 | `--auto`（限目录） | `--sandbox danger-full-access` | `--dangerously-skip-permissions`（仅隔离环境） |

- 澄清 → A2A `input-required` 冒泡给 orch。
- 越界 → 命中拒绝规则直接失败回传，不挂起。
- Codex 无审批通道 → 风险分级只能落沙箱三档。

---

## 10. 多环境扩展（Windows / Android / iOS …）

### 10.1 模型：环境 = 构建主机
| 目标环境 | Agent 部署在 | 驱动 |
|---|---|---|
| Windows | Windows 主机 A2A Server | 直接 |
| iOS | **Mac** 主机 A2A Server（Xcode） | `xcodebuild` / 模拟器 / 真机 |
| Android | Mac/Linux 主机 A2A Server | `adb` / 模拟器 / 真机 |

物理设备由主机 agent 驱动，**不作为 A2A 端点**。

### 10.2 路由：静态项目→机器映射
- 「项目 → 机器」由静态配置维护（orch 与每机各持本单元的 `config/config.json`；模板 `config.json.default` 入库、实际配置 git 忽略）。
- orch：`a2a_projects()` 定位项目所在机器 → `a2a_call(project, message, contextId?)`；目标机器由 Launcher 按需拉起对应 Agent。

### 10.3 新增项目/机器（改静态配置，零重连）
```
新增项目：在目标机器 config/config.json 增加 project 配置
   └─► Launcher 重载本机配置
         └─► 桥下次 a2a_projects / a2a_call 即可见
               └─► orch 无需重连、无需刷新工具

新增机器：在 orch 侧 config/config.json 增加一行（machineId + launcherUrl）
   └─► 桥重载机器清单后可见（orch 工具面不变，仍无须重连）
```

### 10.4 设备本身当 Agent（可选，需反向中继）
移动端无稳定入站端口 → 让设备侧 agent **出站**连到中继，orch 只与中继对话：
```
orch ─► 中继/Hub ◄─(出站长连接)─ 设备 agent
```
- 超出 现成 skillmap 能力，需自建中继；**本期不实现**，默认用「主机代理设备」模型。

---

## 11. 跨机鉴权与网络

- **边界**：A2A 端点前置反向代理（Caddy/Nginx），做 **TLS + Bearer**（或 mTLS）。
- **凭证分发**：凭证引用随机器清单（`orch/config/config.json`）维护；桥在 `a2a_call` 时注入 `Authorization`。
- **地址**：A2A 端点由 Launcher `ensure` 返回；Agent Card `advertiseHost` 填真实可达地址，NAT/内网场景由 Launcher 配置覆盖。
- **隔离**：每 agent 绑定独立 workspace；并发 = 多 agent 并行、同 agent 会话独立。

---

## 12. 工作流（时序）

```
用户        orch         MCP桥            Launcher        A2A Server       CLI        workspace
 │ 讨论      │             │                 │               │            │            │
 │──────────►│             │                 │               │            │            │
 │           │ a2a_projects│──GET /projects─►│               │            │            │
 │           │◄────────────│◄──项目+运行态───│               │            │            │
 │           │ a2a_call    │                 │               │            │            │
 │           │────────────►│─解析 project→machine           │            │            │
 │           │             │──ensure(幂等)──►│               │            │            │
 │           │             │◄──A2A 端点──────│──按需拉起────►│            │            │
 │           │             │──A2A message/send(+Bearer)─────►│            │            │
 │           │             │                 │               │ opencode run│            │
 │           │             │                 │               │───────────►│ 改文件/测试 │
 │           │             │                 │               │◄─sessionID─│            │
 │           │             │                 │               │ 存 ctx↔id  │            │
 │           │             │◄──result/artifacts─────────────│            │            │
 │           │◄─工具结果───│                 │               │            │            │
 │◄─汇总输出─│             │                 │               │            │            │
 │  (需澄清) │             │◄──input-required┘               │            │            │
 │◄─提问─────│ 用户答复 → 带同 contextId 续接 sessionId ──────────────────►│            │
```

---

## 13. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 地基** | 每机 Launcher MVP（ensure/stop/health）+ MCP 薄桥（projects/call）+ 单个 OpenCode 项目按需启动 | `a2a_projects` 可见、`a2a_call` 幂等拉起并跑通一次任务（详见 P0 改造文档） |
| **P1 核心** | Codex / Claude 适配器接入；`contextId↔sessionId` 持久化；权限策略；跨机鉴权 | 多轮续接 + 重启恢复 + 非交互权限生效 |
| **P2 工程化** | **新增项目/机器零重连验证**；多环境（win/ios/android）接入；任务态/artifacts 回传；端到端 demo | 「改前端→改后端→联调」+ 澄清路径；新增项目/机器不需重连 |
| **P3 扩展** | 审查/测试/部署 Agent；分布配置的服务化演进（如需）；（可选）移动端反向中继 | — |

---

## 14. 风险

1. **桥自建成本**：方案 B 需自研薄桥（方案 A 有现成），但换来零重连 + 可扩展。
2. **静态分布维护成本**：项目→机器映射靠人工维护；机器/项目频繁变动时需同步配置（P0 暂不解决）。
3. **Codex 审批限制**：`exec` 审批恒 `never`，权限只能靠沙箱三档。
4. **跨机安全**：TLS/凭证管理、地址广播、防火墙需补足。
5. **包装器成熟度**：a2a-wrapper 稳定版滞后、入站无鉴权 → 由反代补；P0 先验。
6. **移动端设备侧**：本期不做，用主机代理。

---

## 15. 暂缓记录（本期不实现）

| CLI | 结论 | 关键点 |
|---|---|---|
| **pi 家族** | 开源、协议面友好，**未来优先接入** | 上游 `@earendil-works/pi-coding-agent`(bin `pi`)、`@oh-my-pi/pi-coding-agent`(bin `omp`) 均内建 **`--mode rpc`（stdio JSON-RPC）**；omp 还有 **ACP**。⚠️ `@code-yeongyu/senpi` 同时占用 `pi` bin，同镜像冲突 |
| **deepseek-harness** | 官方（MIT），但 headless 是陷阱 | `dsh --profile headless` 一次性纯文本、**无会话续接/无 JSON**；应改用 **`--profile sdk`（JSON-RPC）或 `acp`**；权限 `DSH_PERMISSION_MODE`。⚠️ 同名 squat 包多，官方为 `@deepseek-ai/dsh` / `deepseek-harness-sdk` |
| **zcode** | 专有 + 协议漂移，优先级最低 | 大概率指 **Z.ai/Zhipu ZCode 桌面 ADE**（闭源，无官方 CLI），靠社区提取运行时 `zcode.cjs`，私有 `app-server --stdio`，权限需 `--mode yolo` 才能写；可抄社区 **ACP 桥**（`zcode-acp-server` / `zcode-open-bridge`）。另有 ≥7 个同名开源项目，**需确认所指** |

---

## 16. 待决策

1. 跨机鉴权：Bearer（简单）还是 mTLS（更强）？
2. P0 的 OpenCode 节点：`a2a-wrapper` 的 `a2a-opencode`，还是 `opencode-a2a`？
