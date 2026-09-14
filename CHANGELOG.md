# Changelog

本项目的所有重要变更都记录在此文件。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
