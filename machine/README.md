# machine 单元（Launcher）

> 每台执行机器常驻一个 Launcher，v0.7.0 起升格为 **Runner**：以**反向注册（出站）**连到 orch 桥（注册 → 长轮询拉命令 → 本地 `ensure` + 本地 A2A 执行 → 结果回传），管理本机项目 Agent 的生命周期；**不做服务发现**。启停一律经 `scripts/launcherctl.mjs`（纯 Node ESM，零第三方依赖、无需构建），入口 `dist/launcher/index.js`。

## HTTP 接口（v2.0 起）

Launcher 的**入站指挥端点已于 v2.0 退役**（连接模型反转为 pull，见下节）；保留的本机面只有 `/health` 与可选 `/shutdown`：

| 方法 | 路径 | 状态 | 说明 |
|------|------|------|------|
| GET | `/health` | 保留 | **本机内部接口，非跨机契约面**（loopback；绑定由 `launcher.listenHost` 决定，v0.7.0 缺省 `127.0.0.1`）。响应 `{ ok, protocolVersion, status, bridge, degraded }`；`status ∈ {ok, starting}`（自检通过前为 `starting`）；`bridge` = Runner 注册态快照 `{ registered, lastHeartbeatAt, lastError }`（未启用 `launcher.bridge` 时恒为 `{ registered:false, lastHeartbeatAt:null, lastError:null }`）。`degraded` = 本机降级面快照（v0.8.8 · M4 新增，additive）：`{ selfCheckSkipped, selfCheckFailedProjects[], unavailableProjectIds[], outboxLoopAlive, outboxPendingCount, runnerLoopAlive, inFlightCount, cancelUnsupported[], inFlightByProject{}, queuedByProject{}, lastCancelQuietMs }` —— `selfCheckSkipped` 直报 `launcher.startupCheck === false`（跳过自检不再伪装成「自检通过」）；**`cancelUnsupported[]`（v0.8.10 · M-N4，additive）** = 「`tasks/cancel` 已发出、静默窗内该轮仍未达终态」的**项目集**（= 后端不认 `session/cancel`），**空数组 = 本机当前无此降级项**，与账单 `diagnostics.cancelUnsupported`（单张事实）**同名不同面**；**档位可见面（v0.8.10 增补轨 · A1，additive）**：`inFlightByProject{ [projectId]: {write,read} }` / `queuedByProject{ [projectId]: {write,read,oldestWaitedMs} }`（`Runner.gateSnapshot()` 原样透出，只含有活动的项目）与 `lastCancelQuietMs`（停事件账全局最近一次**取消往返**毫秒 = 本机 `tasks/cancel`/`tasks/get` 到**桥台账转终态**的耗时，**不是后端静默耗时**，见节④）——**四键齐、且恒在**（`cancelUnsupported[]` / `inFlightByProject{}` / `queuedByProject{}` / `lastCancelQuietMs`）：无取消降级 ⇒ `[]`，无在飞 / 无排队 ⇒ `{}`，无取消往返实测 ⇒ `null`，**一律给明确空值、不得省略键**。**判读口径**：未启用 bridge 的机器 `runnerLoopAlive` / `outboxLoopAlive` 恒 `false` 属「未启用」而非「已降级」（与 `bridge.registered` 同处判读），降级判据看 `selfCheckSkipped` / `selfCheckFailedProjects` / `unavailableProjectIds` / `outboxPendingCount`。**两面不通**：本段是纯本机 loopback 运维面，**不经注册载荷外传、到不了 orch**（push 通道 v0.8.3 已退役 + 注册载荷不扩字段）⇒ 与 orch 侧 `/health` 的 `degraded[]` 是两个同名互不相通的面，排查「系统在降级运行吗」须**两处分别查**。就绪判定键 = `status`（`launcherctl` / `reaper` 同口径；`degraded` 只加键、不改 `status` 就绪语义）。 |
| POST | `/shutdown` | 保留（可选） | 仅 `launcher.shutdownEndpoint=true` 时注册；**仅接受 loopback 来源**；可选 Bearer（`launcher.shutdownToken`）。反代转发后源地址亦为 loopback ⇒ 反代必须 deny `/shutdown`。 |
| GET | `/projects` | **已退役（v2.0）** | 命中 404。项目清单改由 Runner 注册载荷上报（桥侧注册视图承载）。 |
| POST | `/projects/{id}/ensure` | **已退役（v2.0）** | 命中 404。启动改由 Runner 命令族 `dispatch` 触发（本地 `ensure`，幂等复用）。 |
| POST | `/projects/{id}/stop` | **已退役（v2.0）** | 命中 404。停止改由 Runner 命令族 `stop` 驱动。 |

> 退役原因：目标部署形态下执行机**无入口**（无公网 / NAT 后），入站 HTTP 不可达；v0.7.0 把连接模型整体反转为 Runner **主动出站**（决策 D1/D6）。

## Runner 反向注册（v0.7.0，出站）

**启用条件**：`launcher.bridge { url, token }` **整段省略 = 不启动 Runner 出站**（零出站，同现状）；**一旦写出该段，`url` 与 `token` 必须同时为非空字符串 —— 缺一即启动 fail-fast**（配置解析期抛错、进程退出）。

**出站循环**（启动自检通过后才进入，注册载荷因此携带真实自检结论）：

1. `POST {bridge.url}/runner/register` —— 携 `machineId` / `projects[]`（`projectId` / `agentKind` / `risk` / `a2aPort`）/ `capabilities` / `selfCheck` / `protocolVersion` / `version`（本单元软件版本，取 `machine/package.json` 的 `version`，读取失败回落 `"0.0.0"`；**观测用、非握手判据**，PROTOCOL 2.0 起即有）；注册载荷顶层字段**不扩**（红线）—— 本机降级面（`/health` 的 `degraded` 段）**不随载荷外传**，与 orch 侧 `degraded[]` 互不相通（见上节）；
2. `POST {bridge.url}/runner/connect` —— **长轮询**（桥端 hold ~25s）：空响应 = 心跳；非空 = 命令。命令族三类：
   - `dispatch` → 本地 `ensure`（幂等复用）→ 本地 A2A `message/send` → 轮询至终态 → 组装结果；
   - `stop` → 该**项目**有在飞任务即拒收（回执 `error:"in-flight"`；v0.8.10 · M-N1 起判据按项目、非全机），否则停项目 → 回执；
   - `cancel-task` → 台账定位项目 → 本地 A2A `tasks/cancel`（台账无此 taskId ⇒ 回执 `error:"unknown-task"`；句柄尚未取得 ⇒ `error:"not-started"`）；
3. **结果回传**：任务终态**先落盘** `.a2a/outbox/<taskId>.json`（durable）→ `POST {bridge.url}/runner/result`（Bearer + `claimToken`）→ **HTTP 2xx = ack ⇒ 删文件**；否则保留并退避重试（1s → 2s → … cap 30s，±20% jitter）。`stop` / `cancel-task` 的回执随下一轮长轮询带回；`dispatch` 的结果不走回执。

**鉴权**：per-machine 静态 Bearer token（machine 侧 `launcher.bridge.token` ↔ orch 侧 `machines[].token`）；401/403 结构化进退避，**绝不崩进程**。

**运行态落盘**：`.a2a/runner-state.json`（原子写；`scripts/reaper.mjs` 判活 Runner 的事实源）。新鲜度窗口 `N = max(2 × 30s, 90s) = 90s`（时钟回拨视为新鲜）；子进程账本 `.a2a/children/<pid>.json` 不变。

## 传输层有界重发与启动补结算（v0.8.7，v0.8.8 增续跑与六类值域，v0.8.9 需求2 改续跑资格与总框口径，v0.8.10 续跑 / 重发改**定向取消**）

**① 传输层有界重发（首发早夭自愈，`launcher/runner-exec.ts`）**：dispatch 在**拿到终态之后**（`deliver` 之前）判定 —— 六类值域（PROTOCOL 2.3）下的传输层判据 = `failureKind === "agent"` ∧ `diagnostics.acpErrorKind ∈ {spawn, closed}` ∧ `chunkCount === 0`（即「**载体早夭**」：后端进程起不来 / 中途退出、且一个 chunk 都没吐；`timeout` kind 天然被排除）⇒ **定向取消本轮 → 重新 `ensure` → 重新 `send`**（v0.8.10 · M-N3 起**不再 `host.stop(projectId)`** —— stop 停整桥、连坐同项目其它在飞任务；静默未达成 ⇒ 不 stop、直接结算交宿主），**每节点最多 1 次**（`MAX_TRANSPORT_ATTEMPTS = 1`）。另保留唯一窄场景的内部重投 = **send 相位连接级失败**（此时连终态都拿不到：`entry.a2aTaskId === null` + ECONNREFUSED / ECONNRESET / 桥进程已死）。**两形态由「是否拿到终态」互斥划分、共用同一计数 ⇒ 不会双触发**。**禁止重发**的相位 = **poll 相位**（只能续轮询，`tasks/get` 只读幂等）与**超时 / abort**（请求**可能已送达并在执行**）。硬闸 = 剩余预算 ≥ 60s（`RESEND_MIN_REMAINING_MS`）且不越该次 dispatch 的 `deadline`。留痕 = 日志 + `diagnostics.attempts`（**不落库** —— `retry_count` 是 Feature rearm 语义，不混用）。桥侧**零改动且不可见**：同 taskId、单次终态回传、**不产生第二次账单**。

**⚠ 超时可自愈的唯一场景（v0.8.8 · M3「场景 C 续跑」，取代 v0.8.7「本版不自愈的一类」边界；v0.8.9 需求2 改闸为四因子、资格改由策略键决定；v0.8.10 · M-N3 改动作为定向取消）**：v0.8.7 对「后端接了活、满窗」一律不自愈，理由是**该路径不发取消** ⇒ 桥返回 failed 时后端那一轮**仍在跑**，同 `contextId` 直接重发会与新桥的 `load` / `resume` 交织，不安全。**该限制在 v0.8.10 被受控解除**（不是撤销）：满窗路径现在**会**发 `session/cancel`，但「发得出」不等于「停得下」—— ACP 的 cancel 是 notification、不等响应 ⇒ 生效与否只能靠**观测静默**确认。因此**发取消的前提**有三：① **捕获窗按 `taskId` 记**（`acp-bridge/acp/session.ts` 的 `captures`，v0.8.10 · M-N2；旧 `sessionId` 单值键会让上一轮尾巴漏进本轮 = 结果污染，也是只读并行的前置）；② **发出后有界静默窗**（`tasks/cancel` → 轮询 `tasks/get` 至终态，窗 ≤ `CANCEL_TIMEOUT_MS = 10s`；本文档取消语境的**「静默」= 桥台账该轮转终态**，**不等于后端停止计算** —— 口径见下节④ `cancelQuiesceMs` 行，计时**一律用该常量、不用 `remaining()`** —— 放弃点上后者已 ≤0，会被 `MIN_REQUEST_TIMEOUT_MS` 夹成不可控值）；③ **三条硬约束**（见下「收尾取消 B16′」）⇒ 结构上不可能产生第二条结果。现存一条**被严格收窄**的续跑路，可续跑判据（**判据在 launcher、原料在桥计量**）**四因子** = `failureKind="timeout"` ∧ **`timeoutScope="acp-prompt"`**（桥 prompt 满窗，排除 `runner-deadline`）∧ **有实质产出**（`partialChars ≥ 200 ∨ updateCount ≥ 5`）∧ **生效余量 > 0**（`em = min(continueMarginMs, 生效窗)`，缺省 0 = 关闭）；另含机械安全闸：`state=failed`、`continueAttempts = 0`（至多续跑 1 次/派发，`MAX_CONTINUE_ATTEMPTS = 1`；总轮数安全网 `MAX_DISPATCH_ROUNDS = 2` =「1 重发 + 1 续跑」防组合）、剩余预算 ≥ `max(180s, em)`。**动作 = 定向取消本轮 →（静默达成）`ensure`（幂等复用同桥）→ 同 `contextId` 重发续跑 prompt**（原任务 + 上轮残段尾部，残段里 ` ```a2a-outcome ` 开栏打散防注入）；**静默未达成 ⇒ (C) 降级：不 `stop`、不续跑**，保持 `failed` 交宿主裁决（宁可不续，不可连坐 —— 2026-09-23 真机实证：旧 `stop → ensure` 一次杀掉同项目 4 个只读任务）。**续跑只在本次派发按三段公式派生的总框内消费剩余**：**续跑轮额度 = `min(生效余量, 生效窗)`，是独立额度、不消费那 300s 结构余量**（结构余量专供非 prompt 往返）⇒ 只保证「不白烧」、不保证「续得完」。续跑轮再满窗 ⇒ 桥自报 `continueAttempts>0` 天然排除、不递归。**不满足判据的满窗**（零产出疑似排队 = `model_queue` 启发式的适用面、`runner-deadline` 无产出证据）⇒ **仍不续不重发**（该两类**不发定向取消**，只在派发收口时走 B16′ 收尾取消），保持 failed 等宿主裁决。**两条硬限制（登记为设计事实，不是实现 bug）**：① **续跑无 mid-flight 实时面** —— 只在终态回传后可见（`diagnostics.continueAttempts/continueTrigger` 留痕；orch 侧 `task.continued` 事件派生），不存在「正在续跑」的实时信号；② **（v0.8.9 需求2 重写，旧口径「未配 `sessionTimeoutMs` 的项目结构性不触发」作废）续跑资格 = 显式 opt-in** —— 能否续跑**只由 `agentConfig.continueMarginMs > 0` 决定**，**与配没配 `sessionTimeoutMs` 无关**；缺省 0 是**缺省关闭的策略键**，未开余量的项目一律不续跑（v0.8.8 时代「靠配窗顺带获得资格」的结构性口径不再成立）。

**② 启动补结算（`launcher/reconcile-inflight.ts`）**：在飞任务在领取后**落盘** `.a2a/inflight/<taskId>.json`（原子写；**无 writer 注入时零 IO**）。冷启动时按「inflight 台账 **减去**子女账本中**在册且存活**的 pid 所属项目」判孤儿：仍有执行体者**跳过**（宁漏勿误杀）；自检条目（`SELF_CHECK_LEDGER_PREFIX`）一律排除（否则重启后自检条目会被当孤儿上报 = 假故障）；其余造 `state='failed'` **新结果**（**必带 `failureKind="runner"`** —— v0.8.8 · M2 定档：本机已无执行体 = 载体侧事实，否则六类在补结算路径缺角）经 `outbox.deliver()` 上报（原因走 `text`，**不落 claimToken** —— 凭证随进程消亡是物理事实，桥侧补结算窄口允许「无令牌 + failed」，由**行级绑定**兜安全），成功后删除已消费的 inflight 条目。**调用时机 = `onListening` 内、`reconcileStartupLedger` 之后、register 成功之后**（口径：桥侧 `/runner/result` **无**「注册表存在性」检查 ⇒ register 顺序非硬要求）。**该路径不违反「boot 不补发」** —— 那条是**不回放既有 outbox 文件**，此处是造新结果。**失败只告警、绝不抛出、绝不阻断启动**（deliver 失败的条目保留文件，下次启动重试）。

**两条路的分工（与 orch 墙钟的显式冗余）**：machine 管「**本机知道自己死过**」（冷启动那一刻的一次性事实，秒级结账）；orch 墙钟管「**看不到事实时的最终兜底**」（掉电 / 僵死 / 断网 / 机器还在跑但结果永不来，30 min）。竞争安全由桥侧 `(machineId, taskId)` upsert 幂等 + **首个终态胜出** CAS 保证。

## 并发语义（v0.8.10：两把闸 · 定向取消与收尾取消 · 归因五键 · 按项目空闲回收）

> 本节是 machine 侧并发语义的事实源。它与 orch 侧是**两个时钟**：**orch 的忙集 / 认领序**决定「何时把一个节点交给某项目」（门径），**machine 的两把闸**决定「同一项目同时真正跑几个」（物理）。二者不互相复制，也不互相兜底。门径半侧（含完整矩阵的「门径」列）归 `flow/spec/引擎映射.md` §4.1 与 `orch/README.md`，本节只写 **machine 半侧**。

**① 并发矩阵 · machine 半侧（read / write × 同 project / 跨 project）**

| 场景 | 缺省（两键都不配 = 1/1） | 配 `maxConcurrentReads ≥ 2` 后 |
|---|---|---|
| 同 project · 写 × 写 | 串行（写档 1 席，后来者排队） | **仍串行**（放宽读档不改写档上限） |
| 同 project · 读 × 读 | 串行（读档 1 席） | **真并行** |
| 同 project · 写 × 读 | **互不占位** ⇒ 可并行（各自先到先起） | 可并行 |
| 跨 project（任意档组合） | **恒并行**（闸按 project 计，无跨项目全局闸） | 同 |

- 归档只认**显式 `readOnly === true`**（`DispatchCommand.readOnly`，经 `parseRunnerCommand` 落 `InFlightEntry.readOnly`）；缺省 / 其它取值 / 老桥不下发 ⇒ **一律写档**（保守方向 = 与 v0.8.9 实况同形）。
- **machine 侧没有第二道优先级**：两档各自 FIFO，读先到就先占读位。orch 的「写优先」只是**候选窗内的认领序**（且「同批至多一个只读被认领」是其刻意保留的防洪泛特性），落到本机后不再叠加。

**② 两把闸（执法归 machine，orch 不做第二道闸）** —— `launcher/runner-exec.ts` 的 `DispatchGate`：

- 上限来自项目平铺键 `agentConfig.maxConcurrentWrites` / `maxConcurrentReads`，**缺省 1 / 1**（单一源 `launcher/agent-config.ts` 的 `DEFAULT_MAX_CONCURRENT_WRITES` / `_READS`）⇒ **一个键都不配 = 同项目同档一次只跑一个 = v0.8.9 行为**（向后兼容缺省态）；非正整数在 `loadMachineConfig` **加载期 fail-fast**。
- **按 project 计、与项目组正交**（v0.8.6 的「一桥多组视野隔离」是可见性概念，与闸无关）；**跨项目全局闸本版不做**（跨项目不共享桥、无连坐风险）。
- **超限时排队、不丢弃、不设排队超时**：席位由释放方**移交**队首（`running` 计数不动）⇒ 后到者插不进队首之前，`oldestWaitedMs` 与「前面几个」的口径不漂。
- **派发预算从放行时刻起算**：`runGated` 过闸后才进 `executeDispatch`，故三段总框（`dispatchBudgetMs`）**不吃排队时长**；`InFlightEntry.admittedAt`（放行时刻）与 `startedAt`（命令领取时刻）之差即排队时长，**并存不替换**（`startedAt` 语义锁定为 v0.8.7 孤儿识别链的既有判据）。排队中的派发**已登记在台账**（排队中也算在飞 ⇒ `stop` 拒收 / 空闲回收判据据它）。
- **可见面**：闸快照 = `DispatchGate.snapshot()` → `Runner.gateSnapshot()`（`inFlightByProject{write,read}` / `queuedByProject{write,read,oldestWaitedMs}`，**只含有活动的项目**）；v0.8.10 增补轨 · A1 起，档位两键与 `lastCancelQuietMs`（= 停事件账 `lastCancelQuiesceMsOverall()`，全局最近一次**取消往返**毫秒，口径同上）已装配进 machine `/health degraded` —— **四键齐、且恒在**：无取消降级 ⇒ `[]`，无在飞 / 无排队 ⇒ `{}`，无取消往返实测 ⇒ `null`，不省略键。
- **并发闸上限播报（v0.8.10 增补轨 · A2）**：此前 `maxConcurrentWrites` / `maxConcurrentReads` 是全仓唯一**无任何回显面**的配置键（闸只在 `DispatchGate` 内执法 ⇒ 「这台机这一项配了多少」只能靠并发行为反推）。现由 `launcher/config-snapshot.ts` 播报：快照字段 `gateLimits`，每次拉起项目 Agent 都打一行 ——
  ```
  [launcher] agent <projectId> 并发闸：写上限=2（agentConfig） 读上限=1（缺省）
  ```
  值与出处与**执法通路同一读点**（`resolveMaxConcurrentWrites` / `resolveMaxConcurrentReads`，即 `effectiveGateLimits` 的组成）⇒ 播报口径与实执口径不会分叉。**「配了 / 缺省」按「键配没配」标注、不按「值是否等于缺省」** ⇒ 显式配 `1` 与缺省回落 `1` 可区分（同 `continueMarginMs=0（agentConfig）` 的判据）。**落点仍是 launcher 本机日志面**（`.a2a/logs/launcher.log`）：不经桥、不进 orch `/health`（与「两面不通」同族）⇒ 查上限只能查本机。同处的会话窗一行（`sessionTimeoutMs=… continueMarginMs=…`）自 M-N4 起可追加 `cancelQuiesceMs=<往返毫秒>（取消往返：桥台账转终态耗时，非后端静默）`，**没有取值就不出该键**（缺键 ≠ 报 0）。

**③ 定向取消（续跑 / 重发的动作，取代旧 `stop → ensure`）** 与 **★ B16′ 收尾取消** —— 见上节「超时可自愈的唯一场景」；此处登记取消纪律本身：

- **什么时候发 `session/cancel`**（三条路之外**一律不发**）：(a) 续跑轮之前、(b) 传输层重发之前（辅形态「进程已死」无对象可取消 ⇒ `cancelRound` 退 `not-started` 跳过）、(c) ★ **收尾取消**：**一趟派发结束时（含「判定不续跑」那条路径）**，若最终账单是一轮**被放弃的超时**（`timedOut ⇒ runner-deadline` / 桥满窗 ⇒ `acp-prompt`）且循环已退出 ⇒ 主动取消那一轮。发之前的前提 = 捕获窗已按 `taskId` 记（M-N2），否则上一轮尾巴会漏进下一轮。
- **为什么必须有 B16′**：机器上还有别的活在飞 ⇒ 该项目 CLI 不被空闲回收 ⇒ 被放弃的那一轮**一直烧到自然结束**，回话被桥当「未知 id」丢弃（v0.8.8 记录过 31 次该形态）。收尾取消消掉这份白烧；**「能收就收」（迟到结果照收）本版不做**，登记 v0.9.0（三个语义未定项：桥 CAS 例外 / Promise 可能永不 settle / 半截输出冒充成功）。
- **三条硬约束（缺一即开「第二条结果」的口子，launcher 与桥侧同源）**：**① 只走控制通道** —— 只发 `tasks/cancel` / `tasks/get`（及桥内 ACP notification），**绝不**读回结果文本、**绝不**再交一次账单；**② 不得改 state** —— 桥 `task-registry.cancel()` 的**终态支路**（record 已处终态 ∧ 该轮标 `abandoned` ⇒ 仍通知执行器）**只 notify、不回写 `status` / `updatedAt`**，改 state 即触终态 CAS = 第二条结果的成因；**③ 收尾取消必须排在 `outbox.deliver()` 之后** —— 账单先行 ⇒ 取消永不拖后交卷。三条同时成立 ⇒ **结构上不可能产生第二条结果**（orch 核出的「`rearmForRetry` 后无 claimToken 命中补结算窄口」由此堵死）。
- **桥侧必须自取消**（纯 launcher 侧覆盖不了的一半）：桥 prompt 满窗出口（`acp-bridge/acp/session.ts`）自己发 `session/cancel` + `markCaptureDead` + 结果标 `abandoned: true`；台账据此允许上述终态迟到取消。**`discardCapture` 照旧删窗**（不得为任何新特性保留捕获窗 —— 留窗就是重现「尾巴漏进下一轮」），dead **只标记不删**（计数还得报给该轮自己的 diagnostics）。
- **尽力而为**：取消失败 / 到点未静默 ⇒ 只 warn + 留痕，**不报错、不阻塞结算、不抛**（抛错会把已成交的账单退化成丢单）。

**④ 归因五键（v0.8.10 · M-N4；「谁杀了这一轮」的账面事实）** —— 全部落在**既有 `diagnostics` blob** 内，**`failureKind` 六类闭集一字不动**：

| 键 | 语义 | 产出条件 |
|---|---|---|
| `stopCause` | 停因闭集四值：`idle-reap`（空闲回收）/ `continue`（续跑）/ `resend`（传输重发）/ `stop-command`（外部 stop 命令）。⚠ **本版实际只产两值**（`idle-reap` · `stop-command`）—— M-N3 后续跑 / 重发已**不再 `stop`**（改定向取消本轮），那两条路上无「被连坐的在飞轮次」可归因 ⇒ `continue` / `resend` 是**留位值、非缺陷** | 本项目 Agent 被**带因**停掉、且本次派发落在该停事件的**闭区间时间窗**内（派发起算 → 结算） |
| `stopCauseTaskId` | **肇事任务** id（触发这次停止的归属者，**≠ 被停者**） | 停因带得出来才报；`stop` 命令无任务归属 ⇒ **省略该键**（不补空串） |
| `ghostRoundCancelled` | ★ B16′ 是否生效的账面证据：`true` = 对被放弃轮次的定向取消**达成往返**（桥台账该轮已转终态）；`false` = 已发出但窗内未转终态 | **只在交卷前**的取消（(C) 降级 / 续跑 / 重发路）能写进本单；**收尾取消排在 `deliver()` 之后 ⇒ 回写不了本键**，改由停事件账 → `config-snapshot` 播报 + `/health degraded` 承载；未发出过任何取消 ⇒ **省略该键** |
| `cancelQuiesceMs` | **取消往返耗时**（墙钟差）：本机 loopback 发 `tasks/cancel` → 轮询 `tasks/get` 到**桥台账把该轮转终态**为止。⚠ **不是「后端静默耗时」** —— 桥对 `session/cancel` 是 fire-and-forget、就地写终态，**从不回等后端**，故本键只量到桥这一层；**「后端是否真的停止计算」当前没有任何面承载**（已知缺口，见下条） | 仅取消**达成往返**（台账转终态）时有值；未达成 ⇒ **播报里省略该键**（缺键 ≠ 报 0） |
| `cancelUnsupported` | 后端不认 `session/cancel`（取消已发出、窗内桥台账该轮仍未转终态） | 同上；machine `/health degraded` 里**同名不同面**（账单 = 单张事实，`/health` = 项目集） |

- **⚠ 取消的可测边界（v0.8.10 增补轨 · A2 改口径）**：取消一侧**只能测到「桥台账转终态」**，测不到「后端进程是否真的停了」—— ACP 的 `session/cancel` 是 notification（无响应可等），桥收到即转发 + 就地置终态 ⇒ `cancelQuiesceMs` / `lastCancelQuietMs` 量的是**取消往返**（桥侧台账耗时）。后端可能仍在算（其输出被按 `taskId` 的捕获窗丢弃 = `staleChunkCount` 那条链），**当前无任何面**（diagnostics / `/health` / launcher.log）承载该事实 —— 登记为已知缺口，读账时不得把「往返很快」读成「后端立刻停了」。
- **⚠「缺键 ≠ 报 0」是本组键的统一口径**：任一事实未发生 ⇒ **整个键省略**（不补 `0`、不补 `false`、不补 `null`）。读账时「键不存在」= 无此观察，**不得**读成「观察到无」；停事件账未注入（单测 / 未接线）⇒ 停因侧与取消侧一并省略。
- 数据源 = **进程内停事件账** `launcher/stop-ledger.ts`（`StopEventLedger`，**单一实例**由 `index.ts` 同时注入 manager 与 runner；`stop()` 写「停因 + 当时的**按项目**在飞快照」，`runner-exec` 结算时按 `projectId + 时间窗` 回读；每项目留 `DEFAULT_MAX_EVENTS_PER_PROJECT = 8` 条；**不落盘** —— 连坐是进程内事实，重启后无在飞任务可归因）。自检收尾的 best-effort 回收**不带因** ⇒ 不记账（记了反而污染归因）。
- 同族哨兵 `staleChunkCount`（M-N2，**恒报**、`0` = 「没有残段漏进本轮」的正向证据）属计量面、不在这五键内：纯取证，**不参与任何 state 判据**，与 `replayDropped`（历史重放）分账。
- ⚠ 这五键**必须同时进 orch 侧 `projectDiagnostics` 白名单**（`DIAG_NUMBER/STRING/BOOLEAN_KEYS`）—— 未列入的键**从出参里消失**（DB 原文仍在，是最难查的一类落差）。

**⑤ 空闲回收判据改按项目** —— 详见下面「空闲回收」节；**本版行为变化**：某项目空闲到点即被回收，**即使别的项目正在忙**（v0.8.9 及以前是全机口径 ⇒ 只读并行常态化后会让所有项目的回收永久失效）。同一改动的另两处判据：注入点、`stop` 命令的在飞拒收（改为**该项目**在飞 >0 才拒收）。

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
- **缺省 `start` 的等待目标 = L1（`/health` 可答 = HTTP 200）**，**不含启动自检**；因此**缺省 `exit 0` ≠ 业务就绪** —— 自检未过时 `/health` 报 `status:"starting"`；**机器级**自检失败**只有一种：全部项目不可用**，仅此 fail-fast 退出，**单项目失败（含 ensure 过程中命中的端口/进程类故障）不再拖垮全机**（v0.8.6 补正口径，见「后端命令」失败语义）。另：**启动期 `listen` 失败**（`EADDRINUSE` 端口被占等）仍是机器级故障 —— 端口即双实例互斥锁，该路径在自检之前直接退出，与自检口径无关。入站业务路由已于 v2.0 退役，就绪态现仅由 `/health` 的 `status` 表达（不再有 503 业务路由）。
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

## 空闲回收（idleStopMs，v0.7.0 新口径，v0.8.10 · M-N1 改**按项目**计数）

项目 Agent 的本地回收判据 = **该项目无在飞任务（`inFlightLedger.countFor(projectId) == 0`）且静默 ≥ `idleStopMs`**：

- **⚠ v0.8.10 行为变化（本版唯一对现网可见者，改造文档 §3.2-U2）**：判据从「**全机** `inFlight.size`」改成「**按项目** `countFor(projectId)`」⇒ **某项目空闲即被回收，即使别的项目正在忙**（旧口径下 A 空着、B 在忙 ⇒ 全机在飞 >0 ⇒ A 永不回收）。这不是回归：只读并行常态化后全机在飞几乎恒 >0，旧口径会让**所有项目**的空闲回收永久失效（表现为桥进程只增不减）。同口径的另两处判据 = `AgentManager` 的在飞注入点、`stop` 命令的在飞拒收（**该项目**在飞 >0 才拒收）。旧台账无 `countFor` ⇒ 回落全机 `size`（行为同旧版）。
- 静默基准由 **`ensure`**（含 Runner 命令族 `dispatch` 触发的本地 `ensure`）复位；
- **计时基准不含心跳 / 回传 / 结算** ⇒ 长任务结算后「下一拍即收」，短任务才表现为"结算后再等"；
- `launcher.idleStopMs` 缺省 `300000`（5 分钟）；`0` 或负值 = **禁用**空闲回收（启动日志显示 `[launcher] idleStopMs=disabled`）；
- **回收停项目经 `stop(projectId, { cause: "idle-reap" })`**（v0.8.10 · M-N4）⇒ 往停事件账盖一条，同项目随之连坐的在飞任务在 `diagnostics.stopCause` 上指认得到回收方；
- **桥心跳失败只降 Runner 注册态**（`/health` 的 `bridge.registered` / `bridge.lastError`），**绝不触发 stop**（决策 D8，根治「桥停 5 分钟误杀在飞任务」缺陷）。

## Agent 类型与 ACP 桥（四条 kind 同构）

本机 `projects[].agentKind` 取值集合 = `opencode` / `codex` / `claude` / `qoder-cn`（单一事实源 `agent-kinds.ts`）。

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

- 桥 CLI 另有一个 **v0.9.0 · M2a 新增（M2c 收紧校验）、launcher 今天不装配** 的 flag：`--mcp-servers-json <JSON 对象数组>` = ACP `session/new` / `session/load` 的 `mcpServers` 取值来源（由板 / 手工起桥时直接传入）；缺省 / 空串 ⇒ 该槽位仍为 `[]`（既有行为零变化）。每个元素须为对象、带非空 `name`、带 ACP 判别键 `type` ∈ {`http`, `sse`, `acp`}，且该 `type` 要求的必填键非空（`http`/`sse` ⇒ `url`；`acp` ⇒ `command`）；非法 JSON / 非数组 / 上述形态不合规 ⇒ 启动即抛（M2b 实测：缺 `type` 的 payload 在 M2a 口径下能过启动期、直到运行期 `session/new` 才被后端拒 `-32602`）。

### 后端命令：外部安装 + `backendCmd` 可选覆盖（四层自动解析）

machine **不内联任何后端**（`package.json` 零新增依赖）：ACP 后端由**适配器包各自外部安装**。v0.8.6 起 `agentConfig.backendCmd` 对四个 kind 一律为**可选覆盖**：缺省时机器按**四层链**自动解析适配器入口（`KIND → 入口` 表唯一事实源 = `adapters/backend-entry.ts` 的 `BACKEND_LOOKUP_BY_KIND`）；写了显式值则**以显式值为准**（含指向非标准位置安装的自建适配器）——显式值的契约 = **入口文件路径，必须存在且是文件**，不满足 ⇒ 该项目明确不可用、**不静默回落下层**（想按命令名走 PATH 的正确表达 = 删键，见 L0 行）。

**四层链**（逐层探测、**命中即停**；`backendCmd` 缺键 / 空串 / 非字符串 ⇒ 回落自动解析）：

| 层 | 找什么 |
|---|---|
| **L0 显式** | 顶层平铺键 `agentConfig.backendCmd`（**显式值须存在且是文件** —— `backendCmd` 的契约 = **ACP 适配器入口文件路径**；不满足 ⇒ **该项目明确不可用、不静默回落**下层，文案含「后端入口」+ 原样路径；裸命令名（如 `node` / `qoderclicn`）同样被拒，**删键即可走自动解析**） |
| **L1 机器本地** | `machine/node_modules/<包>` 的入口（本机 `machine/package.json` 现零后端依赖 ⇒ 该层今天实质恒空，日后 machine 加依赖即自动生效） |
| **L2 全局 npm** | 固定候选表（不起子进程跑 `npm root -g`）：`NPM_CONFIG_PREFIX` + win `%APPDATA%/npm/node_modules` + posix `/usr/local/lib/node_modules`、`/usr/lib/node_modules`（按 root 去重）→ 逐根找 `<包>/package.json` 的 `bin` 入口 |
| **L3 PATH** | 按**适配器命令名**查 PATH（`opencode` / `codex-acp` / `claude-agent-acp` / `qoderclicn`），只命中**真身可执行体**（`.exe` / POSIX 可执行文件）——三家 JS 适配器全局安装通常只有 `.cmd/.ps1` 壳 ⇒ 该层对它们实质恒 `rejected-shell`，**保留但不指望兜底** |

| kind | ACP 后端（外部安装） | 自动解析入口 | `--backend-args` | 显式覆盖示例（`backendCmd`） |
|---|---|---|---|---|
| `opencode` | `opencode` CLI（自带 ACP 入口） | 包 `opencode-ai`（L1/L2）+ PATH 命令名 `opencode` | `["acp"]`（**子命令**，适配器内置；非 `--acp` 旗标） | `…\node_modules\opencode-ai\bin\opencode.exe`（**`.exe` 真身绝对路径**，实测可用） |
| `qoder-cn` | `qodercn` CLI（CN 版） | `pathCommand="qoderclicn"` + 双平台 `knownPaths`（见下） | 缺省 `["--acp"]`（走桥缺省） | `qoderclicn.exe` 的 `.exe` 绝对路径（或可补全为 `.exe` 的裸名） |
| `codex` | `@agentclientprotocol/codex-acp` | 同名 npm 包（L1/L2）+ PATH 命令名 `codex-acp` | 可执行体 `[]` / 脚本入口 `[<入口路径>]` | `…\@agentclientprotocol\codex-acp\dist\index.js`（**脚本入口**，推荐） |
| `claude` | `@agentclientprotocol/claude-agent-acp` | 同名 npm 包（L1/L2）+ PATH 命令名 `claude-agent-acp` | 可执行体 `[]` / 脚本入口 `[<入口路径>]` | `…\@agentclientprotocol\claude-agent-acp\dist\index.js`（**脚本入口**，推荐） |

**`qoder-cn` 无 npm 包、另有 `known` 白名单层**（排在 L3 之前）：按 kind · 按平台登记的**具体文件**（非扫目录）——win `~/.qoder-cn/bin/qoderclicn/qoderclicn.exe` · mac/linux `~/.local/bin/qoderclicn`；PATH 层命令名 `qoderclicn` **≠ kind 名 `qoder-cn`**，故表里必须显式登记。

**两条铁律（解析器不许踩）**：

- **绝不回退包 `main`**：claude 包 `bin=dist/index.js` 而 `main=dist/lib.js`，后者**不是 ACP stdio 入口**，误拉起来的表现是「`initialize` 无响应」，比 ENOENT 更难查。`bin` 解析规则：字符串直用；对象取 `bin[包 unscoped 名]`；key 未命中但对象仅单条目 ⇒ 宽容取该条目并记 `bin-key-mismatch`；多条目不匹配 ⇒ 判未命中进下一层（不猜）；`bin` 值两种写法（带 `./` / 不带）⇒ 一律 `resolve(pkgDir, value)` 后 `isFile` 校验。
- **PATH 层只按适配器命令名查、绝不按 kind 名**：按 kind 名会命中 `claude.exe` 这类**不会说 ACP 的 native CLI**（真实误解析来源）。

**`[backend]` 分层日志行**（解析结果落 `.a2a/logs/launcher.log`；挂在启动快照 `describeAgentConfig` 这一「每次拉起都打」的读点 ⇒ 自检期 / 派发期 / 复用期自动携带）：

```
[backend] <projectId> kind=codex L2-npm-global hit C:\...\codex-acp\dist\index.js        （命中即停，只记到命中层）
[backend] <projectId> 解析失败，逐层清单：L0-explicit=miss(backendCmd) | L1-local=miss(…) | L2-npm-global=miss(…) | L3-path=rejected-shell(…\codex-acp.cmd)
```

**失败语义**：解析不到 ⇒ **该项目明确不可用**——启动抛错（message 只带一句摘要 + 「详见 launcher.log 上方 `[backend]` 行」，分层清单不进 Error 以免被截断）+ 分层原因清单，**不静默降级、不回落 CLI**。v0.8.6 补正后自检粒度 = **单项目失败不再拖垮全机**：其余项目照常服务，**机器级自检故障只有一种 = 全部项目不可用**，仅此才退出；ensure 过程中命中的端口/进程类故障按项目级登记不可用（启动期 `listen` 失败另属双实例互斥语义，仍直接退出，不在自检口径内）。非标准 npm 前缀（nvm / volta / 自定义 prefix）⇒ 设 `NPM_CONFIG_PREFIX` 或显式填 `backendCmd`（L0 出口常在）。

**`backendCmd` 的语义与归一（v0.8.5，真机实测）**：`backendCmd`（显式填写的，或自动解析命中的）是**适配器入口**，由适配器归一为桥可直调的形态：

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
| `opencode` / `qoder-cn` | `--risk read` | `--risk write` | `--risk full` |
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
- 键位口径 = **自消费键顶层平铺**：`backendCmd`（**可选覆盖**，缺省走四层自动解析，见「后端命令」）· `model` · `systemPrompt` / `systemPromptMode`（自定义注入 ⇒ 桥 `--system-prompt` / `--system-prompt-mode`，缺省 `append`）· `sessionTimeoutMs`（v0.8.7 · 桥会话窗 ⇒ `--session-timeout <ms>`，缺省不写 = 桥落自身缺省值 600000；上限护栏见下条）· **`continueMarginMs`（v0.8.9 需求2 · M1 · 场景 C 续跑余量）**：顶层平铺自消费键，**缺省 0 = 不续跑**（缺省关闭的策略键、显式 opt-in），合法值 = **非负整数**，**上限 = 本项目生效会话窗**（`effectiveSessionTimeoutMs` = 显式 `sessionTimeoutMs` ?? 桥缺省 600000，故封顶 ≤ 600000）；超限 / 非法 ⇒ `loadMachineConfig` 加载期 fail-fast（报错文案带生效窗实际数值与出处）；生效值经 `config-snapshot` 与 `sessionTimeoutMs` 同行播报（`sessionTimeoutMs=… continueMarginMs=…`）· `sessionRetentionDays` / `sessionRetentionMax`（v0.8.9 · M5 · SessionMap 保留边界 ⇒ 桥 `--session-retention-days` / `--session-retention-max`，缺省不写 = 桥落自身缺省 7 天 / 500 条）· **`maxConcurrentWrites` / `maxConcurrentReads`（v0.8.10 · M-N5 · 同项目两把并发闸的上限）**：平铺自消费键，**缺省 1 / 1**，launcher 侧消费、**不透传桥**。
- **`maxConcurrentWrites` / `maxConcurrentReads`（v0.8.10 · M-N5）**：同一 **project** 的**两把独立计数闸**上限 —— 写档 / 读档各算各的（读不占写位、写不占读位）。**缺省 1 / 1**（单一源 `launcher/agent-config.ts` 的 `DEFAULT_MAX_CONCURRENT_WRITES` / `DEFAULT_MAX_CONCURRENT_READS`，经 `effectiveGateLimits(agentConfig)` 落）⇒ **不配任何键 = 同项目同档串行 = v0.8.9 行为**；要真并行只读须**显式**配 `maxConcurrentReads ≥ 2`。合法值 = **正整数**，非正整数 / 非整数 ⇒ `loadMachineConfig` **加载期 fail-fast**（0 或负数会让闸「永远排不到」、计数语义失真）。**作用域 = 按 project 计、与项目组正交**（不是组级、不是机器级；跨项目全局闸本版不做）；超限**排队（FIFO）不丢弃不超时**，派发预算从**放行时刻**起算。完整语义见「并发语义」节②；**生效值与出处的查表面 = 同节「并发闸上限播报」**（`config-snapshot` → launcher.log）。
- **`sessionRetentionDays` / `sessionRetentionMax`（v0.8.9 · M5）**：会话映射（`contextId ↔ sessionId`）的 TTL 天数与单项目条数上限（LRU）。合法值 = **正整数**（**无上限语义**），非法 ⇒ `loadMachineConfig` 加载期 fail-fast；生效值随 `config-snapshot` 启动播报落 launcher.log（`sessionRetentionDays=… sessionRetentionMax=…`，值标注出处 agentConfig / 缺省）。**与 `sessionTimeoutMs` 语义完全独立、互不派生**（一个管映射留存、一个管会话执行窗）。
- **`sessionTimeoutMs` 上限护栏（v0.8.7 · M2，v0.8.9 需求2 起 15 min → 10 min）**：合法值 = 正整数且 **≤ 600000（10 min）**，超限 / 非法 ⇒ `loadMachineConfig` 加载期 fail-fast。上限的**单一源** = `launcher/agent-config.ts` 的 `SESSION_TIMEOUT_MS_CAP`（桥是零仓内依赖的叶模块，只宽松校验「整数 > 0」，不重复定义上限）。**降到 10 min 的理由**：最坏总框 = 600s（窗）+ 300s（结构余量）+ 600s（续跑余量按窗封顶）= **1500s（25 min）** ≤ 安全线、且 **< orch 孤儿墙钟 30 min（1800s）** ⇒ launcher 与 orch 两层超时**无需组合校验**（orch 侧零代码改动、`orphanTimeoutMs` 缺省不动）；与 launcher 派发总框的关系见下条三段公式，且**无机器级全局 flag**（一个慢项目不应拉长全部项目的台账寿命）。**⚠ 升级说明：若曾把 `sessionTimeoutMs` 配到 > 600000，须先改配再升级** —— 否则 Launcher 加载期 fail-fast（窗上限已从 900000 降到 600000）。
- **launcher 侧派生（v0.8.7 · M3，v0.8.9 需求2 起改三段式）**：Runner `dispatch` 的等待预算**按项目**取，纯函数**三段公式** `dispatchBudgetMs(生效窗, 续跑余量) = 生效窗 + 结构余量(DISPATCH_MARGIN_MS=300s) + min(续跑余量, 生效窗)` ⇒ 桥窗一改，deadline 同值派生（不存在「只配桥侧、launcher 仍按缺省掐断」的静默无效）；**未配窗** ⇒ 生效窗落桥缺省 600_000，总框 = `600_000 + 300_000 + em`（`em = min(continueMarginMs, 生效窗)`，缺省 em=0 ⇒ **900_000**）—— **未配窗项目的总框也统一走本公式**；**能否续跑只看 `continueMarginMs > 0`，与配没配窗无关**（资格是策略键、不是窗配置的结构性副产品）。结果附**机器可读字段**：`failureKind`（**PROTOCOL 2.3 六类闭集**：`agent` / `transport` / `runner` / `model_queue` / `timeout` / `business`，由 launcher 的 `classifyFailure` 判定 —— **machine 只报原生事实（报得出才报，判不出就不报该键，不造第 7 值）**；`timeout` 类**必带子键** `diagnostics.timeoutScope`（`acp-prompt` / `runner-deadline` 两条路径同归 `timeout`、靠子键分家）；`model_queue` 本版 machine **恒不产出**（无独立信号，判定归 orch 启发式标注）；**闭集校验、落库与重试策略表归 orch**，旧值 `infra` / `task` 自 2.3 起非法、machine 不再产出）+ `diagnostics`（桥内细分与计量键经现成 `artifacts` 通道上带 `name="machine-diagnostics"`，launcher `buildResult` **先摘除再取文本**后填入，剩余 artifacts 原样回传 ⇒ 不污染 resultText）。
- **diagnostics 白名单 = 取证链的机内侧（v0.8.9 · M4）**：桥写什么、launcher 放行什么，两表必须同键集（`parseBridgeDiagnostics` / `BridgeDiagnostics` / `RunnerTaskDiagnostics`），漏放一个键 = 事实断在机内、orch 看不见；契约由 `test/acp-session.test.ts` 的「桥写键集（除 `stage`）⇔ launcher 放行键集」等式锚住。v0.8.9 新增放行：`turn` · `sessionReused` · `promptChars` · `injectedChars` · `resultChars` · `blockCount` · `replayDropped` · `outcomeAmbiguous` · `ambiguousReason` · `sessionMapSize` · `sessionMapOldestAgeDays` · **`staleChunkCount`（v0.8.10 · M-N2 新增放行，残段丢弃计数哨兵、恒报）**（`partialTail` 收进 `BridgeDiagnostics` 供 M3 续跑拼 prompt，但在回传投影 `bridgeForReport` 处**剥离** ⇒ 只上带长度键 `partialTailChars`）。**归因五键不走本白名单** —— `stopCause` / `stopCauseTaskId` / `ghostRoundCancelled` / `cancelQuiesceMs` / `cancelUnsupported` 是 **launcher 自产键**（不经桥），见「并发语义」节④。**成功轮也带 diagnostics**（v0.8.9 起桥在成功出口挂留痕）。
- **`business` 判据的不确定守卫（v0.8.9 · M4）**：`containsFailedOutcomeBlock(text, bridge)` 在桥标 `outcomeAmbiguous=true`（多块 / 跨轮重放漏出 / 跨轮 messageId 命中）时**不据此判 `business`** ⇒ 退回账面 `state`、判不出即**不报 `failureKind` 键**。取向是单向的：`business` **不在自动重试闭集**内，误判会把任务冻成「等宿主改方案」，漏判只让宿主按无 kind 的失败照常裁决 —— **宁可漏判，不可把 completed 误打成 business**。标志只读，launcher 不复算歧义判据（判据事实源在桥）。
- **「保留」≠ 提供读点**：命名空间保留键清单见 `agent-kinds.ts` 的 `RESERVED_AGENT_CONFIG_FLAT_KEYS`。
- **outcome 约定注入的唯一落点 = ACP 桥缺省**（单一源 `agent-outcome.ts`），不随项目配置覆盖。
- **opencode serve 前置后端（sidecar）已随迁 ACP 退役**：桥直接 spawn 后端，无独立后端进程、无端口预分配。

### 认证

- `opencode` / `codex` / `claude`：沿用各自 CLI 的用户级凭据（`~/.codex/config.toml`、`~/.claude/settings.json`）；
- `qoder-cn`：优先文件凭据 `~/.qoder-cn/.auth`（`qodercn` CLI 登录），备选 env `QODERCN_PERSONAL_ACCESS_TOKEN`（经 Launcher 进程环境透传）。

四 kind 项目示例 + 「适配器安装与后端命令示例」见 `config/config.json.default`。