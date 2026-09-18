# Changelog

本项目的所有重要变更都记录在此文件。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

# Changelog

本项目的所有重要变更都记录在此文件。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [v0.6.1] - 2026-09-18

> 主题：**编排引擎失败上收与项目串行**（REQ-v0.6.1-2026-09-17-05）。**删除失败自动化五层自愈机制**（失败分类 / 中性化 / 取证流 / 自动重试 / D5 硬闸），改为**失败隔离 + 静止收敛 + 账单交宿主**：失败只冻结依赖闭包下游（在飞不动），Feature 不再因业务失败判死（`failed` 退化为 DAG 结构非法 fail-fast 专用）；失败收敛 = **`executing` 自然静止** + **新事件 `feature.failure_report`**（账单含 failed 列表 / 错误文本 / contextId / blockedSet），重派 = **`a2a_feature_advance(..., retryTaskIds?)`**（重派指定 failed 节点 + 解冻其被冻下游；不加状态机自环、与 `answer` 互斥、已派发被冻节点解冻不清 `remoteTaskId` 防双派）。**同 project 粒度串行**（同 project 同一时刻最多 1 个任务在写；跨 project 保持并行）+ **静止期禁 ensure**（不再把空闲回收窗口顶掉）。`needs_input` 保持单一来源（任务停下问问题）。**线协议不变**（PROTOCOL 1.0）；**machine 单元零源码改动**（仅 package.json 版本号）；工具面 12 个数量与既有签名不变（`advance` 加可选 `retryTaskIds` additive 入参）。**派发消息自包含规范**入 `flow/spec`（H4，异机 worker 无宿主文件系统）。详见 `doc/v0.6.1/失败上收与项目串行-改造文档.md`（v4(final)，47 条问题清单承接自 v0.6.1 现状梳理 ①②）。

### Added

- **失败隔离（依赖闭包级）**：任一节点失败 → 仅冻结其依赖下游中**未派发**节点（`blocked`）；**在飞节点不动**；其余节点（含其它 project）照常派发、结果有效。`needs_input` 保持单一来源（任务 `input-required` 停下问人）。
- **静止收敛 + `feature.failure_report` 事件**：收敛（无可派发 && 无在飞）且存在失败 ⇒ Feature **保持 `executing` 自然静止**（零动作、不进任何异常态），发一条 failure_report（进程内 signature 去重，一次/静止期；重派使集合变化即重新武装）；全 completed 照旧自动进 `integrating`。`a2a_feature_status` 节点摘要增可选 `text` / `contextId`（账单字段，additive）。
- **`a2a_feature_advance` 增可选 `retryTaskIds?: string[]`**（v0.6.1 REQ-05 新语义）：重派指定未处置 `failed` 节点 + 解冻其被冻下游；`handleFeatureAdvance` 显式特例（`TRANSITIONS` **不加自环**），`to` 必须 `"executing"`；与 `answer` 互斥（同传 `feature_conflicting_args`）；不传/非法集合 ⇒ `feature_nothing_to_resume` 结构化拒绝（防抖振）；重派复用 `rearmForRetry` CAS + 显式 `kick()`；事件 `task.rearmed` 留痕。
- **project 粒度串行**：`session/store.ts` 新增 `listBusyProjectIds()`（存在 `working ∧ remote_task_id != NULL` 的项目集，独立 SQL，不受 `listTasks` clamp 限制）；就绪判定按 projectId 过滤 + 项目预留与 `inFlightNodes` 同步段落位（跨 Feature 并发正确性）；**静止期禁 ensure 不变量**（executing 双义子态判据，防误续命顶掉 `idleStopMs` 回收窗口）。
- **回归用例 v0.6.1**：`test-v0.6.1-failure-semantics.js`（32 条：新符号存在性 / **五层符号零命中** / kind 六值清单 / 冻结-静止-重派-解冻断言）；`.omo` 旧失败自动化用例四文件退役（v0.4.1-timeout-failure-automation / v0.5.0-evidence-parse / v0.5.0-retry-timing / v0.5.1-failure-closure —— 其题材整体随五层删除）；`task-result-guarantee` 与 `v0.6.0-project-group` 两文件的 3 处判据对齐 v6.1 语义（isLocalTerminalState 合一 / probeProjectReady 退役）。

### Changed

- **三处 `package.json` 版本号升至 `0.6.1`**（根 / `orch` / `machine`；根为版本源）。
- **`recover()` 不再整单判死**：重启时在飞节点按 `interrupted` 置 `failed` 但 **Feature 不 `failFeature`**（交给静止收敛交宿主裁量）；`reduceConvergence` 删除 `failed` 臂、`blocked` 升为良性终态。
- `orch/bridge/index.ts`：“先占位后发”派发顺序（`dispatch_guard` 列迁移，ctor try-ALTER）修 **C11 派发崩溃窗口重复派发**；`a2a_task_status` / `a2a_cancel` 的**远端 id 反查落库**（`bridge/task-lookup.ts` 新增）修 **A5-5 本地 id 查远端**；`limit 1000` 截断告警修 **C12**；`isLocalTerminalState` 同义双份合一。
- `bridge/task-watcher.ts`：`persist` 异常与 `poll` 异常分离分类（修 **A5-2**，看护不再把落库失败误判成轮询放弃）。
- **三列休眠**：`exhausted` / `not_before` / `last_poll_at` / `failure_kind` 保留列自 REQ-05 起**停止读写**（schema 不 DROP；`retryCount`/`failureKind` 出参字段保留、语义休眠恒 0/null——登记为出参不变、语义休眠）。`needs_input` 彻底单源：ogets 三处取证交人出口（兜底扫描 / settle / evidenceSettled）随取证流整块删除。
- `flow/spec/` SDK：`引擎映射.md`（失败非异常态 / 静止语义落 §2/§4 二分判据 / `retryTaskIds` 一句 / `拓扑派发（并行/串行资源约束由运行底座决定）`）+ `需求流程.md` **H4 派发消息自包含**（异机 worker 无法读宿主侧 doc ⇒ 每条任务消息必须内嵌改造要点全文）+ `文档模板.md` 派发消息模板。

### Verified

- 门禁：`orch` `typecheck` **0** / `lint` **0** / `npm test` **147/147**（含新增 C11 锁定用例）；regression new 用例 **32/32**。**machine 零源码改动**（`typecheck` 0）。
- **全量回归 666/666**（套件 808 → 666：4 文件共 174 条五层题材断言退役 + 32 条新用例；报告落 `reports/v0.6.1/`）。
- **真机（Step 3 宿主自测 = §4.3 真机 E2E，Feature `6b8e2cfe` completed）**：双 project（scratch-c 18s 受控失败 + flow/machine 对照）—— V2 失败隔离（`blockedSet` 仅闭包两节点，E-a/E-b 照常完成）· V3 failure_report 恰 1 条 & Feature 保持 `executing` **零动作** · V4 `retryTaskIds` 重派×2（返回 `rearmed/unfrozen` 正确、`retryCount` 记账、同 ctx 续接自判成功）· **无自环**（无参数 advance ⇒ `feature_transition_invalid`）· V9 全程 `task.evidence`/`task.retry` 事件**零出现** · 全 completed 自动进 `integrating`。**收口 Feature `25040882`**（N-r1：门禁三绿 147/147 + 僵尸取证结算 + 回归新用例 32/32）completed；发版收尾清理（测试项目 scratch-b/scratch-c 移除 + Launcher 重启）Feature `78c8c45a` completed。
- **真机（发版）**：`bridge:restart` 新构建生效（`a2a_feature_advance` 出现 `retryTaskIds` 参数；事件 kind 六值 = task.settled / task.blocked / feature.state / push.received / feature.transition_skipped / **feature.failure_report**；退役 kind 零命中）。

### 未覆盖（遗留验证，**不得算通过**）

- **`feature.failure_report` 二次重派失败不重发**（signature 未纳入 retryCount ⇒ 同一静止期第二次失败只有状态侧可见、事件面不可见）——登记为下一小需求承接。
- 写者**终止类** (D1 终止写者 / D3 任务级终止 API / D5-D6 孤儿与双写者) 本版**移出**（靠「引擎排队 + 有界 idleStopMs」绕开；D5-D6 由运维 `reap` 承接）。
- 发版回归套件中 **174 条 v0.4.x/v0.5.x 失败自动化与取证流旧断言**（4 用例文件整批退役）随五层题材删除（题材消失、非红灯；新用例 32 项对应承接）。

## [v0.6.0] - 2026-09-17

> 主题：**项目组与选择性连接**（「一版本一需求」）。orch 侧新增**静态「项目组」**（成员 = `machineId × projectId`）+ **选择性连接** —— 桥只连「有成员的机器」、只用「列名成员的项目」；未列成员的项目**不 `ensure` / 不派发 / 不展示**，派发到非成员**显式失败**（`project_not_a_member`）。**线协议不变**（`PROTOCOL.md` / `PROTOCOL_VERSION` = `1.0`）；**`machine` 单元本版零源码改动**（仅 `package.json` 版本号）；**架构约束不变**。原路线图 v0.6.0 的「Transport 抽象与 SSH」经 **Step 0 重新评审后整体移出本版**（登记为后续；触发条件 = 出现「只有 SSH 能进」的机器）。

### Added

- **orch 侧静态「项目组」+ 选择性连接**（REQ-v0.6.0-2026-09-16-01）：
  - **配置**：`orch/config/config.json` 新增可选顶层 **`projectGroup`**（`{ name?, members: [{ machineId, projectId }] }`；**单组**）。**段缺省 = 全量接纳**（`selective:false`，旧配置零改动可用）；`members` **不得为空数组**；`machineId` 必须存在于 `machines[]`（否则**解析期 fail-fast**）；**每请求现读、不缓存** ⇒ 改 members **无需重启桥**。
  - **桥侧过滤（5 个拦截点，同一判据两种形态）**：`memberKey` 为**唯一 key 构造**（分隔符取 NUL，附对抗用例锁单射性）；`isMemberProject()`（过滤）与 `assertMember()`（断言，`code:"project_not_a_member"`）**同源于它**；`listMachineProjects(machine, group)` **单点过滤**（**4 个调用点**全覆盖）；`locateProject` 三条缓存落点（cache-hit 先判成员、不命中即清 `projectIndex` 条目并回落扫描；scan-hit **只缓存成员**；扫描前先 assert；扫描范围收窄为 `memberMachineIds`）；`handleProjects` **只遍历成员机器 + 只列成员项目**，**无成员的机器整条消失（含其 `error` 条目）**；`refreshProjectsSnapshotLazily` **与 `locateProject` 同时施加**；`probeProjectReady` **未改**（保持「无快照 ⇒ `ready=false`」fail-safe）。
  - **三条防线**：`dispatchTask` / `registerFeatureNode` **零 I/O 早失败** + **`ensureProject` 首行硬兜底**（早于 `ensureProtocol`）—— 覆盖**全部 6 条「拉起」路径**（`handleCall` / `dispatchFeatureNode` / `handleTaskStatus` / `handleCancel` / 看护 `renew` / `pollTaskUntilSettled` 的 `renew`）⇒ 非成员**绝不 `POST /ensure`、连 `/health` 都不发**（实测出站 = 0）。
- **`a2a_projects` 出参新增 `group`（恒存在）**：`{ name: string | null, selective: boolean, memberMachines: string[] }`；`memberMachines` = **配置声明的成员机器集合**（**非**运行时在线集合）；`selective:false` 时为空数组。
- **工具面对应描述句**（`register-tools.ts` 两处**静态文本**，零重连）：`a2a_projects` 补「列出项目组成员 / 无成员的机器整条消失」；`a2a_call` 补「仅项目组成员可派发；非成员 ⇒ `project_not_a_member`」。
- **`orch/config/config.json.default` 增可见配置样例**：新增**惰性结构化样例键 `_projectGroupExample`**（置于 `machines` 之后；合法 JSON、**不参与解析** ⇒ 缺省仍为全量接纳）+ `_comment` 里 `projectGroup` 段**前移**（原埋在 1687 字符注释末尾、键树里完全不可见）。

### Changed

- **三处 `package.json` 版本号升至 `0.6.0`**（根 / `orch` / `machine`；根为版本源）。
- **`orch/bridge/index.ts` 顶层新增入口判定 `isEntryModule()` + 条件 `main()`**（为让 `bridge/index.ts` 可被单测 import；三条生产启动路径 `argv[1]` 均指向本文件 ⇒ 行为不变，已真机验证）。
- **新增回归用例** `.omo/skills/regression-test/tests/test-v0.6.0-project-group.js`（结构锁 / 不变量 I1·I2·I3·I5 / 防回退 / **防 vacuous** / 范围锁）。

### Verified

- 门禁：`orch` `typecheck` **0** / `lint` **0** / `npm test` **168/168**（147 → 168：`orch/test/project-group.test.ts` **8 条**防 vacuous 用例 + `config.test.ts` **13 条**）；`machine` **零源码改动**（`typecheck` 0）。
- **全量回归 776/776**（v0.5.1 基线 715；报告落 `reports/v0.6.0/`）。⚠ 过程中**修掉本版自写回归用例的 2 处缺陷**：① `ensureProject` 定义体定位失败（原用缩进正则）⇒ 改「**定义体窗口法**」（自符号起取定长窗口 + `loadMachines` 特征）；② 一处 `probeProjectReady` 断言在定位失败时会**假通过（vacuous）** ⇒ 补「窗口可定位」前置断言。
- **真机（Step 3，宿主独立断言 4/4）**：① `a2a_projects()` 只列成员 + `group={selective:true,…}`；② 非成员派发 ⇒ **`project_not_a_member`** 且**无 `taskId` ⇒ 零出站**；③ 成员内派发 ⇒ **端到端成功**（真 `ensure` → A2A → 回传）；④ 非成员**未被 `ensure`**（Launcher 日志内无该项目 agent 启动 / 端口）。**旁证**：Launcher `/projects` 全量俱在 ⇒ **是过滤、非"项目不存在"**。撤夹具后恢复 **3 项目 + `selective:false`** ⇒ **缺省零回归**；**未重启桥**（配置每请求现读）。
- **真机（发版）**：`bridge:restart` 后新 pid / `role=owner`；新构建**行为判据** = `a2a_projects()` 出参出现 `group`；网页 `GET /api/projects` **200** 且**不含 `group`/`workspace`/`agentConfig`**（字段白名单生效）、`GET /` **200**。

### 未覆盖（遗留验证，**不得算通过**）

- 成员**热移除**后在飞任务 `renew` 失败（需受控中断）· `idleStopMs=0` 机器移出成员后 agent 驻留 · **坏配置**的**真机**路径（单元级已由 `project-group.test.ts` fail-closed 用例覆盖；真机级因「可能把 `transport.mode=http` 打回 stdio」代价高，**保持登记**）· 跨机同名 `projectId` · **无成员的机器整条消失 + 零 `/projects` 请求（需第二台机器）** · 新增**项目**级自注册零重连（成员增删不需重连已顺带印证）。
- **引擎级发现（本版不改，归 v0.6.1「编排引擎重新梳理」）**：同 Feature **≥2 个 infra 失败**时**重试仲裁错配**（先失败节点永不重试、其证据被记到后失败节点账上）· 中性化节点**下游照常派发**（与取证「无写者窗口」互扰，本次靠上界降级侥幸）· **判超时 ≠ 写盘停止**（判死后仍写入 7m38s）。详见 `doc/v0.6.0/项目组与选择性连接-改造文档.md` §6-11~15。

## [v0.5.1] - 2026-09-16

> 主题：**失败自动化收口修复**（补丁版，「一版本一需求」）。修 REQ-03「失败自动化」暴露的两条收口缺陷 —— **D2**（收敛判定 / 失败传播**不认「取证节点」** ⇒ 取证节点失败被当普通失败、Feature **闷声 `failed`**）与 **D1**（`needsInputFeature` 三处静默 `return` + `notifyTaskSettled` 终态早退**零留痕**）；并**同批**处理「修 D2 即死锁」的耦合（`pendingEvidence` 出口未清）+ 兜底扫描。**线协议不变**（`PROTOCOL.md` / `PROTOCOL_VERSION` = `1.0`）；**`machine` 单元本版零源码改动**（仅 `package.json` 版本号）。**D3 已由 v0.5.0 的 D5 闭合 ⇒ 本版移出、不重复改造**。

### Added

- **取证节点失败 ⇒ 停车交人**（REQ-v0.5.1-2026-09-16-01 · **D2**）：`orch/bridge/scheduler.ts` 新增**单一谓词** `isExemptFromFailure(n)` = `isNeuteredSettled(n) || (isEvidenceNode(n) && n.state === "failed")` —— **证据臂收窄到 `state === "failed"`**（`isNeuteredSettled` 自带该条件：re-arm 后仍 `exhausted` 但已回 `working` 的**活跃节点不得视作完成**）。`reduceConvergence` 的 failed 计数 / blocked 计数 / `every()` 三处、以及 `advanceExecuting` 的 `failedIds` 均改用该谓词；**`:481`（input-required）保留 `isNeutered`、不合并** —— 二者语义不同（前者判「节点**是否仍处中性化状态**」`exhausted`，后者判「**已落定的失败事实可否豁免**」`exhausted && failed`），合并会把**重试在飞**的节点误判为「待澄清」。
- **兜底扫描**（同需求 · D2 的必要配套）：`advanceExecuting` 内在 **`failedIds` 传播之后、`reduceConvergence` 之前**同步扫描「`executing` 且存在 `failed` 取证节点」⇒ **先清 map → 交人（`needs_input`）→ return**，覆盖「settle 回调永不达」的悬挂面。**不放进** `reduceConvergence`（导出纯函数 + `pendingEvidence` 是实例私有进程内态 ⇒ 删除动作结构上不可能）。
- **两个新事件 kind**（同需求 · **D1** 留痕）：
  - `EVENT_FEATURE_TRANSITION_SKIPPED = "feature.transition_skipped"` —— 覆盖「**态没变**」的静默路径：`needsInputFeature` 四处 `return false`（`code` = `feature_not_found` / `feature_terminal` / `already_needs_input` / `illegal_transition`；其中原单行合并条件**拆两行**使 5 个 `code` 全可达）+ `notifyTaskSettled` 终态早退（`code` = `early_return_task_settled`）。payload `{site, from, to, code, detail}`；**`events.state` 列写 `null`**（目标态只放 `payload.to`）。
  - `EVENT_PENDING_EVIDENCE_DISCARDED = "feature.pending_evidence_discarded"` —— 覆盖「**待决策取证流被丢弃**」：`:648` / `:985` / **兜底扫描** 三处、且条目实际存在时写一条（`site` 枚举 `notifyTaskSettled` / `reduceConvergence` / `advanceExecuting`）。**不复用** `transition_skipped`（后者不变量是「态没变」，而此处态**确实变了**）。

### Changed

- **不变量「决策已落 ⇔ map 无条目」闭合**：`pendingEvidence.delete` 由 v0.5.0 的「`handleEvidenceSettled` 四处」**扩到全部交人出口** —— `:622`（取证节点失败）/ `:648`（任务 `input-required`）/ `:985`（收敛交人）/ `:1024`（取证派发失败）/ **兜底扫描**；顺序统一为**先无条件 `delete`、再交人**（`:674` / `:681` 已在 `handleEvidenceSettled` 内清、不重复）。依据：**D2 一生效**，未清的出口会在人工恢复后被「待决策取证流」硬闸**永久拦下**（`tick` 只扫 `executing`，无人能救）。
- **单测 140 → 147**：新增 **T5–T11**（D2 判定层 kill-shot / 四出口后 map 无条目 / 兜底扫描〔模拟回调永不达〕/ D1 各**恰一条**事件且**不产生** `feature.state` / `isNeutered` 语义差异回归 / ⑦ 路径「有痕」「无痕」），全部**经真实 infra 路径**填充 `pendingEvidence`（镜像 `seedRealInfraEvidence`）以防 **vacuous**；并含**变异验证**（移除 ⑦ ⇒ T7 红；谓词回退 ⇒ T5 红；移除出口① `delete` ⇒ T5+T6 红；⑦ 回退成裸 `delete` ⇒ T10 红）+ SHA256 还原证明。
- **`store.ts` 零改动**：两个新 kind 常量随**发射模块**落 `scheduler.ts`（先例 `EVIDENCE_EVENT_KIND` / `EVENT_TASK_RETRY` / `EVENT_PUSH_RECEIVED`）；`events.kind` 本就是开放字符串、`EVENTS_DDL` 无枚举约束。
- **引用口径**：落点以**符号名 + 不变式**表述，行号仅作观测值（改造文档附「符号 → 行号」重锚表）。

### Verified

- 门禁：`orch` `typecheck` **0** / `lint` **0** / `npm test` **147/147**；改动**限两个文件** —— `orch/bridge/scheduler.ts`（+248）+ `orch/test/scheduler.test.ts`（+532）。
- **真机 E2E（受控中断 · 两轮 · 未改任何 `timeouts.prompt`）**：
  - **happy path 全链**：`failed(infra)` ⇒ **中性化（Feature 未连坐）** ⇒ `task.evidence wait_start` ⇒ **`wait_ready`（真 offline 窗口，73.0s，非 `wait_timeout` 软路径）** ⇒ 取证 settle ⇒ **`parsed`** ⇒ 决策 ⇒ **`task.retry`（`retry_count` 0→1）** ⇒ **同 `contextId` 续派拿到新非空 `remote_task_id`**（修复前此处**恒 `NULL`**）。
  - **取证节点失败专项**：对**正在运行的取证节点**再次受控中断 ⇒ `task.settled failed` 后 **32ms ⇒ `feature.state = needs_input`**（**非 `failed`、非 `integrating`、未卡 `executing`**）；负向机检 `feature.state=failed` = **0**、**无孤儿取证节点**。
  - **D1 留痕真机可见**：`feature.transition_skipped`（`from:"cancelled"`、`events.state = null`）—— 修复前该路径**完全静默**。
- **未覆盖项（不得默认算通过**，详见 `doc/v0.5.1/失败自动化收口修复-改造文档.md` §6-11）：⑦ 兜底扫描的**真机**触发 / `pending_evidence_discarded` 真机 / 「重试用尽 ⇒ 交人」第二跳 / `stable=false` 分支 / 桥重启后闸失效（**D-2**）/ 跨机与 `codex`·`claude`。

## [v0.5.0] - 2026-09-16

> 主题：**网页端只读工作台**（原 v0.8.0 提前；「一版本一需求」生效后的首个版本）。本版同时收口 REQ-03「失败自动化」后半链暴露的两个缺陷 —— **D4 取证报告解析脆弱** 与 **D5 续派时序**（D3 并入 D5 同源同修）。**线协议不变**（`PROTOCOL.md` / `PROTOCOL_VERSION` = `1.0`）；**`machine` 单元本版零源码改动**（仅 `package.json` 版本号）。

### Added

- **网页端只读工作台**（REQ-v0.5.0-2026-09-16-01）：`orch` 单元新增**只读 HTTP 服务** —— `bridge/transports/web.ts`（`/` · `/api/projects` · `/api/features` · `/api/tasks` · `/api/events`）+ `bridge/web/html.ts`（单页；**两个面板** = 当前宿主下的**项目成员**〔machine × project，含在线态〕+ 任务引擎内的**任务情况**〔Feature / Task 状态〕）。数据源 = `sessions.sqlite` + Launcher `GET /projects`；**只读、绑 `127.0.0.1`、不改线协议、不做第二编排入口**。
  - 配置：`orch/config/config.json` 新增 **`web` 段**（`enabled` / `host` / `port`〔默认 **3300**〕/ `allowStdio`）；**默认仅常驻（http）形态提供页面、stdio 形态默认不开**（避免「页面依赖 agent 子进程」的循环依赖）；**仅 `role=owner` bind**（`follower` 不 bind，页面显示 `role`）；端口被占 ⇒ **warn 降级、不伤 MCP**。
  - 展示口径：`/api/projects` 走**字段白名单**（裁剪 `workspace` / `agentConfig`）；`/api/events` **直连 `listEvents`**（不复用有状态的 `handleEvents`，避免推移宿主收件箱游标）；最小自动刷新间隔 15s。
  - 耗时基础建设：`tasks` 增 **`created_at` / `started_at` / `finished_at`** 三列（含迁移；终态口径 `{completed, failed, blocked}`，`rearm` 时清空），页面按 `finished_at - started_at` 显示耗时；老数据留 `NULL`。

### Fixed

- **取证报告结构化解析脆弱（D4）**（REQ-v0.5.0-2026-09-16-03）：`parseEvidenceResult` 由「第一个 `{` → 最后一个 `}`」切片改为 **fence-aware 主路径**（优先取 ```json 围栏内容）+ **升序候选兜底**（枚举所有 `{`、逐个升序 `}`、首个 `JSON.parse` 成功**且形状合法**者胜；兜底同样过形状校验）；`resolveEvidence` 优先取名为 `evidence.json` 的 artifact；取证消息模板 3 行非法样例**合法化** + 追加「JSON 块之后不得再出现 `{` / `}`」「多文件逐行」。**修因**：报告在 JSON 块**之后**又列工作区脏改（含花括号）⇒ 旧切片混入尾文 ⇒ `JSON.parse` 失败 ⇒ `resolveEvidence` 返回 `null` ⇒ Feature 停 `needs_input`，REQ-03 后半链跑不到。
- **续派时序修复（D5，含 D3 合并）**（REQ-v0.5.0-2026-09-16-04）：四处在 `orch/bridge/` —— **A** `index.ts` push 预写采纳集合收窄为 `completed` / `input-required`（**停止 `failed` 预写** ⇒ 结构性关闭 D3-flaky）；**B** 删除 push 回调里抢跑的 `scheduler.kick()`（**push 只更新状态、不驱动流转**）；**C** `scheduler.ts` 收敛侧**硬闸** `hasPendingEvidenceDecision`（`pendingEvidence.has(featureId) && nodes.some(isEvidenceNode)` ⇒ 决策未落时不得推进 `integrating`）；**D** 两个「交人」出口补 `pendingEvidence.delete`（四出口统一「**决策即清**」，防闸自造死锁）。**修因**：收敛判定抢在 re-arm 之前 ⇒ Feature 先被判 `integrating`，而 `tick` 只扫 `executing` ⇒ **`task.retry` 之后实际续派永不发生**（节点 `remote_task_id` 恒为 `NULL`）。

### Changed

- **三处 `package.json` 版本号升至 `0.5.0`**（根 / `orch` / `machine`；**根为版本源**，`lib/common.getVersion()` 读取它）。
- **`orch/config/config.json.default` 增 `web` 段样例**（`enabled: true` / 端口 3300 / `allowStdio: false`）。
- **页面按用户 Step 3 反馈收起「事件流」面板**（实现级增补，改造文档 v5）：面板从页面移除，`/api/events` **接口保留**（供调试与未来交互面）。

### Verified

- 门禁：`orch` `typecheck` 0 / `lint` 0 / `npm test` **140/140**（含 D5 新增 **T1–T4**，并附**变异测试**证明用例承重 —— 移除硬闸 ⇒ T1/T2 红、谓词改裸 `has` ⇒ T4 红）；`machine` 本版**零源码改动**。
- **全量回归 687/687**（v0.4.1 基线 603；新增 v0.5.0 三条用例：`test-v0.5.0-web-workbench.js`〔只读工作台〕· `test-v0.5.0-evidence-parse.js`〔D4〕· `test-v0.5.0-retry-timing.js`〔D5：四处改动结构锁 + 防回退 + 防 vacuous〕；报告落 `reports/v0.5.0/`。⚠ 用例总数随「当前版本的改造文档份数」浮动 —— `test-doc-final` 按 `doc/v{version}/` 逐份检查，故 v0.4.1 时点 689 → 发布时点 687，**非用例丢失**）。
- **真机**：常驻桥 `role=owner`；只读页面 `GET http://127.0.0.1:3300/` **200**，`/api/*` 白名单与 `events` 游标行为实测符合预期。**D4 真机**：`parsed` → 决策 `retry` → `rearmForRetry` → **全库首条 `task.retry`**。**D5 真机两轮（受控中断法，桥重启加载新构建后）**：① **续派 kill-shot** —— `task.retry` 后节点拿到**新的非空 `remote_task_id`**（修前恒 `NULL`）；② **序判据** —— 节点续跑至 `completed` 后 **`feature.state=integrating` 晚于 `task.retry`**（间隔 52s ⇒ 硬闸未卡死）；负向机检：`feature.state=failed` 计数 **0**、`failure_kind IS NULL` 的失败节点 **0**；并顺带验证「**重试用尽 ⇒ `needs_input`**」路径（未判 `failed`、未困死 `executing`）。

### 未覆盖（遗留验证，**不得算通过**）

- **实际场景验收观察**（用户 2026-09-16 裁定）：D4 / D5 的验收目前均为**受控构造**（宿主主动中断目标项目 agent）；**真实需求自然走到 `retry` 路径的长期观察留待后续**，按 Step 3 规范登记，不并入本版验收。
- **桥重启后硬闸失效（D-2）**：`pendingEvidence` 为**进程内态** ⇒ 重启后硬闸失效（窗口极窄：需恰在「终态落库 ↔ `onSettled`」之间重启）。**人工判据**：重启后 Feature 停 `integrating` 却**缺 `task.retry`** ⇒ 按 **D5** 处置；`failed` 且 `failure_kind IS NULL` ⇒ 按 **D3** 处置。
- 其余登记项：**V6**（push 唤醒被批门闩吞 ⇒ 续推延到下一 tick ≤1.5s）· **迟到的重复 push 可覆盖 re-arm 后节点**（决策后窗口仍在）· `a2a_task_status` / `a2a_cancel` 在本地**非终态**时用**本地 id** 查远端（工具面缺陷）· `watchLoop` 的 `persist()` **不在 try/catch 内** · **远端终态丢失无兜底**（wrapper 终态只留内存、重启即失）· 取证产物「建议名 `evidence.json`」**未生效**（wrapper 原文发布为 `response`、`uri` 为 `NULL`）⇒ 命名候选属死路径。
- **跨版本提醒（v0.5.1）**：D5 落地后，若 `scheduler.ts` 中另三个「交人」出口（`:615` / `:641` / `:986`）仍未清 `pendingEvidence`，硬闸可能把 Feature 困在 `executing` ⇒ **v0.5.1 实施时须把「出口即清」扩到这三处**（本版不动）。

## [v0.4.1] - 2026-09-16

> 主题：**需求流程引擎化 + 编排内核常驻化 + 失败自动化 + 执行准入**（本版本含 4 条需求；「一版本一需求」约束**自 v0.4.1 之后的下一个版本起**生效，**本版豁免**）。

### Added

- **需求流程规范包 `flow/`**（REQ-v0.4.1-2026-09-15-01）：`flow/spec/{需求流程,引擎映射,文档模板}.md` 内核 + `hosts/`（opencode 完整可用；Claude Code / Codex / Cursor 给指引）+ `install/{install,uninstall}.mjs`（**旁路引入**：不破坏目标项目既有 `CLAUDE.md` / `AGENTS.md`，幂等、可字节还原）。
- **常驻编排内核（桥常驻化与多驱动面）**（REQ-v0.4.1-2026-09-15-02）：桥由「宿主 stdio 子进程」升格为**常驻进程** —— 新增 `runtime/{core-lease,lifecycle}.ts`（**core 租约**单调度权 `owner`/`follower` + 启停编排与 drain）、`bridge/register-tools.ts`（`createServer` / `registerTools` 工厂）、`bridge/transports/{stdio,http}.ts`（**stateless Streamable HTTP**：`/mcp` + `/health` + `/shutdown`）、`scripts/bridgectl.mjs`（start/stop/restart/status/logs）、`tools/mcp-http-probe.mjs`、`version.ts`；store 加固（busy timeout / DB 路径绝对化 / CAS）。
- **超时与失败自动化 + 执行后孤儿回收**（REQ-v0.4.1-2026-09-15-03）：`infra` / `task` 失败分类（文本白名单 + **未知降级 `task`**）；**先取证 → 条件重试**（N=1、同 `contextId`）+ **中性化**（`tasks.exhausted`，**6 处**判定，Feature **不连坐**）；**取证节点**（新 ctx、只读、消息自包含含 nonce、结构化输出 D/R/门禁/`stable`）；**等回收门**（`status !== "online"` + **debounce 2 次** + 5s 节流 + **持久化挡板** + 上界转软校验）；machine 侧**进程账本**（`children/<pid>.json`，write-ahead）+ **启动对账清理**（`launcher/reconcile.ts`）+ **`scripts/reaper.mjs`**（默认只读 / `--clean` / 六档闸门 / **红线：pidfile 存活禁清**）+ POSIX `detached` **进程组杀**。
- **引擎职责收敛与执行准入**（REQ-v0.4.1-2026-09-16-01）：主链 **9 → 6 态**（移除 `discussing` / `analyzing` / `planning`；**Step 0/1 引擎不参与**）；`a2a_feature_create` **初态即 `waiting_approval`**；**`approve` 成为唯一准入**（`advance(to="executing")` 被拒，`feature_approval_required`）；**`a2a_call.mode` 必填** + **对偶校验**（`feature_required_for_execute` / `feature_not_allowed_for_inquiry`）；`features.state` 迁移 + **脏值兜底**（`RETIRED_FEATURE_STATES` + 归一留痕）。

### Changed

- **MCP 工具面数量不变**（泛型 7 + Feature 工具组 5）；**`a2a_call` 的 `mode` 必填**（`"inquiry"` 不得带 `featureId`；`"execute"` 必带 `featureId`）。
- **Feature 主链收敛为 6 态**：`waiting_approval → executing → integrating → testing → reviewing → completed`；`waiting_approval → executing` 边保留（供 `approve`），但 `advance` 无法走通。
- **`registerFeatureNode` 挂载门改常量集合驱动**（`MOUNTABLE_FEATURE_STATES`），放开 `waiting_approval`（登记 ≠ 派发）。
- **根 `package.json` 版本号升至 `0.4.1`**（**版本源**，`lib/common.getVersion()` 读取它）；⚠️ **orch / machine 两单元的 `package.json` 版本号待补 bump** —— 本会话宿主 MCP 工具表为**旧 schema**（无 `mode` 参数），而桥已启用 `mode` **必填**，派发被拒（`-32602`）⇒ 两单元（`orch/**` / `machine/**`，须经 A2A 委派）的 bump 需**宿主重启后**执行（见 `planlog.md` 待办）。
- **线协议不变**（`PROTOCOL.md` / `PROTOCOL_VERSION` 保持 `1.0`）；`machine` 本版**仅**账本/对账/reaper/组杀相关改动（无协议改动）。
- **流程规范**：Step 2 增**硬约束 H1–H3**（建 Feature + 同轮贴 DAG / 实现期禁 `execute` 无 `featureId` / H3 = **行为复核**）；Step 3 增**分水岭**（**实现级增补** ⇒ `needs_input → executing` 续推；**方案级回炉** ⇒ `a2a_feature_cancel` + 回步骤 0 新建）。
- **有意撤销**：v0.4.0 的「**分析扇出**」（`analyzing` 态可挂载）随主链收敛**撤销**（用户定「Step 0/1 不走引擎」）—— **非回归缺陷**。
- **已知限制（登记）**：同 project 并发节点时取证不干净（根治 = 每节点独立 worktree，即搁置的 v0.5.0）；硬路径「半写文件」；`stop()` 先删条目后杀进程（故需 debounce）。

### Verified

- 门禁：`orch` `typecheck` 零错 + 单测 **101/101**；`machine` `typecheck` / `lint` 通过；`reaper` **只读模式实跑 exit 0**（红线真实命中「pidfile pid 存活 ⇒ 禁清」）。
- **全量回归 603/603**（v0.4.0 基线 554 → 603：新增 REQ-03 / REQ-04 用例，并**等价改写** 4 条陈旧断言 —— `isLocalTerminalState` 委托化 2 条、主链 6 态 1 条、挂载门常量 1 条；**未放宽标准**）。
- **真机**：常驻桥 `bridgectl` 启停/状态全绿（`role=owner`）、`mcp-http-probe` **9/9**（12 工具 / stateless / 无 `Mcp-Session-Id`）；宿主经 `type:"remote"` 连通（REQ-02）；REQ-04 重启后**三段冒烟**：`tools/list` 的 `a2a_call.required` 含 `mode` ✓、缺 `mode` 拒 `-32602` ✓、`mode="inquiry"` **端到端**回执 ✓、`a2a_feature_status` 全量列表不抛 ✓、桥日志零脏值告警 ✓。

### 未覆盖（遗留验证，**不得算通过**）

- **REQ-03 失败自动化真机 E2E 全链路** 与 **REQ-04 新准入首战** —— 均按 `flow/spec/需求流程.md` Step 3 登记，**交「下一个需求」实施验证**（见 `planlog.md`「下一需求必须承接」）。
- 网页驱动面（v0.8/v0.9）对同一准入的复用未评估；跨机 / 其它库存在退役态或脏值的真实迁移未真机（本机 0 行）；POSIX 组杀路径需 macOS/Linux 真机；硬路径「半写文件」；`reaper --clean` 未实跑。

## [v0.4.0] - 2026-09-14

### Added

- **单 Feature 内并行与协作（需求内并行）**（REQ-v0.4.0-2026-09-14-01）：
  - **拓扑并行 + 失败传播**（`orch/bridge/scheduler.ts`）：由「每 Feature 单在飞」改为**同层无依赖 Task 并发派发**（就绪判定 `find→filter` + 整批 `Promise.all`）；新增**三层防重派**（Feature 批门闩 / 节点级在飞标记「先置位后 await」/ tick 守卫）；**失败传播**——上游 `failed` → 沿 `dependencies` 反向**传递闭包**把下游置 `blocked`，Feature 收敛 `failed`。`TaskState` 新增 `blocked`；`recover()` 并行语义重写。
  - **Artifact 注册与下游引用**（`orch/session/store.ts` + `bridge/index.ts`）：新增 `artifacts` 表；任务 settle 登记产物；下游经 `a2a_call(inputs=[{producerTaskId,name} | {artifactId}])` **显式引用**上游产物，桥派发时**注入**下游 input（`tasks.input_artifacts`）。
  - **Feature Context**：`features` 增 `contextId` / `plan` / `decisions` / `contracts`；`a2a_feature_create(contextId)`、`a2a_feature_advance(note=…)`（+ `decisions`/`contracts`）落库，派发时注入。
  - **分析扇出**：`registerFeatureNode` 放开 `analyzing` 态可挂载（扇出复用拓扑并行）。
  - **worker 回调与收件箱**：orch 内嵌 loopback HTTP 事件端点 `POST /callback`（**默认关**，`callback{enabled,host,port,token?}` 配置）；派发经 A2A `configuration.taskPushNotificationConfig` **内联注册**回调（路径 1，不动线协议）；worker 状态变化推送 → 桥记 `events`；新增 `events` 表 + `a2a_events(since?)` 收件箱 + `a2a_wait(timeoutMs?)` 长轮询；`task-watcher` 增 `subscribePush`（推送优先、轮询对账兜底）。**跨机回调**受鉴权约束，延后 v0.7.0（本版仅同机 opt-in）。

### Changed

- **MCP 工具面**由「泛型 5 + Feature 工具组 5」扩为「**泛型 7 + Feature 工具组 5**」（新增 `a2a_events` / `a2a_wait`）。
- 三处 `package.json`（根 / orch / machine）版本号升至 `0.4.0`。
- **线协议不变**（`PROTOCOL.md` / `PROTOCOL_VERSION` 保持 `1.0`）；**machine 单元无源码改动**（仅 `config.json.default` 加 push 能力 opt-in 样例）。
- `orch/config/config.json.default` 增 `callback` 与 `machines[].pushCallback` 样例（默认关）。

### Verified

- 门禁：orch 单测 **23/23**；orch / machine `typecheck`·`build`·`lint` 全绿；`npm ci` **四补丁重放 clean**。
- 全量回归 **457/457**。
- **真机 E2E（v0.4.0 桥）**：E2E#1 拓扑并行（同层并发）/ Artifact 注入（`P3 got: P1 done`）/ Feature Context 注入（`sees-plan: yes`）/ `a2a_events` 收件箱；E2E#2 失败传播（`Q1 failed → Q2 blocked` → Feature `failed`，事件链 `task.settled(failed)`→`task.blocked`→`feature.state(failed)`）；**(乙)** push 回调 `/callback` 端到端（`push.received`，token 校验通过）、codex / claude ② 标记路径（`input-required` / `failed`）。
- **未覆盖（遗留）**：跨机回调（v0.7.0 鉴权）、`recover()`（未在 Feature 在飞时重启桥）、`input-required` 跨 wrapper 重启持久化。

## [v0.3.1] - 2026-09-14

### Fixed

- **worker 任务态上报缺失（v0.3.0 真机缺口修复）**（REQ-v0.3.1-2026-09-14-01）：v0.3.0 真机 E2E 证明其前提「worker 会把需澄清/失败如实反映到 A2A 任务态」**不成立**——worker 的「需澄清/失败」只出现在**回复文本**，任务态恒为 `completed`，导致 Feature 不进入 `needs_input`（澄清点失效、agent 自编答案）、失败被**误判成功**。本版在 **machine 侧**修复（**orch 零改动、`PROTOCOL.md`/`PROTOCOL_VERSION` 不变**）：
  - **② 约定式状态标记（三端统一）**：`@a2a-wrapper/core` 新增并导出 `resolveOutcome`（解析回复末尾最后一个 `a2a-outcome` JSON 块 → `input-required`/`failed`/`completed`；**无标记/非法一律回退 `completed`**）；三端 executor 收口接入。
  - **三端约定注入**：`machine/launcher/agent-config.ts` + 各适配器向 worker 注入统一约定文案（opencode `systemPrompt` / claude `systemPromptAppend` / codex `developerInstructions`——后者原为死配置，经 `a2a-codex` 补丁接通）。
  - **① opencode 原生提问上报**：`question.asked` **不再自动替用户答**（`autoAnswerQuestions` 默认改 `false`）→ 发布 `input-required` + 挂起；答复经同 `contextId` 续跑（`questionReply` 回填）。
  - **③ opencode 超时不再假 `completed`**：prompt 超时（含轮询兜底路径）收敛为 `failed`。
  - **④ codex 挂起无终态修复**：接线 `timeouts.prompt`（计时器 + 流读取竞速，即便 SDK 忽略 abort 也收敛）→ 挂起**必然**收敛 `failed`（用户取消仍 `canceled`）。
  - **⑤ `input-required` 持久化放宽**：`FileTaskStore` 跨进程重启**保留 `input-required`**（`working` 仍按既有 `interrupted → failed` 收敛）。

### Verified

- machine 门禁 `typecheck` / `build` / `lint` 全绿；`npm ci` **四补丁重放 clean**；全量回归 **364/364**。
- **真机 E2E 自测（Step 3，opencode）**：worker needs_input → 任务态 `input-required`；worker failure → `failed`；Feature 级 `needs_input` **停** → `advance(answer)` **续推** → 完成；Feature 级 failure → **`failed`**。
- **已知边界**（如实）：真实「人答」闭环与 **codex/claude 的 ② 标记路径**由 **v0.4.0 实跑**承担验证（用户决定**以自测为准**验收）；opencode ① 的 `pendingQuestions` 仅进程内存、不跨重启；claude `systemPromptAppend` 与 `customSystemPrompt` 互斥；项目 `agentConfig` 可覆盖约定。

## [v0.3.0] - 2026-09-14

### Added

- **Feature 编排闭环**（REQ-v0.3.0-2026-09-14-01）：从「单次 `a2a_call`」升级为「一个需求 = 一个 Feature」的编排——orch 牵头，跨项目 Task DAG 自动串行推进，中途可停下审批/澄清。
  - **Feature 状态机**（新增 `orch/feature/state-machine.ts`，纯函数、零副作用）：9 主态 `discussing → analyzing → planning → waiting_approval → executing → integrating → testing → reviewing → completed` + 异常态 `failed` / `cancelled` / `needs_input`；转移表 + `canTransition` / `assertTransition`（非法流转 fail-fast、不落库）。`blocked` 为 v0.4.0 保留态。
  - **串行 Task DAG 调度器**（新增 `orch/bridge/scheduler.ts`）：**复用** `task-watcher` 作下层单任务看护；`FeatureScheduler` 提供 `start` / `stop` / `kick` / `notifyTaskSettled` / `recover`；tick 判定顺序「失败 → 需澄清 → 全完成 → 在飞门闩 → 就绪派发」；**每 Feature 单任务门闩**（`dispatching` Set）防双重派发；DAG 校验 `validateDag`（环 / 悬空引用 → Feature `failed`）；全部节点 `completed` → **自动 `executing → integrating`**。
  - **MCP Feature 工具组（5 个）**：`a2a_feature_create` / `a2a_feature_status` / `a2a_feature_advance` / `a2a_feature_approve` / `a2a_feature_cancel`（静态注册、`a2a_` 前缀、零重连）。工具面由「泛型 5」扩为「**泛型 5 + Feature 5**」。
  - **审批门**：进入 `waiting_approval` 后停下不派发，用户经 `a2a_feature_approve` 放行。
  - **`needs_input` 恢复契约**：任务 `input-required` → Feature `needs_input`；`a2a_feature_advance(featureId, to="executing", answer=…)` 把 `answer` 并入节点 `dispatch_message`、清 `remote_task_id`，由调度器重新派发续推（同 `contextId` 续接）。
  - **桥重启恢复**：`main()` 启动时扫描非终态 Feature 纯本地收敛（**不 ensure、不派发**）；`executing` + 已派发 `working` 任务按 wrapper `failed(interrupted)` 语义收敛为任务 `failed` + Feature `failed`（不重派）；`waiting_approval` / `needs_input` 保持挂起。

### Changed

- **数据模型**（`orch/session/store.ts` + `orch/types.ts`）：新增 `features` 表（`feature_id` / `state` / `title` / `requirement` / `created_at` / `updated_at`）；`tasks` 加四列 `feature_id` / `dependencies`（JSON 数组）/ `remote_task_id` / `dispatch_message`（沿用 try-ALTER 迁移）；索引 `idx_features_state_updated`、`idx_tasks_feature`；`pruneTasks` **排除活跃 Feature 的任务证据**。
- **`a2a_call` 增可选 `featureId` / `dependencies`**：带 `featureId` = 登记该 Feature 的队列节点（不立即派发，由调度器按 `dependencies` 串行派发）；**不带 `featureId` 行为与现状完全一致**（立即派发）。A2A 不接受客户端预置 taskId，故本地 id ↔ 远端 id 分离（`remote_task_id`）。
- **桥接线**（`orch/bridge/index.ts`）：抽出可复用 `dispatchTask`（locate→ensure→client→send），供 MCP 工具与调度器共用；`main()` 先 `recover()` 再 `scheduler.start()`；`shutdown()` 停调度器。
- **`task-watcher`**：新增可选 `onSettled(task | null, { abandoned })`，**正常终态与看护放弃路径均回调**。
- 三处 `package.json`（根 / orch / machine）版本号升至 `0.3.0`。
- **线协议不变**（`PROTOCOL.md` / `PROTOCOL_VERSION` 保持 `1.0`）；**machine 单元本版无代码改动**（调度走桥内部 A2A client，复用既有 `ensure` / `/projects`）。

### Verified

- 门禁（orch）：`typecheck` / `build` / `lint` 均 exit 0。
- 新增结构用例 `test-v0.3.0-features.js`（79 断言）通过；离线运行时冒烟 29 项通过：建 Feature、非法流转拒绝且不落库、主链 + 审批门、DAG 环 / 悬空、串行派发次序 `n1→n2→n3`、门闩在飞只派一个、`input-required → needs_input → advance(answer)` 续推、`recover` 收敛 `interrupted`、`pruneTasks` 保留活跃 Feature 任务。
- 回归测试全量通过（**333/333**，报告见 `reports/v0.3.0/regression-report.json`；`reports/` 不入库）。
- **真机 E2E（场景级）未跑**，登记为遗留验证项：改前端 → 改后端 → 联调 happy path + 一条 `needs_input` 路径；**决定以 v0.4.0 需求实跑作为该闭环的真实验证**。

## [v0.2.1] - 2026-09-14

### Added

- **Launcher 跨平台启停脚本**（REQ-v0.2.1-2026-09-14-01）：新增 `machine/scripts/launcherctl.mjs`（纯 Node ESM、零第三方依赖、无需构建），子命令 `start` / `stop` / `restart` / `status` / `logs`；`machine/package.json` 增对应 npm scripts。`start` 以 `spawn(detached:true, stdio→日志文件, windowsHide:true).unref()` 跨平台后台化（POSIX `setsid` / Windows `DETACHED_PROCESS`），脱离终端存活、stdout/stderr 重定向到 `machine/.a2a/logs/launcher.log`；幂等（已在运行即提示并 exit 0）；spawn 后轮询 `/health` 确认就绪。`stop` **默认「pidfile + 发信号」**（POSIX `SIGTERM` 优雅 / Windows `taskkill /T /F` 强制树杀），配置 `launcher.shutdownEndpoint=true` 时改用 `POST /shutdown` 优雅停止（端点失败回落）；`status` 读 pidfile + 端口探测 + `/health`，区分运行中 / 未运行 / pidfile 陈旧；`restart` = stop → 等端口释放 → start；`logs` 支持 `--lines N` 与 `--follow`。**bridge 不纳入**（stdio MCP server，无独立常驻进程）。**为 machine 单元运维配套，`PROTOCOL.md` 不变。**
- **Launcher 启动自检前的单实例互斥**（REQ-v0.2.1-2026-09-14-02）：`launcher/index.ts` 启动顺序改为**先 `listen(launcher.port)` 再自检**——端口即 OS 级原子锁，第二个实例在 `listen` 阶段即 `EADDRINUSE` 退出、**不进入自检**，根除「双实例自检阶段 a2a 端口（3010/3011）撞车」竞态（原 `EADDRINUSE 3011 → fetch failed → fail-fast`）。就绪门：自检通过前业务路由返回 503（`/health` 仍 200 并报 `status: starting|ok`）；自检失败有界关闭端口（`closeIdleConnections()` + 1s `closeAllConnections()` 兜底）后非零退出。
- **Launcher pidfile 与可选优雅停止端点**（REQ-v0.2.1-2026-09-14-02）：`listen` 成功后写 `machine/.a2a/launcher.pid`（JSON `{pid,port,host,startedAt}`），优雅退出 / `exit` 路径删除。新增可选 `POST /shutdown`（配置 `launcher.shutdownEndpoint`，**默认关闭**），触发与 SIGINT/SIGTERM 共享的幂等优雅停止；仅接受 loopback 来源（可选 `shutdownToken`）。新增可选 `launcher.listenHost`（**默认保持现状**，不改变既有可达性）。修正启动日志如实打印实际绑定 host（原注释/日志称 127.0.0.1、代码实际绑全网卡）。
- **wrapper `listen` 错误结构化退出补丁**（REQ-v0.2.1-2026-09-14-02）：补丁 `@a2a-wrapper/core`（`dist/server/factory.js`）将 `app.listen` 包为 Promise（`once('listening')` / `once('error', reject)`），使 `EADDRINUSE` 以 rejection 经 `main().catch` 结构化退出（不再未处理 `error` 事件致进程崩溃 / `UV_HANDLE_CLOSING` assertion）；三端 `a2a-opencode` / `a2a-codex` / `a2a-claude` 的 `dist/cli.js` 信号路径与 `main().catch` 均改 `process.exit(0/1)` → `process.exitCode =`（等事件循环 drain 后退出）。`machine/package.json` 的 `postinstall` 加 `--error-on-fail`，三端 wrapper 依赖版本收紧为精确值。

### Changed

- Launcher 退出清理统一走 `allChildren` 生命周期注册表（spawn 返回即注册，覆盖 `waitForPort` 注册前的在途子进程与 backend `opencode serve`）；`shutdown()` / `killAllSync()` 遍历之；`killAllSync()` 改**树杀**（win32 `spawnSync taskkill /T /F`、POSIX `SIGKILL`），修复原 Windows 下 `child.kill()` 漏杀 cmd.exe 子孙；`shuttingDown` 守卫避免退出中复活状态。
- `machine/launcher/server.ts` 注册可选 `/shutdown` 与就绪门中间件；`config.ts` / `types.ts` 增 `listenHost` / `shutdownEndpoint` / `shutdownToken` 可选字段。
- 三处 `package.json`（根 / orch / machine）版本号升至 `0.2.1`。

### Verified

- 功能测试（2026-09-14，宿主全程执行，隔离沙箱）：REQ-02 —— 双实例并发第二个 `EADDRINUSE` 且不进自检；自检失败 fail-fast 关端口 + 删 pidfile；真实 `a2a-opencode` 端口冲突结构化退出（exit 1、无 `UV_HANDLE_CLOSING`）；`POST /shutdown` 非 loopback → 403、loopback → 优雅停止并回收 wrapper + `opencode serve`；`exit` 钩子在途子进程树杀 0 残留。REQ-01 —— `start` 后台化（脱离终端、日志入文件、pidfile、`/health`）、幂等 start 不起第二实例、`status` 三态、`stop` 端点与回落双路径、`restart`、`logs --lines` / `--follow`。
- 门禁（machine）：`typecheck` / `build` / `lint` / `format:check` 均 exit 0。
- 回归测试全量通过（报告见 `reports/v0.2.1/regression-report.json`；`reports/` 不入库）。

## [v0.2.0] - 2026-09-14

### Added

- **wrapper 任务态持久化**（REQ-v0.2.0-2026-09-13-01，路线 A：patch-package 补丁 `@a2a-wrapper/core@2.1.1`）：三端 wrapper 的任务态由纯内存改为落盘 `<workspace>/.a2a/tasks.json`（`FileTaskStore` 实现 SDK `TaskStore`，一份 core 补丁覆盖三端）。**保留策略（方案②）**：只持久化非终态任务，终态即时从盘上移除（进程内仍可查）；启动装载时对文件中残留的非终态任务补写 `failed` 终态（状态消息含 `interrupted`）——wrapper 重启后任务不再永久悬挂，桥轮询可得到明确终态。写放大控制（非终态 200ms 防抖 + 原子写 tmp/rename）、坏 JSON 备份容错（不抛未捕获异常）。补丁经「删依赖 → `npm install`（`postinstall` 重放）→ `patch-package --error-on-fail`」验证可重放。**线协议不变**（属 A2A 层行为改进）。
- **`a2a_tasks(project, [state], [limit])` 任务列表工具**（REQ-v0.2.0-2026-09-13-02）：MCP 工具面由 4 个泛型工具扩为 **5 个**。按项目列出本地任务记录（默认按 `updatedAt` 倒序、默认 20 条、最多 100；可按 `state` 过滤），作为丢失 `taskId` 句柄后的兜底找回入口。`tasks` 表新增 `prompt` 列（落库时截断，默认 500 字符，`TASK_PROMPT_MAX_CHARS` 可配），列表可辨识「这条问的是什么」；新增 `(project_id, updated_at DESC)` 索引与保留策略 `pruneTasks`（超期 `TASK_RETENTION_DAYS`=7 天、每项目超量 `TASK_MAX_PER_PROJECT`=200，均排除 `working`；启动与每次列任务时机会式清理）。`working` 且不可达（项目 offline 或无在飞看护）的记录标 `stale`。`a2a_task_status` 的本地终结快路径纳入 `input-required`。**为纯桥内变更，`PROTOCOL.md` 不变**。
- **`a2a_call` 可选参数 `wait`**（REQ-v0.2.0-2026-09-13-03）：`wait=false` 时永远立即返回 `working + taskId + contextId`（不进入同步轮询，后台看护照常启动保证结果落库）；`sendMessage` 同步返回已终态时如实返回终态。省略或 `wait=true` 时保持原半异步行为完全不变。**桥内入参，`PROTOCOL.md` 不变**。
- **`agents/` 过期包装器配置清理**（REQ-v0.2.0-2026-09-13-05）：Launcher 启动时（早于启动自检与监听）按当前 `projects[]` 白名单清理 `agents/<kind>.<projectId>.json` 中的过期项，日志打印 `[launcher] 清理过期包装器配置 N 个：…`；仅删匹配 `^(opencode|codex|claude)\..+\.json$` 且不在白名单的文件，不误删其它文件/目录。
- **lint/format 工程基线**（REQ-v0.2.0-2026-09-13-06）：orch / machine 两单元各自接入 ESLint（flat config + `typescript-eslint` + 规则 `@typescript-eslint/no-explicit-any`）+ Prettier（`printWidth: 100`、`endOfLine: auto`）+ `lint` / `format` / `format:check` 脚本 + `.prettierignore`。摸底确认两单元显式 `any` 均为 0（价值在防回归）。

### Changed

- orch / machine 部分源码按 Prettier `printWidth: 100` 重排（**纯空白/换行层，无逻辑改动**；`endOfLine: auto` 下 orch 保持 CRLF、machine 保持 LF，未发生整批换行改写）。
- 三处 `package.json`（根 / orch / machine）版本号升至 `0.2.0`。

### Verified

- 功能测试（2026-09-14，用户确认通过）：REQ-01 长任务中途重启 wrapper → `failed(interrupted)`、working 落盘/终态移除；REQ-02 `a2a_tasks` 字段与 `prompt` 落库；REQ-03 `wait=false` 立即返回并轮询到终态；REQ-05 真实 Launcher 重启清理过期配置；REQ-06 两单元 `lint` / `prettier --check` 均 exit 0；双项目冒烟（`machine` + `orch` 均派发完成）。
- 回归测试全量通过（报告见 `reports/v0.2.0/regression-report.json`；`reports/` 不入库）。

## [v0.1.2] - 2026-09-13

### Added

- **三端任务执行日志统一（含自检场景）**（REQ-v0.1.2-2026-09-13-01）：三端 wrapper 统一任务观测日志——开始行 `[a2a-task] start taskId=… contextId=… promptLen=…`、结束行 `[a2a-task] end … state=completed|failed|canceled responseChars=… durationMs=…`（failed 行附单行截断 `error=`），直写 stdout、不受各端 `logging.level` 影响，并替换原风格不一的「开始」日志；取消路径（codex / claude）同样有结束行。Launcher 启动自检 `[self-check]` 结果行对齐同套字段（耗时口径 = 发送 → 终态），settle 失败行附带任务错误文本（与「任务结果保障」的 text 落库同源）。`grep "[a2a-task]"` 可跨三端对齐观测。
- **线协议版本化（Bridge ⇄ Launcher 契约）**（REQ-v0.1.2-2026-09-13-02，v0.2.0 拆仓前置）：
  - 新增 `PROTOCOL.md`（仓库根，入库）为线协议**单一事实源**：端点/字段、版本规则（加可选字段 → minor+1；删字段 / 改语义 / 加必填请求体 → major+1）、握手语义、可支持对端版本维护流程（`SUPPORTED_PEER_PROTOCOL_MAJORS` 显式决策）与演进记录表（含对端最低要求）；
  - Launcher `GET /health` 自报 `protocolVersion`（`"major.minor"`，当前 `1.0`）；
  - 桥**首触一台机器**（首个 `/projects` / `ensure` 前）先握手校验：机器主版本不在支持清单内即拒绝派发（`protocol_version_mismatch`，含机器 ID、实测版本、可支持清单与升级指引）；`protocolVersion` 缺失/非法按「未版本化旧版 Launcher」拒绝；机器不可达为连接失败语义，不与版本问题混淆；
  - 成功校验进程内缓存（后续调用不再握手）；失败不缓存负项——机器升级后下一轮调用自动恢复，无需重启桥；并发首触按 machineId 去重；
  - `locateProject` 将协议拒绝与普通不可达分开归集：项目无法定位且存在协议拒绝时报 `protocol_version_mismatch`，不误报 `project_not_found`；
  - 桥观测日志统一走 stderr（`[a2a-bridge]` 前缀），不混入 MCP stdio 协议通道；`[a2a-bridge] protocol handshake` 行含两侧版本，即各机版本台账。

### Changed

- 桥 MCP server 版本串随发布更新（原硬编码 `0.1.0` 滞后于 v0.1.1）。

### Verified

- 新增契约用例 `test-protocol-version.js`（28 断言：两侧常量与 PROTOCOL.md 三方一致、支持清单与演进表互锁、握手行为）随全量回归通过；
- 四场景运行时夹具验证：成功后不再握手、机器原地升级同进程自愈、死端口连接语义不误报、非终结态 status/cancel 拒绝且不 ensure、终结态快路径零网络；
- 真实链路验证：桥对升级前旧 Launcher 正确拒绝（未版本化文案 + 升级指引）、Launcher 升级后握手通过、真实 codex 任务经桥全链路完成（返回结构与改造前一致）、启动自检真实任务通过；
- 三端任务日志经自检与真实任务实测（REQ-01 用户测试记录见 planlog 归档）。
- 回归测试全量通过（报告见 `reports/v0.1.2/regression-report.json`；`reports/` 不入库）。

## [v0.1.1] - 2026-09-13

### Added

- **Codex 与 Claude Code 接入**（REQ-v0.1.1-2026-09-11-01）：执行层从 OpenCode 单端扩展为三端——项目 `agentKind` 配成 `codex` / `claude` 即可被同一 Launcher / 同一泛型工具面拉起、派发、执行、回传；新增依赖 `a2a-codex` / `a2a-claude`（运行时随依赖内置，无需安装全局 CLI，仅 opencode 需预装）。
- **任务风险档位**：项目可配 `risk: read | write | full`（缺省 `write`），由适配器映射为各端权限/沙箱参数（opencode `--auto-approve` 开关；codex `--sandbox` 三档；claude `--permission-mode` 三档，full 档需 `claude.dangerouslyAllowBypassPermissions`）。
- **三端会话落盘补丁**：`a2a-codex` / `a2a-claude` 经 patch-package 将 `contextId → sessionId/threadId` 落盘至 `<workspace>/.a2a/sessions.json`，agent 退出后同一 `contextId` 仍可续接（与 opencode 补丁语义一致）；配套验证脚本 `verify-session-persist-{codex,claude}.mjs`。
- **Machine 启动自检**（REQ-v0.1.1-2026-09-11-03）：Launcher 监听端口前对本机全部项目逐个 `ensure` 拉起 → 发送真实最小任务 → 校验完成且响应非空 → `stop` 回收；任一失败打印项目/阶段/原因并**非零退出**（fail-fast）。可配 `launcher.startupCheck`（缺省开）、`startupCheckTimeoutMs`（默认 120s）、`startupCheckPrompt`。
- **启动配置快照**：每次拉起 Agent 时 Launcher 日志打印配置获取层级（项目 agentConfig + 用户级配置路径）与 endpoint / 模型 id（标注来源 agentConfig / env / 用户配置），便于核对实际生效配置。
- **任务结果保障**（REQ-v0.1.1-2026-09-13-01）：桥的派发-落库-查询全链路加固——
  - 半异步预算：`SYNC_BUDGET_MS` 默认 30s（须小于 host MCP client 超时），到点返回 `working + taskId + contextId` 与轮询/恢复指引文案；
  - 后台看护（`bridge/task-watcher.ts`）：预算到点后桥继续轮询 + 租约续约**直至任务终态并落库**，无人轮询结果也不丢；按 taskId 并发去重，连续失败 30 次放弃；
  - 落库带 text：任务结果纯文本（成功 = artifacts 文本，失败 = 错误原因）随 settle 持久化，tasks 表加 `text` 列（旧库自动迁移）；
  - 查询本地快路径：`a2a_task_status` 对终结态任务直接以本地存档作答（不唤醒远端 Agent），旧记录 text 为空时从 artifactsJson 拼接兜底。

### Changed

- **Claude 默认加载用户级配置**（REQ-v0.1.1-2026-09-11-02）：`a2a-claude` 默认 `settingSources: ["user"]`，用户 `~/.claude/settings.json` 的模型 / 网关 / 认证开箱即用（与 opencode / codex 配置继承语义一致）；项目可用 `agentConfig.claude.settingSources: []` 恢复隔离。三端统一语义：默认继承用户级配置，项目 `agentConfig` 逐字段覆盖。
- README：三端部署与验证说明、工具半异步语义、`SYNC_BUDGET_MS` 与 host 超时匹配说明、codex 自定义网关配置要点（OpenAI 兼容 `base_url` + `/responses` 拼接需含版本段）。

### Verified

- 三端均完成真实模型端到端验证（含退出后同 `contextId` 续接）：opencode（v0.1.0）；claude（用户级 settings 网关认证，无 env 注入）；codex（`config.toml` 自定义 provider + 兼容网关）。
- 回归测试全量通过（报告见 `reports/v0.1.1/regression-report.json`；`reports/` 不入库）。

## [v0.1.0] - 2026-09-11

### Added

- 基于 A2A 的分布式 Code Agent 协作最小闭环，本轮以 OpenCode 打样。
- 两个自包含部署单元：`orch/`（MCP 泛型桥 + 会话/任务库）与 `machine/`（每机启动器 + 三端适配器骨架）。两者各自持有 `package.json` / `tsconfig.json` / `node_modules/` / `dist/` / `config/`，线协议类型在两侧各自声明（无 `shared/`，无跨单元 import）。
- MCP 泛型工具 `a2a_projects` / `a2a_call` / `a2a_task_status` / `a2a_cancel`。工具面恒定，新增 Agent 不需要 orch 重连，也不发 `tools/list_changed`。
- 静态「项目 → 机器」分布：orch 持机器清单（`orch/config/config.json`），每机持本机项目配置（`machine/config/config.json`）。
- 每机常驻 Launcher，暴露 `GET /health`、`GET /projects`、`POST /projects/{id}/ensure`、`POST /projects/{id}/stop`，不做服务发现。
- 按需幂等启动：`ensure` 已在运行则复用同一端点，不重复拉起。
- 执行层集成 `a2a-opencode`：launcher 先拉起前置 `opencode serve`（动态分配本机空闲端口），再启动包装器并传入 `--opencode-url`。
- 包装器配置生成：launcher 每次启动渲染 `agents/<agentKind>.<projectId>.json`，默认 `events.enabled=false`，并深合并每项目 `agentConfig`。
- trace 处理：源头关闭 `events`，bridge 侧再兜底过滤 `trace.*` artifacts，观测数据不进入 orch。
- 会话跨退出复用（方案 P）：`patch-package` 补丁让 `a2a-opencode` 把 `contextId → sessionId` 落盘到 `<workspace>/.a2a/sessions.json`，Agent 退出后同一 `contextId` 仍可恢复上下文。
- 用完退出：launcher 按 `launcher.idleStopMs` 空闲回收（默认 5 分钟，`0` 关闭）；bridge 在轮询期间按 `LEASE_RENEW_INTERVAL_MS` 周期性 re-ensure 续约，避免误杀长任务。
- 回归测试 skill：`.omo/skills/regression-test/`（`index.js + lib/ + tests/`，共 60 条断言），静态检查项目结构、单元自包含、配置样例、会话补丁、trace 处理、空闲回收与租约、入口脚本、两单元类型检查与文档收尾，输出 `reports/v0.1.0/regression-report.json`。

### Notes

- 本轮仅 OpenCode 打样：`machine/adapters/` 已含 `codex` / `claude` 骨架，依赖安装、配置生成与生命周期随后续版本补齐。
- `orch/config/config.json` 与 `machine/config/config.json` 为本地实际配置（git 忽略），模板见各自目录下的 `config.json.default`；部署到实际机器时按机器与项目替换。
- 执行层入站鉴权尚未实现，跨机 A2A 端点依赖反向代理补足（见 README「已知边界」）。
