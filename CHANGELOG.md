# Changelog

本项目的所有重要变更都记录在此文件。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [v0.8.9] - 2026-09-23

> 主题：**执行可靠性 III：上下文**（**两条需求同版交付** —— ① `REQ-v0.8.9-2026-09-22-01`「会话复用与上下文治理」· ② `REQ-v0.8.9-2026-09-23-01`「续跑余量独立配置」；两条 Step 3 均由用户验收通过，验收账见各自改造文档）。**需求 1 的问题定义在 Step 0 被实测推翻并收窄**：生产里**没有长会话**（同一锚点 60 条 / 54 个 `contextId`：**48 个只跑 1 轮、0 个 ≥3 轮**）⇒ **不做上下文截断 / 摘要**，改建四件：**① 派发消息不再递归膨胀**（实测同一节点 500 字 → **7261 字**、`<feature-context>` 叠 3 层）· **② 复用 / 轮次 / 消息体积只读可见面**（此前四张面全不可查）· **③ 轮边界判据加固**（历史回灌的结论块可能被当成本轮结论）· **④ 会话映射保留边界**（只增不减 ⇒ 7 天 / 500 条 + 让删除方法有调用点）。**需求 2 把「自动续跑」的资格与额度从窗配置里拆出来**：`continueMarginMs` **独立成键、缺省 0 = 不续跑**（改显式 opt-in），派发预算改**三段公式**，续跑轮额度**只吃 `em`、不吃 300s 结构余量**（由**轮级 deadline 收紧**执法），并把窗上限由 15 min 收严到 10 min 以免击穿 orch 孤儿墙钟。**协议零变更**（`PROTOCOL_VERSION` 仍 **2.3** —— 两条需求都是本机策略 / 本机可见面，不动线上契约）。

### Changed

- **派发消息不再重复包裹**（orch ①-a + machine ①-b）：orch 侧把**未渲染 base** 与**渲染结果**分列 —— `dispatch_message` 只存 base，渲染快照另落 `dispatch_rendered`（**覆盖写**）；machine 侧首轮注入加 `injectedAt` 守卫 ⇒ **重派不再二次注入**。真机 3 连派：`baseChars`/`renderedChars`/`wrappedChars(=133)` 三次逐字不变、`injectedChars` **582 → 0 → 0**；库内对照历史行（3 层 / 7261 字）⇒ 归零。
- **续跑余量独立成键**（machine）：`agentConfig.continueMarginMs`（平铺自消费键 · **非负整数** · **上限 = 本项目生效会话窗** · **缺省 0 = 不续跑**）；派发预算改**三段公式** `总框 = 生效窗 + 结构余量(DISPATCH_MARGIN_MS = 300_000) + min(续跑余量, 生效窗)`，`生效窗 = 显式 sessionTimeoutMs ?? 桥缺省 600_000` ⇒ **未配窗项目也走同一公式**（消除「配不配窗 ⇒ 续跑资格不同」的隐式耦合）。
- **续跑轮额度 = `em`（独立额度 + 轮级 deadline 收紧）**（machine）：进续跑轮前 `deadline = Math.min(deadline, now + em)`（**只收紧、不延长**）—— 桥的 `--session-timeout` 只带窗值、不知 `em`，不收紧则续跑轮会吃掉 300s 结构余量。闸新增准入 **`em > 0`**，地板改为 **`remaining ≥ max(180_000, em)`**。
- **窗上限护栏收严**（machine）：`SESSION_TIMEOUT_MS_CAP` **900_000 → 600_000**（10 min）—— 最坏总框 = 600 + 300 + 600 = **1500s（25 min）** < orch 孤儿墙钟 30 min ⇒ **免组合校验**；代价 = 单轮不再能跑到 12–15 分钟。**超限 / 非法 ⇒ 加载期 `fail-fast`（拒绝，不是截断）**。
- **轮边界判据加固**（machine）：跨轮归档保留（历史回灌的结论块不再被当本轮结论）；判据仍单点，但**不确定就显式暴露**（`outcomeAmbiguous`）。
- **会话映射保留边界**（machine）：`sessionRetentionDays`（缺省 7）/ `sessionRetentionMax`（缺省 500）+ LRU 淘汰，并**让 `SessionMap.delete()` 有调用点**。
- **宿主口径文档**（仓根）：`AGENTS.md` ↔ `CLAUDE.md` 的「失败处置纪律」§2 按新口径重写（续跑资格 = `continueMarginMs > 0`、与配没配窗解耦；「660s」字样退役；跨单元硬约束三数 600_000 / 1500s / 1800s）。

### Added

- **复用 / 轮次 / 消息体积可见面**（machine 上送 + orch 投影）：`turn` / `sessionReused` / `sessionResumed` / `injectedChars` / `resultChars` / `blockCount` / `replayDropped` / `outcomeAmbiguous` / `sessionMapSize` / `sessionMapOldestAgeDays` / `partialChars` 等，orch 侧另有 `baseChars` / `renderedChars` / `wrappedChars` / `attempts`。
- **`config-snapshot` 播报两键**（machine）：启动时逐项目打印 `sessionTimeoutMs=… continueMarginMs=…`（含「缺省」标注与出处）—— 补上「配了窗但日志看不到」的盲区。
- **`continueMarginMs` 加载期校验 + 新用例**（machine）：非负整数 + **≤ 生效窗**，超限 ⇒ 拒，文案带窗数值与出处（`test/config-continue-margin.test.ts`、`test/config-session-retention.test.ts`、`test/acp-session-retention.test.ts`）。

### Removed

- **`DEFAULT_DISPATCH_TIMEOUT_MS = 660_000`**（machine）：退役 —— 隐式耦合的落地处（未配窗项目的总框不再自成一档）。
- **桥侧死常量 `DEFAULT_TASK_TIMEOUT_MS = 660_000`**（machine）：零消费方 ⇒ 直接删。
- **`orch/config.ts` 对已删符号名 `dispatchTimeoutMs` 的引用**（收口轨 `560a0dde`）：改写为「机器侧最坏总框上界」口径。

### 门禁与真机

- **单元门禁（发版前重跑实测）**：machine `typecheck` **0** / `npm test` **501 / 501 · 0 失败**；orch `typecheck` **0** / `npm test` **342（341 pass / 0 fail / 1 平台跳过）**。
- **宿主回归**：**1298 / 1298 零失败**（`reports/v0.8.9/regression-report.json`）。**与 v0.8.8 的 1296 差额 = +2，已核实为**：本版**两条需求** ⇒ `doc/v0.8.9/` 目录锚 + **两份**改造文档各自的 TC10 锚（含字面 `final` 行）；版本锚与两条 pin 为**改名**（0.8.8⇒0.8.9）**非增减**。
- **真机（Step 3 · 2026-09-23；用户重启桥 + Launcher 并**新建 `test` 项目**供验收；宿主全程自取证据）** —— **需求 1**：①-a ✓✓（3 连派 `wrappedChars` 恒定 + 库内 before/after）· ①-b ✓（首轮 `injectedChars=582` → 后两轮 **0**）· ② ✓（键面在真机出参里）· ④ ✓（`sessionMapSize=272` / `oldestAgeDays=3`）· **场景 C 正例 ✓✓**；③ 部分（以离线用例为准）。**需求 2**：**三段公式**（未配窗 `900000` / `test` `1000000`）· **续跑额度 = `em`**（`em=600000` ⇒ 日志 `remaining=600000ms`；`em=100000` ⇒ `remaining=99999ms`）· **轮级 deadline 收紧 ⇒ 300s 结构余量未被挪用**（总耗时 **1203s** 而公式总框 **1500s**）· **`em=0` 准入执法**（负例满窗剩 ≈300s ≥ 180s 闸却**不续跑**：603.3s / `acp-prompt`）· **续跑真接回同一会话**（`sessionResumed=true` + 同 `sessionId`）· **超限被拒**（用户亲手验两条：`> 600000` ⇒ `Error: [config] …` + **Launcher 不启动**）· 快照两键播报 ✓ · 两种结局（被收紧 deadline 砍断 / 额度内完成）各现一次 ✓。

### 未覆盖（登记，不计通过）

- **需求 2**：`em < 180s`（**设计上不验**：会触发但意义有限 —— 地板只闸剩余预算、不闸额度下限）· 多轮续跑（设计禁止 `MAX_CONTINUE_ATTEMPTS = 1`）· 「传输重发 × 续跑」组合（`MAX_DISPATCH_ROUNDS = 2` 防 4 轮，需组合条件、不可控）· 闸的三条防御路径（`dispatchTimeoutOverride` / 时钟回拨 / `ensure` 超长吃掉结构余量）。
- **需求 1**：`CE-4` 已知不可判 · `CE-2` 真机现实性 · `parseOutcomeFromGroups` 机制就绪**未接线** · `lastBlockIndex` 不上账面 · 受控排队实验 · **长会话未证实也未证伪**（重启条件 = 出现 ≥5 轮的真实节点且失败率显著高于首轮）· `sealed_settle` 事件语义待核。
- **两处新登记的「失败可见面」缺口（属 v0.8.8 面、本版刻意不顺手修）**：**①「事件先于分类」** —— orch 落 `failureKind` 在发出 `task.settled` **之后**（读的是结算前的值）⇒ 某行**首次**失败的事件 payload 必然读不到类型（实测 7 条 failed settle 仅 1 条带）；**② 续跑闸「拒绝路径零日志」** —— `dispatchAction` 返回 `null` 时静默 `break`、只有放行分支才打印 ⇒ 「为什么没续跑」无法从日志直读。
- **沿袭的老项**：传输层**有界重发**（只在 `spawn`/`closed` 早夭触发、不可控 —— 9 万行日志至今 **0 触发**）· `agent` / `transport` 六类真机样本 · `model_queue` 本版无代码产出 · L3 跨机 × 跨 kind（`mac-dev` 入组即可）· 混跑兜底（需旧版本机）。
- **两处只报不修的小缺陷（v0.8.8 遗留面）**：降级 `degraded[].since` **不粘滞**（持续降级期间随 sweep tick 前跳）· 墙钟判死任务 `text` 为空（⇒ 账单 `failed[].text` 会是 `null`）。
- **一条新观测（非缺陷）**：续跑日志行里的 `sessionResumed` 是**触发续跑那一轮**的值 ⇒ 易误读（宿主据此错判过一次，已改正）· **一条待清的口径漂移**：`orch/config/config.json.default` 仍写孤儿墙钟置 `failure_kind=infra`（该取值自协议 2.3 起非法、现行 = `runner`）⇒ 随下一轮 orch 口径收口一并清。

## [v0.8.8] - 2026-09-22

> 主题：**执行可靠性 II：失败可见与策略**（单需求 · `REQ-v0.8.8-2026-09-22-01`；用户 2026-09-22 Step 3「验收通过」）。**四件事一次收口**：**① 失败分类由「两值桶」变六类闭集** —— `{infra, task}` 里 `task` 是**兜底桶**（`timeout`/`rpc`/`protocol` 全落进去），且两单元对 `timeout` 的定义**互相矛盾**（machine ⇒ `infra` / orch ⇒ `task`，而 orch **根本不读** machine 上报的那个值）⇒ 新闭集 `{agent, transport, runner, model_queue, timeout, business}`（+ `timeoutScope` 子键），线协议 `2.2 → 2.3`。**② 判死的任务第一次能说清「为什么死」** —— 补齐 `task.settled` 终态事件（pull 模型下普通任务的事件足迹原只剩 `task.claimed`）+ 六类真机样本 + 失败账单带 `failureKind`。**③ 超时不再必然丢活** —— 场景 C 续跑（同 `contextId` 续接，用户裁 ①(b)「按类自动重试」的第一个显式场景：**600s 超时 ∧ 确有输出 ⇒ 任务太大 ⇒ 可重试**）。**④ 降级不再静默** —— 坏配置曾让 orch 三条保护**静默失效**而 `/health` 照旧 200 `ok`。同版补齐 **v0.8.7 顺延 5 项里的 4 项**（孤儿墙钟 / 启动补结算 / `--session-timeout` 成对 / `failure_kind` 落库）+ 投影层 `claimedAt` / `queuedAt`。改造文档：`doc/v0.8.8/失败可见与策略-改造文档.md`（**final**；边界 R1→R2→R3 三轮收敛 + Step 2/Step 3 两条实现级增补）。

### Changed

- **失败分类硬切六类**（orch · §2.1）：`FailureKind` 改 **`{agent, transport, runner, model_queue, timeout, business}`**，闭集**派生自 `PROTOCOL.md`**（唯一事实源）；orch 的**自映射角色被删除**，改为「**校验 + 落库**」。**兜底宽容（D2）**：缺键 / 旧值 `infra`·`task` / 未知值 ⇒ 桥**不崩、不整包拒**，落**安全类 + warn**（warn 带原值 `failure_kind_fallback=<infra>`，否则事后无法区分「真 business」与「兜底 business」）；`coerceStoredFailureKind` 放宽。**硬切不保别名**（无归一谓词、无旧键兼容）。**唯一显式冗余 = 兜底映射**（`mapAcpErrorKindToFailureKind`，并存理由仅「混跑窗口内未升级的 2.2 machine 可能上报缺键或旧值」，登记为「兜底，非并行分类」）。
- **machine 判据映射（事实归 machine、映射权归协议）**（machine · §2.3）：`classifyFailure` 改值域为六类 + **判不出即不报键**（不加第 7 值）；新增 **`timeoutScope ∈ {acp-prompt, runner-deadline}`** 子键。**machine 只报原生事实、不建第二张「kind→六类」映射表**。**`model_queue` 本版 machine 恒不产出**（无独立信号：ACP 层无队列概念、后端静默时什么都不说）⇒ 它今天只是「协议里合法的取值」，**不是「会被产出的取值」**（启发式判定挪 v0.8.10，与排队可见面同版）。
- **`recover()` 修法**（orch · §2.7）：桥重启**不再把派发窗口内的在飞节点直接置 `failed`** —— 改造前那一支会**抢先扼杀**随后 `reconcile-inflight` 的启动补结算窗口。改后保留 `working`，交**补结算 / 孤儿墙钟**两条既有路径结账。
- **墙钟判死改判非续跑子类**（orch · §2.1-9）：`failure_kind = runner`（**不是 `timeout`**）—— 「载体已经走了」不该在账面上显示成「本可续跑」。
- **`PROTOCOL.md` 升 2.3**（§2.11）：演进表新增行（含「**旧值非法但可接收**」）+ 六类取值集合写入条文；两侧 `PROTOCOL_VERSION` 常量**同升**（orch `types.ts` / machine `types.ts` / `orch/README.md` 三处，v0.8.7 那次的「三处同升漏两侧常量」教训已按单元拆节点落）。

### Added

- **场景 C 续跑 = 「续跑 ≠ 重派」**（machine · §2.4，本版主战场）：判据 = `state=failed ∧ timeoutScope="acp-prompt" ∧ continueAttempts=0 ∧ roundsSinceStart<MAX_DISPATCH_ROUNDS(2) ∧ (partialChars≥200 ∨ updateCount≥5) ∧ remaining()≥CONTINUE_MIN_REMAINING_MS(180s)`；机制 = **`host.stop → ensure → 同 `contextId` `session/load` 续跑** + 半截产出**拼进 prompt**（注入消毒 + 尾部上限 4000 字符）+ `sessionResumed` 回标。**`deadline` 从不延长**（`--session-timeout` 成对语义零改动）。**续跑不动 `retry_count`** —— 正交双计数器：`attempt`（宿主重派）vs `continueAttempts`（machine 续跑）；orch **零新写口、不新增端点**（`/runner/retry-request` 提案已撤回）。
- **`task.settled` 终态事件补齐**（orch · §2.6）：`upsertTaskResult` 在「**首个终态胜出**」时发一条（门 = `changes>0 ∧ isFinishedState`），payload 含 `attempt`（= `retry_count`）/ `continueAttempts` / `machineId`；**`working` 更新不发**、重复/迟到上报**不重发**（幂等）。根因 = pull 模型下结果直接 UPSERT、不 `appendEvent` ⇒ 「靠事件流等普通任务收尾」原本不可行。
- **`task.continued` 派生事件 + `diagnostics` 宽 JSON 原文列**（orch · §2.5/§2.6）：`continueAttempts>0` 时发 `task.continued`；`diagnostics` 以**宽 JSON 原文**落库（**13 键**，为 v0.8.10 留返工红线）。
- **降级可见（两面，互不相通）**：orch 侧新 **`DegradationRegistry` + `GET /health degraded[]`**，先接管三条**静默失效**的保护 —— 心跳超期清算（`runner.heartbeat-sweep`）/ **孤儿墙钟清算**（`runner.orphan-sweep`，v0.8.7 刚落的那条）/ 领取超期判据（`claim.stale-criterion`），坏配置当场可见（每条带**精确原因**）而非「服务还活着 = 配置没问题」；machine 侧**只改自身 `/health`**（`degraded.selfCheckSkipped` 等）—— **不动注册载荷顶层字段**（`startupCheck=false` 不再伪装成「自检通过」）。两面按 C4 **互不相通**。
- **执行轨迹 Trace**（orch · §2.10）：**(a)** 页面渲染 `retryCount` / `failureKind` 两列 · **(b)** 投影补 **`claimedAt` / `queuedAt`**（v0.8.7 顺延项坐实）· **(c)** 只读查询 `GET /api/features/:id/trace`（答「在等谁 / 排队位次」，**不落库**）。
- **machine 计量补全 + 上报 schema（13 键）**（machine · §2.5）：新增 `firstChunkElapsedMs` / `partialChars` / `updateCount` / `promptElapsedMs` / `bridgeEnsureElapsedMs` / `sessionResumed` / `continueAttempts` / `continueTrigger` / `partialTailChars` / `acpErrorCode` / **`acpErrorData`** / `workspaceTouched` / `touchedFileCount`。**`AcpError.data` 必留** —— **方言不对称**：qoder-cn 把细节写进 `message`、**opencode 只写进 `data`**（message 仅 `Invalid params`）⇒ 只留文本则 opencode 的错误永远只有四个字、判不出来。
- **取证面四处（让证据活下来）**（machine · §2.3.1）：① `client.ts` 迟到响应分支 `return` 前保留 `error.code/message/data` ② `reasonOf` 扩成 `message +（code=…）+ data 摘要` ③ `failureResult` 补 `code`（此前**连 code 都不拼**，最大缺口）④ `withDiag` payload 加 `code`/`data` 并同步放行 launcher 白名单（否则桥写了 launcher 也丢）。**动因是一条历史取证**：86,554 行日志里两条 600s 零输出样本的 `failed` 行后**紧跟 `[acp] 收到未知 id 的响应：4`**（id=4 即 `session/prompt`，全日志 31 次皆如此）⇒ **响应其实回来了、payload 被丢**（超时回调先 `pending.delete(id)` 再抛 ⇒ 迟到响应落进「未知 id」分支、一字不留）⇒ 用户「配额该有报错」的假设**方向正确，但取证面自己吃掉了证据**。
- **只读工作树指纹**（machine · §2.3.2）：`git --no-optional-locks status --porcelain` + `rev-parse HEAD`（起止各一次，**零写入 / 不动 HEAD**），**必须按 project 子目录前缀过滤**（从子目录跑仍输出全仓改动）。定位 = **单向排除 + 重发安全闸**，主判据仍是执行面信号。**用户提议的「每任务前 `git commit`」不采纳** —— 三 project 是同一 monorepo 子目录、**共用唯一 `.git`/index**，而纯只读任务跑满窗与排队零输出在「工作树有无改动」上**完全同相**（无分辨力，且只读任务正是超时高发户）；自动 commit 还会摧毁「相对 HEAD 的 diff」复核链 + 并发抢 `index.lock` + 卷走对方半成品。
- **存量迁移脚本**：`orch/scripts/migrate-failure-kind-sixclass.mjs`（四值存量置 NULL，**缺省 dry-run**、`--apply` 才写、可重入）。
- **单测**：orch `test/o1-sixclass.test.ts` · `o3b-diagnostics-continued.test.ts` · `o5-degradation-visibility.test.ts` · `o7-feature-trace.test.ts` · `migrate-failure-kind-sixclass.test.mjs`；machine `test/health-degraded.test.ts`。
- **回归用例**：`.omo` 新增 **`test-v0.8.8-failure-visible.js`**，`TESTCASES.md` 新增 **TC21**；`test-v0.8.4-key-layout.js` / `test-v0.8.5-codex-claude-acp.js` 的 machine 版本 pin 随发版翻向 0.8.8。
- **`scripts/watch-feature-loud.mjs`（宿主面，Step 3 现场化的工具）**：既有 `watch-feature.mjs` 的 `failure-at-rest(10)` 要求「**静止**且有失败」⇒ 600s 超时型失败出现时其它节点仍在飞 ⇒ **永远不退 10**、只能等窗口耗尽退 20（宿主因此收不到「有失败」信号）⇒ 新脚本改为「**失败即叫**」：相对入场基线出现 `failed` 即打印失败清单并退 **30**（其余退出码兼容 `0/10/11/12/13/20/1`）。
- **宿主纪律**：`CLAUDE.md` / `AGENTS.md` 新增**失败处置纪律**（策略表怎么用：`timeout × acp-prompt` 可重试 · `runner-deadline` 不可 · `model_queue` 只标注不自动动作）。

### Removed

- **`{infra, task}` 二分及其自映射角色**（orch）：不再自行映射 `acpErrorKind`，改「校验 + 落库」；无别名表、无归一谓词（硬切）。
- **`startupCheck=false` 的不可区分性**（machine）：自检被跳过时 `/health` 不再与「自检通过」同形。

### 门禁与真机

- **单元门禁（发版前重跑实测）**：orch `typecheck` **0** / `lint` **0** / `npm test` **332（331 pass / 0 fail / 1 平台跳过）**；machine `typecheck` **0** / `lint` **0** / `npm test` **422 / 422 · 0 失败**。
- **宿主回归**：**1289 / 1289 零失败**（`reports/v0.8.8/regression-report.json`；v0.8.7 为 1220 —— 差额 = 本版新增 **TC21** + 若干反转/新增断言）。
- **真机（Step 3 · 2026-09-22，用户重启 + 三次配置窗口，宿主全程自取证据、无一项靠转述）** —— 本版核心三机制全过：**① 场景 C 续跑正例 ✓✓**（`task.continued`：`continueAttempts:1` · `continueTrigger:"acp-prompt-timeout"` · `timeoutScope:"acp-prompt"` · `partialChars:9317` · `updateCount:1677` · `firstChunkElapsedMs:10535` · **`sessionResumed:true`** ⇒ **同 ctx 续接真的成功、未退化成重跑**；同任务 `task.settled` = `attempt:0` + `continueAttempts:1` ⇒ 正交双口径成立）· **② 场景 C 负例 ✓✓**（未配窗项目：寿命 **603.1s** 判 `failed`、`continueAttempts:0`、**全程无 `task.continued`**）· **③ 降级可见（负向 + 恢复）✓✓**（故意写坏类型 ⇒ `degraded[]` 当场出现**三条带精确原因**、`status` 仍 `ok`；改回 ⇒ **归零**）。另 **孤儿墙钟出口 ✓✓**（`task.orphaned`，`elapsedMs 309461 ≥ timeoutMs 300000`，`failureKind=runner`）· **启动补结算 ✓✓**（在飞时重启 Launcher ⇒ `task.stale → runner.offline → task.settled(failed) → runner.online`，**text 自解释**）· **`recover()` 不误杀 ✓✓**（桥重启前后均 `working`、事件面零新增，且该任务**活着跑完**）· **换 kind 会话回落 ✓✓**（`session/load` 带旧 uuid ⇒ `-32603` ⇒ `session/resume` 缺 `cwd` ⇒ `-32602` ⇒ 回落 `session/new`、`sessionResumed:false`）· 协议 2.3 注册 ✓ · O6 投影四字段（真实值 `queuedAt → claimedAt` 排队 **75ms**）✓ · O7 trace 路由 ✓ · **`task.settled` 两种终态各落一条** ✓ · **六类真机样本 `business` / `runner` / `timeout`** + 账单带 `failureKind` ✓ · 工作台两列 ✓。**v0.8.7 顺延 5 项 ⇒ 4 项已验**（仅剩「有界重发」：只在 `spawn`/`closed` 早夭触发、**不可控**）。
- **执行期实况（本版自身的观测样本）**：**9 次 600s 超时**（`M1` `M2` `M3` `O1` `O3` `O5` `O7` `M5` `D2`，全部靠 `retryTaskIds` 重派收口、**无节点需第二次重派**；`D2` 四次才过）· **2 次 `needs_input`**（门禁归属 / 收口裁决）· **四轮补正轨**（② 协议三处同升漏两侧常量 · ② `O6` 产出未落地 · ③ 版本 pin 提前翻 · ④ 账单 payload 未落地）。

### 未覆盖（登记，不计通过）

- **`model_queue` 本版无任何代码产出该值**（machine 恒不产出 + orch 启发式**也未实现**）⇒ 它只是「协议里合法的取值」；判定形态与排队可见面**一起归 v0.8.10**。
- **「配额耗尽会不会报错」的真实样本未取到**：取证面四处已就位，但两家后端**始终没等到**一次真触发（历史取证结论 = **既不能证实也不能证伪**）⇒ 先攒样本，攒够后把 (a) 半升级为确定性判据。
- **续跑轮上下文完整性未验**：`session/load` 回灌的历史**是否含那半条未完成的 assistant message** · 超时后**延迟到达的 chunk 是否污染 `replayMessageIds`**（两条原标「Step 2 前置核实」，始终没做）。
- **`agent` / `transport` 两类无真机样本**（下游是载体早夭、与「有界重发」同源、不可控）；**混跑兜底未真机**（需一台旧版本机器；**过渡期口径**：2.2 机上报的载体侧失败在账面上呈 `business`，与真 `business` 靠 warn 原值区分）。
- **设计上不验**：续跑**无 mid-flight 实时面**（`task.continued` 只能在终态回传后派生）· 未配 `sessionTimeoutMs` 的项目**场景 C 结构性不触发**（**不算 bug**：缺省 margin 仅 60s < 180s 闸）· 续跑任务若**被墙钟判死**则续跑痕迹不入事件流。
- **三处小缺陷（Step 3 只报不修）**：① 降级 `degraded[].since` **不粘滞**（持续降级期间随 sweep tick 前跳 ⇒ 丢「持续多久」；**静态复核结论被真机推翻**）② 墙钟判死的任务 `text` 为**空**（⇒ 账单 `failed[].text` 会是 `null`）③ `session/resume` 请求**缺 `cwd`** ⇒ 在 opencode 上必然 `-32602`、该级形同虚设。
- **执行期新观察待专项核实**：失败文本**「重复两遍」不是超时专有**（业务失败同为 `任务失败\n任务失败`）⇒ 原「两层超时各出一句」假设被削弱，更像**文本拼接路径重复 append**。
- **L3 跨机 × 跨 kind 单 Feature 端到端**仍未覆盖（v0.8.7 顺延项）：新线索 = 事件流出现过 `mac-dev` 的 Runner ⇒ 它**连着这个桥、只是不在组**，加进 `projectGroup` 即可验。

## [v0.8.7] - 2026-09-22

> 主题：**执行可靠性 I：任务不丢**（单需求 · `REQ-v0.8.7-2026-09-22-01`；用户 2026-09-22 裁「真机验证通过，其余未覆盖项实施 v0.8.8 时来验收」）。**三个病根一次收口**：**① 同 project 串行门修复** —— 忙集判据断链（SQL 用 `remote_task_id`，而 pull 模型下 Feature 节点该列**全程 NULL** ⇒ 忙集**恒空集**，只余 30s 批次的 `reservedProjects` ⇒ 实际语义退化为「**同批互斥、跨批不设防**」；真机实证三条同项目节点并发在飞 541 s）· **② 载体消失后的结账** —— 新增**孤儿墙钟出口**（`runner.orphanTimeoutMs`，缺省 30 min）与 **Runner 启动补结算**两条**显式冗余**路径 · **③ 传输层有界重发** —— 首发早夭自愈，每节点**最多 1 次**。同版另落：**`failureKind` 二分（`{infra, task}`）** · **`--session-timeout` 可配（成对常量）** · **取证面 `started_at` 接首次领取** · **3300 工作台任务表加 `startedAt` 并把「耗时」拆成「排队 / 执行」**。改造文档：`doc/v0.8.7/任务不丢与串行门修复-改造文档.md`（**final**；边界 R1→R3 三轮收敛 + Step 2/Step 3 两条实现级增补）。

### Changed

- **忙集判据改活**（orch · 改造文档 §2.1）：`listBusyProjectIds()` 的 SQL 由 `state='working' AND remote_task_id IS NOT NULL`（**pull 模型下恒空集**）改为 `state='working' AND queue_state IN ('queued','claimed','running')`，并收敛为**单一私有谓词** `busyProjectPredicate()`（判据唯一事实源）。**采纳 orch 的反对、不做 lane 复合键** —— 消费侧是三处 `set.has(projectId)`，元素变 `p#lane` 后任一消费点漏改即 **串行门静默失效**（正是本版要根治的「假绿」形态）⇒ v0.8.10 读写分道的接缝**以文档形态留、不以代码形态留**；`reservedProjects` 保留不动（成本零）。`queued` 一并计入忙集 ⇒ 串行不变量**完全由 orch 谓词持有，不依赖 machine 的领取纪律**。
- **`started_at` 接首次领取**（orch · §2.4）：`claimTask` 的 UPDATE 加 `started_at = COALESCE(started_at, ?)`（**只填一次、重试不重置**）；**摘除 `createTask` 对 `working` 行的 `started_at` 预填** —— 该预填使 COALESCE 在**生产链路上恒不生效**（O3 以 `:memory:` 探针实测），摘除后 `claimTask` 成为开工时刻的**唯一写口**；连带**翻正五处过期注释**（原口径指向**生产零调用**的 `markTaskDispatchStarted`）。
- **`--session-timeout` 可配 + 成对常量**（machine · §2.6）：新项目级**平铺**键 `agentConfig.sessionTimeoutMs` ⇒ 四家适配器下发 `--session-timeout <ms>` ⇒ 桥 `parseBridgeArgs` 宽松校验（**整数 > 0**，纪律同 `--port`）⇒ launcher 侧 `dispatchBudgetMs(sessionTimeoutMs) = sessionTimeoutMs + DISPATCH_MARGIN_MS(300s)` **按项目取** deadline。**取值改判（R2 纠错）**：真实最坏墙钟 = 会话建立段（`new`/`load`/`resume` + 三个 `apply*`）**每步各享一个 session 窗**（最坏 ≈ 6×）⇒ **上限由 20 min 改 15 min、margin 由 60s 改 300s**（最坏 20 min，对 orch 30 min 仍 **1.5×**。**上限校验单一源 = `launcher/agent-config.ts` 的 `SESSION_TIMEOUT_MS_CAP`**（桥是零仓内依赖的叶模块，只宽松校验 —— 两处各定义必漂移）；**反对只做机器级全局 flag**（一个慢项目不应拉长全部项目的台账寿命）。
- **迟到 / 重复终态 = 2xx-with-ignore 显式落档**（orch **零实现改动** · §2.9 契约 3）：经核实**这已是现状行为**（`upsertTaskResult` 的 `WHERE state NOT IN (terminal)` 使迟到件**整条零写入** ⇒ 回执恒 `200 + ack:true`）⇒ 本版只加**契约文档 + 硬用例锁定 + 一条「与已落终态不一致」warn**。**不得改成 4xx** —— Runner 侧 outbox 对**任何非 2xx 一律保留待重试**，改 4xx 会让已落终态的迟到件**无限退避死循环**。
- **`requeueStaleTask` 不再清 `claimed_by`**（orch · §2.7 前置）：只清 `claim_token` / `claimed_at`（零涟漪已核：`listClaimedTasks` 按 `queue_state IN ('claimed','running')` 过滤 ⇒ `queued` 行留着旧 `claimed_by` 不进回收路径；下次 `claimTask` 覆写）。

### Added

- **孤儿墙钟出口**（orch · §2.2）：新配置键 `runner.orphanTimeoutMs`（`asPositiveMs` 校验，**缺省 `1800000` = 30 min**）+ 新方法 **`sweepOrphanedTasks()`**（挂**既有** `sweepIntervalMs` timer、同 gate / 同 try-catch 风格、判据**独立**于注册态）+ 新事件 **`task.orphaned`**（payload `{machineId, projectId, featureId, claimedAt, elapsedMs, timeoutMs}`）；命中 ⇒ `state='failed'` + `queue_state='settled'` + `failure_kind='infra'`（**不清 claim 三字段** —— 墙钟后的迟到件须仍能过契约 3 的幂等口）⇒ Feature 静止收敛发失败账单 ⇒ 宿主 `advance(retryTaskIds)`。**与心跳清算分工不同**（心跳管「**机器死没死**」⇒ `queued` 可复活；墙钟管「**任务自己超没超**」⇒ `failed` 记账交宿主），**同 tick 先 `sweepStale` 后墙钟** ⇒ 两路竞争天然消解。
- **`failureKind` 二分写口**（orch · §2.3 / §2.8）：取值**复用既有 `{infra, task}`**（零新词；v0.8.4 起的 v0.4.1 原文口径，v0.8.8 再往六类扩 = **加取值而非重定字段**）。**事实归 machine、映射归 orch**：machine `classifyFailure` 只判 `failureKind` 并附 `diagnostics`，桥侧纯函数 **`mapAcpErrorKindToFailureKind`** 以**原生 `acpErrorKind`** 为输入映射后落列（`spawn`/`closed` ⇒ `infra`，`rpc`/`protocol`/`timeout`/缺键 ⇒ `task` 安全降级）。**全库两个写口**（结果回传映射 + 墙钟自置 `infra`），均守「**首个终态胜出**」：`setTaskFailureKind` 判据含 `existing.state !== 'failed'` ⇒ **迟到件不得把 `infra` 覆盖成 `task`**。
- **传输层有界重发**（machine · §2.5）：**主形态 = 终态重跑** —— launcher 在**拿到终态之后**（`deliver` 之前）判定 `failureKind === "infra"` ∧ `diagnostics.acpErrorKind ∈ {spawn, closed}` ∧ `chunkCount === 0` ⇒ **`host.stop(projectId)` → 重新 `ensure` → 重新 `send`**（`ensure ≠ 重建`，故必先 stop）；**辅形态 = send 相位连接级失败的内部重投**（唯一「连终态都拿不到」的窄场景）。**两形态由「是否拿到终态」互斥划分、共用 `attempts ≤ 1`（`MAX_TRANSPORT_ATTEMPTS = 1`）⇒ 不会双触发**。硬闸 = 剩余预算 ≥ `RESEND_MIN_REMAINING_MS`(60s) 且不越该次 dispatch 的 `deadline`。**禁止重发** = **poll 相位**（只能续轮询，`tasks/get` 只读幂等）与**超时 / abort**（请求**可能已送达并在执行**）。留痕 = 日志 + `diagnostics.attempts`（**不落库** —— `retry_count` 是 Feature rearm 语义，不混用）。**桥侧零改动且不可见**：同 taskId、单次终态回传、**不产生第二次账单**。⚠ 如实登记的边界：**「后端接了活、一个字不吐直到满窗」本版不自愈**（超时路径**从不发 `session/cancel`** ⇒ 桥返回 failed 时后端那轮仍在跑，同 `contextId` 重跑会与新桥的 `load`/`resume` 交织 ⇒ 不安全）⇒ 只能靠 §2.6 加窗跑完或等墙钟判死后宿主重派。
- **Runner 启动补结算**（machine · §2.7）：新模块 **`launcher/reconcile-inflight.ts`**（纯函数判定 `planInflightReconcile`）+ 在飞台账落盘 `.a2a/inflight/<taskId>.json`（`InFlightLedger` 可选 persist 回调注入，**无 writer 时零 IO**）。判据 = 「inflight 台账 **减去**子女账本中**在册且存活**的 pid 所属项目」（仍有执行体者**跳过**，**宁漏勿误杀**）；**自检条目一律排除**（`SELF_CHECK_LEDGER_PREFIX`，否则重启后自检条目会被当孤儿上报 = **假故障**）；上报**复用 `outbox.deliver()`** ⇒ 落盘 / Bearer / 退避 / ack **零新代码**，且 **不违反「boot 不补发」**（那条是**不回放既有 outbox 文件**，此处造新结果；`runner-outbox.test.ts` 的 `calls===0` 当护栏守住）。调用时机 = `onListening` 内、`reconcileStartupLedger` 之后、**register 成功之后**（口径已核：桥侧 `/runner/result` **无**「注册表存在性」检查 ⇒ register 顺序非硬要求）。失败只告警、**绝不抛出、绝不阻断启动**。
- **补结算窄口（桥侧 A2 + ④⑤⑥）**（orch · §2.7）：`/runner/result` 允许「**`state=failed` 且行仍绑定本机领取**」（`claimed_by` = 上报 `machineId` ∧ 行 `state='working'`）的上报 —— 覆盖「**无 `claimToken` 的启动补报**」与「**墙钟判死后的迟到件**」两种；无令牌时 `text`（失败原因）**非空必填**（缺 ⇒ 400）+ 命中记 **warn 审计行**（machineId / taskId / 距 `claimed_at` 耗时）。**R3 抓出并补上的真实漏洞 = ④ 行级绑定**：缺 ④ 时敌手机器的迟到补报可**击穿「已被重领取」的重派执行**（行被他机重领后 `state` 仍 `working`、令牌已换新）⇒ **orch 明确「不接受无 ④ 的窄口」，若拒 ④ 则退回 A3（纯靠墙钟 30 min）**。**安全边界如实降级登记**：边界由「持有**领取凭证**」降为「持有**本机 Bearer** + 桥侧状态匹配」；④ 之后攻击面收敛为「**持某机 Bearer ⇒ 只能把该机自己名下的在飞 / 已回队任务判 failed**」= **机器自杀、非跨机他杀**。
- **机器可读失败字段**（machine · §2.8）：回传体加两个**可选**键 —— `failureKind`（`"infra" | "task"`，launcher 判定）与 `diagnostics`（`{acpErrorKind?, elapsedMs, chunkCount?, stage}`；桥内细分经**现成 `artifacts` 通道**上带 `name="machine-diagnostics"` ⇒ **零类型 / 零 wire 变更**）。**必须动作**：launcher `buildResult` **先摘除该 artifact 再 deliver**（否则它会被 orch 的 `resultText` 拼接进结果文本 = v0.8.1 M3 口径的回归）。**向后兼容已核**：`readJsonBody` 无 schema / 键集校验、`handleResult` 全为逐键白名单读取 ⇒ **未知键无处可拒**（「宽容」口径；diagnostics 只走 artifacts 的 B 预案 orch 也接受、**备而不用**）。
- **四家适配器新增 `--session-timeout` 透传**（machine · §2.6）：`opencode` / `codex` / `claude` / `qoder-cn` 各 +2 行；桥侧 `parseSessionTimeoutArg` + `BridgeArgs.sessionTimeoutMs` + `startBridge` 三点一线（`args ?? deps ?? DEFAULT_SESSION_TIMEOUT_MS`）。
- **3300 工作台任务表加 `startedAt`（Step 3 实现级增补 · §10）**：时间列由 `createdAt → finishedAt` 改为 **`createdAt → startedAt → finishedAt`**（表头同步；`startedAt` 为空显示占位 **`—`** —— 本版摘除预填后「已入队未领取」的 `started_at` **合法为 NULL**，不占位会出现 `createdAt → → finishedAt`）；**「耗时」拆两列 = 排队（`createdAt → startedAt`）/ 执行（`startedAt → finishedAt`）**，`startedAt` 为空时两列同样显示 `—`（**不得把排队当 0**）。**纯前端改动**（`orch/bridge/web/html.ts`；`/api/features/<id>` **本已带 `startedAt`** ⇒ 不动 API 投影）；**投影层**（补 `claimedAt` / `queuedAt`）仍归 v0.8.8 / v0.9.0。实现走**增补轨 Feature `456b34f1`**（主 Feature 已在 `testing`，引擎**不允许**给在飞 Feature 挂新节点）。**注**：`started_at` 是**行级数据**、**老行不回填** ⇒ 页面新旧混显属正常，不是 bug。
- **单测**：machine `test/acp-session-timeout.test.ts` · `config-session-timeout.test.ts` · `reconcile-inflight.test.ts` · `runner-inflight-persist.test.ts`；orch `test/o2-orphan-sweep.test.ts` · `o3-failure-kind.test.ts`；**`test/n5-project-serial.test.ts` 从「假绿」翻真**（原用 `markTaskDispatched` 手工造生产不存在的 `remote_task_id` —— 谓词一改必红，正好强制翻真）+ 新增 **「同 project 多节点不并发」硬行为锚**（建 2 节点同项目 Feature → `approve` → **断言第二节点在第一个落定前不被派发**，走真实 `enqueueTask` + `claimTask` CAS、不需活 Runner）。
- **回归用例**：`.omo` 新增 **`test-v0.8.7-task-durability.js`**（41 条），`TESTCASES.md` 新增 **TC20**；`test-v0.8.4-key-layout.js` / `test-v0.8.5-codex-claude-acp.js` 的 machine 版本 pin 随发版翻向 0.8.7。

### 门禁与真机

- **单元门禁（发版前重跑实测）**：orch `typecheck` **0**（TC9 同批重跑）· `lint` **0** · `npm test` **295（294 pass / 0 fail / 1 skip ≈ POSIX 真 SIGKILL）**；machine `typecheck` **0** · `lint` **0** · `npm test` **372 / 372**。**必红锚全绿**：`adapters.test.ts` 的 argv 逐字断言已同步 `--session-timeout`（正向 / 未配零下发负向 / 四家逐字）；`runner-outbox.test.ts` 的 `calls===0`（boot 不补发护栏）仍绿。
- **宿主回归**：**1220 / 1220 零失败**（`reports/v0.8.7/regression-report.json`；v0.8.6 为 1183 —— 差额 = 本版新增 **TC20（41 条）** + 若干反转 / 新增断言）。发版前修掉两处收口项：① 改造文档修订历史行首格去粗体（TC10 判据须字面 `final`）② **回归锚点细化** —— `test-v0.8.1-opencode-acp.js` 的「PROTOCOL.md 的 ACP 提及恰 1 次」原用**大小写不敏感**计数，而 v0.8.7 起 `/runner/result` 的线协议枚举键 **`acpErrorKind`**（小写）合法出现在该文件 ⇒ 改判为「**大写 `ACP`** 恰 1 次」（原意 = 不得写入 ACP 适配契约，未削弱）。
- **真机（Step 3 · 2026-09-22）** —— **已取证的两项承重**：**① 同 project 串行门 ✓**（宿主自派探针：同 project 双节点执行窗口**几乎零重叠** —— P1 `06:54:46.490→06:55:26.622`、P2 `06:55:26.589→06:55:45.121`；对照旧缺陷为「三条同时在飞 **541 s** / claimed **每 30 s 一个**」）· **② `started_at` 接首次领取 ✓**（两行 `started` 均 ≠ `created`，差 14.4 s / 54.4 s）· **③ 3300 页面显示 ✓**（用户重启桥后「没问题」）。**待观察（登记备查）**：探针里 P2 领取时刻比 P1 落定早 **33 ms** 的毫秒级交错（**非旧缺陷**，差四个数量级）⇒ 忙集释放与落定落库非严格同刻。
- **⚠ 未覆盖（不得默算通过；用户 2026-09-22 裁「顺延至 v0.8.8 实施时一并验收」）**：**孤儿墙钟出口**（阈值 30 min ⇒ 需小阈值配置 + 重启才触发）· **启动补结算**（需「重启时正好有在飞」的样本）· **有界重发**（只在 `spawn`/`closed` 早夭触发，**不可控**）· **`--session-timeout` 成对生效**（需改配置 + 重启）· **`failure_kind` 落库**（需一次真实失败）· **L3 跨机 × 跨 kind 单 Feature 端到端**（mac 未升级 / 不在组）· **POSIX / macOS 面**（本机 Windows 固有跳过）。此外 **3300 增补需重启桥才生效**（改完当次未重启 —— 用户「另一个项目还有在用」；用户其后已在自选窗口重启复验）。
- **实现期观察（对「首发早夭」的强证据）**：**12 个节点里 6 个首发吃满 600s 零输出**（O2 · O3 ×2 · O5 · M3 · M4 · M5），**全部靠 `retryTaskIds` 收口、无一次真失败** ⇒ 首发命中率约 **50%**；O3 需 3 次尝试才过（**三次同一 `contextId`**）⇒ 削弱「同会话污染」解释，更支持「**首发偶发卡住**」。**H3 收口自检**：实现期内 `feature_id IS NULL` 且 `mode="execute"` 的派发 = **空**（同窗 11 条全为 inquiry / 握手 / 只读）✅；⚠ 一条如实登记：其中 06:15 有一条 inquiry 在 `shop-image` 项目内执行过生成命令 —— **异机行为，orch 侧无法核实其文件改动**。
- **同轮登记的未决口径（非本版缺陷）**：**v0.8.7 给 `/runner/result` 加了两个可选请求字段**（`failureKind` / `diagnostics`）。按 `PROTOCOL.md` 版本规则「**加可选字段 → minor +1**」本应升 **2.3**，但本版 Step 1 已裁「**不动 PROTOCOL 版本**」（依据 = 可选键可被未升级对端忽略 + 历史可选字段未逐次升版）⇒ **`PROTOCOL_VERSION` 沿用 2.2**（两侧一致；字段表 / 契约 2·3 / 窄口已同步落 `PROTOCOL.md`）⇒ **规则条文与该裁量的取舍已入 `planlog.md`「跨版本登记项」待用户裁决**。

## [v0.8.6] - 2026-09-22

> 主题：**三条需求**（同版串行 `req03 → req02 → req01`）。**① `agentKind` 更名 `qoder` → `qoder-cn`（硬切）**：把国内版构建应有的名字还给 kind，`AGENT_KINDS` 保持 **4 值**、无别名表、旧值两侧均非法，线协议 `2.1 → 2.2`（minor：变更取值集合；**握手只校验主版本 ⇒ 版本号不构成兼容窗口，两端须同窗口切换**）。**② 适配器入口自动解析（`backendCmd` 去手填）**：四个 kind 的入口由机器按**四层链**（L0 显式 → L1 机器本地 → L2 全局 npm 候选表 → L3 PATH）自动解析 ⇒ `backendCmd` 对四者一律降级为**可选覆盖**；**解析期对显式值加存在性校验**（不静默回落）；**自检失败粒度改判 = 单项目失败不再拖垮全机**（机器级退出只保留「全部项目不可用」）。**③ orch 多编排者视野隔离（一桥多组）**：身份载体 = **连接 URL 路径段 `/<组名>/mcp`**（`url` 是所有 MCP 客户端的唯一公共必需项），补齐**四个此前完全无组约束的出口面**（任务列表 / Feature 五工具 / 事件收件箱 / Runner claim）；**Feature 谁建谁见**、**组间成员互斥**、**存量 `owner_group=NULL` 走 fail-closed**。改造文档（三份，均 **final**）：`doc/v0.8.6/agentKind改名为qoder-cn-改造文档.md` · `doc/v0.8.6/适配器入口自动解析-改造文档.md` · `doc/v0.8.6/一桥多组视野隔离-改造文档.md`。

### Changed

- **kind 更名硬切**（req03）：`machine/agent-kinds.ts` / `orch/types.ts` 的 `AGENT_KINDS` 由 `qoder` 换为 **`qoder-cn`**（保持 4 值）；产物随名走 —— `adapters/qoder.ts` → **`adapters/qoder-cn.ts`**、类 `QoderCnAdapter`、常量 `QODER_CN_BACKEND_CMD_REQUIRED`、`model-catalog.json` 段键、`config.json.default` 条目、文档与注释。**产品名/CLI/目录名一律不动**（`qoderclicn` / `~/.qoder-cn` / `.qoder` 是后端真名）。一次性迁移见 `orch/scripts/migrate-agent-kind-qoder-cn.mjs`（缺省 dry-run、`--apply` 才写、可重入；**须在部署新桥之前执行**）。
- **`backendCmd` 降级为可选覆盖**（req02）：四 adapter 的必填判定统一改 `requireBackendEntry(...)`；**L0 显式值须「存在且是文件」**（否则归 `backend-entry` 类项目级失败、**不静默回落**下层，文案含「后端入口」+ 原样路径）；裸命令名同样被拒（删键即走自动解析）。
- **自检失败粒度改判**（req02）：机器级退出**只保留「全部项目不可用」**（删掉原「ensure 阶段端口/进程故障」那条机器级判据）；单项目失败 ⇒ 该项目 `unavailable` + 「自检部分通过：可用 N/M」告警，**其余项目照常服务**。**F-e 修**：自检失败提示按 `cause`（`backend-entry` / `auth` / `model` / `timeout`）分流，不再把模型名非法指向认证。
- **连接身份 = URL 路径段**（req01）：`/<组名>/mcp`（**组名作首段**，其余须恰等于 `options.path`）；**未配组 ⇒ 全量接纳（零破坏）；配了组 ⇒ 未带身份 = 403 `group_identity_required`**；`coreFor(identity)` 每请求轻量视图、**不留双通道**。
- **四个出口面补齐组约束**（req01）：`a2a_tasks`（成员前置 + `locateProject` 按身份）· `a2a_events` / `a2a_wait`（案 B 读时反查 join，**孤儿事件归全体可见**）· Feature 五工具（create 落 `owner_group`、status/advance/approve/cancel 归属校验 + **`registerFeatureNode` 归属校验**）；**按身份游标 `Map<identity, cursor>`** 与 **`latestEventId(scope)`**（两处同谓词）。
- **Runner claim 判据**（req01）：由「全局 `selective` 单组」改为「**本机在任一组中的项目**」；**machine 侧零改动**。
- **文档面**：`PROTOCOL.md` 版本规则由「**扩展**取值集合」扩为「**变更**取值集合（**新增 / 更名 / 移除成员**）」并载明「单向不兼容 + 整包项目级拒绝 + 版本号不构成兼容窗口」；`orch/README.md` 补「一桥多组 / 3300 非身份面 / 组不是鉴权边界」；`machine/README.md` 四层链与「机器级自检只有一种 = 全部项目不可用」；仓根 `README.md` 组配置与宿主接入示例；`flow/**` 宿主接入改「url 带组名段」（`flow/spec/需求流程.md` 零改动，`引擎映射.md §4.1` 补一句限定）。

### Added

- **解析器**（req02）：`machine/adapters/backend-entry.ts` —— kind → 入口表（`opencode-ai` / `@agentclientprotocol/codex-acp` / `@agentclientprotocol/claude-agent-acp` / **qoder-cn → `pathCommand:"qoderclicn"` + 双平台 `knownPaths`**）+ 四层解析 + 逐层 `probes`；**铁律**：绝不回退包 `main`（实测 `claude-agent-acp` 的 `bin=dist/index.js` 而 `main=dist/lib.js`）· PATH 只按适配器命令名查、绝不按 kind 名 · 壳扩展名与桥共享同一常量。
- **`[backend]` 分层日志**（req02）：随既有启动快照落 `launcher.log`（含 projectId / kind / 层名 / 真身路径；失败给完整逐层清单），**清单不进 Error message**。
- **组 schema**（req01）：`projectGroup` **沿用键名、形状扩为组数组**（每项 `{name, members[{machineId,projectId}]}`），**组间成员互斥 ⇒ 配置期 fail-fast**；`features.owner_group` 幂等补列（未引入 DDL 版本管理）+ 可选迁移脚本 `orch/scripts/migrate-feature-owner.mjs`（缺省 dry-run）。
- **单测**：machine `test/backend-entry.test.ts`（21+ 例：`bin`≠`main` / PATH 绝不用 kind 名 / 四层顺序命中即停 / qoder 平台过滤 / 显式路径不存在 ⇒ `rejected-missing` 不回落）、`test/self-check-granularity.test.ts`（粒度 + F-e）；orch `test/http-identity.test.ts`、`test/group-read-scope.test.ts`、`test/mount-ownership-scope.test.ts`（跨组挂载被拒 + 不泄漏他组名 + 零入库 + 零出站）、`test/feature-tools.test.ts`。
- **回归用例**：`.omo` 新增 `test-v0.8.6-backend-entry.js`（四层链 / 三铁律 / 四 kind 可选 / 分层日志 / 自检粒度 / 三红线 / 文档面 + 真机补正锚），`TESTCASES.md` 新增 TC19。

### Removed

- **别名/兼容机制**（req03 未采纳）：无别名表、无归一谓词、无旧键兼容 —— 硬切（`AGENT_KINDS` 4 值、旧值两侧均非法）。
- **机器级 fail-fast 的旧判据**（req02）：`fatalEnsureFault`（`stage === "ensure" && cause !== "backend-entry"`）及旧文案「ensure 阶段端口/进程故障」。
- **「约定目录」解析层**（req02，Step 1 自行取消）：四层链定案为 L0 → L1 → L2 → L3（无该层）。
- **旧措辞**（发版前清理）：`machine/launcher/index.ts` 与 `scripts/launcherctl.mjs` 的「业务路由 503」表述；`scripts/reaper.mjs` 的 `not-ready = /projects 503` 判据（`/projects` 恒 404 ⇒ 实质不可达，改以 `/health` 的 `status` 判就绪，**逐输入证明 `canClean` 不变**）。

### 门禁与真机

- **门禁**：machine `typecheck` **0** / `npm test` **321/321**（基线 281 → +40）· orch `typecheck` **0** / `npm test` **278 tests（277 pass / 0 fail / 1 skip ≈ POSIX 真 SIGKILL）** · **宿主回归 1183 / 1183 零失败**（`reports/v0.8.6/regression-report.json`；v0.8.5 为 1113 —— 差额来自本版新增两套用例与若干反转/新增断言）。
- **实现期三类纪律教训（已写进 `planlog.md`）**：**① 节点首发普遍撞 ACP `session/prompt` 600s 传输层超时，重派即收敛**（req02 主轨 7 节点首发全超时、重派 1–4 次全绿；req01 十节点同形）· **② 超时被判 `failed` 后 agent 可能仍在写文件**（实测引擎判死后 37 秒仍有写入）⇒ **重派前须确认「无人在写」**（无该项目的 `acp-bridge` 子进程 + 目标文件 mtime 静默 + CPU 零增量）· **③ 真机窗口（重启 Launcher/桥）与代码改动轨不可交错** —— req02 补正轨的节点曾因用户在改造期重启 Launcher 而成孤儿（引擎不 reconcile），按 playbook `cancel` + 续体重建。
- **收口复核（两轮独立只读）**：req02 的 F1′ 抽查确认「夹具收口是真用沙箱临时文件解决，无删例 / 无跳例 / 无弱化」（`assert.throws` 10→1 可逐条归因到被需求本体废止的必填语义，其负向语义转由 `missMessage()` 承担）· req01 的 F1 判 **3 红 2 黄**（**跨组写入洞** / 示例配置未同步 / 项目侧文案未接满 / 派发归属注释不实 / 文档与实现偏离）⇒ 补正轨全收、F1′ 复审**总判全收**（3 红均有可执行测试佐证），文档升 **v7/v8**。
- **真机（Step 3）**：
  - **req02**（用户一次重启 + 宿主取证，日志 `launcher.log:84991–85050`）：**7/8 项目自检通过仍整机退出**（真机暴露「粒度假改判未覆盖 `ensure` 失败这一支」）⇒ 双修补正后复验 **`自检部分通过：可用 3/5，不可用项目 test_codex,test_badpath`**、**无「机器级自检故障」行**、机器继续服务；两处补正各自生效且原因可分（`test_badpath` 归 `（ensure/backend-entry）` 且**全块无任何 `[agent:test_badpath]` 行** ⇒ 未走到 spawn；`test_codex` 为「路径存在但填错对象」⇒ 降级为项目级）。**mac 侧 `knownPaths` 分支顺带闭环**（mac 去掉 `backendCmd` 后 inquiry 10 秒 completed）。
  - **req01**（用户配两组 + 重启**编排桥**，未动 Launcher；宿主以直连 HTTP 扮演组身份取证）：**判据 ①–⑦ 全通过** —— 各组只列本组项目（双向无泄漏）· 裸 `/mcp` ⇒ 403 + 指路 · 跨组项目操作 `project_not_a_member` 且文案点名「属另一项目组」· 存量 Feature 配组后列表返回 `[]`（fail-closed）· **Feature 谁建谁见**（跨组 单查/advance/approve/cancel/**execute 挂载** 五路全拒、不泄漏他组名）· 单桥单库 · 事件面不泄漏且 `a2a_wait` 不被误唤醒。**组间互斥「启动即 fail-fast」由用户亲手负向测试补验**（`[a2a-bridge] fatal: [config] projectGroup 组间成员互斥：{ machineId: "win-dev", projectId: "machine" } 同时出现在 projectGroup[0] 与 projectGroup[1]`；`status` 未运行 / pidfile 不存在；还原后恢复）。
- **未覆盖（不得默算通过）**：**POSIX / macOS 面**（本机 Windows 固有跳过）· **跨机 × 跨 kind 单 Feature 端到端（L3 通过线）** 归 v0.8.7 · **`a2a_events` 首次读的游标语义**（身份首次读基线 = 本组可见队尾 + 严格 `>` ⇒ 队尾那条永不返回；设计为「先订阅后收增量」，须显式传 `since`）· **组间事件隔离的「不被他组唤醒」未真机构造**（`shop-image` 组唯一机器 mac-dev 曾在配组初期离线 ⇒ 产生不了他组事件；单测已覆盖「全局长进、本组长不进」）· **`runner-endpoints.test.ts` / `runner-events.test.ts` 里 `ProjectGroup` 引用性质**（类型 vs 断言，低风险）· **该机 `machine/config/config.json` 的组配置为运行态、不入库**。
- **同轮新登记（非本版缺陷，已入 `planlog.md`）**：**① 同 project 串行不变式失效**（忙集 SQL 用 `remote_task_id`，而 pull 模型下 Feature 节点该列**全程 NULL** ⇒ 忙集恒空、只余 30s 批次的 `reservedProjects` ⇒ 实际语义「同批互斥、跨批不设防」；真机实证三条同项目节点并发在飞 541s）⇒ **排入 v0.8.7** · **② 孤儿自动结算待核**（桥内已有「领取超期判据」扫描，先核实现状再定是否要修）⇒ **排入 v0.8.7** · **③ pull 模型下任务完成不写 `task.settled` 事件**（最后一条停在 2026-09-18；根因 = `upsertTaskResult` 直接 UPSERT 不 `appendEvent`）⇒ 建议归 v0.8.8 可观测性面。

## [v0.8.5] - 2026-09-21

> 主题：**wrapper 族（codex / claude）迁 ACP、废弃 A2A 包装器**（单需求 · `REQ-v0.8.5-2026-09-21-01`）。把 codex / claude 的执行链路从「仓外 A2A 包装器」整体换到「**仓内 ACP 桥 + 第三方 ACP 适配器**」，使**四条 kind 执行层同构**（opencode / qoder 直连 CLI 自带的 ACP 入口，codex / claude 经 ACP 适配器再驱动官方 CLI）；`agentConfig.<kind>` 段**及其配置通道整体退役** ⇒ v0.8.4 定下的「自消费键平铺」键位口径在本版**达成终局**。**kind 名 / 线协议 / machine 内 A2A 面零改动**（`PROTOCOL.md` 仅 2 处散文措辞、未 bump）。改造文档：`doc/v0.8.5/包装器族迁移至ACP-改造文档.md`（**v10 final**，边界 R1→R5 五轮收敛 + 两次运行时探针驱动的事实更正）。

### Changed

- **两 adapter 归队 ACP**：`adapters/codex.ts` / `claude.ts` —— `protocol: "wrapper" → "acp"`，`buildLaunch` 改为与 `opencode.ts` / `qoder.ts` 同形（`node <appRoot>/dist/acp-bridge/index.js --port … --backend-cmd … --risk …`）；`baseConfig()` 退役；`backendCmd` 必填化（对齐既有 `OPENCODE_BACKEND_CMD_REQUIRED` 文案纪律）。
- **权限三档搬到「会话模式」**：`risk` 由 **adapter** 映射为 ACP 会话模式、经桥 `--mode` 下发（**映射表唯一落点 = adapter，桥对 kind 无知**）—— codex `read` ⇒ `mode=read-only` **+ `collaboration_mode=plan`**、`write` ⇒ `agent`、`full` ⇒ `agent-full-access`；claude ⇒ `plan` / `acceptEdits` / `bypassPermissions`。旧 `--sandbox` / `--permission-mode` 拼装随包装器退役。
- **播报面语义级重写**（`launcher/config-snapshot.ts`）：退役 `describeHierarchy` / `generatedSettingsSources` / `userSettingsLoaded` / `readSectionModel`；`agentConfigModel` 全 kind 统一读**平铺**；claude 分支直读 `~/.claude/settings.json`（存在即播报、否则 `n/a`）。
- **文档面收口**：仓根 `README.md` —— 架构图 / 三段式描述 / 功能特性 / 技术栈表 / 目录树 / 构建 / FAQ 全部改为「四 kind 同构 ACP 桥」，`risk` 映射表重写为**会话模式**口径并标注 codex `read` 档的「可读不可写」实测结论，删 `skipGitRepoCheck` / `settingSources` / `codexPathOverride` 等已退役键；`machine/README.md` 补明「**不写 `risk` ⇒ 缺省 `write`**」与三档实质差别、更正 `CODEX_PATH` / `CLAUDE_CODE_EXECUTABLE` 口径；`machine/config/config.json.default` 四条目 `risk` 示例值统一为 `write`；`machine/types.ts` / `adapters/types.ts` 注释重写。
- **orch 4 文件 5 行**（零源码逻辑）：执行层表述去「A2A 包装器」改中性（`types.ts` / `bridge/index.ts`）、`README.md:3` 收敛为「仓内 ACP 桥」、`bridge/scheduler.ts` 两处**改符号锚、不写行号**（中断收敛语义显式保留：编排桥重启 ⇒ 在飞置 `failed` / 不自动重派 / Feature 交静止）。

### Added

- **桥三条新通道**（`acp-bridge/index.ts` + `acp/session.ts`）：`--mode` + **`applyMode()`**（与 `applyModel` 逐行同形；下发优先 `session/set_mode`，**仅 `-32601` 才回落** `set_config_option{configId:"mode"}`，其余错误 fail-fast；`session/new` / `load` / `resume` **三路串联**；缺省 ⇒ 零请求）· **`--collaboration-mode`**（独立 flag，codex `read` 档用；只走 `set_config_option`，因该键不在 `modes` 里）· **`--session-meta-json`**（claude `full` 档 `_meta.claudeCode.options.allowDangerouslySkipPermissions`，三路同发，否则经 `load` / `resume` 的会话会静默降级）。
- **adapter 入口形态解析**（`adapters/backend-command.ts`）：`backendCmd` 指向**脚本**（`.js` / `.mjs` / `.cjs`）⇒ 组 `--backend-cmd <node 绝对路径>` + `--backend-args [<脚本绝对路径>]`（node 取 `process.execPath`）；指向**可执行体**（`.exe`）⇒ 单命令直调 + `--backend-args '[]'`。**桥零改动、一个配置项两种形态都成立**（Windows 上 `--backend-cmd` 是单 token，命令串必 ENOENT）。
- **平铺 `model` / `systemPrompt` / `systemPromptMode` 接通**：两 adapter 复用既有 `resolveAcpModel` / `resolveSystemPrompt` / `resolveSystemPromptMode`（与 opencode / qoder 同形；链路既有、零新机制）。**改判**：claude 平铺 `model` 由「本版不做」改为**必做**（真机证 claude 有 `configOptions{id:"model"}` ⇒ 不做即随段退役丢能力）。
- **ledger 脱敏**（`launcher/manager.ts`）：启动台账里 `--session-meta-json` 的取值遮蔽为 `<redacted>`（凭据类值不进 argv 也不落账本）。
- **`machine/config/model-catalog.json` 补 `codex` / `claude` 两段**（codex：`deepseek-v4-pro` / `deepseek-flash`；claude：`default` / `opus` / `fable` / `sonnet` / `haiku`），与既有 qoder / opencode 段同形。
- **machine 单测**：`test/acp-mode-channel.test.ts`（`applyMode` / `-32601` 回落 / `--collaboration-mode` / `--session-meta-json` 三路）、`test/ledger-redact.test.ts`（脱敏）；`test/adapters.test.ts` / `test/agent-config-segments.test.ts` / `test/config-snapshot-model.test.ts` / `test/acp-session.test.ts` / `test/acp-bridge-m1|m2.test.ts` 改写为 ACP 口径（**改写非删除**）。
- **回归用例**：`.omo` 新增 `test-v0.8.5-codex-claude-acp.js`（静态锁定 v0.8.5 交付物：两 adapter 归队 ACP / risk→会话模式映射 / `--session-meta-json` / 平铺 `model` 与 `systemPrompt` / 入口形态解析 / 桥三通道 / ledger 脱敏 / 段与配置通道退役负向 / 三包三补丁三脚本退役负向 / model-catalog 补两段 / 模板 `risk` 示例值一致）。

### Removed

- **仓外包装器全家**：`a2a-codex` / `a2a-claude` / `@a2a-wrapper/core` 三依赖与三枚 `patch-package` 补丁 + `postinstall` 机制 + `patch-package` devDep + **`patches/` 目录本身**；三个验证脚本 `scripts/verify-config-precedence.mjs` / `verify-session-persist-claude.mjs` / `verify-session-persist-codex.mjs`。
- **`agentConfig.<kind>` 段与其配置通道整体退役**：`writeAgentConfig` · `DEFAULT_AGENT_CONFIG` · `deepMerge` · `agents/<kind>.<projectId>.json` 产物 · `--config-file` / `--config-segment` · `wrapperConfigPath` · `LaunchRequest.configPath` · `PermissionSpec.config` · `AcpAdapter` 占位接口 · `machine/.gitignore` 的 `agents/` 行。**连带 B3 后置项归零**（opencode 段注入键 `systemPrompt` / `systemPromptMode` 随段退役 ⇒ 改读**产物顶层平铺**，长文本不走 argv，避开 Windows 命令行长度限制）。专属键逐键处置：`codex.developerInstructions` / `codex.workingDirectory` / `codex.permissionMode` / `codex.codexPathOverride` / `codex.skipGitRepoCheck` / `claude.systemPromptAppend` / `claude.workingDirectory` / `claude.enabledPlugins` / `claude.permissionMode` / `events.enabled` / `timeouts.prompt` / `agentCard` 全部删除；`claude.settingSources` 删除不改行为（claude 凭据取自 `~/.claude/settings.json`，默认即加载用户级配置）。

### 门禁与真机

- **门禁**：machine `typecheck` **0** / `lint` **0** / `npm test` **281/281**（基线 243 → +38）；orch `typecheck` **0** / `lint` **0** / `npm test` **237 pass / 0 fail / 1 skip**（与 v0.8.3 基线一致，本版 orch 零源码逻辑改动）；**零越界** —— `orch/**` 仅 4 文件 5 行注释散文、`flow/**` 零 diff、machine 内 A2A 面（`a2a-server.ts` / `runner-exec.ts` / `self-check.ts`）零 diff、kind 集合零 diff、`PROTOCOL.md` 仅 2 处散文且版本未 bump；宿主回归 **1113/1113 零失败**（`reports/v0.8.5/regression-report.json`，版本源 = 根 `package.json`；v0.8.4 为 1039 —— 差额来自本版对 wrapper 族补丁断言的反转收敛〔16 条按 kind 重复的补丁内容断言并为文件级负向锁〕与新增 TC18）。
- **发版准备轨（Feature `3261e451`）**：机器侧新增 `.omo` `test-v0.8.5-codex-claude-acp.js`（TC18）+ 反转 TC11 / TC12 / TC13，另反转 7 个旧版本用例中因退役而失效的断言（`test-task-exec-log` / `test-v0.3.1-features` / `test-v0.2.1-features` / `test-v0.2.0-features` / `test-units-self-contained` / `test-trace-handling` / `test-agent-kind-anchor`），并把 `baseConfig` 注入锚改点为**平铺 `systemPrompt` ⇒ 桥 flag**、把 wrapper 补丁内的 `resolveOutcome` 能力锚**改点到仓内实码**（`acp-bridge/outcome.ts`）并追加 `parseOutcome` **运行时行为锚**（能力锚不删）。**过程**：M-R1 撞 ACP `session/prompt` **600 s 传输层超时**（非业务失败，已落盘部分有效）⇒ 拆出 M-R2 精确收口 42 条失效断言（42 → 0）；O-R1 的版本提升初被单元路径守卫拦下 ⇒ 宿主按项目既有做法授权 Bash 通道改 3 处版本值（orch 三处 = 0.8.5，双证齐备）。
- **真机（Step 3，2026-09-21；用户重启 ×2 + 宿主发任务 / 直接取证，未用 agent 自报）**：① **双 kind 端到端** —— `test_codex` / `test_claude` 任务均 `completed`、答案正确；② **Windows 适配器入口形态真机成立** —— 桥 argv = `--backend-cmd "<node.exe 绝对路径>" --backend-args ["<codex-acp>/dist/index.js"]`（脚本归一在真机生效）；③ **平铺 `model` 生效** —— `[acp-session] model=deepseek-flash / default 已设置（currentValue=真实值）`；④ **`risk` → 会话模式生效** —— `write` ⇒ codex `mode=agent` / claude `mode=acceptEdits`；`read` ⇒ argv 三旗标齐全（`--risk read --mode read-only --collaboration-mode plan`）、`collaboration_mode` 的 `currentValue` 读回 `plan`；⑤ **会话续接** —— 暗号法（`QINGFENG-742`）两 kind 第 2 轮均答对；**claude 有跨桥进程重启的铁证**（`[session/query] resume=<同一 sessionId>` + `[session/load] phase=session-ready` + `[session/replay] messages=N`，且发生在桥进程被空闲回收重启**之后**）；⑥ **codex `read` 档「可读不可写」（本版唯一红项）闭合** —— 带写意图任务 ⇒ `proof-read-tier-2.txt` **未落盘**（宿主直接 `ls` 取证、非模型自报），模型自述处于 Plan Mode；决定性组合探针（`mode=read-only` + `collaboration_mode=plan` + 客户端全拒 + 带写意图）三态严格区分：**写成了 = 否 / 没写成因为被拒 = 是 / 跑不起来 = 否** ⇒ **保护成立、不需兜底签字**；⑦ **平铺 `systemPrompt` 行为级注入** —— argv 含 `--system-prompt …`，且**回复末尾真的出现行为记号 `SP-PROBE-OK`**。
- **未覆盖（不得默算通过）**：**桥的拒绝路径本次未被触发** —— `read` 档下 codex 在 Plan Mode 即被**自身模式**拦下、未发出任何 `session/request_permission`（`[acp-permission]` 0 命中）⇒ 「门必现 + 桥必拒」中「模式生效」已证、**「桥全拒」一半无真机记录** · **`full` 档未真机验**（`bypassPermissions` / `--session-meta-json`）· POSIX / macOS 面 · `-32601` 以外的 mode 设置错误语义 · `--session-meta-json` 的 `_meta` 键名与默认值 · `mcpServers: []` 容忍度 · **非 git workspace 可用性**（删 `codex.skipGitRepoCheck` 的连带必验项）· 适配器 `session/load` / `resume` 真机报文 · codex 自带 0.154.0 vs PATH 0.137.0 行为差异 · `claude.settingSources` 的「隔离用户配置」能力（随段退役消失）· `timeouts.prompt` 无可配等价物 · **A2A 面任务台账不落盘**（用户已裁 = 本版接受差异、未来拉齐，已转出为未排期需求）。另：`read` 档下写意图任务的 A2A 终态为 **`input-required`**（模型请示是否切到可执行模式），与组合探针的 `end_turn`（只给计划）同属「没干成」，两种形态均须上层**不得误当成功**。

## [v0.8.4] - 2026-09-21

> 主题：**agentConfig 键位口径统一（平铺 vs 分段）**（单需求 · `REQ-v0.8.4-2026-09-20-01`）。按判据「**谁执行读取动作**」把 `agentConfig` 收口为「**自消费键（机器读）平铺 / wrapper 契约键（外包程序读）分段**」：ACP 族（qoder / opencode）`model` 由 `agentConfig.<kind>.model` **迁为顶层平铺** `agentConfig.model`（**判据变更 ⇒ 显式推翻 v0.8.2 对 model 键位的归属**）；wrapper 族（codex / claude）段内写法不变；opencode 段注入键（`systemPrompt` / `systemPromptMode`）**B3 后置**为显式例外（解锁前置与 v0.8.5 接力约定见 `planlog.md`）。生效链路（adapter → argv `--model` → ACP 桥 `session/set_config_option`）与 `writeAgentConfig` 产物合并链**零改动**；**orch / flow 零改动、`PROTOCOL.md` 零 diff、kind 集合不变**。改造文档：`doc/v0.8.4/agentConfig键位统一-改造文档.md`（v7 final，边界 v3 三轮收敛 + 两轮实现期细化）。

### Changed

- **读取点平铺**（M1）：`launcher/agent-config.ts` `resolveAcpModel(agentConfig)` 改读**平铺** `agentConfig["model"]`（取值口径同 `resolveAcpBackendCmd`：仅非空字符串；**去掉 `kind` 形参**）；`adapters/qoder.ts:52` / `opencode.ts:63` 调用点随签名改（各 1 行）；argv `--model` 拼装逻辑零改动；两 adapter 头注定稿口径。
- **播报面按 kind 分支**（M2）：`launcher/config-snapshot.ts` —— ACP 族读平铺 `model`；wrapper 族（claude / codex）维持**段读**（`readSectionModel`），其启动日志播报保持原样。
- **测试锚翻向 + 新增防撞锚**（M3 + 增补轨）：`test/acp-model-config.test.ts`（平铺正读 / 段内 ⇒ 不生效 / 缺省零回退）· `test/adapters.test.ts`（平铺输入 + 段内旧键不生效 + **遗留键告警用例**：ACP 族段内 ⇒ 恰一次告警且不生效、wrapper 族不告警）· `test/agent-config-segments.test.ts`（平铺合法 + 新锚 `AGENT_KINDS ∩ 保留集 = ∅`）· `test/config-snapshot-model.test.ts`（增补轨 **7 条**：ACP 平铺命中 / 段内不影响播报·未配平铺落兜底 / wrapper 段读 / 外层平铺对其不生效 / 四 kind 未配兜底 / 非法平铺值视同未配 / `describeAgentConfig` 透传）。
- **文档口径收口**：`config/config.json.default`（键位原则段「自消费键平铺 / wrapper 契约分段」+ 四条目示例改平铺 + `_agentConfigComment` 补「kind 扩展须先增补保留平铺键名清单」注记）· `config/model-catalog.json` `_comment` 指向平铺键 · `machine/README.md` · `adapters/types.ts` / `types.ts` 注记；**仓根 `README.md` 两处现存矛盾顺修**（`:114` `agentConfig.qoder.backendCmd` 笔误 → 平铺；`:288-289` 与分段说明自相矛盾 → 改键位原则 + `projects[].agentConfig.model` 行）。

### Added

- **遗留键启动告警**（B4）：`launcher/manager.ts` —— ACP 族项目存在段内 `agentConfig.<kind>.model` ⇒ 启动 warn；**语义写死「不生效 + 告警」**（不双读、不 fail）；**仅 ACP 族告警**（claude / codex 段内 model 合法、不告警）。
- **保留平铺键清单 + 机械防撞锚**（B7）：`machine/agent-kinds.ts` 新增 `RESERVED_AGENT_CONFIG_FLAT_KEYS`（8 键 `{backendCmd, model, systemPrompt, systemPromptMode, timeouts, agentCard, events, mcp}`，旁注「保留 = 命名空间占用，≠ 提供平铺读点」）+ 测试锚 `AGENT_KINDS ∩ 保留集 = ∅` + 模板注记（kind 扩展 PR 须先增补保留集）。
- **回归用例**：`.omo` 新增 `test-v0.8.4-key-layout.js`（静态锁定 v0.8.4 交付物：新单测文件 / 保留键常量 / 告警文案 / `resolveAcpModel` 平铺读点 / 播报面分支 / 模板键位原则与平铺示例 / model-catalog 注记 / 仓根 README 顺修 / machine 版本 0.8.4）。
- **machine 侧 v0.8.3 部署打包工具入库**（用户裁决「保留 + 入库」）：`machine/package.json` 的 `zip` 脚本 · `machine/scripts/pack.mjs` · `machine-0.8.3-validation.zip` 随本版 commit 入库（非 v0.8.4 产出，部署遗留）。

### Removed

- **段内 `agentConfig.<kind>.model`（ACP 族）自本版起不生效**：**硬切、无双读**（存量 = 0；检测到旧键 ⇒ 告警且不生效）；`qoder` 段本就无读者（纯清理对象）；opencode 段**注入键**（`systemPrompt` / `systemPromptMode`）**维持段内**（B3 后置显式例外 —— 其解锁前置「核实仓外 wrapper 是否消费产物顶层 systemPrompt」随 **v0.8.5 wrapper 族迁 ACP** 一并归零，接力约定见 planlog）。

### 门禁与真机

- **门禁**：machine `typecheck` **0** / `lint` **0** / `npm test` **243/243**（236 + 增补轨 7）；**orch 源码零 diff**（仅 `package.json` 版本号）；**宿主回归 1039/1039 零失败**（`reports/v0.8.4/regression-report.json`，版本源 = 根 `package.json`）。
- **回归套件反转/退役（同 v0.8.3 惯例）**：`test-v0.8.2-acp-model.js` 分段键位断言**反转**为平铺口径（顶层平铺在位 / 段内遗留键不应存在 / qoder 平铺示例 = catalog 可解析 modelId）；`test-v0.8.1-machine-retire.js`「manager.ts 无 opencode 字样」**收窄**为「无 opencode serve 特判 / 专用后端符号」（kind 字样属遗留键告警门控，豁免）；`test-v0.8.1-opencode-acp.js` 分段注记锚改为「B3 后置显式例外（暂留段内）」；`test-doc-final.js` 依 `| final |` 行通过。
- **真机（用户重启 + machine 单元只读取证任务 `08e8ccc9`，全程未用 agent 自报）**：① **配了就生效 ✓ 双后端** —— machine（qoder）平铺 `model=qmodel_38max` ⇒ `launcher.log:82440 已设置（currentValue=qmodel_38max）`；orch（opencode）`model=opencode-go/glm-5.3-flash` ⇒ `:82449 已设置（currentValue=…）`；**argv 第三线** `--model qmodel_38max`（`Get-CimInstance`，只读）。② **不配零回退 ✓** —— flow 未配 ⇒ 重启后**零** `acp-session` 行、快照走未配口径、自检通过。**时序合规**：`dist` mtime 09:54:52 < launcher 启动 10:13:20（跑新构建）；自检 3/3、`status=ok`、Runner 注册成功、无 `设置失败` 行。
- **未覆盖（不得默算通过）**：③ 遗留键告警未触发（配置无遗留键 ⇒ 无对象；**用户裁决「不用管」**）· 播报面运行期输出（**真机已补证** `:82437/:82446`；自动化锚由增补轨补齐）· POSIX / macOS 面 · 真机混布过渡窗。


> 主题：**拆除 push 通知附加链（worker→orch 直连回调通道退役）**（单需求 · `REQ-v0.8.3-2026-09-20-01`）。把 v0.4.0 遗留的 worker push 回调附加链从**代码 / 配置 / 文档 / 回归断言**四面彻底拆除 + 运行态清理（释放 3200），使「全系统 = Runner 单通道」**在代码面上也成立**；**不动 A2A 协议本身的 pushNotification 字段、`PROTOCOL.md` 零改动**。改造文档：`doc/v0.8.3/拆除push通知附加链-改造文档.md`（final）。（原定同版第二条需求 **B5 · orch 退化为 kind 无关** 发版时未做 ⇒ 已转出本版、归属待裁决，见 `planlog.md`。）

### Removed

- **orch 回调接收侧整套**（`bridge/index.ts`，**净 −270 行**）：`POST /callback` HTTP 端点（`PushInfo` / `parsePushInfo` / `applyPushedTaskState` / `applyPushNotification` / `callbackTokenOk` / `handleCallbackRequest` / `startCallbackServer` / `stopCallbackServer`，含段内 5 个局部件——经核无其它调用者）、`callbackConfig()` 配置缓存（进程启动一次性读）、`EVENT_PUSH_RECEIVED = "push.received"` 事件生产、`DEFAULT_CALLBACK_CONFIG` / `CALLBACK_MAX_BODY_BYTES` / `CALLBACK_PAYLOAD_MAX_CHARS` 三常量、启动/停机挂点（`startCallbackServer(callbackConfig())` / `stopCallbackServer()`）、`node:http` import 两行与相关 import 收窄。**背景**：该链发送侧（`message/send` 内联下发 `taskPushNotificationConfig`）已于 v0.7.0（`bb1f420`）删除；接收侧此后**零流量**（`push.received` 共 33,859 条、末条 `2026-09-18T09:31:30.456Z`、v0.7.0 后无新事件）。
- **orch 看护 push 提前唤醒机制**（`bridge/task-watcher.ts`，**净 −66 行**）：`subscribePush` 选项、`pushWakeups` 表、`notifyTaskPush()`、`sleepOrPush()` 与 `watchLoop` 内订阅/唤醒接入、`finally` 退订（`try/finally` 壳收敛）。唯一生产者即上条回调端点（已死）；看护正确性由周期轮询承担（**回落 sleep 保留 `unref()`**：新写 `watchSleep`，B3 `queued` 长期驻留不独撑事件循环）。
- **orch 配置面**：`types.ts` 删 `MachineRef.pushCallback` / `CallbackConfig` / `MachinesConfig.callback`（−22 行）；`config.ts` 删 `DEFAULT_CALLBACK_HOST/PORT` 与 `parseCallback`——`machines[].pushCallback` 由「解析无消费点」的死配置转为退役态。
- **machine 模板与文档**：`config/config.json.default` 删 `agentCard.pushNotifications` 占位（含孤立逗号修复、「留 v0.8.2 专项」悬置措辞消解）；根 `README.md` **9 处**（machine 表 `agentCard` 行、orch 表 `machines[].pushCallback` 与 `callback.*` 四行、字段列举与 JSON 样例、callback 说明段、`a2a_events` 描述去「worker push」短语——`a2a_wait`「推送优先唤醒」指 MCP 事件收件箱机制、**保留**）。
- **第三方**：不动（`patches/` 中 `pushNotificationStore=undefined` 系补丁 context 行；wrapper 族能力闲置即等效退役）。

### Added

- **旧键宽容兼容层**（用户裁决「删解析 + 残留旧键宽容忽略 + warnOnce」）：`config.ts` 对残留 `callback` 段 / `machines[].pushCallback` 键**出现即 warn 一次（文案级 once-per-process）后忽略**——旧配置零改动可启动；**不用裸 `console.warn`**（`loadMachinesConfig` 被 per-request 路径现读，走既有 `warnOnce` 集合）；**不再校验其值类型**（与 v0.7.1 `web.allowStdio` 先例同口径）。
- **单元断言**：`test/config.test.ts` 两条新断言——含旧键的旧配置解析成功不抛错、返回对象无 `callback` 键；两条退役 warn 各恰一次（`resetWarnOnceCache`）。
- **探针断言扩容**（`tools/bridgectl-probe.mjs`，6→8）：⑤ `3200 → ECONNREFUSED`（含 owner 归属判定：外部进程占用 ⇒ SKIP、本探针持有 ⇒ FAIL）；⑥ `POST /callback → 404 not_found`（桥存活窗口内执行）。
- **回归用例**：`.omo` 新增 `test-v0.8.3-push-retire.js`（**23 条断言**：桥侧/唤醒/配置面符号零命中 · `unref` 在位 · 兼容层两条文案 + **旧键名仅现于 `config.ts`** 白名单 · 探针双断言 · orch/machine 模板与根 README、`PROTOCOL.md`、`store.test` 零残留）。

### Changed

- **回归套件退役/反转（拆除即红的旧断言）**：`test-v0.4.0-features.js` 约 12 条 push 断言退役、`:125`「◄ v0.7.0 反转：push 可选通道保留」沿革行**反转为「◄ v0.8.3 反转：push 附加链整体退役」**；`test-v0.6.1-failure-semantics.js` 事件 kind 清单「恰 6 值」→ **5 值**、`push.received` 挪入 `RETIRED_KINDS`；`test-v0.6.0-project-group.js` 模板顶层键集合去 `callback`；`test-v0.8.1-opencode-acp.js` B8′ 的 `agentCard` 行反转为「键已删除」。
- **`orch/config/config.json.default` 模板**：删 `callback` 段 / `machines[].pushCallback` / `_comment` 回调说明（收尾轨补的清单缺口）。
- **运行态清理（本机 `orch/config/config.json`，gitignored）**：删顶层 `callback` 段（`enabled:true` / token `e2e-callback-token`）与 `machines[].pushCallback` 键——**改前全文存档于改造文档 §7.3**；重启桥后 **3200 释放**。

### Fixed

- **探针断言 ⑥ 的编排顺序缺陷**（`tools/bridgectl-probe.mjs`）：⑥（`POST /callback ⇒ 404`）原位于断言 ④（`bridgectl stop`）之后、对**已停止**的临时桥端口发请求 ⇒ 永不可能通过；上移至桥存活窗口（③ 与 ④ 之间）⇒ 真跑 **8/8 PASS**（⑤ 同步正向确认 `connect=ECONNREFUSED`）。

### 门禁与真机

- **门禁**：orch `npm run typecheck` **0** / `lint` **0** / `npm run test` **237 pass · 0 fail · 1 skip**（POSIX-only 集成用例）；machine 零代码改动（仅模板 + 根 README）；**宿主回归 1022/1022 零失败**（`reports/v0.8.2/regression-report.json`，版本源 = 根 `package.json`）。
- **真机（宿主执行 + 单元核实，全程未用 agent 自报）**：
  - **V1**：`bridgectl stop`（优雅停机）→ `start --wait-ready` ⇒ `/health` ok、**3200 无监听**、`POST 127.0.0.1:8787/callback` ⇒ **HTTP 404 `{"ok":false,"error":"not_found"}`**。
  - **V2 等效真机 4/4**（临时工作区 + 端口 8898 + 含旧键临时配置，不触碰常驻服务）：正常启动 + 两条 warnOnce 各恰一次 + 3200 未被 bind。
  - **V3 端到端**：经新桥完整往返（派发 → 执行 → 回传）；`push.received` 仍 **33,859 条无新增**；`orch/config/config.json` 顶层键 = `provisioning, transport, machines`。
  - **V4 零活性残留**（回归新断言 + 收口只读复核 grep）；**探针 8/8**；**编排链路设计式 E2E**（自测 Feature 单节点 completed → 自动 `integrating`，验证后 cancel）。
- **收口只读复核（F1）**：落点齐全（file:line）/ 共用件零误伤（`mapTaskState`、`taskStateFromJSON`、`asNonEmptyString` 经核属回调专属死代码，随删正确）/ 源码零残留 / 门禁三绿 / 无越界。

### 未覆盖（登记，不计通过）

- **POSIX 未真机**（本需求为单机代码层拆除，跨端为结构级）。
- **「旧键宽容」常驻窗口变体未做**（以等效真机代替）；`orch/config/config.json` 残留 `provisioning` 键不碰（观察项）。**✅ 该观察项已结（2026-09-22，v0.8.8 验收后清理）**：五标识符（`provisioning`/`worktreeRoot`/`integrationBranch`/`featureIsolation`/`contractFreeze`）经只读取证确认为**死配置**（orch / machine / flow / 仓根**全部源码零读点**、`MachinesConfig` 类型无该字段、解析器对未知顶层键静默忽略）⇒ **该键已从 `orch/config/config.json` 删除**（32 → 24 行，`JSON.parse` 通过、未重启、`/health` 仍 `ok`/`degraded:[]`）⇒ 连续三版绕开的旧账至此清零。
- **33,859 条历史 push 载荷发送方未溯源**（推断 `a2a-opencode` 包装器，v0.8.1 已退役）；wrapper 族「再声明 `agentCard.pushNotifications`」场景不验。
- **历史 `push.received` 事件行保留不动**（只读历史，`events` 表无 kind 白名单约束）。

## [v0.8.2] - 2026-09-20

> 主题：**ACP 桥参数面扩展（per-project 模型名称透传）+ 常规任务等待脚本**（双需求 · `REQ-v0.8.2-2026-09-20-01` / `REQ-v0.8.2-2026-09-20-02`）。两条需求分别补上「模型可配」与「等待可等」两块宿主/执行面缺口；**kind 名与线协议 2.1 不变、PROTOCOL.md 零改动、orch 源码零改动**。改造文档：`doc/v0.8.2/ACP桥参数面扩展-改造文档.md`（final）· `doc/v0.8.2/常规任务等待脚本-改造文档.md`（final）。

### Added

- **per-project 模型名称透传（machine/acp-bridge）**：项目 `agentConfig.<kind>.model` ⇒ adapter 原样透传 `--model <modelId>` ⇒ 桥在**每次会话建立后**（`session/new` / `load` / `resume` 三路汇合到唯一 `applyModel` 调用点）发一次 ACP `session/set_config_option {sessionId, configId:"model", value:<原样>}`。**未配 / 空串 ⇒ 桥完全不发该请求**（零干预，走后端自身默认）。值**不校验、不映射**——`-m` 吃显示名、协议面吃 modelId，两家取值口径不同 ⇒ 统一只走协议面，后端 argv 不再拼 `-m`。
- **`machine/config/model-catalog.json`（新）**：模型名称映射表（key = ACP 使用值 / value = 模型名称），per-kind；qoder 段 14 个合法 modelId ↔ 显示名，opencode 段 103 项 `providerID/modelID` 形态。**位置在 machine 侧**（orch 只是编排宿主、不持模型目录）；`config.json.default` 新增注记指向该表。
- **`scripts/watch-task.mjs`（新，宿主面）**：常规 `a2a_call` 任务的只读阻塞等待脚本。数据源 = orch 既有只读端点 `GET /api/tasks/:taskId`（3300 端口，与 `watch-feature.mjs` 同服务、同 `--base` 默认值，GET-only 无鉴权）；只读轮询、阻塞至终态、**只打印 state**（不打印文本/失败原因/artifacts，详情由宿主退出后自行调 MCP 工具取）；**退出码三档**：`0` 等到终态（含 `failed`，故 **0 ≠ 成功**）/ `20` 窗口耗尽仍有未终态 / `1` 脚本错误含未知 id。多 id ⇒ 一条命令等全部，按入参顺序每行 `id + state`；未知 id 记 `not_found` 行后继续等其余。默认窗口 10s × 180 = 30 min。**脚本内无写路径**（无 POST / 无文件写入 / 无 SQLite）。
- **宿主等待纪律**：`CLAUDE.md` / `AGENTS.md` 各补一行——派发常规 `a2a_call` 后必须 `node scripts/watch-task.mjs <taskId...>` 阻塞等待；入参用 `a2a_call` 返回的 taskId（web 端点走主键直查，传远端 id 会 404）；以退出码为准判断等待是否正常结束，任务成败看状态行。
- **回归用例**：`.omo` 新增 `test-v0.8.2-acp-model.js`（TC14，56 条断言：桥 `--model` CLI 面 / `applyModel` 取位与 fail-fast / model-catalog / config.default 注记 / 负向锚点 / 单测锚点）与 `test-v0.8.2-watch-task.js`（TC15，36 条断言：脚本存在与 ESM 面 / 用法入参纪律 / 退出码三档 / 只读性负向 / 只报 state / orch 零改动负向 / 只读端点契约 / watch-feature 并列零接线）。

### Changed

- **set 失败语义改为 fail-fast（用户 2026-09-20 裁决「配错就明确失败」）**：`applyModel()` catch 内记 `[acp-session] model=<v> 设置失败（<原因>）` 后 **throw**，经 `ensureSession` 唯一调用点冒泡到 `execute()` 既有 catch ⇒ 任务终态 `failed`，**不执行 prompt、不静默回落**到后端默认模型。**升级注意**：既有配置含无效模型名时，行为从「告警/静默」变为任务失败。
- **`machine/adapters/{opencode,qoder}.ts`**：透传 `--model`；**qoder 旧 `-m` 拼装撤除**（模型只走协议面）。
- **`machine/config/config.json.default`**：新增 `agentConfig.<kind>.model` 键位注记 + 指向 model-catalog + 「未配 = 后端默认」口径 + 「effort / mode / reasoning_effort 明确不做」注记。
- **`machine/README.md`**：`buildLaunch` 形态补 `[--model <modelId>]`；新增「model 通路（协议面）」小节。
- **`orch/test/project-group.test.ts`**：字段白名单负向断言加 `model`——防「machine 误把 model 提到注册 ⇒ orch 静默忽略 = 假透传」。**orch 源码零 diff。**
- **`flow/spec/需求流程.md`**：Step 0 核实条款补「**技术可行性假设**」必须由执行单元核实（若该假设不成立则整个方案路径需改变的事实，如 CLI 兼容性、协议行为、命令组合、文件解析方式等），不得仅作为方案设计阶段的待验证项。

### Fixed

- **F-a：`[acp-session] model=<v> 已设置（currentValue=undefined）` 恒为 undefined**（`acp/session.ts`）：回显取位写在 set 响应的**顶层**，而真值嵌在 `configOptions[id==="model"].currentValue` 数组里。改为从 `configOptions[]` 按 `id === "model"` 取；取不到（无 `configOptions` / 数组内无匹配 / 非数组）时日志打 `n/a` 而非 `undefined`。单测含**顶层同名陷阱键**断言，直接锁死该回归。

### 门禁与真机

- 回归 **998/998 零失败**（`reports/v0.8.2/regression-report.json`，版本源 = 根 `package.json`）；machine `npm run typecheck` 0 error + `npm test` **229/229**（基线 226 + 净 3）；orch `npm run typecheck` 0 error + `npm test` 235 pass / 0 fail / 1 skip（POSIX-only 集成用例）。
- **真机三证（宿主派发探测 + 机器侧只读取证，未用 agent 自报）**：
  - **① session/new 双后端「配置值 = 实际生效」**：machine 配 `qmodel_38max` ⇒ 后端 run 日志实际绑定 `model_config={"key":"qmodel_38max","display_name":"Qwen3.8-Max"}`；orch 配 `opencode/big-pickle` ⇒ `opencode export` 落盘 `info.model={"id":"big-pickle","providerID":"opencode"}`；flow **未配** ⇒ 桥无 `--model`、**零 set 请求**、走用户级默认 `qfmodel` ⇒ 「配置值 = 实际生效」双后端成立，「未配即不干预」成立。
  - **② session/load 续接路径**：qoder + opencode 续接轮均绑定配置模型（load 后都执行了 model set）。
  - **③ fail-fast 受控复验（含后端原始报文）**：给 orch 临时配无效值 `qmodel_bogus_verify_faf` + 两次重启 ⇒ launcher.log:81793→81826 完整证据链 —— launcher 读到该值 → 后端原始报文 `session/set_config_option{configId:'model',value:'qmodel_bogus_verify_faf'}` → `-32602 Invalid params: Invalid value for config option model` → 桥 `[acp-session] model=… 设置失败（…code=-32602）` → `[self-check] orch 失败（settle）：任务终态为 failed…` → `启动自检未通过…退出（fail-fast）`。**证实 qoder 与 opencode 一致拒绝无效 modelId，「配错就明确失败」在 qoder 侧成立，且发生在启动自检、先于任何真实任务。**
- **watch-task 真机 V1–V6 全过**：已终态 completed / 已终态 failed 退 0 且不打印文本 / 未知 id 快速退 1 / 多 id 一条命令等全部 / 多 id 含未知 id 仍等其余 / 窗口耗尽退 20。实战验证：单次调用阻塞 2 分 30 秒 → `completed`/exit 0；窗口耗尽 7 分 20 秒 → 退 20 → 再调一次续等 30 秒 → `completed`。
- **F-a 修后真机复证**：launcher.log:81678 `[agent:flow] [acp-session] model=opencode/big-pickle 已设置（currentValue=opencode/big-pickle）` —— `currentValue` 为真实值而非 `undefined`，修复在生产路径上证实生效。

### 未覆盖（登记，不计通过）

- **`session/resume` 路径无直接日志样本**（load 均一次成功、未触发 resume 回退）；依据为代码结构（resume 成功后汇合到同一 `applyModel` 调用点）+ 历史回退案例。
- **POSIX 未真机**（`.exe` / PATHEXT 解析为 Windows 专属；`.omo` 侧仅结构级断言）。
- **watch-task**：任务失联 / 看护放弃 ⇒ 永久 `working`，脚本无法区分「仍在跑」与「已失联」（详情端点刻意不透出 `stale`）⇒ 只能等 `--max` 耗尽退 20，**这是正确表现**；长任务窗口默认值（30 min）与「qoder 免费模型排队致长时间零输出」的匹配度未实测。
- **模型端点 / API key 不在本需求范围**（用户 2026-09-20 裁决：只做模型名称）——由后端自身配置承担（opencode `opencode.json` provider 段 + `auth.json`；qoder `~/.qoder-cn`），当前架构下不新增任何配置通道。
- codex / claude 真机（本机无 CLI/项目配置）。

### 已知边界（登记待排期）

- **F-e：自检失败的「修复提示」与真实原因不匹配**（本仓缺陷）：模型名非法时提示指向「检查 qodercn 认证与登录」，误导排查方向；提示生成逻辑未按失败原因分流。
- **自检失败粒度错配**（设计取舍待用户决策）：本轮 machine/flow 自检均通过、仅 orch 失败，launcher 仍整体退出 ⇒ **一个项目配错 = 全机所有项目不可用**。是否改为「仅该项目标记不可用、其余放行」待定。
- **launcher 把 `machine/config/config.json` 缓存在内存**（运维事实）：热改文件不生效，**配置变更必须重启 machine 服务**；且「未配 model」（零 `[acp-session]` 行）与「配错」（一条带「设置失败」的行）在日志上形态不同，判读勿混。
- 进程级模型是否可 per-session 切换取决于后端实现（本需求只经协议面设置，不宣称覆盖）。

## [v0.8.1] - 2026-09-20

> 主题：**opencode 改走 ACP 接入（去 `opencode serve` sidecar）** —— `REQ-v0.8.1-2026-09-19-01`（+ M9 三轮实现级增补轨）。opencode 从「仓外 `a2a-opencode` 包装器 + Launcher 前置 `opencode serve` sidecar」迁移为「复用 v0.8.0 qoder 落地的仓内 ACP 桥（桥直接 spawn `opencode acp`）」；**kind 名与线协议 2.1 不变、PROTOCOL.md 零改动、orch 源码零改动**。改造文档：`doc/v0.8.1/opencode改走ACP接入-改造文档.md`（final）。

### Added

- **桥参数面/配置面（machine/acp-bridge）**：`--backend-args <JSON 数组>`（缺省 `["--acp"]` 保 qoder 行为逐字不变；opencode 配 `["acp"]` 子命令）· `--config-file` + `--config-segment <kind>`（读 writeAgentConfig 产物并只取本项目 kind 段，缺文件/缺段容忍告警不崩）· `AcpClient.notify()` 公开出口（`session/cancel` 由带 id request 改为 notification 形态，opencode 探针实证）。
- **注入语义对齐（跨 kind 行为变更）**：outcome 约定 + `opencode.{systemPrompt,systemPromptMode}` 注入改为**每 session 首轮**（append/replace 两模式），`prompted` 标志持久化到 session-map（旧条目缺省 false、跨进程 load 恢复不重注入）。
- **artifacts 接线**：任务终态恒产 `name="response"` 单 text part artifact（text = `parseOutcome` 剥块全文）；**去重口径**——`completed` 时 `status.message` 不带结果文本（orch `resultText` 会拼接 message 与 artifacts，双填即结果×2），`input-required`/`failed` 时 message = question/reason 短文。
- **`adapters/opencode.ts` 改写为 ACP 族**：`protocol="acp"`、`buildLaunch` 拉桥进程（含 `--backend-args '["acp"]'`、`--config-file/--config-segment opencode`）、权限 `--auto-approve` 二值 → `--risk read|write|full` 三档、`backendCmd` 必填零硬编码（报错文案含 Windows `.exe` 绝对路径提示）。
- **回归测试**：machine 侧新增 30+ 用例（桥参数面/配置面/notify、注入时机与 prompted 持久化、artifact 三态与去重、M9 三轮轮边界回归）；`.omo` 新增 `test-v0.8.1-opencode-acp.js`（TC12，orch 侧对称与防顺手改锚点，38 断言）与 `test-v0.8.1-machine-retire.js`（TC13，退役负向锚点）。

### Changed

- **`machine/config/config.json.default` opencode 条目**：`agentConfig.backendCmd` 必填（示例为 `opencode.exe` 绝对路径，探针实证 Windows 裸命令名 ENOENT）；`opencode` 分段键**保持分段、读者从仓外包装器换为仓内 ACP 桥**（经 `--config-file`+段选择）；`agentCard`/`events`/`timeouts` 按「迁移后失效，登记不补」注记；条目级 push 回调 `_comment` 段删除。
- **文档同步**：仓根 `README.md`（架构图执行层、opencode 前置描述、依赖与 patches 注释）· `CLAUDE.md` 执行层描述 · `machine/README.md` 侧段；`orch/README.md` :3/:33 纠偏（线协议 2.0→2.1 + 「A2A 包装器 / 仓内 ACP 桥」措辞；:22 与 :29 的「2.0 硬切」保留并加正向 pin）。

### Removed（wrapper 全家退役）

- `a2a-opencode` 依赖 + `patches/a2a-opencode+1.7.2.patch` + `scripts/verify-session-persist.mjs`（`@a2a-wrapper/core` 补丁保留——codex/claude 共用）。
- `launcher/manager.ts`：opencode 特判（全仓唯一 kind 硬编码）、`startOpencodeServe` 全生命周期、`backendUrl` 注入、`serveChild` 及五条 serve 回收路径；`ports.ts` 的 `waitForHttpOk`/`allocateFreePort`（死导出）；`adapters/types.ts` 的 `LaunchRequest.backendUrl`；ChildLedger kind `"serve"`。
- `.omo` 回归：`test-wrapper-session-patch.js`（TC5）删除，`test-v0.3.1-features.js` 摘除 opencode 段（语义断言迁 `acp-bridge` 新锚点），`test-task-exec-log.js`/`test-v0.2.1-features.js`/`test-codex-claude-adapter.js` 相应重定。

### Fixed

- **ACP 路径 needs_input 死循环（v0.8.0 遗留，波及全部 ACP 项目）**：桥的文本缓冲按 sessionId 跨轮共享，`session/load` 历史重放 chunk 混入本轮缓冲，`parseOutcome` last-block-wins 命中历史 `input-required` 块 ⇒ 续派永久判 input-required。**三轮收敛**：capturing 门控（窗外丢弃）→ messageId 轮隔离（qodercn 方言）→ **重放 messageId 集合普适规则**（prompt 前登记重放 id、窗内仅丢集合内 id；qodercn 活 chunk 无 id、opencode 活 chunk 带新 id 两种方言均正确）。真机闭环：原毒化会话续派 completed + Launcher 自检 4/4。
- **桥 artifacts 未接线**（v0.8.0 遗留）：`artifacts.ts` 仅有单测引用、运行链路从不产出 ⇒ ACP 路径 artifacts 恒空；本期接入终态接线并加去重口径。
- `--config-file` 段选择器缺失会让 qoder 桥误读 opencode 段（复核补 `--config-segment`）。
- `CHANGELOG.md` 头部重复标题段（格式）。

### 门禁与真机

- 回归 **904/904**（`reports/v0.8.1/regression-report.json`，版本源 = 根 `package.json`）；machine `npm run typecheck` 0 + `npm test` 186/186。
- 真机：Launcher 自检 **4/4**（opencode 项目经仓内桥拉起）· V1 opencode 全链（ensure→桥→`opencode acp`→派发→回传→completed 落库）· V2 会话 resume（opencode 同 contextId 续问 + qoder ≥2 轮）· V3 qoder 回归（含末轮 outcome 判定）· V4 artifacts 回传（`name="response"`）。

### 未覆盖（登记，不计通过）

- codex/claude 真机（本机无 CLI/项目配置）· POSIX 桥行为（仅结构级断言）· 权限 read 档真机（opencode 默认不发权限请求，read 语义弱化）· 交互式 needs_input 完整闭环（仅探针级验证）· `buildWorkspaceArtifacts`（workspace 文件形态，ACP 无文件清单通道）。

### 已知边界（登记待排期，见 planlog「未排期需求」）

- 传输层零输出死亡的有界重发（worker 首发早夭安全网）· 在飞任务在 Runner 重启后不被重新领取（孤儿结算缺失）· 长会话上下文疑致 ACP worker 崩溃。

## [v0.8.0] - 2026-09-19

> 主题：**agentKind 分层与 ACP 接缝 + qoder（CN）真机接入**（双需求 · `REQ-v0.8.0-2026-09-18-01` / `REQ-v0.8.0-2026-09-19-01` + 5 条 Step 3 增补轨）。**线协议 2.0 → 2.1**（agentKind 取值集合扩展）。改造文档：`doc/v0.8.0/agentKind分层与ACP接缝-改造文档.md`（final）· `doc/v0.8.0/qoder接入-改造文档.md`（final）。

### Added（REQ-01 · agentKind 分层与 ACP 接缝）

- **单一事实源**：新增零依赖叶模块 `machine/agent-kinds.ts`（`AGENT_KINDS` 唯一声明源）；`machine/types.ts` 改 re-export、`config.ts` 改 import；orch 侧 `orch/types.ts` 单源 + `runner.ts`/`store.ts` 删本地常量改 import（两个 `isAgentKind` 按边界保留）；`PROTOCOL.md:35` 新增机器可解析锚点 `<!-- agent-kinds: ... -->` + 规范源声明，一致性由回归断言「三方清单 == 锚点」锁定（新增 `test-agent-kind-anchor.js`）。
- **编译期安全网**：`self-check.ts` / `config-snapshot.ts`（×2）三处穷尽 switch 加 `never` 断言 default（新 kind 未加分支即编译报错，运行期兜底中性串）；`agents-prune.ts` 正则改由 `AGENT_KINDS` 派生（新 kind 不再漏清理）。
- **ACP 接缝（契约级）**：`Adapter` 契约新增 `protocol: "wrapper" | "acp"` 维度 + `AcpAdapter` 接口占位（不含实现、不注册）。
- **测试补齐**：machine +17（非法 kind 拒 / adapters 逐字锁定 buildLaunch·permission·baseConfig / prune 正则 / `DEFAULT_AGENT_CONFIG` 段一致）；orch +4（注册整包拒 / 写口拒 / 读回脏值守卫 ×2）。

### Added（REQ-02 · qoder 真机接入 + 仓内 ACP 桥）

- **`machine/acp-bridge/` 新子系统**（仓内自持 `a2a-<kind>` 等价物，每项目桥进程 bind 项目 `a2aPort`）：`node:http` A2A 服务（`/a2a/jsonrpc`，`message/send` blocking:false 立即回句柄 / `tasks/get` / `tasks/cancel`，形状逐字兼容 `launcher/a2a-client.ts`）· ACP stdio JSON-RPC 客户端（spawn 后端 + initialize 握手 + 通知分派，可注入）· session 生命周期（new / load|resume 失败回退 / prompt / update 流式累积）· `request_permission` → `read|write|full` 三档映射（含越权拒）· contextId↔sessionId 持久化（`.a2a/acp-sessions/<projectId>.json` 原子写）· outcome 解析 · artifacts 最小集 · 子进程树杀 / 超时 / 端口占用 fail-fast。
- **`adapters/qoder.ts`**（`protocol="acp"`）：拉起桥进程；`ADAPTERS` 4 键（`Record<AgentKind,Adapter>` 完备性强制）；三处 never 断言 switch 加 qoder case。
- **`agentConfig.backendCmd`（ACP 族必填，顶层平铺键）**：ACP 后端命令（绝对路径或 PATH 命令名）经 `LaunchRequest.agentConfig` 透传给桥 `--backend-cmd`；代码零硬编码缺省，未配置即启动报错；wrapper 族（opencode/codex/claude）豁免。`config.json.default` 四条目补全键位示例（`_agentConfigComment`，值内嵌必填/非必填标注 + 「占位勿原样拷贝」警示）。
- **`machine/agent-outcome.ts`**：`A2A_OUTCOME_CONVENTION` 下沉零依赖叶模块（消除 `acp-bridge→launcher` 倒置），`agent-config.ts` 转 re-export（三家 adapter import 站点零改动）。
- **outcome 注入**：桥经 ACP `session/new`（system-prompt 通道）注入约定；outcome 解析复用叶模块常量（input-required/failed/completed 回退）。

### Changed

- **线协议 2.0 → 2.1**：`PROTOCOL.md` 标题/当前版本/agentKind 枚举（+qoder）/锚点同步；版本规则**补条款「必填字段取值集合扩展 → minor +1」**；演进表加 2.1 行（注明实际强制来自 agentKind 闭集拒绝，版本握手只校验主版本）；双端 `PROTOCOL_VERSION` 常量同步 2.1；`SUPPORTED_PEER_PROTOCOL_MAJORS` 保持 `[2]`。
- **回归面行级更新**：`test-protocol-version.js`（2.1 + 新增规则/演进行断言）· v0.3.0/v0.4.0/v0.5.0/v0.6.0/v0.7.0 五个历史用例的版本 pin · `orch/test/config.test.ts` 常量断言；`test-v0.7.2-wedge-fix.js` 版本 pin 改下限 ≥0.8.0；新增 `test-v0.8.0-agent-kind-acp.js`（37 断言：三方清单四值 / 线协议 2.1 / 新模块存在性 / backendCmd 平铺 / 文档对齐）。
- **`LaunchRequest` 增 `agentConfig`**（`manager.ts` 传参接通），wrapper 族忽略。

### Verified

- 真机 E2E（win-dev）：Launcher 自检（真实 qoder 调用，"OK"）· V1 全链（注册→拉起桥→ACP→qoder 真实模型应答 391=17×23）· V2 多轮会话 resume（782=391×2）· V3 opencode 回归（1024）· V4 部署顺序（orch→machine→配置，注册 4 项目、整包拒未触发）。
- 门禁：machine typecheck 0 / test 141·0（+26）· lint 0；orch typecheck 0 / test 235·0（+4）；回归 **870/870**（`reports/v0.8.0/regression-report.json`）。
- 未覆盖（登记）：权限三档真机未触发写请求（单测覆盖含越权拒）；artifacts 真机未触发文件产物；P1 方言探针未完整产出（B2 按通用 ACP 规范实现 + 真机 E2E 兜底）；ACP 族 per-project model 透传 → **v0.8.2**；POSIX 侧桥行为仅结构级覆盖。



## [v0.7.2] - 2026-09-19

> 主题：**bridge 停机 wedge 修复**（单一需求 · `REQ-v0.7.2-2026-09-18-01` + Step 3 实测增补轨）。**三端硬性要求**（Linux / macOS / Windows；POSIX = Linux + macOS 同分支）。改造文档：`doc/v0.7.2/bridge停机wedge修复-改造文档.md`（final）。

### Fixed

- **shutdown 不退（主嫌）**：`orch/bridge/transports/http.ts` 的 `close()` 由裸 `server.close(cb)`（无界 await —— keep-alive / Runner 长轮询连接滞留 ⇒ 停机链不 settle、进程不退、`core.lock` 不释放）改为 **`closeIdleConnections()` + 有界兜底 timer → `closeAllConnections()` 强断并 resolve**（幂等守卫；长轮询是活动连接，仅关空闲无效 ⇒ 强断兜底不可省）。
- **`bridgectl stop` 判据 = 端口而非进程**：成功判据改 **「端口释放 ∧ 进程退出」**（pidfile pid + `isPidAlive` 后置校验）；pid 超时未退 ⇒ **`killForce` 兜底首次可达**；**清 pidfile 仅在确证进程退出之后**；未达标 ⇒ `ok:false` 且保留 pidfile（不再假报「已停止」）。
- **`killForce` POSIX 名实不符**：原发 SIGTERM（优雅信号，对 wedge 进程无强杀能力，与桥自身 SIGTERM handler 重复）⇒ 改 **`kill(-pid, "SIGKILL")` 组杀 + `ESRCH` 回落单 pid**；Windows 维持 `taskkill /T /F`。`killForce` 与 `bridgectl-probe` 的 `killTree` **收敛为同一进程工具模块 `orch/scripts/lib/proc.mjs`**。
- **租约 liveness 探针（免人工删 `core.lock`）**：`orch/runtime/core-lease.ts` 新增 `reclaimWedgeCoreLease`，由 `startHttpBridge` 在绑端口前调用 —— holder pid 存活时探其自广播端点（pidfile 新增 `host`/`port` 广播，锁文件格式未动）；**四态保守判据**：pid 死 ⇒ 既有清锁路径；确认不在服务（ECONNREFUSED ⇒ not-serving）⇒ 删锁接管；探针失败/超时/抛错 ⇒ 保守视为活不接管；判定期间锁易主 ⇒ 不删不接管。独立短超时 300ms。
- **drain/stop 预算对齐**：`bridgectl` stop 等待 15s → **45s**（= drain 30s + 15s 余量，两侧交叉注释锚定），消除「正常慢停机被提前宣告已停止」。
- **config warn spam**：`orch/config.ts` 两写点（`web.allowStdio` 死配置 · `machines[i].launcherUrl` 缺省/非法——Runner 端点每请求现读 config 导致 ~25s 刷屏）改 **warnOnce（同文案 per-process 仅一次）**；不缓存 config、热改语义不变。
- **`bridgectl` 退出卫生（Step 3 增补轨）**：**18 处强制 `process.exit()` 清零**（`CliExit` + `process.exitCode` 收口）—— 消除 `restart` 成功路径的 **libuv 断言崩溃 + 退出码污染 `-1073740791`(0xC0000409)**；HTTP 轮询 `fetch` → `node:http`（`agent:false` + `connection:close`）；退出码契约 `{0,1}` 不变。
- **`start` 输出 `pid=undefined`（Step 3 增补轨）**：改读 `data/bridge.pid` 权威 pid（读不到如实报「未知（pidfile 未就位）」）。

### Added

- **`bridgectl start/restart` 新增 `--wait-ready` / `--ready-timeout`**（opt-in，与 `--no-wait` 互斥）：`exit 0` 仅在 `/health` 的 `status === "ok"`（对齐 machine `--wait-ready` 与 v0.6.2 契约 C4 判据键）。
- **`machine/scripts/launcherctl.mjs` 同构修复**：两分支停止判据同口径「端口释放 ∧ 进程退出」；**POSIX 补可达强杀兜底**（SIGTERM → 有界等待 → SIGKILL，原缺失）；Windows `taskkill /T /F` 检查 `result.error`/`result.status`（原丢弃）；未达标 `ok:false` 且不删 pidfile。
- 回归测试 `test-v0.7.2-wedge-fix.js`；orch 新增测试：`test/proc.test.mjs`（killForce / isPidAlive 注入式三端断言 + entry guard）、`test/bridgectl.test.mjs`（无强制退出 + 退出码契约 + 无 libuv 断言）、`test/http-transport-close.test.ts`（close 有界三态）、core-lease 四态用例、config warn-once 用例。

### Verified

- 门禁：orch `typecheck` **0** / `lint` **0** / `npm test` **228 tests / 227 pass / 0 fail / 1 skip（POSIX 集成 win32 跳过）/ 6.2s 自然退出**；machine `typecheck` 0 + `node --check`。
- 真机（宿主 + 用户分工）：**V1** 旧桥 wedge 现场复现 ⇒ 新判据等满 45s ⇒ killForce 强杀 ⇒ **零人工恢复**；**V2** 新桥 3/3 stop 优雅退出（不再 taskkill/删锁）；**C** 假锁（活 pid + pidfile 广播死端口）⇒ 探针 ECONNREFUSED ⇒ **删锁接管 owner**（缺广播时保守不接管——意外实证）；**E** warn 节流**行号级实证**（每进程恰 1 条、存活期 0 重复）；**复验** restart **exit 0 无断言 + pid 权威输出**；每次换桥后 MCP / Runner 自动重连。
- Step 3：用户「通过 + 发版」。

### 未覆盖（遗留验证，**不得默认算通过**）

- **POSIX 真机**（Linux/macOS 无真机）：SIGKILL 投递与 POSIX stop 路径仅结构级断言（注入式）+ 源码审查；launcher 孙进程孤儿残余（launcher 自身 SIGTERM handler 兜住）未真机。
- **doStop「端口释放但 pid 活」边界无自动化用例**（doStop 未导出；真机 V1 已实测该分支）—— 发版回归补受控断言。
- **bridgectl start/restart 退出路径无自动化断言**（隔离手工 E2E 覆盖）—— 发版回归补受控用例。
- K3 探针仅对新格式 pidfile（含 host/port）生效；旧格式 ⇒ 保守不接管（安全方向）。PID 复用误杀理论面（路径窄，本版不改）。

## [v0.7.1] - 2026-09-18

> 主题：**编排等待与提醒 + stdio transport 退役**（两条需求 · `REQ-v0.7.1-2026-09-18-01` / `REQ-v0.7.1-2026-09-18-02`）。两者**均不改状态机语义、不新增 Feature 态**。

### Added

- **宿主侧 Feature 等待脚本**（①）：`scripts/watch-feature.mjs` 重写 —— **只读**、经 orch 只读 web API（`GET /api/features/:id`，base URL 可经 `--base`/`WATCH_BASE_URL` 注入）**快照驱动**监视 Feature 至「需宿主动作」时点；退出码七类：`0` 完成 · `10` 失败收敛静止 · `11` needs_input · `12` cancelled · `13` failed(DAG) · `20` 超时仍在 executing · `1` 参数/连接错误。HTTP 用 **`node:http`（`agent:false`）** + **`process.exitCode` 自然退出**（消除 Windows libuv 退出竞态致**退出码损坏**）。
- **流程语义条款**（①）：`flow/spec/引擎映射.md` §7 新增「可观测语义」—— 宿主在**需动作三时点**（完成 / 失败收敛静止 / 需澄清）经**运行底座给出的可观测信号**被感知；**等待由运行底座（代码组件）承担、不靠人工提醒**；明文保留「LLM 不执行等待与轮询」；终态与 timeout 排除。§5 补一句 `a2a_events`/`a2a_wait` 的状态语义。
- **宿主指令**（①）：`CLAUDE.md`「宿主侧辅助面（仓根 `scripts/`）」含「**用法（必须）**」—— 派发 Feature 后宿主**必须**用 `watch-feature.mjs` **同步阻塞**等待并按退出码分流；**禁止** `Start-Sleep` + `a2a_feature_status` 手工轮询。

### Changed

- **stdio transport 退役**（②，力度 (b)）：桥**移除 stdio 运行分支** —— 删 `orch/bridge/transports/stdio.ts`、`main()` 的 stdio 分派、`unref` 双轨、`web.allowStdio` 死配置；`transport.mode` **只接受 `"http"`**，显式 `"stdio"` ⇒ **结构化 fail-fast**（不静默降级）；`FALLBACK_TRANSPORT` 改 **fail-fast（读配置失败不 bind）**；**缺省 = http**；**保留 `main()` / `isEntryModule()`**。
- **接入面统一常驻 http**：`flow/hosts/{opencode,claude-code,codex,cursor}.md`（去两形态）· `flow/README.md` · **`flow/install/{install,uninstall}.mjs`（产出 `type:"remote"` 条目、**无 `env`**）** · 仓根 `README.md` / `opencode.json.example`（remote 单条目）· `CLAUDE.md` · `orch/README.md` / `orch/opencode.json.example`。
- **`PROTOCOL.md:17`**：去 stdio 限定（→「桥接入面为**常驻 HTTP**（现唯一形态）」），**`/runner/*` 契约不变**；**machine 只读审阅接受**。
- **`flow/spec/引擎映射.md:10`**：仅去「stdio」限定词、**保留拉模型论证**（论证内核逐字保留）；§8 Transport 行**示例单元格对齐**（原则句与收尾句 `:125` 逐字冻结）。
- 三处 `package.json` 版本 → **0.7.1**（根 / `orch` / `machine`）。
- **`machine` 零源码改动**（7 项冻结 + 线协议零改）。

### Verified

- 门禁：`orch` `typecheck` **0** / `lint` **0** / `test` **195/195** / `build` **0**；`machine` `typecheck` **0**。
- 真机：桥以**唯一 http 形态**常驻运行 —— 8787 + 3300 监听、`/health` `role=owner`、`a2a_projects()` 3 项目 online、**Runner 自动重连**（machine 未重启）；`mode="stdio"` ⇒ **fail-fast 且不 bind**；坏配置 ⇒ fail-fast 不 bind。
- ① 脚本真机：`scripts/watch-feature.mjs <featureId>` 阻塞等待 → `判定=completed` → **`exit 0`**；mock 六态+1 **7/7**；真机 timeout 路径 **12/12** `exit 20`；错误路径 **5/5** `exit 1`。
- ② 宿主自测：端到端派发（inquiry → `S2-SELFTEST-OK`、`protocolVersion=2.0`）· installer 真机（临时目标：产出 remote 条目 + `uninstall` 字节还原 `opencode.json`）。
- Step 3 验收：① 用户「算通过」· ② 用户「以自测为准」。

### 未覆盖（遗留验证，**不得默认算通过**）

- ① **`failure-at-rest` 的真机**（mock 覆盖 + 完成侧真机命中；失败收敛静止未在真机复现）。
- ② **旧 stdio 配置的真机 fail-fast**（单元真机证据已给，宿主未复跑）；**codex / claude-code / cursor** 三端接入面真机。
- `bridge:restart` **就绪窗口 >30s ⇒ 假阴性**（与 v0.6.2 同族）；发版时 `bridge:start --no-wait` 后立即 `status` 可能报「未运行」，需等待/重试。
- **`config warn spam` 淹没启动日志**（v0.7.0 已登记遗留；本次导致诊断失明）。
- `machine/config/config.json.default:2` 注释 stale（machine 单元）。
- 回归用例（本版于 `§8.1e` 补 `test-v0.7.1-*`）。

## [v0.7.0] - 2026-09-18

> 主题：**Runner 反向注册（pull 连接模型整体反转）**（REQ-v0.7.0-2026-09-18-01，方案级变更；架构约束「无中心注册/静态分布/每机 Launcher 入站」随之修订）。**发版纪律变更：自本版起不上传 GitHub 仓库（用户指示；commit/tag 仅本地）。**

> - **连接模型反转（D1）**：Launcher 升格 **Runner**——出站注册（machineId + projects + capabilities + selfCheck + protocolVersion + version）→ HTTP 长轮询 /runner/connect（hold 25s 可配 + wake signal，poll 即心跳）→ 领取命令（命令族 dispatch / stop / cancel-task，均携 commandId）→ 本地 manager.ensure + 本地 A2A 执行（**三端 wrapper/adapters/会话映射零改**）→ /runner/result 回传。
> - **outbox 与幂等**：结果按 (machineId, taskId) 幂等 upsert（覆盖 callback + pull 双到达路径）；.a2a/outbox 暂存 ack 后清空，断线重连结果重放不丢。
> - **轻量注册视图（D3/D4）**：桥侧 runners / runner_projects 运行态投影表（不启动清空）；machines[].token ↔ launcher.bridge.token per-machine Bearer（常量时间比较）；注册准入 = machineId 在 machines[] 白名单内；projectGroup 仅控项目级读/claim。
> - **调度与回收语义**（半异步对外契约不变）：dispatchTask 改入队（成员前置同步零 I/O fail-fast，无 Runner 在线照常入队）；task-watcher poll/persist 换本地队列态、renew 退役；心跳超期清算 = **requeue**（claimed→queued + task.stale；不判 failed、不 stop）——根治「控制面离线 5 分钟误杀在飞任务」；idle 判据 = 本机无在飞任务。
> - **事件族**：runner.registered / online / offline · task.claimed / task.stale（+signalEvents）。
> - **协议 1.0 → 2.0（D5，发版即硬切）**：PROTOCOL.md 原地重写为「Runner ⇤ Bridge 线协议契约（2.0）」（machine 本地 /health 声明为非契约面；capabilities 可扩展对象 + 未知字段忽略）；契约测试全量重写（注册载荷准入断言）。
> - **端点退役（D6）**：machine 侧 /projects、/{id}/ensure、/{id}/stop 退役（404）；保留 loopback 只读 /health（additive bridge 字段）与 /shutdown；/runner/* 仅常驻 http 形态注册（stdio 启动 warn）。
> - **SSH/Transport 方向废弃（D9）**（planlog v0.6.0 缩减登记改判「被反向注册取代」）。
> - **真机 E2E 全 PASS**：E1 注册 · E2 inquiry 全链 · E3 Feature execute×pull · E4 断桥重连+在飞保护+outbox 重放 · E5 超期清算+复领 · E7 鉴权/成员拒绝 · E8 idle 旁证；E6 cancel-task 链路贯通、终态 failed≠canceled（语义缺陷登记待修）。增补轨 N1（命令载荷补 commandId/projectId，orch 196/196）、N2（register version 字段，machine 66/66）。
> - **过程遗留（登记待修/候收口批）**：bridge:stop wedge ×2（shutdown 打印完整但进程不退 + 租约滞留阻塞重启，绕过 = taskkill + 删 core.lock）；advance(note) 不注入 retryTaskIds 重派消息；config warn spam；DAG 登记缺依赖存在性校验。


## [v0.6.2] - 2026-09-18

> 主题：**编排可观测性修复 + 启停脚本非阻塞收口**（两条需求 + 一条流程纪律沉淀）。**A** `REQ-v0.6.2-2026-09-18-01`：`feature.failure_report` 的去重单位由「失败节点集合」改为「**失败 episode**」—— signature 的 failed 项改为 `${taskId}:${retryCount}`（`orch/bridge/scheduler.ts`），使**同一节点重派后再次失败也发第二条账单**；同一静止期仍幂等。**B** `REQ-v0.6.2-2026-09-18-02`：`launcherctl` / `bridgectl` 增 **`--no-wait`**（显式开关，缺省不变）+ machine opt-in **`--wait-ready`**；就绪判据键统一为 `/health` 的 `status`；占用判定三分类（`status` 缺失 ⇒ occupied）；`restart --no-wait` **仅作用 start 段**；**调用方维度**修复 —— Windows 改用 **WMI 脱壳拉起**常驻进程（否则宿主工具会被调用方的作业/进程树拖住）。**流程纪律**：`flow/spec` 写入「同一版本内多需求必须串行」。详见 `doc/v0.6.2/`。

### Added

- **失败账单 episode 去重**（A）：`orch/bridge/scheduler.ts` signature 的 failed 项由 taskId 集合改为 `${taskId}:${retryCount}`（`rearmForRetry` 自增的失败代次）；`orch/types.ts` 的 `retryCount` 注释由「语义休眠」改为「重派代次、参与 episode 去重」；`orch/session/store.ts` 的 `rearmTask` 加不变量注释（Feature `failed` 重派唯一入口 = `rearmForRetry`）。
- **启停脚本 `--no-wait` / `--wait-ready`**（B）：`machine/scripts/launcherctl.mjs` · `orch/scripts/bridgectl.mjs`；统一契约 C1–C8（发起即返 · 缺省等待目标分层 · 三分类键 = `/health` 的 `status` · 退出码恒 `{0,1}` · 调用拼写 `npm run <script> -- --no-wait` · `--no-wait` 的 pid 仅供参考）。
- **Windows 脱壳拉起**（B 增补轨）：常驻进程经 **WMI `Win32_Process.Create`** + 隐藏窗口拉起，脱离调用方作业/进程树（实测：宿主工具调用**即时返回**、无弹窗）；脱壳不可用时**显式降级 + 警告**（不得静默）；POSIX 保持 `detached + unref`。
- **单元 README 锚点段**：`orch/README.md` · `machine/README.md`（**版本中立**；就绪语义 / 退出码 / 调用拼写的**唯一锚点**）。
- **流程纪律**：`flow/spec/引擎映射.md` §4.1（+ `需求流程.md`）写入「**同一版本内多需求必须串行**」—— 第 2 个及以后的 Feature 须停在 `waiting_approval`，**前一条 `completed` 后才 `approve`**；引擎只提供同 project 串行，**不提供需求间串行**。
- **回归用例**：`.omo/skills/regression-test/tests/test-v0.6.2-observability.js`（A/B/纪律/版本一致性检测项）。

### Changed

- **三处 `package.json` 版本号升至 `0.6.2`**（根 / `orch` / `machine`；根为版本源）。
- `README.md`：启停段改用 `npm run <script> -- --no-wait` + `status` 确认，并指向**单元 README 为唯一锚点**（不复述判据）。
- `CLAUDE.md`：更正启停「非阻塞发起」的**误归因** —— `Start-Process + 切 stdin` **不能让宿主工具退出**；真因是**调用方作业 / 进程树归属**，修复 = **WMI 脱壳拉起**。
- `flow/hosts/{codex,claude-code}.md` · `flow/README.md` · `flow/hosts/opencode.md`：改用 `--no-wait` → `status` 直接用法 + 内联执行目录 + 指向单元 README。

### Verified

- **门禁**：`orch` `typecheck` 0 / `lint` 0 / **`npm test` 152 pass**（含 5 组新测）；`machine` `typecheck` 0；两脚本 `node --check` 0；宿主只读收口复核（A/B/增补轨）逐条通过。
- **真机 E2E（A，scratch-e2e `timeouts.prompt=18000` 受控超时）**：首轮失败收敛 = **恰 1 条** `feature.failure_report`（event `30298`，`text="Error: Prompt timeout after 18000ms"`、`blockedSet=[]`）；`advance(retryTaskIds=[S-N2])` 重派（`rearmed=[S-N2]` / `unfrozen=[]` / `retryCount 0→1`）→ 再次失败 ⇒ **第二条账单**（event `30301`，failed 集合与 #1 **完全相同**）= **修复目标达成**；其后静止期 **40s 零新事件**（不刷屏）；全程 `task.evidence` / `task.retry` **零出现**。
- **真机（B）**：`restart --no-wait` 脱壳路径 **1263–1314ms 返回**；**进程归属取证** —— 常驻进程的 `cmd` 祖先**已断**（不在调用方作业/进程树内）；`--wait-ready` / 互斥报错 / 已运行幂等 / 未知选项拒绝（orch 侧无 `--wait-ready`）均验。

### 未覆盖（遗留验证，**不得算通过**）

- **V4**：桥重启后「至多补发一条」账单（已知有界假阳性）未真机验证。
- **A 的 W1 语义缺口**：episode 结束原因**非重派**时集合可能复原 ⇒ 账单仍可能被静默吞（建议后续改用独立 episode 计数）。
- B：`--wait-ready` **穿透 `starting`** 未真机（只验到「已 ok」路径）；就绪窗口内并发 `start` 误诊未真机；`restart --no-wait` 的 stop 段上界未实测。
- 增补轨 #1 `dc78e2c5` 因节点自测**自毁**（停掉承载自身的 Launcher ⇒ 连带另一个节点失败、Launcher 宕机）被 `cancel`；已沉淀纪律：**worker 自测禁止启停承载自身或其它单元的服务**（启停与「调用方维度」验收归宿主）。

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
