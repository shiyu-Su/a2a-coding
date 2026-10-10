# PROTOCOL — Runner ⇄ Bridge 线协议契约（2.3）

本文件是 machine（Launcher 升格为 **Runner**，出站方）与 orch（**Bridge**，入站承载方）之间 HTTP 线协议的**单一事实源**。v0.7.0 起连接模型整体反转为 **pull**：**Runner 主动出站连桥**，桥不再向机器发起业务调用。线协议类型与版本常量在两侧各自声明（`orch/types.ts` / `machine/types.ts`），以本文件 + 契约测试（`.omo/skills/regression-test/tests/test-protocol-version.js`）保持一致；修改协议时**先改本文件**，再同步两侧实现。

- 当前版本：**2.3**（两侧同名常量 `PROTOCOL_VERSION`）
- 主笔归属：**orch 主笔、machine 审阅**（仓根唯一单写面）。
- 适用范围：仅 Runner ⇄ Bridge HTTP（`/runner/*`，挂载于桥的常驻 HTTP transport、复用 MCP 端口，不引第二接入面）。Runner ⇄ 本地 A2A 端点走标准 A2A 协议（自带版本）；MCP 工具面（`a2a_*` 工具出入参）不属本契约。约束：两部署单元自包含、无跨单元 import —— 因此协议以「文档 + 契约测试」对齐，不做共享 schema 包。

## 非契约面（明示）

- **machine 本地 `GET /health`**（`{ ok, protocolVersion, status, bridge }`）是**机器本地内部接口**（loopback，供 `launcherctl` / `reaper` / 运维探活），**不是跨机契约面** —— 其字段属 machine 私有实现，本文件不做保证。Runner 的注册态经由 `bridge` 段自报，但该段不是桥的输入。
- 桥侧 `GET /health`（MCP transport 健康）与 `POST /mcp` 同样不属本契约。
- 机器侧**不再暴露任何业务入站端点**：1.0 的 `GET /projects`、`POST /projects/{id}/ensure`、`POST /projects/{id}/stop` 已退役（命中 404）。

## 端点

`/runner/*` 仅由 core 租约 `owner` 的桥实例提供（follower ⇒ 503 `runner_not_owner`）；桥接入面为**常驻 HTTP**（现唯一形态，`transport.mode` 恒为 `"http"`，stdio 已退役）。全部 **POST + JSON**，统一外壳 `{ result, data, error }`；请求头 `Authorization: Bearer <token>`（per-machine 静态 Bearer：machine 侧 `launcher.bridge.token` ↔ orch 侧 `machines[].token`；常量时间比较）。

### POST /runner/register

Runner 启动自检通过后首触（注册 / 刷新投影）。

请求体：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `machineId` | string | 是 | 机器标识；必须 ∈ 桥配置 `machines[]` |
| `protocolVersion` | string | 是 | `"major.minor"`；主版本必须 ∈ `SUPPORTED_PEER_PROTOCOL_MAJORS`（`orch/types.ts`） |
| `projects` | array | 否 | 本地项目投影（缺省 `[]`）；每项见下 |
| `capabilities` | object | 否 | **可扩展能力对象**（2.0 为 `{}`）；键值自由，**桥对未知字段一律忽略**（不落库、不校验）。**注**：OS / 工具链等能力字段的正式约定 **v0.8.0 扩展时议**（本版不定义、不校验） |
| `selfCheck` | object | 否 | Runner 自检结论 `{ ok, failures }`；桥**不解析**（宽容忽略） |
| `version` | string | 否 | Runner 软件版本（观测用） |

`projects[]` 项：`projectId`（必填）/ `agentKind`（必填，`"opencode" \| "codex" \| "claude" \| "qoder-cn"`）/ `a2aPort`（必填，1–65535 整数）/ `risk`（可选，`"read" \| "write" \| "full"`）/ `status`（可选，`"online" \| "offline"`）/ `workspace`、`endpoint`、`startedAt`（可选，观测用）。未知字段忽略。
<!-- agent-kinds: opencode,codex,claude,qoder-cn -->

> **`agentKind` 取值集合规范源**：上行为 `agentKind` 取值集合的**机器可解析规范源锚点**（供回归断言以正则捕获）。orch（`orch/types.ts` 的 `AGENT_KINDS`）与 machine（`machine/agent-kinds.ts` 的 `AGENT_KINDS`）**各自派生常量、不共享代码**（两单元自包含），两侧一致性由回归断言「本地清单 == 锚点」锁定（两侧同一捕获正则）。

> **作用域（锚点用途）**：本文件定义域**仅覆盖 Runner ⇄ Bridge HTTP 线协议**（见文首「适用范围」），该锚点**仅供两侧 `agentKind` 清单对齐**使用。**ACP 适配契约不得写入本文件**，另落 machine 侧文档。

响应 200：`{ "result": "ok", "data": { "ack": true, "runnerId": string, "machineId": string, "protocolVersion": string, "projects": string[] }, "error": null }`

- `ack` = `true`（注册确认）；`runnerId` = `machineId`（1:1）；`projects` = 本次采纳的项目 id 数组。

幂等：注册是**投影刷新**（`upsertRunner` + 项目全量替换），可重复调用。

### POST /runner/connect

Runner 长轮询（**poll 即心跳**）：携带 `machineId`，可携带本轮限定项目、hold 上限与上一轮产生的 `acks`。

请求体：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `machineId` | string | 是 | 同 register；亦为心跳主体 |
| `projects` | string[] | 否 | 本轮仅领取这些项目（去重；缺省 = 本机已注册且为成员的全部项目） |
| `holdMs` | number | 否 | 非负整数；**只可缩短**，上限被服务端截断为配置 `runner.holdMs` |
| `acks` | array | 否 | 控制命令回执（见「命令回执」）；桥**宽容接收但不消费**（归入未知字段忽略） |

响应三态：

- **200 + 命令**：`{ "result": "ok", "data": <命令>, "error": null }`（有可下发命令时立即返回）；
- **204 无体**：hold 到期仍无命令 = **心跳**；
- **错误**：统一错误外壳（见「错误码族」）。

命令族（三类，即 `data` 载荷）：

| 判别字段 | 载荷 | 语义 |
|----------|------|------|
| `"dispatch"` | `{ command, taskId, projectId, contextId, commandId, message, claimToken, featureId, dependencies, inputs, taskType? }` | 派发一条任务：Runner 本地 `ensure`（幂等复用）→ 本地 A2A `message/send` → 轮询至终态 |
| `"stop"` | `{ command: "stop", projectId, commandId }` | 停止**本机单个项目** Agent（`projectId` = **该 stop 目标项目**；**不是停全部**）：Runner 以本机在飞台账自决 —— `in-flight > 0` 拒收，回执 `error: "in-flight"` |
| `"cancel-task"` | `{ command: "cancel-task", taskId, projectId, commandId }` | 取消某在飞任务（Runner 经台账按 `taskId` 定位项目 → 本地 A2A `tasks/cancel`；台账无此 taskId ⇒ 回执 `error: "unknown-task"`，本地句柄未取得 ⇒ `error: "not-started"`） |

**命令公共字段（必填）**：三类载荷一律必携 **`commandId`**（string）—— 桥侧 `uuid` 生成的命令标识；`stop` / `cancel-task` 的 machine 回执 `{ commandId, error? }` 以它**原样带回**（见「命令回执」），`dispatch` 的 `commandId` 供观测 / 对账（其结果走 `/runner/result`，不走回执）。`stop` / `cancel-task` 另必携 **`projectId`**：`stop` 由桥侧显式指定目标项目；`cancel-task` 由桥侧任务记录解析补入（machine 侧按 `taskId` 定位台账，不消费该字段）。

`dispatch` 字段：`taskId` = 桥侧任务 id（**回传幂等键的一半**）；`contextId` = A2A 会话上下文；`message` = 派发消息全文；`claimToken` = **本次领取令牌**（回传结果时必须原样带回）；`featureId` = 所属 Feature（可为 `null`）；`dependencies` / `inputs` = 上游依赖与产物引用（Runner 仅展示，顺序由桥保证）；**`taskType`（可选，v0.10.2 引入）= 职责位**，取值 ∈ 下方 `task-types` 锚点闭集，**缺省 `unit_agent`**（键缺省 = 未声明 ⇒ 按 `unit_agent` 处理）。
<!-- task-types: unit_agent,product_manager,project_manager,dev_manager -->

> **`taskType` 取值集合规范源**：上行为 `taskType` 取值集合的**机器可解析规范源锚点**（供回归断言以正则捕获）。orch（`orch/types.ts` 的 `TASK_TYPES`）与 machine 侧对应模块**各自派生常量、不共享代码**（两单元自包含），两侧一致性由回归断言「本地清单 == 锚点」锁定（与上文 `agent-kinds` 锚点同一捕获形制）。
>
> **为何 `PROTOCOL_VERSION` 保持 `2.3` 不升（v0.10.2 判据）**：`taskType` 是**可选键**、**缺省值 = `unit_agent` = 该字段引入前的唯一行为**，且**不下发即现状** —— 未升版 Runner 按「未知字段忽略」伞整键丢弃本键，其判定与消费语义与 2.3 逐字一致，不存在单向不兼容变更。按 `需求流程.md` §7 协议版本规则（「可被对端完全忽略且不影响任何判定 / 消费语义的新增字段 ⇒ 不升版」），本次**不 minor bump**。（消费侧对本键的非法值处置属 machine 侧 intake 语义，不改变本判据。）

**优先级**：控制命令（stop / cancel-task）**先于** claim 评估 —— 已就绪的控制命令总是优先下发，避免「先 claim 再发现该下发 stop」而丢任务；多条按入队时刻（同刻按入队序）取最早就绪者。

**hold 与 wake**：

- 服务端挂起上限 = `runner.holdMs`（**缺省 25000ms**，配置可改；请求 `holdMs` 只能缩短、不可超过配置值）；hold 到期返回 204。
- **wake 语义**：新任务入队 / 新事件到达时，桥按 `machineId` 立即唤醒挂起的 `/connect`（省略 `machineId` = 广播）；被唤醒者重新评估控制命令与 claim ⇒ **命令/任务的下发延迟不受 hold 上限约束**，hold 只决定空转时的心跳节拍。
- Runner 侧客户端超时 30000ms（> 缺省 hold 25s），超时按失败退避。

### POST /runner/result

Runner 任务终态回传（**ack 语义**）。Runner 侧结果**先本地持久化后回传**（持久化路径属机器本地实现，**非契约**）：**HTTP 2xx = ack ⇒ 删文件**；否则保留并退避重试（1s → 2s → 4s → … cap 30s，±20% jitter）。

请求体：`{ machineId, taskId, claimToken, state, text?, artifacts?, projectId?, contextId?, remoteTaskId?, failureKind?, diagnostics? }`

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `machineId` | string | 是 | 鉴权与幂等键的一半 |
| `taskId` | string | 是 | 桥侧任务 id；**幂等键 = `(machineId, taskId)`** |
| `claimToken` | string | 是 | 必须与桥侧落库的领取令牌一致（入站第 3 校验点）；不一致 ⇒ 409 `claim_token_mismatch` |
| `state` | string | 是 | `"working"` / `"completed"` / `"failed"` / `"input-required"` / `"blocked"` |
| `text` | string | 否 | 结果文本 |
| `artifacts` | array \| string | 否 | 产物（数组或 JSON 字符串） |
| `projectId` / `contextId` | string | 否 | 缺省沿用桥侧落库值 |
| `remoteTaskId` | string | 否 | 远端任务句柄（观测用） |
| `failureKind` | string | 否 | **机器侧失败大类**（**2.3 起六类闭集**：`"agent"` \| `"transport"` \| `"runner"` \| `"model_queue"` \| `"timeout"` \| `"business"`；v0.8.7 新增字段、v0.8.8 硬切取值集合）：由 **Runner** 判定（它是唯一同时看得见 `ensure` / transport / 自有超时的位置），**仅 `state="failed"` 时有值**；`timeout` 类**必带子键** `diagnostics.timeoutScope`。判不出 ⇒ **不报该键**（字段本有可选语义）。**旧值 `"infra"` / `"task"` 自 2.3 起非法但仍可被接收**（接收端兜底口径见下「失败分类」）。**桥不消费该字段做自动重试判据**（重试执行在 machine，orch 只登记策略白名单）—— 其存在是给桥记账、运维 / 观测读 |
| `diagnostics` | object | 否 | **机器侧诊断**（**v0.8.7 新增**）：`{ acpErrorKind?, elapsedMs, chunkCount?, stage }`，`stage ∈ {"ensure","send","poll","wait"}`；`acpErrorKind ∈ {spawn, closed, timeout, rpc, protocol}`（桥内原生类别）。失败态必带；成功态仅在桥带了诊断时才带。**桥只读 `acpErrorKind` 用于失败分类映射**，其余键仅观测。v0.8.8 起该对象内的新增键（`timeoutScope` / `continueAttempts` / `acpErrorCode` / `acpErrorData` / `partialChars` / `updateCount` / `firstChunkElapsedMs` 等）**全部在「未知字段忽略」伞下，不单独触发版本变更** |

响应 200：`{ "result": "ok", "data": { "ack": true, "taskId": string, "state": string, "idempotent": boolean }, "error": null }`

- `ack` = `true`；`idempotent` = `true` 表示本条回传与落库态相同（**首个终态胜出**，重复上报幂等）。

**幂等键 `(machineId, taskId)`**：结果按此键 upsert；同一任务重复到达（断桥重连 / outbox 重投）不产生重复副作用。任务不存在于本机队列 ⇒ 404 `task_not_found`。

**迟到 / 重复终态 = 2xx-with-ignore（契约，v0.8.7 起显式落档）**：终态**首个胜出**（`WHERE state NOT IN ('completed','failed','blocked')`）⇒ 迟到 / 重复的终态回传**整条零写入**，回执**恒为 200 + `ack:true`**（`idempotent` 回显是否同值）；与**已落终态不一致**时另记一条 warn 留痕。**不得改成 4xx** —— Runner 侧 outbox 对**任何非 2xx 一律保留待重试**，改成 4xx 会让已落终态的迟到件**无限退避死循环**（`pending` 永不清、`.outbox` 文件永留）。该幂等口**同时兜住**「桥侧墙钟判死后的迟到件」与「Runner 启动补结算件」两类。

**失败分类（事实归 Runner、闭集校验与记账归桥，2.3 起六类）**：Runner 只报**原生事实**（`diagnostics.acpErrorKind` 及下表信号来源），**不得预映射**成六类之外的自造 vocabulary（否则取值集合变更要动两端）；分类权在 machine（**报得出才报、判不出不报 `failureKind` 键**），桥侧做**闭集校验 + 落库**，并保留一个**兜底映射**（`mapAcpErrorKindToFailureKind` 改值域后；**唯一触发条件 = machine 未上报合格六类值**，不是并行分类器）。**machine 原生信号 → 六类的对应（清单）**：

| 六类 | machine 侧原生信号（判定来源） |
|---|---|
| `agent` | `acpErrorKind ∈ {spawn, closed}`（后端进程拉起即败）；后端 `rpc` / `protocol` **明确拒绝**（**是后端语义拒绝，不是 transport**） |
| `transport` | **仅 launcher↔桥 HTTP 层失败**：传输标记 + 连接级失败判据 + 阶段 `stage ∈ {send, poll}` |
| `runner` | launcher `deadline` 耗尽 / `ensure` 失败 / **启动补结算孤儿**（本机已无执行体 = 载体侧事实；补结算上报路径本版起必须带值，否则六类在该路径缺角） |
| `model_queue` | **machine 恒不产出**（ACP 层无队列概念、无独立信号）—— 只能由桥侧跨任务视野**启发式推论**且**显式标注为启发式**；原料 = `updateCount` / `partialChars` / `firstChunkElapsedMs` / `acpErrorCode(+Data)` |
| `timeout` | `acpErrorKind="timeout"` ⇒ **子键 `timeoutScope="acp-prompt"`**（桥 prompt 满窗）；launcher `timedOut` ⇒ **子键 `timeoutScope="runner-deadline"`** —— 两条路径同归本类、**靠子键分家**（否则 timeout 会在 `runner` 与 `timeout` 两处被重复认领） |
| `business` | 后端正常收尾 ∧ 输出含失败结论块（`a2a-outcome` 约定）= 原 `"task"` 的直系继承 |

**兜底口径（入站方向，硬契约）**：`/runner/result` 对 `failureKind` **不做整包 400 拒收** —— **缺键 / 旧值 `"infra"` / `"task"` / 未知值** ⇒ 一律落**安全兜底类 `business`**（「不可重试」侧），并**记一条 warn 且必须带上原值**（如 `failure_kind_fallback=<infra>`，供事后区分「真 business」与「兜底 business」）。理由：版本握手只校验主版本 ⇒ 2.2 机器 + 2.3 桥**必然存在混跑窗口**，若对旧值硬拒 = 混跑窗口内旧机任务全部结不了账 = **丢单**。**⚠ 入站宽容与存量库行读侧安全（非法值 ⇒ 兜底 + warn 的读侧放宽 + 存量迁移置 NULL）互补、不可互替**。`business` 不标 `model_queue` 之外的自动动作：`model_queue` 在策略表登记为**不自动重试**（后端还在排队，重跑还得排），只做可见面标注。

**全库两个写口**：本端点的闭集写入，与桥侧**孤儿墙钟**判死时自置（**2.3 起直写六类中的「不可续跑」子类**，v0.8.7 的 `infra` 直写口径废止；**不得与 `timeoutScope="acp-prompt"` 的 Timeout 混淆** —— 后者是「本可续跑」的症状面）；二者均遵守「**首个终态胜出**」——迟到 / 重复上报不得改写既有分类。

### 命令回执（acks）

`stop` / `cancel-task` 的执行结果由 Runner 在**下一轮** `/runner/connect` 的 `acks[]` 中带回：`{ commandId, error? }`（`error` 缺省 = 成功）。`dispatch` 的结果**不走回执**，走 `/runner/result` + outbox。回执为**观测通道**：桥当前宽容接收，不作为控制流依赖。

### 错误码族

非 2xx：`{ "result": "error", "data": null, "error": { "code": string, "message": string } }`

| code | HTTP | 触发 |
|------|------|------|
| `runner_unauthorized` | 401 | 缺 Bearer token / token 不匹配 / 该机未配置 token（**绝不 fail-open**） |
| `runner_not_allowed` | 403 | `machineId ∉ machines[]`（注册白名单） |
| `protocol_version_mismatch` | 403 | 主版本 ∉ `SUPPORTED_PEER_PROTOCOL_MAJORS`（含实测版本、可支持清单与升级指引） |
| `project_not_a_member` | 403 | `/runner/connect` 显式清单含非成员项目（`projectGroup` 选择性连接） |
| `runner_not_owner` | 503 | 桥实例非 core 租约 owner（follower；端点仅 owner 提供） |
| `bad_request` | 400 | 必填字段缺失 / 类型非法 / 请求体非 JSON 对象 |
| `payload_too_large` | 413 | 请求体超限（1 MiB） |
| `method_not_allowed` | 405 | 端点仅 POST |
| `task_not_found` | 404 | `/runner/result` 的 `taskId` 在本机队列无记录 |
| `claim_token_mismatch` | 409 | 回传令牌 ≠ 落库领取令牌（陈旧 / 已清算领取）。**Runner 收到 409 的语义 = 「任务已被回收、本机台账条目作废」⇒ 删条目、不无限重试**（此时任务已回队等重派，不是丢单）。**例外 = 补结算窄口（v0.8.7）**：`state="failed"` ∧ 行仍**绑定本机领取**（`claimed_by` = 上报 `machineId` ∧ 行 `state="working"`）⇒ **受理** —— 覆盖「无 `claimToken` 的启动补报」与「墙钟判死后的迟到件」两种；无令牌时 `text`（失败原因）**非空必填**，缺 ⇒ 400；命中时桥记 `warn` 审计行（machineId / taskId / 距 `claimed_at` 耗时）。**行级绑定即安全边界**：行若已被**他机重领** ⇒ `claimed_by` 已覆写 ⇒ 仍 409（窄口不得击穿既有保护）。窄口**只能置 `failed`**，不能置 `completed` |
| `internal_error` | 500 | 未预期异常 |

**准入校验链（`/runner/register` 顺序）**：Bearer 形态 → JSON body → `machineId` 非空 → `machineId ∈ machines[]`（403 `runner_not_allowed`）→ token 已配置且匹配（401 `runner_unauthorized`）→ `protocolVersion` 非空（400）→ 主版本 ∈ `SUPPORTED_PEER_PROTOCOL_MAJORS`（403 `protocol_version_mismatch`）→ `projects[]` 结构校验（400）。`/runner/connect` / `/runner/result` 复用前四步，后者再加 `claimToken` 比对（409；**含 v0.8.7 补结算窄口例外**，见错误码族）。

**未知字段忽略**：三个端点请求体一律**宽容解析** —— `capabilities` / `acks` / `selfCheck` 及任何未列字段均不导致 400、不落库、不进入判据；只有**已列入契约的必填字段**参与校验。

> **v0.8.7 新增的两个可选请求字段**（`failureKind` / `diagnostics`，见 `/runner/result`）：当时**沿用 2.2、未升版**，与版本规则「加可选字段 → minor +1」条文的取舍曾登记待裁（`planlog.md`「跨版本登记项」）。**v0.8.8（2.3）已裁**：**仅新增可忽略的可选字段本身不触发升版**；2.2 → 2.3 的实际触发器是 **`failureKind` 取值集合成员移除**（`infra` / `task` → 六类闭集）—— 属**取值集合变更**且**单向不兼容**，按版本规则须**两侧同升**（见演进记录表 2.3 行）。**本裁定的判据已升为版本规则一般判据**（见「版本规则」第一条：可完全忽略且不影响判定 / 消费语义 ⇒ 不升版）。

> **`diagnostics` 内部加键**（v0.8.8 计量键等）：在「未知字段忽略」伞下，**不单独触发版本变更**；触发 2.3 的只有 `failureKind` 取值集合变更。

## 版本规则

- **加可选字段**（请求或响应）—— **以判据为准，不默认升版**：字段**可被对端完全忽略且不影响任何判定 / 消费语义** ⇒ **不升版**（主版本、minor 均不变，沿用当前版本）；**引入新可观测行为，或把原本可选 / 无约束项收紧为必填 / 闭集成员** ⇒ **minor +1**（主版本不变，旧对端可忽略未用部分）；
- **变更必填字段的取值集合**（**新增 / 更名 / 移除成员**，如 `agentKind` 的成员增减或改名、`failureKind` 的合法取值集合更替（2.3：`{infra, task}` → 六类闭集））→ minor +1，主版本不变；旧对端仅在未使用变更取值时兼容；
  - ⚠ **更名与移除是「单向不兼容」**：变更后的取值对未升级对端会被拒，旧取值对已升级对端同样被拒；且拒绝发生在**整包项目级**（`projects[]` 结构校验失败 ⇒ 该 Runner 上报的**全部项目**一起被 `400 bad_request` 拒、该机对桥不可见），**不是只拒那一个项目**。
  - ⇒ 因此**版本号本身不构成兼容窗口**（`/runner/register` 的版本握手只校验**主版本**，枚举取值集合由闭集校验强制）⇒ **更名 / 移除必须由部署侧在同一切换窗口内完成（两侧同升）**，并**在本节下方演进记录表新增一行**登记；**不得跨版本混跑**（旧机与新机同时在线时，必有一侧整包被拒）。
- **删字段 / 改字段语义 / 加必填请求体或必填参数** → major +1；
- 桥在 `/runner/register` 校验 Runner 主版本：不在桥侧 `SUPPORTED_PEER_PROTOCOL_MAJORS`（`orch/types.ts`）清单内即 **403 `protocol_version_mismatch`**（结构化错误含机器 ID、实测版本、可支持清单与升级指引）；同主版本内 minor 差异兼容放行；
- 跨主版本一律明确拒绝（fail-fast），不做静默降级猜测；按版本的行为降级适配必须显式写分支（以注册载荷中的完整版本号为依据）。

### 2.0 硬切语义

v0.7.0 发版即**硬切**：连接模型由 push（Bridge → Launcher 入站）整体反转为 pull（Runner → Bridge 出站）。

- 1.0 业务端点（`GET /projects`、`POST /projects/{id}/ensure`、`POST /projects/{id}/stop`）整体退役（机器侧 404）；桥侧出站调用面（按 `launcherUrl` 拨号、首触 `/health` 握手与缓存、`in-flight` 去重）随之删除。
- `SUPPORTED_PEER_PROTOCOL_MAJORS = [2]`：不保留 1.0 兼容分支；旧版 Runner 注册被拒并获升级指引。
- “Runner 未注册 / 心跳超时”改由**注册表运行态投影**表达（`runner.state` / `lastHeartbeatAt`），不再有握手版本缓存。

## 可支持对端版本的维护流程（每次协议变更执行）

1. 按版本规则定新版本号；
2. 若主版本升级 → 显式决策桥的 `SUPPORTED_PEER_PROTOCOL_MAJORS`：保留旧主版本支持则留在清单并维护对应行为分支；放弃支持则移出（旧机被拒绝并获升级指引）；
3. 更新下方演进记录表（含「对端最低要求」列）；
4. 同步两侧 `PROTOCOL_VERSION` 常量，并确认契约测试全部通过。

## 演进记录表

| 版本 | 变更内容 | 破坏性 | 对端最低要求 |
|------|----------|--------|--------------|
| 1.0（v0.1.2） | 初始版本化：**push 模型**（Bridge → Launcher 入站）：`GET /projects`、`POST /projects/{id}/ensure`、`POST /projects/{id}/stop`；`GET /health` 自报 `protocolVersion` | — | 机器 ≥ 1.0；桥 ≥ 1.0（首触握手校验） |
| 2.0（v0.7.0） | **pull 模型**（Runner → Bridge 出站）：`/runner/register`、`/runner/connect`（长轮询 hold 缺省 25s + wake）、`/runner/result`（ack）；命令族三类 dispatch / stop / cancel-task；幂等键 `(machineId, taskId)`；`capabilities` 可扩展 + 未知字段忽略；错误码族 `runner_not_allowed` / `runner_unauthorized` / `runner_not_owner` / `project_not_a_member`；**1.0 端点与握手硬切退役（本版发版时）**；machine 本地 `/health` 明示为**机器本地内部接口、非契约面** | 是（major） | Runner ≥ 2.0（携 `protocolVersion`，主版本 ∈ `[2]`）；Bridge ≥ 2.0（`SUPPORTED_PEER_PROTOCOL_MAJORS = [2]`，拒 1.0） |
| 2.1（v0.8.0） | agentKind 取值集合扩展（+qoder）；实际强制来自 agentKind 闭集拒绝，版本握手只校验主版本（SUPPORTED_PEER_PROTOCOL_MAJORS=[2]） | 否（minor） | 使用 qoder 的 Runner 要求 Bridge ≥ 2.1（旧 Bridge 对 qoder 注册以 400 bad_request 拒绝） |
| 2.2（v0.8.6） | agentKind 取值集合**更名**：`qoder` → `qoder-cn`（**旧值不再合法**）；实际强制来自 agentKind 闭集拒绝，版本握手只校验主版本（SUPPORTED_PEER_PROTOCOL_MAJORS=[2]） | 否（minor，沿 2.1 先例：取值集合变更 + 单向不兼容） | 使用 `qoder-cn` 的 Runner 要求 Bridge ≥ 2.2；**旧值 `qoder` 本版起于两侧均非法**（旧 Bridge 对新值同样 400 拒整包） |
| 2.3（v0.8.8） | `failureKind` 合法取值 → **六类闭集** `agent` / `transport` / `runner` / `model_queue` / `timeout` / `business`；**旧值 `infra` / `task` 自 2.3 起非法但仍可被接收**（接收端兜底为 `business` 并 warn 留原值，见 `/runner/result`「失败分类」）；`timeout` 必带子键 `diagnostics.timeoutScope`（`acp-prompt` / `runner-deadline`）；`diagnostics` 新增计量键均在「未知字段忽略」伞下、不单独触发版本变更 | 否（minor；但**取值集合成员移除 ⇒ 单方不兼容 ⇒ 两侧须同升**——握手只校验主版本，旧值靠接收端兜底而非握手挡） | Runner ≥ 2.3 上报六类（未升级 2.2 Runner 上报 `infra`/`task` 被兜底为 `business` + warn 留原值，混跑期账面口径见改造文档 §6-9）；Bridge ≥ 2.3 闭集校验 + 兜底落库 |
| —（沿用 2.3，v0.10.0） | `/runner/register` 注册载荷新增**可选字段 `repo`**（仓库标识，供版本面按仓库拓扑归一 —— 拓扑无关、polyrepo / monorepo 双支持）。该字段**可被对端完全忽略、不进入任何判定 / 消费语义** ⇒ 按版本规则一般判据（第一条）**不升版**（主版本、minor 均不变，沿用 2.3） | 否（新增可忽略的可选字段 ⇒ **不升版**，见版本规则第一条判据） | 无新要求（旧 Runner 不携 `repo` 仍合法，桥按缺省处理；新旧可混跑） |
