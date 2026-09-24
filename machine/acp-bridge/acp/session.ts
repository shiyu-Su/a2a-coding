/**
 * ACP 会话生命周期 + B1 执行器桥接（REQ-v0.8.0-2026-09-19-01 · 节点 B3）。
 *
 * 语义（依 P1 探针实测方言）：
 * - 会话保证：`session/load` → 失败回退 `session/resume` → 再失败 `session/new`；成功映射落 `SessionMap`；
 *   阶梯的**实际落点**经 `sessionResumed` 回标（v0.8.8 · M1，见下「失败诊断留痕」）；
 * - `session/prompt` params `{ sessionId, prompt:[{type:"text",text}] }`；
 *   **注入 = 每 session 首轮 prompt 前缀**（v0.8.1 · M2）：内容 = 缺省 a2a-outcome 约定
 *   + config 段 `systemPrompt`（append=追加缺省之后 / replace=替换缺省；无 config 仅约定）；
 *   次轮及以后不注入；`prompted` 在收到 prompt 响应后置位（load/resume 跨进程不重注入）；
 * - 流式累积：`session/update` 通知中 `update.sessionUpdate === "agent_message_chunk"` 的
 *   `update.content.text` 逐 chunk 拼接为最终回复（`agent_thought_chunk` 忽略）；
 *   **轮边界双判据（v0.8.1 · M9 + M9-b/M9-c）**：
 *   ① 捕获窗（M9）：缓冲清空与开窗推迟到 `session/prompt` 写出之前，窗外到达的重放一律丢弃；
 *   ② 重放 id 集合（M9-c，普适于多后端）：`session/load|resume` 期间（窗内 prompt 写出前）
 *      到达的每个带 `update.messageId` chunk，其 id 记入 `replayMessageIds`；窗内 chunk
 *      无 messageId ⇒ 保留（`qoderclicn` 实时形态：活 chunk 恒不带 id）；带 id 且 **∈ 集合**
 *      ⇒ 丢弃（历史消息重放的尾部与本窗毫秒级交叠）；带 id 且 **∉ 集合** ⇒ 保留
 *      （opencode 实时形态：活 chunk 带本轮新 id，首见即活）；
 *   修复跨轮污染致续派永久判 input-required 的死循环；
 *   （M9-b 原判据「窗内带 id 一律丢弃」经真机自检证伪为 `qoderclicn` 专属方言 ——
 *    opencode 实时 chunk 本就带 messageId，会被整轮误丢致响应为空，故 M9-c 收窄为集合判定。）
 * - 终态：`stopReason:"cancelled"` → `canceled`；否则按 `parseOutcome` 映射 completed/input-required/failed；
 *   超时 → `failed`（对齐 600s 惯例，可配置）。
 *
 * **model 通路（v0.8.2 · M1 协议面增补，协议面 set）**：`model` 非空 ⇒ 每次会话建立（`session/new` 或
 * `session/load` / `session/resume` 复用）**成功后**、`session/prompt` 之前发一次
 * `session/set_config_option {sessionId, configId:"model", value:<原样>}`；恢复路径同样 set（不假设
 * 后端跨会话保持模型）。值**原样透传不校验**（双方言实测：opencode 与 qoder 同方言，qoder 须传
 * modelId 而非显示名）。`model` 未配 / 空串 / 非字符串 ⇒ **完全不调用**，行为与旧版逐字一致。
 * set 失败 ⇒ **fail-fast**（REQ-v0.8.2 M1 验证期裁决「配错就明确失败」）：记一条含配置原值与
 * 失败原因（message / code）的日志后**抛错**，会话建立失败、不继续 prompt、不回退后端默认；
 * 错误经 `execute` 的 `ensureSession` catch 冒泡为任务 `failed`。
 * 成功日志回显的 `currentValue` 从响应 `configOptions[]` 内 `id==="model"` 项取（顶层无该键），
 * 取不到 ⇒ 呈现 `n/a`（不打裸 `undefined`）。
 *
 * 依赖可注入（`client` 经构造注入，fake 单测）；不 import `orch/**` / `launcher/**`。
 *
 * **mode / collaboration_mode / session-meta 通路（v0.8.5 · M1）**：`mode` 非空 ⇒ 每次会话建立后发一次
 * `session/set_mode {sessionId, modeId}`（**仅**后端回 `-32601` 才回落
 * `session/set_config_option {configId:"mode"}`）；`collaboration_mode` 非空 ⇒ **只走**
 * `session/set_config_option {configId:"collaboration_mode"}`（它不在 `modes` 里）。两者与 `model` **同形**：
 * 缺省 / 空串 ⇒ **零请求**；失败 ⇒ **fail-fast**（日志 + 抛错，不静默回落）。`sessionMeta` 非空 ⇒
 * `session/new` / `load` / `resume` **三路统一携带 `_meta`**（否则复用会话拿不到 ⇒ full 档静默降级）。
 * 桥只收 adapter 的原样值，**不做 kind→mode 映射**。
 *
 * **失败诊断留痕（v0.8.7 · M4 → v0.8.8 · M1 扩）**：三处失败出口（① 会话建立失败 ② prompt 失败
 * ③ prompt 超时）各在 `TaskExecutionResult.artifacts` 追加一条 `name="machine-diagnostics"`（text = JSON）
 * ⇒ **零类型 / 零 wire 变更**；launcher `buildResult` 按名摘除 + 解析（见 {@link DIAGNOSTICS_ARTIFACT_NAME}）。
 *
 * **会话层加固（v0.8.9 · M2，改造文档 §2.2 / §2.3 / §2.4）**：
 * - **捕获窗按 `messageId` 分组累积**：`CaptureWindow.groups` 是本轮的**消息块序列**（run-length
 *   分组 ⇒ `groups` 顺序拼接与旧 `chunks` 拼接**逐字等价**，结果文本不变）；开窗即分配轮次序号
 *   `turn`（= `SessionMapEntry.turn + 1`）。分组是 M3 `parseOutcomeFromGroups`（按组定位末块）的原料。
 * - **跨轮归档判重放**：开窗时快照该 ctx 历轮活块 id（`SessionMapEntry.lastMessageIds`）；窗内出现
 *   **归档命中**的 id ⇒ 判为重放并计入 `replayDropped`（补 M9-c 的空洞：重放尾部跨过 `load` 响应
 *   之后时，窗外登记根本没发生）。**安全阀**：本轮尚无其它保留内容时**不丢**（丢空 = v0.8.1 M9-b
 *   犯过的错，R-Ⅱ），只留 `cross-turn-message-id` 痕迹。归档写入受 `SessionMap` 的 ≤32 有界约束。
 *   归档**只记本轮活块 id**（被丢的重放 id 不入档，否则一次污染会永久传染后续轮次）。
 * - **不确定三判据 ⇒ 只暴露、不动作**：(i) `blockCount ≥ 2` → `multi-block`；(ii) `replayDropped > 0 ∧
 *   blockCount ≥ 1` → `replay-leak`；(iii) 本轮活块 id 命中历轮归档 → `cross-turn-message-id`。
 *   命中即置 `outcomeAmbiguous` + `ambiguousReason`，**不改任务 state、不重派、不新增任务态**
 *   （state 仍走 `parseOutcome` 既有主规则与回退规则）。**续跑轮**（prompt 含 launcher
 *   {@link CONTINUE_TURN_PROMPT_MARKER}）用 `continue-` 前缀的独立取值，与常规轮分账。
 * - **注入判定改「曾发出过 prompt」**：`isFirstTurn` 读 `injectedAt`（{@link SessionMap.isInjected}）
 *   而非 `prompted` ⇒ 首轮 prompt 超时 / 失败**未收到响应**时，重派不再重复注入约定（①-b 根因）。
 *   **守卫不可省**：写 `injectedAt` 只发生在 ① 收到 prompt 响应 ②prompt 失败**且有推进证据**
 *   （`updateCount > 0 ∨ partialChars > 0`）两处；`stage==="ensure"`（prompt 从未写出）与
 *   「零输出」失败（transport / spawn 未到达后端、疑似排队）**一律不写** ⇒ 该类重派仍按首轮注入
 *   （漏注入 = 后端不输出结论块、被静默判 completed，比重复注入更坏）。
 * - **成功轮也挂 diagnostics**：`takeText` 之后、return 之前统一挂一次（`stage:"success"`），
 *   带体积键 `promptChars` / `injectedChars` / `resultChars`。⚠ 结果文本**不含** diagnostics 内容
 *   （走 artifact 另轨，AC-S1）；`partialTail` 仅失败路径报（AC-S2）。
 * - **无 `SessionMap` 的降级路径同步扩**：轮次 / 归档 / 注入簿记另立进程内表（`turnsInMemory`
 *   / `archiveInMemory` / `injectedInMemory`），否则 ③ 加固在该分支整段失效（R-Ⅸ）。
 *
 * **会话层捕获台账换键（v0.8.10 · M-N2）**：捕获窗的键由 **`sessionId` 改为 `taskId`**，通知侧改走
 * **两级路由**（`session/update` 只带 `sessionId` ⇒ `sessionId → 本 session 当前活跃 taskId → 该 task 的窗`）。
 * 换键修掉两处结构性缺陷：① **幽灵轮**（等待已放弃、后端仍在跑的那一轮）的 chunk 漏进同一会话的下一轮
 * ⇒ 结果污染；② 只读并行下写节点与只读节点**续接同一 `sessionId`** ⇒ 并发互相覆盖捕获窗。配套三条语义：
 * - **dead 窗**：被取消（`cancel`）或被放弃（同 session 上新一轮开窗接管了活跃指针）的窗标记 `dead`
 *   ⇒ 此后落入该窗的 chunk **一律丢弃并计数**（该轮文本与 `partialChars` 就此冻结，不再被幽灵输出推进）。
 *   判 dead **不删窗**（计数还得报给该轮自己的 diagnostics）；删除仍只发生在 `closeCapture` /
 *   `discardCapture` —— **不得为任何新特性保留捕获窗**，保留就是重现「尾巴漏进下一轮」。
 * - **残段 id 登记**：窗判 dead 时把其已收集的活块 id 记入该 session 的 `staleMessageIds`（有界，口径同
 *   归档 ≤32）⇒ 指针移交后仍试图落入**新窗**的同 id chunk 一并丢弃并计数。**失败 / 超时轮不登记**
 *   （那条路径只删窗）—— 续跑轮（v0.8.9 场景 C）合法地接着写同一条消息，把它的 id 判残段会丢空整轮。
 * - **`staleChunkCount`（纯可观测哨兵）**：本轮被上述两条丢弃的 chunk 条数，**恒报**（`0` = 「没有残段
 *   漏进来」的正向证据）。**不接入 `ambiguityOf` 三判据、不参与 state 判定**，与 `replayDropped` 分账。
 * 三处读者的口径：`replayMessageIds` **仍按 `sessionId` 键**（「窗外见过的 id」是会话级事实，不属于某个
 * task），但**清理改为条件式** —— 仅当该 session 的活跃指针仍属于正在结束的 task 才清 ⇒ 先结束的 task
 * 不再抹掉在飞 task 赖以判重放的登记；`archivedIds` 按 `contextId` 取快照后**存进本 task 自己的窗**
 * （并发下各窗自带归档快照，不再互相覆盖）；`ambiguityOf` 只读窗对象字段 ⇒ 语义不变（残段既已不入
 * `groups`，其 `blockCount` 反而更干净）。
 *
 * 载荷键（v0.8.8 · M1 计量补全 + 取证面；改造文档 §2.5 / §2.3.1）：
 * - **恒定七键**：`acpErrorKind`（`AcpError["kind"]`，非结构化抛出归 `error`）· `stage`（`ensure` / `prompt`
 *   落点）· `promptElapsedMs`（**prompt 段**耗时，改名自 `elapsedMs`，避开与 launcher 侧同名异义的
 *   `elapsedMs`；① 未进入 prompt ⇒ 0）· `bridgeEnsureElapsedMs`（会话建立段耗时）· `chunkCount`（本轮
 *   入缓冲 `agent_message_chunk` 数）· `partialChars`（本轮累计字符数，「确有产出」主判据原料）·
 *   `updateCount`（本轮**任意** `session/update` 计数，含 thought / tool_call = 「有推进」原料）；
 * - **条件五键**（事实缺失即**不报该键**，不编造 0 / false）：`firstChunkElapsedMs`（首 chunk 距开窗；
 *   无 chunk ⇒ 缺键，「满窗零产出」的证据）· `sessionResumed`（`load → resume → new` 阶梯实际是否续接
 *   成功；`false` = **续跑退化成重跑**，本机制最大隐性风险，必须上报）· `acpErrorCode` / `acpErrorData`
 *   （后端错误对象的 `code` 与 `data` **宽 JSON 原文** —— opencode 把细节只写进 `data`，丢掉它等于把
 *   错误压成「Invalid params」四个字）· `partialTail` / `partialTailChars`（半截产出**取出再弃**前先快照、
 *   截断至 {@link DIAGNOSTICS_PARTIAL_TAIL_MAX_CHARS} 经本通道带回 launcher —— 进程会被杀，桥内存态必失效）。
 *
 * **v0.8.9 · M2 新增键（§2.3 表；`stage` 增第三值 `success` ⇒ 成功轮也带载荷）**：
 * - `turn`（本轮轮次序号，桥内单调）· `sessionReused`（**映射命中**，与 `sessionResumed`=「load|resume
 *   真成功」**不等价**：命中但双失败回落 new 时二者相反）；
 * - `promptChars`（本轮写出的 prompt 全长）· `injectedChars`（其中注入部分 —— 首轮 >0、次轮恒 0，
 *   ①-b 的机器可判定证据）· `resultChars`（= `partialChars`，成功轮也报）；
 * - `blockCount`（本轮结构有效 outcome 块数）· `replayDropped`（被滤 chunk 条数，从「只落日志」升为账面）
 *   · `outcomeAmbiguous`（缺省 false ⇒ **不报该键**）· `ambiguousReason`（闭集，见上）；
 * - `sessionMapSize` / `sessionMapOldestAgeDays`（④ 可见面，**只搭桥的首个任务**一次；无映射 ⇒ 不报）；
 * - `continueAttempts`（续跑轮**自报** `1`；常规轮不报该键 —— launcher 用作跨轮防递归的第二信号）。
 *
 * **v0.8.10 · M-N2 新增键**：`staleChunkCount`（**恒定报**，与 `chunkCount` 同族的计数键；口径见上「捕获台账换键」）。
 * ⚠ launcher 侧 `parseBridgeDiagnostics` 白名单须同步放行该键 —— `test/acp-session.test.ts` 的「M2↔M4 契约」
 * 例断言**桥写键集 ⇔ launcher 放行键集相等**，漏放行即红。
 *
 * ⚠ launcher 侧 `parseBridgeDiagnostics` 是**逐键白名单**：未放行的键会被**静默忽略**（改造文档 §2.5
 * 「只加键不 breaking」）。M1 计量键与取证键的放行已由 M2 同步，契约由 `test/acp-session.test.ts`
 * 的「M4 契约 / M1↔M2 契约」两例锚住（白名单再收窄时该二例失败）。正常完成路径不带该 artifact。
 */
import { AcpError, wideJson } from "./client.js";
import { buildArtifacts } from "../artifacts.js";
import type { TaskExecutionInput, TaskExecutionResult } from "../types.js";
import { countValidOutcomeBlocks, parseOutcome } from "../outcome.js";
import { A2A_OUTCOME_CONVENTION } from "../outcome.js";
import { MAX_LAST_MESSAGE_IDS, type SessionMap } from "../session-map.js";

/** 单次 `session/prompt` 超时（对齐三端 prompt 600s 惯例；可配置）。 */
export const DEFAULT_SESSION_TIMEOUT_MS = 600_000;

/**
 * 失败诊断留痕 artifact 名（v0.8.7 · M4）。消费方 = `launcher/runner-exec.ts` 的
 * `DIAGNOSTICS_ARTIFACT_NAME`（deliver 前摘除 + 解析）—— 两侧同名是**线上传契约**，
 * 由 `test/acp-session.test.ts` 断言二者字面量一致。
 */
export const DIAGNOSTICS_ARTIFACT_NAME = "machine-diagnostics";

/**
 * 半截产出随 diagnostics 带回 launcher 的尾部上限（字符）。**护的是 `/runner/result` 的 1 MiB
 * 请求体上限**（UTF-8 最坏 4 字节/字符 ⇒ 4k 字符 ≤ 16 KB）；与 launcher 侧续跑判据的
 * `CONTINUE_TAIL_MAX_CHARS`（M2）取同一数值，桥先截 ⇒ 桥是唯一持有该文本的地方。
 */
export const DIAGNOSTICS_PARTIAL_TAIL_MAX_CHARS = 4_000;

/** diagnostics 载荷里 `acpErrorData` 宽 JSON 原文的上限（字符）。 */
const DIAGNOSTICS_DATA_MAX_CHARS = 2_000;

/**
 * 单个 session 的**残段 id 登记**上限（v0.8.10 · M-N2）：判 dead 的窗把其活块 id 记在这里，
 * 供该 session 后续轮次识别「上一轮的尾巴」。取与跨轮归档同一界，防无界增长。
 */
const MAX_STALE_MESSAGE_IDS = MAX_LAST_MESSAGE_IDS;

/** 人读文本（结果文本 / 日志）里的 `data` 摘要上限（字符）—— 比诊断载荷短，避免文本被淹。 */
const REASON_DATA_MAX_CHARS = 300;

/**
 * 续跑轮 prompt 的识别锚（v0.8.9 · M2）：launcher `buildContinuePrompt` 在续跑 prompt 里嵌入
 * 残段区标记 ⇒ 桥据此把本轮记为**续跑轮**（`ambiguousReason` 用 `continue-` 前缀独立取值）。
 * 桥与 launcher 不共享 import（分层红线：`acp-bridge` ⇹ `launcher`），故**同名字面量两份**，
 * 契约由 `test/acp-session.test.ts` 断言二者一致（同 `DIAGNOSTICS_ARTIFACT_NAME` 的先例）。
 */
export const CONTINUE_TURN_PROMPT_MARKER = "<partial-output-resume>";

/**
 * outcome「不确定」原因闭集（v0.8.9 · M2 · §2.4 三判据）：常规轮三值 + 续跑轮三值（`continue-` 前缀）。
 * 命中优先级 = `multi-block` > `cross-turn-message-id` > `replay-leak`（前者点名更准的机制）。
 */
export type OutcomeAmbiguousReason =
  | "multi-block"
  | "replay-leak"
  | "cross-turn-message-id"
  | "continue-multi-block"
  | "continue-replay-leak"
  | "continue-cross-turn-message-id";

/** 三判据的常规轮取值（续跑轮加 `continue-` 前缀）。 */
const AMBIGUOUS_BASE_REASON: Record<
  "multi-block" | "replay-leak" | "cross-turn-message-id",
  OutcomeAmbiguousReason
> = {
  "multi-block": "multi-block",
  "replay-leak": "replay-leak",
  "cross-turn-message-id": "cross-turn-message-id",
};

/** 诊断落点（v0.8.7 · M4 → v0.8.9 · M2 增 `success`）：桥内各出口的落点标识。 */
type BridgeDiagStage = "ensure" | "prompt" | "success";

/**
 * `withDiag` 的入参（v0.8.8 · M1 计量 + v0.8.9 · M2 会话层键）：三项计数与两段耗时**恒报**
 * （无事实即 0，含义明确）；可选键（`firstChunkElapsedMs` / `sessionResumed` / `partialTail` /
 * `ambiguousReason` / `sessionMap*` / `continueAttempts`）**事实缺失 ⇒ 不报**
 * （0 / false 与「没发生」是两回事，下游判据靠前者会误判）；`acpErrorCode` / `acpErrorData`
 * 由 `err` 派生，同样「无即不报」；`err` 在成功出口缺省。
 */
interface BridgeDiag {
  err?: unknown;
  stage: BridgeDiagStage;
  promptElapsedMs: number;
  bridgeEnsureElapsedMs: number;
  chunkCount: number;
  partialChars: number;
  updateCount: number;
  firstChunkElapsedMs?: number;
  sessionResumed?: boolean;
  partialTail?: string;
  // ---- v0.8.9 · M2 ----
  turn: number;
  sessionReused?: boolean;
  promptChars?: number;
  injectedChars?: number;
  blockCount: number;
  replayDropped: number;
  /** 本轮被判**残段**而丢弃的 chunk 条数（v0.8.10 · M-N2 哨兵；恒报，`0` = 无残段漏进本轮） */
  staleChunkCount: number;
  outcomeAmbiguous?: boolean;
  ambiguousReason?: OutcomeAmbiguousReason;
  continueTurn?: boolean;
  sessionMapSize?: number;
  sessionMapOldestAgeDays?: number;
}

/**
 * 本轮的一个**消息组**（v0.8.9 · M2）：同一 `messageId` 的连续 chunk 归一组
 * （run-length 分组 ⇒ 组间顺序 = 到达顺序 ⇒ 组文本串接与旧 `chunks.join("")` **逐字等价**）。
 * `messageId` 为 `undefined` = 该后端的实时 chunk 不带 id（`qoderclicn` 方言）。
 */
interface MessageGroup {
  readonly messageId: string | undefined;
  readonly chunks: string[];
}

/**
 * 本轮捕获窗（v0.8.8 · M1 分组 + 归档 → v0.8.10 · M-N2 换键 `taskId` + dead 语义）：把此前分散在
 * `buffers` / `capturing` / `captureOpenedAt` / `replayDropped` 四张并行 map 里的**同一份本轮状态**
 * 收成一处，避免跨表漂移与计量口径不一致。
 * 生命周期 = `session/prompt` 写出前置入（M9 捕获窗）、`takeText` / `discardCapture` 移除。
 * **归属键 = `taskId`**（不是 `sessionId`）：同一 session 上先后/并发的多个 task 各记各窗。
 */
interface CaptureWindow {
  /** 本窗归属的 taskId（= `captures` 的键；留痕与日志用） */
  readonly taskId: string;
  /** 本窗所在会话（dead 时登记残段 id、注销会话级簿记都要用它） */
  readonly sessionId: string;
  /** 本轮保留的 `agent_message_chunk` 按 `messageId` 分组（历史重放已在入缓冲前排除） */
  readonly groups: MessageGroup[];
  /** 本轮轮次序号（= 开窗时 `SessionMapEntry.turn + 1`；`turn` 键的事实源） */
  readonly turn: number;
  /** 开窗时该 ctx 的历轮活块 id 快照（跨轮归档判重放的依据；空集 = 首轮 / 无归档） */
  readonly archived: ReadonlySet<string>;
  /** 本轮是否 launcher 的**续跑轮**（prompt 含 {@link CONTINUE_TURN_PROMPT_MARKER}）⇒ ambiguous 取值独立分账 */
  readonly continueTurn: boolean;
  /** 开窗时刻（ms）—— `promptElapsedMs` / `firstChunkElapsedMs` 的锚点 */
  readonly openedAt: number;
  /** 首个入缓冲的 chunk 时刻（ms）；**缺 = 本轮一个 message chunk 都没来过**（「满窗零产出」的证据） */
  firstChunkAt?: number;
  /** 本轮入缓冲 chunk 的累计字符数（「确有产出」主判据原料） */
  partialChars: number;
  /** 本轮**任意** `session/update` 计数（含 thought / tool_call = 「有推进」原料） */
  updateCount: number;
  /** 窗内被轮边界判据（M9-c 窗外登记 id **或** v0.8.9 跨轮归档）丢弃的 chunk 数（账面键 `replayDropped`） */
  replayDropped: number;
  /** 本轮出现归档命中的 id（判据 iii；无论该块最终被丢还是走安全阀保留） */
  archiveHit: boolean;
  /**
   * **死窗标记**（v0.8.10 · M-N2）：本轮已被取消或被放弃 ⇒ 此后落入本窗的 chunk 一律丢弃并计数，
   * 文本与 `partialChars` 冻结在判死时刻。标记**不删窗**（计数还得报），删除仍只在收窗 / 弃窗两处。
   */
  dead: boolean;
  /**
   * 本轮被判**残段**丢弃的 chunk 条数（v0.8.10 · M-N2 哨兵 `staleChunkCount`）：
   * ① 落入本窗时本窗已 dead；② 落入活窗但其 id 属于该 session 上一轮判死的窗。
   * 与 `replayDropped`（历史重放）**分账**，且不参与任何判据。
   */
  staleChunkCount: number;
}

/** 会话建立结果（v0.8.8 · M1 回标：`load → resume → new` 阶梯的实际落点）。 */
interface EstablishedSession {
  sessionId: string;
  /** `load` / `resume` 任一真成功 = true；回落 `session/new` ⇒ false（**续跑退化成重跑**，必须上报） */
  sessionResumed: boolean;
  /**
   * **映射命中**（v0.8.9 · M2 · `sessionReused`）：该 ctx 在 `SessionMap` 里有旧 sessionId 可接。
   * 与 `sessionResumed` **不等价** —— 「命中但 load|resume 双失败回落 new」时二者相反。
   * 无映射（`SessionMap` 未配置 / 该 ctx 首见）⇒ 事实不成立 ⇒ `undefined`（**不报该键、不编造 false**）。
   */
  sessionReused?: boolean;
}

/** 会话客户端最小面（`AcpClient` 结构满足；便于 fake 注入）。 */
export interface AcpRequestClient {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  onNotification(handler: (method: string, params: unknown) => void): () => void;
}

/**
 * 首轮注入来源（v0.8.5 · M4：`--config-file` 段通道退役后 = 桥 flag `--system-prompt`
 * / `--system-prompt-mode` 的解析结果；键形状保持 `systemPrompt` / `systemPromptMode`）。
 */
export interface AcpInjectionConfig {
  /** 段内自定义注入文本（缺省 ⇒ 仅缺省 outcome 约定） */
  systemPrompt?: string;
  /** `append`（缺省）= 追加在缺省约定之后；`replace` = 替换缺省约定 */
  systemPromptMode?: "append" | "replace";
}

export interface AcpSessionRunnerOptions {
  client: AcpRequestClient;
  /** ACP 会话工作目录（项目 workspace） */
  cwd: string;
  /** contextId ↔ sessionId 映射（缺省不持久化，每次 `session/new`） */
  sessions?: SessionMap;
  timeoutMs?: number;
  mcpServers?: readonly unknown[];
  /** 首轮注入的 config 段（缺省 = 无 config，仅缺省约定注入） */
  injection?: AcpInjectionConfig;
  /**
   * ACP 模型标识（平铺 `agentConfig.model` 原样透传值）；非空 ⇒ 会话建立成功后发一次
   * `session/set_config_option {configId:"model"}`（new / load / resume 三路同此）。缺省 ⇒ 完全不调用。
   */
  model?: string;
  /**
   * ACP 会话模式标识（v0.8.5 · M1；adapter 按 `risk` 映射后的**原样值**，桥不做 kind→mode 映射）。
   * 非空 ⇒ 会话建立成功后发一次（优先 `session/set_mode`，仅 `-32601` 回落
   * `session/set_config_option {configId:"mode"}`）；缺省 / 空串 ⇒ **完全不调用**。
   */
  mode?: string;
  /**
   * ACP `collaboration_mode` 取值（v0.8.5 · M1；原样、不校验）。非空 ⇒ 会话建立成功后发一次
   * `session/set_config_option {configId:"collaboration_mode"}`；缺省 / 空串 ⇒ **完全不调用**。
   */
  collaborationMode?: string;
  /**
   * 会话建立期 `_meta` 注入（v0.8.5 · M1）：`session/new` / `load` / `resume` **三路统一携带**；
   * 缺省 ⇒ 三路均不带该键。
   */
  sessionMeta?: Record<string, unknown>;
  logger?: (message: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 后端错误对象的 `code`（非 `AcpError` / 无 code ⇒ `undefined`，**不编造**）。 */
function errorCodeOf(err: unknown): number | undefined {
  return err instanceof AcpError && err.code !== undefined ? err.code : undefined;
}

/**
 * 后端错误对象的 `data` 宽 JSON 原文（截断到 `maxChars`；无 `data` ⇒ `undefined`，**不编造**）。
 * **方言不对称**（双样本取证）：opencode 把细节只写进 `data`、qoder-cn 写进 `message`
 * ⇒ 两侧都得留（改造文档 §2.5 第 12 键）。
 */
function errorDataOf(err: unknown, maxChars: number): string | undefined {
  const data = err instanceof AcpError ? err.data : undefined;
  return data === undefined ? undefined : wideJson(data, maxChars);
}

/**
 * 失败原因串 = `message` + `（code=…）` + `〔data=…〕`（v0.8.8 · M1 取证面）。
 * 三处消费：`applyModel` / `applyMode` / `applyCollaborationMode` 的 fail-fast 文本、
 * `failureResult` 的结果文本、会话建立失败的结果文本 —— 此前 `failureResult` 连 `code` 都不拼，
 * 是「配额 / 限流到底有没有报错」这个问题答不上来的直接原因。
 */
function reasonOf(err: unknown): string {
  const code = errorCodeOf(err);
  const data = errorDataOf(err, REASON_DATA_MAX_CHARS);
  return `${messageOf(err)}${code === undefined ? "" : `（code=${String(code)}）`}${
    data === undefined ? "" : `〔data=${data}〕`
  }`;
}

/** 后端未实现该方法（JSON-RPC `-32601` Method not found）—— **仅此错误**允许回落。 */
function isMethodNotFound(err: unknown): boolean {
  return err instanceof AcpError && err.code === -32601;
}

/** 诊断用错误类别（v0.8.7 · M4）：结构化 `AcpError` 取其 `kind`；裸 Error / 未知抛出归 `error`。 */
function errorKindOf(err: unknown): string {
  return err instanceof AcpError ? err.kind : "error";
}

/**
 * `session/set_config_option` 响应的真值取位（F-a）：双方言实测顶层**无** `currentValue` 键，
 * 生效值嵌在 `result.configOptions[]` 内 `id === configId` 项的 `currentValue`。取不到 ⇒ undefined。
 */
function configCurrentValue(result: unknown, configId: string): unknown {
  if (!isRecord(result)) return undefined;
  const options = result["configOptions"];
  if (!Array.isArray(options)) return undefined;
  const entry = options.find((item) => isRecord(item) && item["id"] === configId);
  return isRecord(entry) ? entry["currentValue"] : undefined;
}

/**
 * chunk 的 `messageId`（M9-c 轮边界输入；无 / 空串 ⇒ `undefined`）。
 * 双方对方言（依双后端真机取证）：
 * - `qoderclicn` v1.1.57（M9-b 探针，仓外 %TEMP%/acp-m9b-probe）：实时 chunk 恒**不带**
 *   messageId（`update` 键集合 = `sessionUpdate` + `content`），只有 `session/load` 回灌的
 *   历史重放逐条带 id（每条历史消息一个 id，从不出现在本轮 prompt 响应里）；
 * - opencode：实时 chunk **本就带** messageId（本轮新消息的 id，首见于本窗）。
 * 故「有无 id」单独不可作判据，必须配合「该 id 是否在捕获窗外已出现过」。
 * 残余边界：某后端重放时若复用与本轮活 chunk 相同的 id，且该 id 曾在窗外出现 ⇒ 会误伤；
 * ACP 语义下 messageId 每消息唯一，可接受。
 */
function messageIdOf(update: Record<string, unknown>): string | undefined {
  const id = update["messageId"];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** 本轮各消息组的文本（组内 chunk 串接）；**顺序串接 == 旧 `chunks.join("")`**（逐字等价）。 */
function groupTexts(win: CaptureWindow): string[] {
  return win.groups.map((group) => group.chunks.join(""));
}

/** 本轮入缓冲的 `agent_message_chunk` 条数（= 各组 chunk 数之和，口径同 v0.8.8 的 `chunks.length`）。 */
function countChunks(win: CaptureWindow): number {
  return win.groups.reduce((sum, group) => sum + group.chunks.length, 0);
}

/**
 * 会话执行器：实现 B1 的 `TaskExecutor` 语义（execute / cancel）。
 * 任务执行 = 保证会话（load|resume|new）→ prompt（注入 outcome 约定）→ 累积至终态 → 文本。
 */
export class AcpSessionRunner {
  private readonly client: AcpRequestClient;
  private readonly cwd: string;
  private readonly sessions: SessionMap | null;
  private readonly timeoutMs: number;
  private readonly mcpServers: readonly unknown[];
  private readonly injection: AcpInjectionConfig;
  /** 归一化后的 model：非空字符串才保留（空串 / 非字符串 ⇒ `undefined` ⇒ 永不 set） */
  private readonly model: string | undefined;
  /** 归一化后的 mode：非空字符串才保留（空串 / 非字符串 ⇒ `undefined` ⇒ 永不下发）。 */
  private readonly mode: string | undefined;
  /** 归一化后的 collaboration_mode：同 mode。 */
  private readonly collaborationMode: string | undefined;
  /** 会话建立期 `_meta`（`undefined` ⇒ 三路均不携带）。 */
  private readonly sessionMeta: Record<string, unknown> | undefined;
  private readonly logger: (message: string) => void;
  /**
   * **taskId → 本轮捕获窗**（v0.8.10 · M-N2 换键，此前是 `sessionId → 窗`）：**开窗即存在、收窗即删**
   * ⇒ 「有窗」等价于旧 `capturing.has(...)`；窗内一次性收齐本轮的 chunk 文本与三原料计数（旧
   * `buffers` / `capturing` / `captureOpenedAt` / `replayDropped` 四张并行 map 的合并落点）。
   * 换键的动因：`sessionId` 单值键下，同一会话的多个 task（幽灵轮 / 写节点与只读节点并发）
   * **共用一格** ⇒ 互相覆盖、上一轮的尾巴漏进下一轮。
   */
  private readonly captures = new Map<string, CaptureWindow>();
  /**
   * **sessionId → 本 session 当前活跃 taskId**（v0.8.10 · M-N2 两级路由的第一级）：
   * `session/update` 只带 `sessionId`，通知侧须经本指针落到 `captures` 里对应的 taskId 窗。
   * 开窗时接管、收窗 / 弃窗时（仅当自己仍持有）注销。
   */
  private readonly activeTaskOf = new Map<string, string>();
  /**
   * **sessionId → 已判死轮次的活块 id**（v0.8.10 · M-N2）：指针移交给新一轮后，同 id 的 chunk
   * 若还想进新窗 ⇒ 判为上一轮（幽灵 / 已取消）的残段，丢弃并计入 `staleChunkCount`。
   * 每 session 有界 ≤{@link MAX_STALE_MESSAGE_IDS}。
   */
  private readonly staleMessageIds = new Map<string, Set<string>>();
  /**
   * sessionId → 重放 messageId 集合（M9-c）：捕获窗外（`session/load|resume` 回灌期）出现过的
   * 每个 messageId。窗内 chunk 的 id 命中本集合 ⇒ 判为历史重放；未命中 ⇒ 判为本轮实时消息的新 id。
   * **键仍是 `sessionId`**（v0.8.10 · M-N2 不换）——「窗外见过某 id」是该会话的事实，不属于某个 task；
   * 换的是**清理时机**：只在活跃指针仍属于正在结束的 task 时清，先结束的 task 不得抹掉在飞 task 的登记。
   */
  private readonly replayMessageIds = new Map<string, Set<string>>();
  /** taskId → sessionId（供 cancel 定位） */
  private readonly taskSessions = new Map<string, string>();
  /**
   * 无 SessionMap 时的进程内首轮注入簿记（contextId → 已收到响应）。
   * 持久化路径经 `SessionMap.prompted`，不依赖本集合。
   */
  private readonly promptedInMemory = new Set<string>();
  /**
   * 无 SessionMap 时的进程内「曾发出过首轮 prompt」簿记（v0.8.9 · M2 · `injectedAt` 的内存同位）。
   * 与 `promptedInMemory` **分开**：前者 = 是否写出（注入判定），后者 = 是否收到响应（既有语义）。
   */
  private readonly injectedInMemory = new Set<string>();
  /** 无 SessionMap 时的进程内已完成轮次计数（v0.8.9 · M2 · `turn` 的内存同位，R-Ⅸ）。 */
  private readonly turnsInMemory = new Map<string, number>();
  /** 无 SessionMap 时的进程内历轮活块 id 归档（v0.8.9 · M2 · `lastMessageIds` 的内存同位，R-Ⅸ）。 */
  private readonly archiveInMemory = new Map<string, string[]>();
  /** `sessionMapSize` / `sessionMapOldestAgeDays` 的一次性搭车闸（v0.8.9 · M2：只随**桥首个任务**带出）。 */
  private sessionMapStatsSent = false;

  constructor(options: AcpSessionRunnerOptions) {
    this.client = options.client;
    this.cwd = options.cwd;
    this.sessions = options.sessions ?? null;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    this.mcpServers = options.mcpServers ?? [];
    this.injection = options.injection ?? {};
    this.model = typeof options.model === "string" && options.model.length > 0 ? options.model : undefined;
    this.mode = typeof options.mode === "string" && options.mode.length > 0 ? options.mode : undefined;
    this.collaborationMode =
      typeof options.collaborationMode === "string" && options.collaborationMode.length > 0
        ? options.collaborationMode
        : undefined;
    this.sessionMeta = options.sessionMeta;
    this.logger = options.logger ?? ((): void => undefined);
    this.client.onNotification((method, params) => this.onNotification(method, params));
  }

  /**
   * 首轮注入文本 = 缺省 a2a-outcome 约定 + config 段 `systemPrompt`
   * （`append` = 追加在缺省约定之后；`replace` = 替换缺省约定；无 config 时仅缺省约定）。
   */
  private buildInjection(): string {
    const custom = this.injection.systemPrompt;
    if (custom === undefined || custom.length === 0) return A2A_OUTCOME_CONVENTION;
    if (this.injection.systemPromptMode === "replace") return custom;
    return `${A2A_OUTCOME_CONVENTION}\n\n${custom}`;
  }

  /**
   * 该 contextId 的会话是否**尚未发出过**首轮 prompt（= 需注入）。
   * v0.8.9 · M2（①-b）：判据从「已收到响应」（`prompted`）改为「曾写出」（`injectedAt`）
   * ⇒ 首轮超时 / 失败的重派不再重复注入约定。写入点与守卫见 {@link AcpSessionRunner.recordInjected}。
   */
  private isFirstTurn(contextId: string): boolean {
    if (this.sessions !== null) return !this.sessions.isInjected(contextId);
    return !this.injectedInMemory.has(contextId);
  }

  /** 该 contextId 在桥内**已完成**的轮次（`turn` 键 = 本值 + 1）。 */
  private completedTurns(contextId: string): number {
    if (this.sessions !== null) return this.sessions.getEntry(contextId)?.turn ?? 0;
    return this.turnsInMemory.get(contextId) ?? 0;
  }

  /** 该 contextId 的历轮活块 id 归档快照（开窗时取一次；无 ⇒ 空集）。 */
  private archivedIds(contextId: string): ReadonlySet<string> {
    if (this.sessions !== null) return new Set(this.sessions.getEntry(contextId)?.lastMessageIds ?? []);
    return new Set(this.archiveInMemory.get(contextId) ?? []);
  }

  /**
   * 记账「本轮 prompt 已发出」（①-b）。**调用点即守卫**：只允许 ① 收到 prompt 响应 ②prompt 失败
   * 且有推进证据 两处；`ensure` 失败（prompt 从未写出）与「零输出」失败（未到达后端 / 疑似排队）
   * **一律不调用** ⇒ 该类重派仍按首轮注入（漏注入比重复注入更坏）。
   */
  private recordInjected(contextId: string): void {
    if (this.sessions !== null) this.sessions.markInjected(contextId);
    else this.injectedInMemory.add(contextId);
  }

  /**
   * 记账「首轮 prompt 已收到响应」（`prompted` 语义保留不动，v0.8.1 · M2）。
   * v0.8.9 · M2：注入判定改读 `injectedAt` 后，`prompted` 不再兼任判定 ⇒ 每轮收到响应都保真
   * （已置位则跳过写入，避免逐轮无谓落盘）。
   */
  private recordPrompted(contextId: string): void {
    if (this.sessions !== null) {
      if (!this.sessions.isPrompted(contextId)) this.sessions.markPrompted(contextId);
      return;
    }
    this.promptedInMemory.add(contextId);
  }

  /** 收轮：已完成轮次 +1（prompt 成功出口的 `turn` 主口径）。 */
  private bumpTurn(contextId: string): void {
    if (this.sessions !== null) this.sessions.bumpTurn(contextId);
    else this.turnsInMemory.set(contextId, this.completedTurns(contextId) + 1);
  }

  /**
   * 归档本轮**活块** id（次轮开窗时的重放判据）。被丢的重放 id 不经此入口 ⇒ 一次污染不永久传染。
   * 有界 ≤32 由 `SessionMap.recordMessageId` 保证；无映射路径本地同界。
   */
  private archiveLiveIds(contextId: string, messageIds: readonly string[]): void {
    if (this.sessions !== null) {
      for (const id of messageIds) this.sessions.recordMessageId(contextId, id);
      return;
    }
    const prev = this.archiveInMemory.get(contextId) ?? [];
    for (const id of messageIds) {
      if (prev[prev.length - 1] !== id) prev.push(id);
    }
    this.archiveInMemory.set(contextId, prev.slice(-MAX_LAST_MESSAGE_IDS));
  }

  /**
   * ④ 可见面（v0.8.9 · M2）：映射规模与最老条目年龄，**只随桥的首个任务**带出一次
   * （§2.5(b)；无 `SessionMap` ⇒ 无事实，两键不报）。
   */
  private sessionMapStatsOnce(): { sessionMapSize?: number; sessionMapOldestAgeDays?: number } {
    if (this.sessions === null || this.sessionMapStatsSent) return {};
    this.sessionMapStatsSent = true;
    const stats = this.sessions.stats();
    return {
      sessionMapSize: stats.size,
      ...(stats.oldestAgeDays === undefined ? {} : { sessionMapOldestAgeDays: stats.oldestAgeDays }),
    };
  }

  // ---------- v0.8.10 · M-N2：捕获台账（taskId 键 + 两级路由 + dead 窗）----------

  /**
   * 两级路由（通知侧唯一入口）：`sessionId →（本 session 当前活跃 taskId）→ 该 task 的窗`。
   * 无活跃 task 或窗已收 ⇒ `undefined` = **窗外**（load/resume 回灌、或上一轮已弃置后的残段）。
   */
  private routeCapture(sessionId: string): CaptureWindow | undefined {
    const taskId = this.activeTaskOf.get(sessionId);
    return taskId === undefined ? undefined : this.captures.get(taskId);
  }

  /**
   * 判 dead（v0.8.10 · M-N2）：把该 task 的窗标记为**已死** —— 此后落入该窗的 chunk 一律丢弃并计数，
   * 其已收集的活块 id 登记为该 session 的**残段 id**（指针移交后，同 id 的 chunk 即便落进新窗也照样丢）。
   * **不删窗**：窗对象还得持有计数，供该轮自己的 diagnostics 报出；删除只发生在收窗 / 弃窗两处。
   */
  private markCaptureDead(taskId: string, reason: "cancelled" | "superseded"): void {
    const win = this.captures.get(taskId);
    if (win === undefined || win.dead) return;
    win.dead = true;
    for (const group of win.groups) {
      if (group.messageId !== undefined) this.rememberStaleMessageId(win.sessionId, group.messageId);
    }
    this.logger(
      `[acp-session] 捕获窗判 dead（${reason}）：taskId=${taskId} sessionId=${win.sessionId} turn=${String(win.turn)} ⇒ 已收 ${String(countChunks(win))} 条冻结，该轮后续 chunk 一律丢弃并计数`,
    );
  }

  /** 登记一个「属于已判死轮次」的 messageId（每 session 有界 ≤{@link MAX_STALE_MESSAGE_IDS}）。 */
  private rememberStaleMessageId(sessionId: string, messageId: string): void {
    let ids = this.staleMessageIds.get(sessionId);
    if (ids === undefined) {
      ids = new Set<string>();
      this.staleMessageIds.set(sessionId, ids);
    }
    ids.add(messageId);
    while (ids.size > MAX_STALE_MESSAGE_IDS) {
      const oldest = ids.values().next().value;
      if (oldest === undefined) break;
      ids.delete(oldest);
    }
  }

  /** 该 id 是否属于本 session 某个已判死轮次（残段判据；无登记 ⇒ false）。 */
  private isStaleMessageId(sessionId: string, messageId: string | undefined): boolean {
    return messageId !== undefined && this.staleMessageIds.get(sessionId)?.has(messageId) === true;
  }

  /**
   * 注销本轮的**会话级**簿记（活跃指针 + 重放 id 登记）：只在该 session 的活跃指针仍属于正在结束的
   * 这个 task 时才清 —— 并发（写节点与只读节点续接同一 `sessionId`）下，先结束的 task 不得抹掉仍在飞的
   * task 赖以判重放的登记（那是 M9-c 的证据面，被抹掉即整轮失防）。
   */
  private releaseCaptureLedger(sessionId: string, taskId: string): void {
    if (this.activeTaskOf.get(sessionId) !== taskId) return;
    this.activeTaskOf.delete(sessionId);
    this.replayMessageIds.delete(sessionId);
  }

  /** 执行一个任务（B1 `TaskExecutor.execute` 语义）。 */
  async execute(input: TaskExecutionInput): Promise<TaskExecutionResult> {
    const ensureStartedAt = Date.now();
    const continueTurn = input.text.includes(CONTINUE_TURN_PROMPT_MARKER);
    let session: EstablishedSession;
    try {
      session = await this.ensureSession(input.contextId);
    } catch (err) {
      // 建立失败：捕获窗未开 ⇒ 三项计数记 0，`sessionResumed` / `sessionReused` / `firstChunkElapsedMs`
      // **不报**（无事实不编造，报 0 会被下游当成「有推进但零字符」）。
      // ①-b 守卫第 1 处：`stage==="ensure"` ⇒ prompt 从未写出 ⇒ **不写**注入前计数 ⇒ 重派仍按首轮注入。
      return this.withDiag({ state: "failed", text: `会话建立失败：${reasonOf(err)}` }, {
        err,
        stage: "ensure",
        promptElapsedMs: 0, // 未进入 prompt 段
        bridgeEnsureElapsedMs: Math.max(0, Date.now() - ensureStartedAt),
        chunkCount: 0,
        partialChars: 0,
        updateCount: 0,
        turn: this.completedTurns(input.contextId) + 1, // 映射现值（本出口不 bump）
        blockCount: 0,
        replayDropped: 0,
        staleChunkCount: 0, // 窗从未开 ⇒ 无残段可言（恒报键，与 chunkCount 同口径）
        continueTurn,
        ...this.sessionMapStatsOnce(),
      });
    }
    const { sessionId, sessionResumed, sessionReused } = session;
    const bridgeEnsureElapsedMs = Math.max(0, Date.now() - ensureStartedAt);
    this.taskSessions.set(input.taskId, sessionId);
    // 轮次序号**在会话建立之后**取：load/resume 双失败回落 new 会 delete 旧条目（其 turn 已作废），
    // 建立前取会把死会话的轮次算进新会话的第一轮。
    const turn = this.completedTurns(input.contextId) + 1;

    const firstTurn = this.isFirstTurn(input.contextId);
    const injection = firstTurn ? `${this.buildInjection()}\n\n---\n\n` : "";
    const promptText = `${injection}${input.text}`;

    let promptResult: unknown;
    try {
      // M9 捕获窗：prompt 写出前才清缓冲并开窗（窗外 backlog 直接丢弃，但其 messageId 已登记）。
      // 探针实测回灌尾部与本窗开启毫秒级交叠 ⇒ 窗内另按 M9-c 重放 id 集合 + v0.8.9 跨轮归档二次过滤。
      // 注意：不可在此清 replayMessageIds —— 其中的 id 正是本轮 ensureSession 的 load/resume 期登记的。
      // v0.8.10 · M-N2：窗键 = taskId；开窗前若该 session 仍有**别的**活窗（等待已放弃、后端还在跑的
      // 幽灵轮）⇒ 先判 dead，再接管活跃指针，此后它的尾巴一律落进 dead/残段通道，不再进本轮文本。
      const priorTaskId = this.activeTaskOf.get(sessionId);
      if (priorTaskId !== undefined && priorTaskId !== input.taskId) {
        this.markCaptureDead(priorTaskId, "superseded");
      }
      this.captures.set(input.taskId, {
        taskId: input.taskId,
        sessionId,
        groups: [],
        turn,
        archived: this.archivedIds(input.contextId),
        continueTurn,
        openedAt: Date.now(),
        partialChars: 0,
        updateCount: 0,
        replayDropped: 0,
        archiveHit: false,
        dead: false,
        staleChunkCount: 0,
      });
      this.activeTaskOf.set(sessionId, input.taskId);
      promptResult = await this.requestWithTimeout("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: promptText }],
      });
    } catch (err) {
      // v0.8.10 · M-N3（B16′ 桥侧半边）：prompt **满窗** ⇒ 本轮已被桥放弃，但后端那一轮**仍在烧**。
      // launcher 不再 `stop` 桥（stop 连坐同项目其它在飞任务）⇒ 这一轮的取消只能由桥自己发。
      const promptTimedOut = err instanceof AcpError && err.kind === "timeout";
      // 计量与半截尾部快照须在 `discardCapture` **之前**取：失败后进程可能被杀 ⇒ 桥内存态必失效，
      // 尾部只能经 diagnostics 通道带回 launcher（M3 用它拼续跑 prompt）
      const win = this.captures.get(input.taskId);
      const produced = win === undefined ? "" : groupTexts(win).join("");
      const blockCount = countValidOutcomeBlocks(produced);
      const diag: BridgeDiag = {
        err,
        stage: "prompt",
        promptElapsedMs: win === undefined ? 0 : Math.max(0, Date.now() - win.openedAt),
        bridgeEnsureElapsedMs,
        chunkCount: win === undefined ? 0 : countChunks(win),
        partialChars: win === undefined ? 0 : win.partialChars,
        updateCount: win === undefined ? 0 : win.updateCount,
        firstChunkElapsedMs:
          win === undefined || win.firstChunkAt === undefined
            ? undefined
            : Math.max(0, win.firstChunkAt - win.openedAt),
        sessionResumed,
        sessionReused,
        partialTail:
          produced.length === 0 ? undefined : produced.slice(-DIAGNOSTICS_PARTIAL_TAIL_MAX_CHARS),
        turn,
        promptChars: promptText.length,
        injectedChars: injection.length,
        blockCount,
        replayDropped: win === undefined ? 0 : win.replayDropped,
        staleChunkCount: win === undefined ? 0 : win.staleChunkCount,
        continueTurn,
        ...this.ambiguityOf(win, blockCount),
        ...this.sessionMapStatsOnce(),
      };
      // 弃置半截缓冲：**照旧删窗**（不得为 dead/残段这类新特性留窗 —— 留窗就是重现「尾巴漏进下一轮」）。
      // 顺序：先自取消（`markCaptureDead` 要在窗还在时把已收活块 id 登记为残段），再删窗。
      if (promptTimedOut) {
        await this.cancel(input.taskId);
      }
      this.discardCapture(sessionId, input.taskId);
      // ①-b 守卫第 2 处：本轮**到达 prompt 段且后端确有推进**（任一 update / 任一产出）⇒ 约定已被
      // 消费 ⇒ 记为「曾发出过 prompt」，重派不再重复注入；「零输出」失败（未到达后端 / 疑似排队）
      // **不写** ⇒ 该类重派照旧注入（漏注入 = 后端不输出结论块被静默判 completed，比重复注入更坏）。
      if (firstTurn && win !== undefined && (win.updateCount > 0 || win.partialChars > 0)) {
        this.recordInjected(input.contextId);
      }
      return this.withDiag(
        promptTimedOut ? { ...this.failureResult(err), abandoned: true } : this.failureResult(err),
        diag,
      );
    }
    // prompted 置位时机 = 收到响应即置（含 end_turn / input-required / cancelled）；
    // v0.8.9 · M2：注入前计数（injectedAt）改在 prompt **写出侧**记账（见 {@link recordInjected} 守卫），
    // 成功出口这里补齐「收到过响应」这一半 ⇒ `prompted` 与 `injectedAt` 不再互相代替。
    // 顺序：先写 injectedAt（= 发出侧时刻，markPrompted 不得覆盖更早的值）。
    if (firstTurn) this.recordInjected(input.contextId);
    this.recordPrompted(input.contextId);

    const win = this.closeCapture(input.contextId, sessionId, input.taskId);
    this.bumpTurn(input.contextId);
    const text = win === null ? "" : groupTexts(win).join("");
    const blockCount = countValidOutcomeBlocks(text);
    const diag: BridgeDiag = {
      stage: "success",
      promptElapsedMs: win === null ? 0 : Math.max(0, Date.now() - win.openedAt),
      bridgeEnsureElapsedMs,
      chunkCount: win === null ? 0 : countChunks(win),
      partialChars: win === null ? 0 : win.partialChars,
      updateCount: win === null ? 0 : win.updateCount,
      firstChunkElapsedMs:
        win === null || win.firstChunkAt === undefined
          ? undefined
          : Math.max(0, win.firstChunkAt - win.openedAt),
      sessionResumed,
      sessionReused,
      turn,
      promptChars: promptText.length,
      injectedChars: injection.length,
      blockCount,
      replayDropped: win === null ? 0 : win.replayDropped,
      staleChunkCount: win === null ? 0 : win.staleChunkCount,
      continueTurn,
      ...this.ambiguityOf(win, blockCount),
      ...this.sessionMapStatsOnce(),
    };
    const stopReason =
      isRecord(promptResult) && typeof promptResult["stopReason"] === "string"
        ? promptResult["stopReason"]
        : "";
    if (stopReason === "cancelled" || stopReason === "canceled") {
      return this.withDiag({ state: "canceled", text }, diag);
    }

    const outcome = parseOutcome(text);
    if (outcome.state === "input-required") {
      return this.withDiag(
        {
          state: "input-required",
          text: outcome.text.length > 0 ? outcome.text : (outcome.question ?? ""),
          ...(outcome.question !== undefined ? { question: outcome.question } : {}),
        },
        diag,
      );
    }
    if (outcome.state === "failed") {
      return this.withDiag(
        {
          state: "failed",
          text: outcome.text.length > 0 ? outcome.text : (outcome.reason ?? "任务失败"),
          ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
        },
        diag,
      );
    }
    return this.withDiag({ state: "completed", text: outcome.text }, diag);
  }

  /**
   * 取消：尽力通知后端 `session/cancel`（B1 `TaskExecutor.cancel` 语义；notification 形态，不等响应）。
   * v0.8.10 · M-N2：先把该 task 的捕获窗判 **dead** —— 后端处理取消前还会吐 chunk，那些尾巴既不该进
   * 本轮结果，也不该把 `partialChars` 推过「有实质产出」门槛（否则一个已取消的任务能被误判成可续跑）。
   * v0.8.10 · M-N3：本方法有两个调用面 —— ① 台账收到 `tasks/cancel`（launcher 定向取消 / 收尾取消）；
   * ② **桥自己的 prompt 满窗出口**（该轮已放弃、后端仍在烧 ⇒ 立即自取消）。两者都只走控制通道。
   */
  async cancel(taskId: string): Promise<void> {
    const sessionId = this.taskSessions.get(taskId);
    if (sessionId === undefined) return;
    this.markCaptureDead(taskId, "cancelled");
    try {
      this.client.notify("session/cancel", { sessionId });
    } catch (err) {
      this.logger(`[acp-session] session/cancel 失败（忽略）：${messageOf(err)}`);
    }
  }

  private failureResult(err: unknown): TaskExecutionResult {
    if (err instanceof AcpError && err.kind === "timeout") {
      return { state: "failed", text: `任务超时（ACP session/prompt 超过 ${String(this.timeoutMs)}ms）` };
    }
    // v0.8.8 · M1 取证面：此前本出口连 `code` 都不拼（与 `reasonOf` 不同形）⇒ 后端带码错误
    // （配额 / 限流 / Invalid params + `data`）在结果文本里被压成一句话，事后无从取证
    return { state: "failed", text: reasonOf(err) };
  }

  /**
   * 出口挂诊断留痕（v0.8.7 · M4 → v0.8.8 · M1 扩键 → v0.8.9 · M2 全会话层键 + 成功轮也挂）：
   * 经现成 `artifacts` 通道追加一条 {@link DIAGNOSTICS_ARTIFACT_NAME}（text = JSON）⇒ 零类型 /
   * 零 wire 变更；launcher 侧按名摘除 + 解析（**诊断绝不进结果文本**，AC-S1）。
   * 值为 `undefined` 的键由 `JSON.stringify` 自然**省略** ⇒「没报」与「报了 0」在载荷上可区分
   * （成功出口无 `err` ⇒ `acpErrorKind` / `acpErrorCode` / `acpErrorData` 三键不报；
   * `partialTail` 仅失败路径报，AC-S2；`outcomeAmbiguous` 为 false 时不报）。
   *
   * ⚠ **`chunkCount` 只作留痕，绝不作自动重发判据**：它只计 `agent_message_chunk`、
   * `agent_thought_chunk` 被忽略 ⇒ 思考型后端（codex / claude 长思考）可「有推进而 chunkCount=0」，
   * 而一句「我先看一下」就让 chunkCount>0 —— **双向误判**。判「有推进」用 `updateCount`、
   * 判「有实质产出」用 `partialChars`（改造文档 §2.4 续跑判据）。
   */
  private withDiag(result: TaskExecutionResult, diag: BridgeDiag): TaskExecutionResult {
    const payload = JSON.stringify({
      acpErrorKind: diag.err === undefined ? undefined : errorKindOf(diag.err),
      stage: diag.stage,
      promptElapsedMs: diag.promptElapsedMs,
      bridgeEnsureElapsedMs: diag.bridgeEnsureElapsedMs,
      chunkCount: diag.chunkCount,
      partialChars: diag.partialChars,
      updateCount: diag.updateCount,
      firstChunkElapsedMs: diag.firstChunkElapsedMs,
      sessionResumed: diag.sessionResumed,
      acpErrorCode: diag.err === undefined ? undefined : errorCodeOf(diag.err),
      acpErrorData: diag.err === undefined ? undefined : errorDataOf(diag.err, DIAGNOSTICS_DATA_MAX_CHARS),
      partialTail: diag.partialTail,
      partialTailChars: diag.partialTail?.length,
      // ---- v0.8.9 · M2（§2.3 键表；白名单放行归 M4）----
      turn: diag.turn,
      sessionReused: diag.sessionReused,
      promptChars: diag.promptChars,
      injectedChars: diag.injectedChars,
      resultChars: diag.partialChars,
      blockCount: diag.blockCount,
      replayDropped: diag.replayDropped,
      // v0.8.10 · M-N2 哨兵：恒报（`0` = 「没有残段漏进本轮」的正向证据）；不参与任何判据
      staleChunkCount: diag.staleChunkCount,
      outcomeAmbiguous: diag.outcomeAmbiguous,
      ambiguousReason: diag.ambiguousReason,
      // 续跑轮**自报**（launcher 的跨轮防递归第二信号）；常规轮不报该键（缺省 = 0，不占账面）
      continueAttempts: diag.continueTurn === true ? 1 : undefined,
      sessionMapSize: diag.sessionMapSize,
      sessionMapOldestAgeDays: diag.sessionMapOldestAgeDays,
    });
    return {
      ...result,
      artifacts: [
        ...(result.artifacts ?? []),
        ...buildArtifacts([{ name: DIAGNOSTICS_ARTIFACT_NAME, text: payload }]),
      ],
    };
  }

  /**
   * outcome 不确定三判据（v0.8.9 · M2 · §2.4 第 4 项）：命中任一即置 `outcomeAmbiguous`，
   * 取值优先级 `multi-block` > `cross-turn-message-id` > `replay-leak`；续跑轮加 `continue-` 前缀。
   *
   * **只暴露、不动作**：本方法不参与 state 判定（state 仍由 `parseOutcome` 的主规则 + 回退规则产出），
   * 也不触发任何重派 / 重试（护 v0.8.8 场景 C 边界）。
   */
  private ambiguityOf(
    win: CaptureWindow | null | undefined,
    blockCount: number,
  ): Pick<BridgeDiag, "outcomeAmbiguous" | "ambiguousReason"> {
    if (win === null || win === undefined) return {};
    const hits: Array<keyof typeof AMBIGUOUS_BASE_REASON | null> = [
      blockCount >= 2 ? "multi-block" : null,
      win.archiveHit ? "cross-turn-message-id" : null,
      win.replayDropped > 0 && blockCount >= 1 ? "replay-leak" : null,
    ];
    const hit = hits.find((item): item is keyof typeof AMBIGUOUS_BASE_REASON => item !== null);
    if (hit === undefined) return {};
    const prefix = win.continueTurn ? "continue-" : "";
    return {
      outcomeAmbiguous: true,
      ambiguousReason: `${prefix}${AMBIGUOUS_BASE_REASON[hit]}` as OutcomeAmbiguousReason,
    };
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== "session/update" || !isRecord(params)) return;
    const sessionId = params["sessionId"];
    const update = params["update"];
    if (typeof sessionId !== "string" || !isRecord(update)) return;
    // 两级路由（v0.8.10 · M-N2）：通知只带 sessionId ⇒ 经「本 session 当前活跃 taskId」落到该 task 的窗。
    // 本轮任意 session/update 都算「有推进」（含 thought / tool_call / plan）—— 窗内才计
    const win = this.routeCapture(sessionId);
    if (win !== undefined) win.updateCount += 1;
    // P1 探针：仅 agent_message_chunk 计入回复（agent_thought_chunk 为思考，忽略）
    if (update["sessionUpdate"] !== "agent_message_chunk") return;
    const content = update["content"];
    if (!isRecord(content)) return;
    const text = content["text"];
    if (typeof text !== "string") return;
    const id = messageIdOf(update);
    if (win === undefined) {
      // 窗外 = load/resume 回灌 backlog，不入本轮缓冲；其 messageId 登记为重放 id（M9-c）
      if (id !== undefined) {
        let ids = this.replayMessageIds.get(sessionId);
        if (ids === undefined) {
          ids = new Set<string>();
          this.replayMessageIds.set(sessionId, ids);
        }
        ids.add(id);
      }
      return;
    }
    if (win.dead) {
      // dead 窗（v0.8.10 · M-N2）：本轮已取消 / 已放弃 ⇒ 其 chunk 一律丢弃并计数，
      // 并把该 id 登记为残段 —— 指针此后移交下一轮时，同 id 的尾巴照样进不了新窗。
      if (id !== undefined) this.rememberStaleMessageId(sessionId, id);
      win.staleChunkCount += 1;
      return;
    }
    if (this.isStaleMessageId(sessionId, id)) {
      // 残段漏进活窗（v0.8.10 · M-N2 的正面靶子）：该 id 属于本 session 某个已判死的轮次 ⇒ 丢弃并计数。
      // **不并入 replayDropped**：那是「历史重放」的分账，两者机制不同、口径不得混。
      win.staleChunkCount += 1;
      return;
    }
    if (id !== undefined && this.replayMessageIds.get(sessionId)?.has(id) === true) {
      // M9-c 轮边界：该 id 在捕获窗外已出现过 = 历史消息重放的尾部，排除出本轮文本
      win.replayDropped += 1;
      return;
    }
    if (id !== undefined && win.archived.has(id)) {
      // v0.8.9 · M2 跨轮归档：该 id 是**历轮活块**的 id ⇒ 判为重放（补 M9-c 的空洞：回灌尾部跨过
      // `load` 响应之后时，窗外登记根本没发生）。
      // **安全阀（R-Ⅱ）**：本轮尚无其它保留内容时**不丢** —— 后端若跨轮复用同一 messageId（或续跑
      // 轮接着写同一条消息），整轮丢空就是 v0.8.1 M9-b 犯过的错。此时只留 `archiveHit` 痕迹。
      win.archiveHit = true;
      if (win.partialChars > 0) {
        win.replayDropped += 1;
        return;
      }
    }
    if (win.firstChunkAt === undefined) win.firstChunkAt = Date.now();
    win.partialChars += text.length;
    // run-length 分组：与上一组同 id 则续写，否则新起一组（组序 = 到达序 ⇒ 串接逐字等价于旧 chunks）
    const last = win.groups[win.groups.length - 1];
    if (last !== undefined && last.messageId === id) last.chunks.push(text);
    else win.groups.push({ messageId: id, chunks: [text] });
  }

  /**
   * 收窗（成功路径）：**删窗** + 注销该窗持有的会话级簿记（活跃指针 / 重放 id 登记，见
   * {@link releaseCaptureLedger}）、留痕丢弃条数、**归档本轮活块 id**，并返回窗（供计量）。
   * 归档只收**保留下来**的 id（被丢的重放 id 不入档 ⇒ 一次污染不会永久传染后续轮次）。
   */
  private closeCapture(contextId: string, sessionId: string, taskId: string): CaptureWindow | null {
    const win = this.captures.get(taskId);
    this.captures.delete(taskId);
    this.releaseCaptureLedger(sessionId, taskId);
    if (win === undefined) return null;
    if (win.replayDropped > 0) {
      this.logger(
        `[acp-session] 本轮丢弃历史重放 chunk ${String(win.replayDropped)} 条（sessionId=${sessionId}）`,
      );
    }
    if (win.staleChunkCount > 0) {
      this.logger(
        `[acp-session] 本轮丢弃残段 chunk ${String(win.staleChunkCount)} 条（taskId=${taskId} sessionId=${sessionId}）：来自该会话已判 dead 的轮次`,
      );
    }
    this.archiveLiveIds(
      contextId,
      win.groups.flatMap((group) => (group.messageId === undefined ? [] : [group.messageId])),
    );
    return win;
  }

  /**
   * prompt 失败/超时路径：关窗并弃置半截缓冲，避免残窗把下轮 backlog 收进来。
   * **调用方必须在调用前取走尾部与计量**（v0.8.8 · M1「取出再弃」）—— 窗一关即失。
   * 失败轮**不归档**活块 id（轮次未完成，其 id 不作为次轮的重放判据）。
   * v0.8.10 · M-N2：删窗语义**不变** —— 判 dead 不是留窗的理由，失败轮一律即删（该 session 的活跃指针
   * 也随删注销 ⇒ 之后到达的尾巴落进「窗外」分支，照旧登记为 M9-c 重放 id）。
   * 失败轮**不登记残段 id**：续跑轮（场景 C）合法地接着写同一条消息，把它的 id 判残段会丢空整轮。
   */
  private discardCapture(sessionId: string, taskId: string): void {
    this.captures.delete(taskId);
    this.releaseCaptureLedger(sessionId, taskId);
  }

  /**
   * 会话保证：load → resume → new；**三条路径成功后**统一依次走一次 {@link applyModel} /
   * {@link applyMode} / {@link applyCollaborationMode}（恢复路径同样下发，不假设后端跨会话保持）。
   *
   * **回标 `sessionResumed`（v0.8.8 · M1）**：`load` / `resume` 任一真成功 ⇒ true；两级都失败回落
   * `session/new` ⇒ false = **续跑退化成重跑**（本机制最大隐性风险，日志 + 诊断双留痕）。
   */
  private async ensureSession(contextId: string): Promise<EstablishedSession> {
    const cached = this.sessions?.get(contextId) ?? null;
    let sessionId: string | null = null;
    let sessionResumed = false;
    if (cached !== null) {
      if (await this.tryReuse("session/load", cached)) {
        sessionId = cached;
        sessionResumed = true;
      } else if (await this.tryReuse("session/resume", cached)) {
        sessionId = cached;
        sessionResumed = true;
      }
    }
    if (sessionId === null) {
      if (cached !== null) {
        this.logger(
          `[acp-session] warn：load/resume 双失败 ⇒ 回落 session/new（contextId=${contextId} 旧 sessionId=${cached}）：续接退化为重跑`,
        );
        // v0.8.9 · M1：显式作废旧条目（含其 turn / lastMessageIds / injectedAt）——
        // `set` 已改合并式写入，不删会把死会话的状态并进新会话。删除 = 不再主动接回，
        // **不销毁后端会话文件、不调后端 session/delete**。
        this.sessions?.delete(contextId);
      }
      sessionId = await this.newSession();
      this.sessions?.set(contextId, sessionId);
    }
    this.logger(
      `[acp-session] 会话建立完成（contextId=${contextId} sessionId=${sessionId} sessionResumed=${String(sessionResumed)}）`,
    );
    await this.applyModel(sessionId);
    await this.applyMode(sessionId);
    await this.applyCollaborationMode(sessionId);
    return {
      sessionId,
      sessionResumed,
      // v0.8.9 · M2：`sessionReused` = 映射命中（与 `sessionResumed` 分开 —— 命中但双失败回落 new
      // 时二者相反）；无 `SessionMap` ⇒ 无「映射命中」这件事，键不报（不编造 false）
      ...(this.sessions === null ? {} : { sessionReused: cached !== null }),
    };
  }

  /**
   * 模型设置（v0.8.2 · M1 协议面增补）：`model` 缺省 ⇒ **零请求**（与旧版逐字一致）；
   * 否则发 `session/set_config_option {configId:"model", value:<原样>}`，**不校验**值合法性。
   * 失败（含后端 `-32602` 一类的取值错误）⇒ **fail-fast**：日志（含配置原值 + 原因）后抛错，
   * 由 `ensureSession` 冒泡使会话建立失败，任务以 `failed` 收场（不回退后端默认、不继续 prompt）。
   */
  private async applyModel(sessionId: string): Promise<void> {
    if (this.model === undefined) return;
    let result: unknown;
    try {
      result = await this.requestWithTimeout("session/set_config_option", {
        sessionId,
        configId: "model",
        value: this.model,
      });
    } catch (err) {
      const reason = reasonOf(err);
      this.logger(`[acp-session] model=${this.model} 设置失败（${reason}）`);
      throw new Error(`model=${this.model} 设置失败：${reason}`);
    }
    const current = configCurrentValue(result, "model");
    this.logger(
      `[acp-session] model=${this.model} 已设置（currentValue=${current === undefined ? "n/a" : String(current)}）`,
    );
  }

  /**
   * 模式设置（v0.8.5 · M1；与 {@link applyModel} 逐行同形）：`mode` 缺省 ⇒ **零请求**。
   * 下发**优先** `session/set_mode {sessionId, modeId}`；**仅当后端回 `-32601`**（方法不存在）
   * 才回落 `session/set_config_option {configId:"mode"}`；**其余错误一律 fail-fast**
   * （日志含配置原值 + 原因后抛错 ⇒ 会话建立失败、任务 `failed`，不静默回落）。
   * 成功日志回显方式同 {@link applyModel}（`configCurrentValue(result, "mode")`，取不到呈现 `n/a`）。
   */
  private async applyMode(sessionId: string): Promise<void> {
    const mode = this.mode;
    if (mode === undefined) return;
    let result: unknown = undefined;
    try {
      result = await this.requestWithTimeout("session/set_mode", { sessionId, modeId: mode });
    } catch (err) {
      if (!isMethodNotFound(err)) {
        const reason = reasonOf(err);
        this.logger(`[acp-session] mode=${mode} 设置失败（${reason}）`);
        throw new Error(`mode=${mode} 设置失败：${reason}`);
      }
      // 后端未实现 `session/set_mode`（JSON-RPC -32601）⇒ 回落到 config option 通道
      try {
        result = await this.requestWithTimeout("session/set_config_option", {
          sessionId,
          configId: "mode",
          value: mode,
        });
      } catch (fallbackErr) {
        const reason = reasonOf(fallbackErr);
        this.logger(`[acp-session] mode=${mode} 设置失败（${reason}）`);
        throw new Error(`mode=${mode} 设置失败：${reason}`);
      }
    }
    const current = configCurrentValue(result, "mode");
    this.logger(
      `[acp-session] mode=${mode} 已设置（currentValue=${current === undefined ? "n/a" : String(current)}）`,
    );
  }

  /**
   * 协作模式设置（v0.8.5 · M1；与 {@link applyModel} 逐行同形）：`collaborationMode` 缺省 ⇒ **零请求**。
   * `collaboration_mode` **不在 `modes` 集合内** ⇒ **只走**
   * `session/set_config_option {configId:"collaboration_mode"}`，无 `session/set_mode` 优先路径、也不回落；
   * 失败 ⇒ fail-fast（同 applyModel：日志 + 抛错）。
   */
  private async applyCollaborationMode(sessionId: string): Promise<void> {
    const value = this.collaborationMode;
    if (value === undefined) return;
    let result: unknown = undefined;
    try {
      result = await this.requestWithTimeout("session/set_config_option", {
        sessionId,
        configId: "collaboration_mode",
        value,
      });
    } catch (err) {
      const reason = reasonOf(err);
      this.logger(`[acp-session] collaboration_mode=${value} 设置失败（${reason}）`);
      throw new Error(`collaboration_mode=${value} 设置失败：${reason}`);
    }
    const current = configCurrentValue(result, "collaboration_mode");
    this.logger(
      `[acp-session] collaboration_mode=${value} 已设置（currentValue=${current === undefined ? "n/a" : String(current)}）`,
    );
  }

  private async tryReuse(method: string, sessionId: string): Promise<boolean> {
    const base =
      method === "session/load"
        ? { sessionId, cwd: this.cwd, mcpServers: [...this.mcpServers] }
        : { sessionId };
    // `--session-meta-json` **三路统一携带**（load / resume 亦带；否则经 load/resume 的会话拿不到 ⇒ full 档静默降级）
    const params = this.sessionMeta === undefined ? base : { ...base, _meta: this.sessionMeta };
    try {
      await this.requestWithTimeout(method, params);
      return true;
    } catch (err) {
      this.logger(`[acp-session] ${method} 失败（回退下一策略）：${messageOf(err)}`);
      return false;
    }
  }

  private async newSession(): Promise<string> {
    const result = await this.requestWithTimeout("session/new", {
      cwd: this.cwd,
      mcpServers: [...this.mcpServers],
      ...(this.sessionMeta !== undefined ? { _meta: this.sessionMeta } : {}),
    });
    if (!isRecord(result) || typeof result["sessionId"] !== "string" || result["sessionId"].length === 0) {
      throw new AcpError("protocol", "session/new 响应缺少 sessionId");
    }
    return result["sessionId"];
  }

  /** 带**自身**超时的请求（不依赖客户端实现，便于 fake 注入与超时单测）。 */
  private async requestWithTimeout(method: string, params: unknown): Promise<unknown> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new AcpError("timeout", `ACP 请求超时：${method}（${String(this.timeoutMs)}ms）`));
      }, this.timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.client.request(method, params, this.timeoutMs), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
