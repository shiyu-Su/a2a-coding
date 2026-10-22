/**
 * MCP Feature 工具组（v0.3.0 起 5 个；v0.8.10 O-N3 加只读 trace = 6 个）。
 *
 * 纯数据层处理器：只依赖 `session/store.ts`、`feature/state-machine.ts` 与 `./scheduler.js` 的
 * **纯函数**（`planResume` = 重派 / 解冻计划，无副作用、不触发调度），
 * 不触碰 A2A / 不触发调度（调度 kick 由 `bridge/index.ts` 在工具返回后统一发起）。
 *
 * - `handleFeatureCreate`  新建 Feature（**初态 `waiting_approval`** = 主链起点；登记字段**初值恒定**
 *                          —— `stage=需求分析` + `approval=未发起` 由引擎硬编码，**不再是入参**，
 *                          v0.10.5 O4；落 `contextId` 到 `features.context_id`）；
 *                          成功出参带**本阶段明细七枚**（增补 `6cc46dd2` N4 · {@link FeatureCreateSuccess}）
 * - `handleFeatureStatus`  查询单个 Feature 详情 / 全部列表（state + tasks 摘要 + artifacts；
 *                          v0.9.1 起单查增量扩 `acceptance` 聚合块 = 主链段轨迹 + 失败账单 + 节点态计数；
 *                          v0.10.1 O7 起单查扩 `projects`、列表扩 `attributionsByFeature` = 归属（承诺集）
 *                          只读面，两条面各走一条 SQL；
 *                          **增补 `6cc46dd2` N5**：单查带**本阶段明细七枚**（{@link FeatureStatusSingleSuccess}）、
 *                          **列表分支不带**（七枚在列表出参上恒缺）
 * - `handleFeatureAdvance` orch agent 驱动主链推进（状态机校验合法后继；`note`→plan、
 *                          `decisions`/`contracts` 可选落 Feature Context；`answer` 用于 needs_input 补齐）；
 *                          **`waiting_approval` 出格须 `approve`**（增补 `bbc7ea28` O1 守卫泛化）——
 *                          准入守卫**按行前提把关、不按 `to` 取值点名**：从该态出发凡改动 `state` 的
 *                          **前进边**一律拒为 `feature_approval_required`（唯一准入 = `handleFeatureApprove`），
 *                          **归档边**（`cancelled` / `failed`，非主链态）放行；位置在 `canTransition` **之后**
 *                          ⇒ 非法目标仍报 `feature_transition_invalid`（错误区分）；
 *                          **`retryTaskIds`**（§2.3）走**显式特例**：
 *                          跳过 `canTransition`（转移表零改动、无自环）、重派指定 `failed` 节点 +
 *                          解冻闭包**外**的 `blocked` 下游，**不改 Feature 态**；
 *                          **`projectVersions`**（v0.10.1 O3 / C-17）走**归属独立分支**：非空即写
 *                          承诺集（全量重发、同值幂等），`to` = 当前态时同样跳过 `canTransition`，
 *                          与合法流转同单时归属 + 迁移一起生效（归属拒 ⇒ 主链零迁移）；
 *                          **归属门双挂（v0.10.5 O4）**：`version_planning → decomposing` 与
 *                          `decomposing → executing` 两枚转移以「本需求归属非空」为出格凭据，
 *                          空 ⇒ {@link ERR_FEATURE_ATTRIBUTION_REQUIRED}、主链零迁移；
 *                          **门① 三前提（v0.10.5 O4 · 增补 `bbc7ea28` O3 · v0.11.0 O1）**：`stage` 由
 *                          「需求分析」外迁以「`version` 非空 ∧ 可见 `decisions` 已登记《需求确认单》路径
 *                          ∧ 「需求分析」至少一轮 `settled=true`」为前提，
 *                          缺哪报哪（{@link ERR_GROUP_VERSION_REQUIRED} / {@link ERR_CONFIRMATION_DOC_REQUIRED} /
 *                          {@link ERR_STAGE_ROUND_REQUIRED}）、整单拒绝零写入；第三前提**无豁免名单**
 * - `handleFeatureApprove` 审批门（**唯一准入**）：**目标态按父链分流**（v0.10.5 O4）——
 *                          无父卡（主轨）`waiting_approval → version_planning`；有父卡（增补 / 承接轨）
 *                          直接 `→ decomposing`（不重走 PjM 工序 ⇒ 跳过 `version_planning` 格）。
 *                          既有三条判据（非 `waiting_approval` 拒 / `approval` 须 `待审批` /
 *                          放行同轮 `notstart→active`）**零改动**；**增补 `ec93e1bd` 起在其后另加四条**
 *                          （③ `version` 非空 / ④ 确认单在册 / ⑤ `stage` 非「需求分析」/ ⑥ 改造文档在册；
 *                          序 ③→④→⑤→⑥，③④ 照抄门① 两前提，⑤⑥ 新码
 *                          {@link ERR_REQUIREMENT_GATE_NOT_PASSED} / {@link ERR_DESIGN_DOC_REQUIRED}）；
 *                          入参面**零改动**；
 *                          成功出参 = {@link FeatureApproveSuccess}（增补 `6cc46dd2` N4 · 基类型 ∧
 *                          明细七枚）—— 明细**只挂 `approve` 自己的出口形**、不宽化 `cancel` 共用的
 *                          {@link FeatureStateChangeSuccess}
 * - `handleFeatureCancel`  非收口态 → `cancelled`；**`failed` 亦可经此归档为 `cancelled`**
 *                          （v0.9.5 O1：仅迁 Feature 态、不动节点账面；`completed`/`cancelled` 拒）
 * - `handleFeatureTrace`   **只读**投影「这个 Feature 为什么还没完成」（在等谁 / 排队位次 / 占位档）；
 *                          **v0.8.10 O-N3 起挂成 MCP 工具 `a2a_feature_trace`**（Feature 工具组 5→6），
 *                          与工作台端点 `/api/features/:id/trace` 复用**同一实现**（两出口零第二套判据）
 *
 * 另含 **v0.10.1 O2 版本面第二级的执法面**（非 MCP 工具，接线归 O3 / O4）：
 * `checkFeatureAttributionWrites` / `applyFeatureAttributions`（归属写执法：未过门挡写、
 * released 门、不隐式建版、不变式继承、同值幂等 / 异值冲突）与
 * `evaluateProjectReleaseGate`（project 侧收口判据 = **展示字段**，不作门、不产拒绝码）。
 * **O3 已接线**（v0.10.1）：`handleFeatureAdvance` 的可选入参 `projectVersions[]` = **归属独立分支**
 * （`to` = 当前态时跳过 `canTransition`、照 `retryTaskIds` 先例；**不入 `hasRegistration`**）。
 *
 * 另含 **② 可见面只读投影**（v0.8.9 §2.3，非 MCP 工具）：`projectTaskVisibility` =
 * 「派发包裹体积 + 触达次数 + machine diagnostics 透传」的**唯一实现**，
 * 由 `summarizeTask`（`a2a_feature_status`）与 `handleTaskStatus`（`a2a_task_status`）共用。
 */
import { randomUUID } from "node:crypto";
import {
  appendEvent,
  aggregateFeaturesByVersion,
  confirmStageSynthesis,
  countQueuedBefore,
  createFeature,
  createTask,
  enqueueTask,
  ERR_PROJECT_VERSION_SHAPE,
  ERR_PROJECT_VERSION_UNKNOWN,
  EVENT_FEATURE_STATE,
  featureProjectListByFeature,
  featureProjectListByFeatures,
  featureProjectListByVersion,
  featureProjectStateCounts,
  featureProjectUpsert,
  featureTaskStateCounts,
  getEventByIdempotencyKey,
  getDefaultStore,
  getFeature,
  getQueuedTask,
  isUniqueConstraintError,
  listArtifactsByFeature,
  listBusyTasksForProject,
  listEvents,
  listFeatureTasks,
  listFeatures,
  listReadLaneTasksForProject,
  listRunnerProjects,
  listRunners,
  listStageRoundRows,
  listStageRows,
  listStageSynthesisRows,
  projectVersionGet,
  rearmForRetry,
  rearmTask,
  updateFeatureContext,
  updateFeatureRegistration,
  updateFeatureState,
  updateTaskState,
  versionLedgerHas,
  versionLedgerStatus,
} from "../session/store.js";
import { EVENT_FAILURE_REPORT, isDagNode, planResume } from "./scheduler.js";
import { resolveStageRoundBasisRev } from "./stage-seal.js";
import {
  buildStageRowMessage,
  buildStageRunCell,
  computeBasisRev,
  EVENT_STAGE_DOC_OBJECTION,
  EVENT_STAGE_GATE1_CONFIRM,
  EVENT_STAGE_ROUND_OPEN,
  groupStageRoundRows,
  maxStageRound,
  parseStageRoundOpenPayload,
  parseStageSynthesisDocVersion,
  projectStageReachability,
  stageDocObjectionKey,
  stageGate1ConfirmKey,
  stageObjectionIdOf,
  stageRoundKey,
  stageRoundOpenKey,
  stageRoundOpenPayload,
  STAGE_OBJECTION_TARGETS,
  STAGE_ROUND_TASK_KEY,
  toStageSynthesisCell,
  type StageObjectionTarget,
  type StageRunCellView,
  type StageRoundOpenPayload,
} from "./stage-round.js";
import { synthesisDocVersion } from "./synthesis.js";
import { activateVersionForFeature, versionActivator } from "./versions-activation.js";
import type {
  FeatureContextPatch,
  FeatureProjectRecord,
  FeatureRegistrationPatch,
  QueueState,
  QueuedTaskRecord,
} from "../session/store.js";
import type { TaskLane, TaskMode, TaskType } from "../types.js";
import {
  allowedTransitions,
  canTransition,
  FEATURE_MAIN_CHAIN,
  isFeatureState,
  isTerminalFeatureState,
} from "../feature/state-machine.js";
import type {
  ArtifactRecord,
  EventRecord,
  FailureKind,
  FeatureApproval,
  FeatureRecord,
  FeatureStage,
  FeatureState,
  InputArtifactRef,
  TaskRecord,
  TaskState,
} from "../types.js";
import {
  FEATURE_APPROVALS,
  FEATURE_STAGES,
  isFeatureApproval,
  isFeatureStage,
} from "../types.js";

/**
 * **create 硬编码初值**（v0.10.5 O4 / §3.5「初值恒定」条）：`a2a_feature_create` 不再收
 * `stage` / `approval` 两枚入参，初值由引擎固定写入 —— 一切需求卡从「需求分析 + 未发起」起步。
 *
 * 与 {@link DEFAULT_FEATURE_STAGE} / {@link DEFAULT_FEATURE_APPROVAL} **刻意分常量**：后两者是
 * 「未传 ⇒ 缺省」旧语义的落点，现只剩**读侧归一 + ctor 脏值归一**一职（存量 NULL 行仍读回
 * 「改造方案 / 待审批」）；初值若与归一值同值耦合，将来动读侧归一会静默改掉 create 契约。
 */
const CREATE_INITIAL_STAGE: FeatureStage = "需求分析";
const CREATE_INITIAL_APPROVAL: FeatureApproval = "未发起";

/**
 * **节点重派**事件 kind（v0.6.1 REQ-05 §2.3 / N4）。
 *
 * 触发点 = `handleFeatureAdvance(retryTaskIds)` 对每个成功重排的失败节点（`rearmForRetry` CAS 命中）。
 * 语义：
 * - **不是** `feature.failure_report` —— 那条由静止收敛在 **Feature 级**发一次（见 `scheduler.ts`），
 *   本 kind 是**节点级**「已重派」痕迹（`NOT failure_report`，宿主已定案）；
 * - `state` 列写重派后的**实际**节点态（`working`）——与 `task.settled` / `task.blocked` 同一列语义
 *   （「实际流转/落库后的态」）；
 * - 兼作**失败静止去重 signature 的重新武装**标记：重派改变 failed/blocked 集合 ⇒ 下一次静止
 *   自然发新账单；本事件让「为何重新武装」在 `a2a_events` 面可观测；
 * - `events` 表**零 schema 变更**（kind 是既有自由文本列）；事件接口面不变（仍 `a2a_events(since)`）。
 */
export const EVENT_TASK_REARMED = "task.rearmed";

/** Feature 工具失败外壳（桥转为 `errorResult`） */
export interface FeatureToolFailure {
  ok: false;
  code: string;
  error: string;
}

/** tasks 摘要（status 出参） */
export interface FeatureTaskSummary {
  taskId: string;
  projectId: string;
  state: TaskRecord["state"];
  /**
   * **并发档**（v0.8.10 O-N3 additive；来源 `tasks.lane`，见 {@link TaskLane}）：
   * `write` = 参与同 project 串行门（缺省档），`read` = 只读档（**退出写忙集** ⇒ 不挡写、不被写挡）。
   *
   * 读账口径：`read` 且**迟迟不开工**时，**先看 trace 的 `readOccupants`**（machine 侧同 project
   * 读并发闸 `maxConcurrentReads` 缺省 1）而非 `projectBusy` —— 后者按设计只反映**写门**。
   * 存量行 / 未带档登记 = `write`（NULL 已在读侧归一，**不存在第三个值**）。
   */
  lane: TaskLane;
  /**
   * **职责位**（v0.10.2 O-3 additive；来源 `tasks.task_type`，取值见 {@link TASK_TYPES}）：
   * 与 `lane` 同一条声明链，**读侧不存在 NULL** —— 列里的 NULL 已在读侧归一为缺省档
   * `unit_agent`（= 本列引入前的唯一行为），故本字段**恒有值、不得省略**。
   *
   * 读账口径：非 `unit_agent` ⇒ 该节点以其它职责位（产品经理 / 项目经理 / 研发经理）出场，
   * machine 侧按本机 `agentConfig.roles` 路由该次会话的四个旋钮。
   */
  taskType: TaskType;
  /**
   * **执行通道**（v0.10.8 O-5 additive；来源 `tasks.mode`，取值见 {@link TaskMode}）：
   * 与 `lane`/`taskType` 同一条声明链，**读侧不存在 NULL** —— 列里的 NULL 已在读侧归一为缺省档
   * `dag`（= 本列引入前的唯一行为，归一只在 store 读侧一处），故本字段**恒有值、不得省略**。
   */
  mode: TaskMode;
  /**
   * **派发当刻阶段快照**（v0.10.8 O-9 additive；来源 `tasks.stage`，值域 {@link FeatureStage}）：
   * 值 = 该 task 派发当刻其 Feature 登记字段 `stage` 的快照。
   *
   * ⚠️ 与 `mode` **相反**：本列**无默认档**、读侧 NULL **照实读出 `null`**（不归一、不兜底 ——
   * 兜底成任何一档 = 给存量行凭空赋阶段语义），故本字段**可 null**（展示侧 `null` 显 `—`）。
   */
  stage: FeatureStage | null;
  /** 阶段成员行的命名键（仅 `mode=stage` 时下发，普通 DAG / inquiry 行保持既有形状）。 */
  taskKey?: string | null;
  /** 阶段成员行的轮次（仅 `mode=stage` 时下发）。 */
  round?: number | null;
  prompt: string | null;
  remoteTaskId: string | null;
  dependencies: string[] | null;
  /** 下游声明的上游产物引用（v0.4.0；NULL = 无输入产物） */
  inputArtifacts: InputArtifactRef[] | null;
  updatedAt: string;
  /**
   * 失败分类（v0.4.1 §4.1.13 可观测；`null` = 未失败 / 未分类）。
   * **只增字段**，既有字段语义不变。
   *
   * ✅ v0.8.7 起本字段已有**真实值**（不再是 v0.6.1「删五层」后的语义休眠恒 `null`）：
   * 写口 = `upsertTaskResult`（v0.11.0 O4 结算前分类：与终态**同一条 UPDATE** 落，仅本次
   * `failed` 胜出时携带）与 `failOrphanedTask`（孤儿补结算落
   * `runner`）；v0.8.8 起任务失败在账面携带闭集 `failureKind`（v0.11.0 O1 起七类，事实源 =
   * `PROTOCOL.md`），
   * 可据此判断失败类型（网页工作台已渲染该列，O6）。
   */
  failureKind: FailureKind | null;
  /**
   * 重派记账次数（v0.4.1 的「条件重试已用次数」；**v0.6.1 REQ-05 起门禁语义删除、降级为记账**）。
   *
   * ⚠️ 条件重试 / re-arm 调用点已删除；本列唯一写口 = `rearmForRetry`（保留给「重派」复用）——
   * `a2a_feature_advance(retryTaskIds)` 每成功重派一次 **+1** ⇒ 本字段**不再恒 `0`**。
   * **不得**据此判断「重试是否用尽（N=1 门槛已随条件重试删除）」或「是否已重试过」。
   */
  retryCount: number;
  /** ② 体积 / 触达 / machine 事实只读投影（v0.8.9 O3；见 {@link projectTaskVisibility}） */
  baseChars: number;
  renderedChars: number;
  wrappedChars: number;
  attempts: number;
  diagnostics: TaskDiagnosticsView;
}

/**
 * ② 可见面里**从 machine 透传**的那一半（改造文档 §2.3 键表；**逐键原样、不合并、不改写**）。
 *
 * **缺键 = machine 没报**，与本视图「报了 0」**严格可区分**（⇒ 本接口全部字段可选，
 * 未命中类型的键**省略**，不得补 `0` / `false` —— 补值就是把「未知」谎报成「没有」，
 * 同 `store.ts` 的 `continuedEventPayload` 口径）。
 *
 * `turn` 是**轮次唯一主口径**且**只从 diagnostics 取**：orch **不得**用「同 `contextId`
 * 任务条数」反推（首轮超时未置 `prompted` ⇒ 计数会 +1，§1 表第 6 条已实测否证）。
 */
export interface TaskDiagnosticsView {
  /** 该 `contextId` 的第几轮（桥内单调；**透传**，orch 不计算） */
  turn?: number;
  /** 会话映射命中（与 `sessionResumed` **不等价**） */
  sessionReused?: boolean;
  /** `load|resume` 真成功 */
  sessionResumed?: boolean;
  /** 本轮实际写出 `session/prompt` 的字符数 */
  promptChars?: number;
  /** 其中注入部分（首轮 > 0、次轮应恒 0 —— ①-b 的机器可判定证据） */
  injectedChars?: number;
  /** 本轮累积字符（成功轮也报） */
  resultChars?: number;
  /** 失败轮的已捕获字符量。与 `resultChars` **各自原样保留**：择一只发生在呈现层 */
  partialChars?: number;
  /** 本轮结构有效 outcome 块数 */
  blockCount?: number;
  /** 末块位置 */
  lastBlockIndex?: number;
  /** 被过滤掉的历史重放 chunk 条数 */
  replayDropped?: number;
  /** outcome 不确定标志（machine 侧 false 时不报该键） */
  outcomeAmbiguous?: boolean;
  /** 不确定原因（闭集：`multi-block` / `replay-leak` / `cross-turn-message-id`，续跑轮带 `continue-` 前缀） */
  ambiguousReason?: string;
  /** **machine 自报**的续跑轮数 —— `attempts` 的加数之一，随投影带出使 `attempts` 可核算 */
  continueAttempts?: number;
  /** 桥内会话映射规模（该桥首个任务时搭车带出，v0.8.9 · ④ 可见面） */
  sessionMapSize?: number;
  /** 会话映射最老条目年龄（天）；**空映射时 machine 不报该键** ⇒ 缺键 ≠ 0 */
  sessionMapOldestAgeDays?: number;
  /**
   * **停轮归因：谁杀的**（v0.8.10 · M-N4 五键之一，闭集 `idle-reap` / `continue` / `resend` /
   * `stop-command`）；machine 未报 ⇒ 本键省略。
   */
  stopCause?: string;
  /** **肇事任务 id**（触发 stop 的归属者，**不是被停者清单**，口径 U8） */
  stopCauseTaskId?: string;
  /** 派发收尾的**幽灵轮取消**（B16′）是否生效的账面证据；machine 判不出时不报 ⇒ 缺键 ≠ false */
  ghostRoundCancelled?: boolean;
  /** 取消 → 静默的耗时（ms，真机判据 R1）；**未走取消路径时 machine 不报** ⇒ 缺键 ≠ 0 */
  cancelQuiesceMs?: number;
  /** 后端不认 `session/cancel`（与 machine `/health` 同键名）；缺键 = machine 没报，**不等于「支持」** */
  cancelUnsupported?: boolean;
}

/** {@link projectTaskVisibility} 的输入：只读投影所需的四个列（其余字段不消费） */
export type TaskVisibilitySource = Pick<
  TaskRecord,
  "dispatchMessage" | "dispatchRendered" | "retryCount" | "diagnosticsJson"
>;

/**
 * ② 的 **orch 侧只读投影**（改造文档 §2.3「orch 侧（投影，只增出参字段、零写口）」）。
 *
 * 两个出口共用本函数（`summarizeTask` = `a2a_feature_status` 的 tasks 行 /
 * `handleTaskStatus` = `a2a_task_status`），**投影口径只有一处实现**。
 *
 * - `baseChars` = `dispatch_message`（未渲染 base）字符数；**NULL ⇒ 0**（独立单任务无 base 可测）；
 * - `renderedChars` = `dispatch_rendered`（本轮实际下发快照）字符数；
 *   **NULL ⇒ 回退显示 `baseChars`**（领取侧 `?? dispatch_message` 兜底 ⇒ 下发的就是 base）；
 * - `wrappedChars` = `renderedChars − baseChars` = 本次派发加出去的外壳体积
 *   （**①-a「去重可证」指标**：修复后应恒等于一层壳、**不随派发次数增长**）；
 * - `attempts` = `retry_count`（宿主重派）+ `diagnostics.continueAttempts`（machine 续跑）
 *   = 本节点被**触达**的总次数。**刻意不叫 `turn`**：`turn` 是 machine 的 ACP 轮次事实，
 *   二者口径不同、并存异名（§1 表第 6 条 / §3.3 防撞名）。
 *
 * 计长口径 = `String#length`（UTF-16 code unit），与 machine 侧 `promptChars` 等体积键一致。
 */
export function projectTaskVisibility(rec: TaskVisibilitySource): {
  baseChars: number;
  renderedChars: number;
  wrappedChars: number;
  attempts: number;
  diagnostics: TaskDiagnosticsView;
} {
  const baseChars = rec.dispatchMessage?.length ?? 0;
  const renderedChars = rec.dispatchRendered?.length ?? baseChars;
  const diagnostics = projectDiagnostics(rec.diagnosticsJson ?? null);
  return {
    baseChars,
    renderedChars,
    wrappedChars: renderedChars - baseChars,
    attempts: (rec.retryCount ?? 0) + (diagnostics.continueAttempts ?? 0),
    diagnostics,
  };
}

/**
 * `diagnostics` 透传白名单（**machine 侧键表的镜像**，两侧必须同步）。
 *
 * ★ v0.8.10 O-N3（REQ-v0.8.10-2026-09-23-01 §2.4 / A9）：machine 新增的**归因五键**
 * （`stopCause` / `stopCauseTaskId` / `ghostRoundCancelled` / `cancelQuiesceMs` / `cancelUnsupported`）
 * **必须在此列出** —— 本视图是**显式白名单**，未列入的键**从 MCP 出参里消失**而 **DB 原文仍在**，
 * 是「库里查得到、宿主看不到」最难查的一类落差（v0.8.9 踩过同一个坑）。
 * 新增键的同时**必须同步** {@link TaskDiagnosticsView} 的字段声明（否则 TS 侧读不到）。
 */
const DIAG_NUMBER_KEYS = [
  "turn",
  "promptChars",
  "injectedChars",
  "resultChars",
  "partialChars",
  "blockCount",
  "lastBlockIndex",
  "replayDropped",
  "continueAttempts",
  "sessionMapSize",
  "sessionMapOldestAgeDays",
  "cancelQuiesceMs",
] as const;

const DIAG_STRING_KEYS = ["ambiguousReason", "stopCause", "stopCauseTaskId"] as const;
const DIAG_BOOLEAN_KEYS = [
  "sessionReused",
  "sessionResumed",
  "outcomeAmbiguous",
  "ghostRoundCancelled",
  "cancelUnsupported",
] as const;

/** `diagnostics_json` 原文 → ② 透传视图（NULL / 非法 JSON / 非对象 ⇒ 空视图，不报错） */
function projectDiagnostics(diagnosticsJson: string | null): TaskDiagnosticsView {
  const view: TaskDiagnosticsView = {};
  const obj = parseDiagnosticsObject(diagnosticsJson);
  if (obj === null) return view;
  // 宽容读取：类型不符（脏值）等同「没报」⇒ 省略该键（同 `store.ts` 的 `diag*` 三件套）
  for (const key of DIAG_NUMBER_KEYS) {
    const v = obj[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) view[key] = v;
  }
  for (const key of DIAG_STRING_KEYS) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) view[key] = v;
  }
  for (const key of DIAG_BOOLEAN_KEYS) {
    const v = obj[key];
    if (typeof v === "boolean") view[key] = v;
  }
  return view;
}

/** 落库宽 JSON 的读侧解析（只读；非法形状 ⇒ `null`） */
function parseDiagnosticsObject(diagnosticsJson: string | null): Record<string, unknown> | null {
  if (diagnosticsJson === null) return null;
  try {
    const parsed: unknown = JSON.parse(diagnosticsJson);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function summarizeTask(rec: TaskRecord): FeatureTaskSummary {
  return {
    taskId: rec.taskId,
    projectId: rec.projectId,
    state: rec.state,
    // 并发档恒有值（读侧 NULL 已归一 write）：**不得省略字段**
    lane: rec.lane,
    // 职责位恒有值（读侧 NULL 已归一 unit_agent）：**不得省略字段**（v0.10.2 O-3）
    taskType: rec.taskType,
    // 执行通道恒有值（读侧 NULL 已归一 dag）：**不得省略字段**（v0.10.8 O-5）
    mode: rec.mode,
    // 派发当刻阶段快照：读侧 NULL 照实为 null，**不归一 / 不兜底**（v0.10.8 O-9）
    stage: rec.stage,
    // 阶段任务需可定位到具体一轮；非阶段行不追加两键，既有摘要逐字兼容。
    ...(rec.mode === "stage" ? { taskKey: rec.taskKey, round: rec.round } : {}),
    prompt: rec.prompt,
    remoteTaskId: rec.remoteTaskId,
    dependencies: rec.dependencies,
    inputArtifacts: rec.inputArtifacts,
    updatedAt: rec.updatedAt,
    // 缺失 / 未设时给 `null` / `0`：**不得省略字段、不得 `undefined`**（老记录 / 部分对象也要有确定值）
    failureKind: rec.failureKind ?? null,
    retryCount: rec.retryCount ?? 0,
    // ② 只读投影（v0.8.9 O3）：派生 4 键恒有值，`diagnostics` 内 machine 键**没报即省略**
    ...projectTaskVisibility(rec),
  };
}

/**
 * **门① version 守卫拒绝码**（v0.10.5 O4 / 引擎映射 §3 门表）。码值即契约：MCP 面与 HTTP 信封
 * `error.code` 共用；`feature_*` 前缀照登记字段族既有码（`feature_invalid_stage` 等同族）。
 */
export const ERR_GROUP_VERSION_REQUIRED = "feature_group_version_required";

/**
 * **归属门（转移守卫）拒绝码**（v0.10.5 O4 / 改造文档 §2.6 + §5.3 裁定 3）。
 *
 * 独立成码、**不复用** `orch_project_attribution_state_locked`：后者语义是「该态**不允许写**归属」
 * （写入口的锁），本码语义是「**缺归属而不许离开**该态」（出口的门），方向相反，复用会误导读面。
 * 故本码属 **MCP Feature 工具面**（`feature_*` 前缀，与 `feature_approval_required` /
 * `feature_group_version_required` 同族），**不属版本面写口码族**（`orch_*`）。
 */
export const ERR_FEATURE_ATTRIBUTION_REQUIRED = "feature_attribution_required";

/**
 * **门① 第二前提（《需求确认单》已登记）拒绝码**（增补 `bbc7ea28` O3 / 引擎映射 §3 门表 案 (a)）。
 * 与 {@link ERR_GROUP_VERSION_REQUIRED} 同族、**独立成码** —— 门① 的两前提「缺哪报哪」，
 * 不合并成一个错误（version 缺失与确认单未登记是两笔不同的善后动作）。
 */
export const ERR_CONFIRMATION_DOC_REQUIRED = "feature_confirmation_doc_required";

/**
 * **门① 第三前提（「需求分析」至少收口一轮）拒绝码**（v0.11.0 O1 / 用户裁定 2026-10-20
 * 「未来一律通过板操作、**板也不允许跳步**」/ 改造文档 §3 门表）。
 * 与前两枚同族、**独立成码**（缺哪报哪，不合并）—— 三笔善后是三件不同的事：排期 /
 * 登记《需求确认单》/ **开一轮并等回执收齐**。语义 = 「本需求在 `需求分析` 阶段**不存在任何
 * 一轮 `settled=true`**」⇒ 抬 `stage` 即拒（判据单点 {@link gate1SettledRound}，**无豁免名单**：
 * 补丁卡同样要开轮，历史已跳步的卡只登记不回填）。
 */
export const ERR_STAGE_ROUND_REQUIRED = "feature_stage_round_required";

/**
 * **门②（改造文档确认）条件 ⑤ 拒绝码**（增补 `ec93e1bd` / 引擎映射 §3 门②行「过门判据 = 六条」）。
 * 语义 = 「该卡**没过门①**，却想直接过门②」。判据 = `stage` 仍「需求分析」，与
 * {@link derivePendingItems} 的 `"stage"` 欠项**同判据单源** ⇒ 观测面与执法面共用一件事，不造第二套。
 * 与 {@link ERR_GROUP_VERSION_REQUIRED} / {@link ERR_CONFIRMATION_DOC_REQUIRED} 同族、**独立成码**
 * （六条「缺哪报哪」，各档的善后动作是四件不同的事，合并会让读账方分不清该补哪一笔）；
 * **码名刻意避开**改造文档 §C.2 点名的那枚被根回归反锚禁用的字面。
 */
export const ERR_REQUIREMENT_GATE_NOT_PASSED = "feature_requirement_gate_not_passed";

/**
 * **门②（改造文档确认）条件 ⑥ 拒绝码**（增补 `ec93e1bd` / 引擎映射 §3 门②行「过门判据 = 六条」）。
 * 语义 = 「门② 自己的产出物《改造文档》未登记在册」。判据用同一 {@link docRegistered} +
 * {@link DESIGN_DOC_MARKER}（**无第二套判据**）；与 ④ 的 {@link ERR_CONFIRMATION_DOC_REQUIRED}
 * **各自独立成码**（照门① 两前提先例），两枚档名**须同时在册**。
 */
export const ERR_DESIGN_DOC_REQUIRED = "feature_design_doc_required";

/**
 * 《需求确认单》档名在 `decisions` 串里的查找子串（增补 `bbc7ea28` O3）。
 * 取命名规范 `{topic}-需求确认单.md`（`需求流程.md` §4）的**固定尾段** —— 严格式令裸文件名
 * `需求确认单.md`（§4 明令禁止的无 topic 前缀形态）不构成命中。
 */
const CONFIRMATION_DOC_MARKER = "-需求确认单.md";

/**
 * 《改造文档》档名在 `decisions` 串里的查找子串（增补 `6cc46dd2` N1）。
 * 与 {@link CONFIRMATION_DOC_MARKER} 同族同式：取命名规范 `{topic}-改造文档.md`（`需求流程.md` §4）
 * 的**固定尾段**，**前导连字符不可省** —— 省了裸文件名 `改造文档.md` 也构成命中。
 */
export const DESIGN_DOC_MARKER = "-改造文档.md";

/**
 * `decisions` 里是否登记了某类文档 = **已落库 Feature Context ∪ 本单同写**（增补 `bbc7ea28` O3，
 * 原 `confirmationDocRegistered`；增补 `6cc46dd2` N1 泛化为按 `marker` 查找）。
 * 并集**不可省**：宿主在**同一单**里「先登记文档路径、再抬 `stage`」是既有合法用法
 * （登记写 = `to` = 当前态特例，先于本守卫的落笔发生在同一调用内），只看已落库值会打死该用法。
 */
export function docRegistered(
  persisted: string | null,
  pending: string | undefined,
  marker: string,
): boolean {
  return (persisted ?? "").includes(marker) || (pending ?? "").includes(marker);
}

/**
 * 门①「《需求确认单》在册」的**命中档**（v0.11.0 orch-N7 / 宿主裁决 A10）。
 * 仅用于错误信息与排查 —— 对外错误码语义**不因它分叉**。
 */
export type Gate1DocTier = "file" | "synthesis";

/**
 * **门①「确认单在册」双档判据单点**（v0.11.0 orch-N7 / 宿主裁决 A10）：
 * `docRegistered(decisions 含确认单档名) ∨ 本轮合成行在册且 sections 非空`。
 * - **旧档 `file` 必须保留** —— 存量 Feature 的 `decisions` 只有文件路径，删档即打死存量；
 * - **新档 `synthesis`** = 引擎内综合分析那一档：本轮 = {@link maxStageRound} 指「需求分析」
 *   （与开轮取轮同一条判据），合成行正文经读面解析单点 {@link toStageSynthesisCell} 严格解析
 *   ⇒ 脏正文 / 缺节只落 `sections: []`（不命中），不许出现第二套「算 sections」的解析。
 * 三处引用**同源**（advance 门① 守卫 / approve 门② 条件 ④ / derivePendingItems 确认单欠项）
 * ⇒ 文件名子串判断在本文件**只允许出现在本函数内**。
 */
export function gate1DocPresent(
  feature: Pick<FeatureRecord, "featureId" | "decisions">,
  pendingDecisions?: string,
): Gate1DocTier | null {
  if (docRegistered(feature.decisions, pendingDecisions, CONFIRMATION_DOC_MARKER)) return "file";
  const round = maxStageRound(listStageRows(feature.featureId), "需求分析");
  if (round === 0) return null;
  const row = listStageSynthesisRows(feature.featureId).find(
    (r) => r.stage === "需求分析" && r.round === round,
  );
  if (row === undefined) return null;
  return toStageSynthesisCell({ row, rounds: 0 }).sections.length > 0 ? "synthesis" : null;
}

// ---------------------------------------------------------------------------
// 归属校验（v0.8.6 §2.3 / REQ-v0.8.6-2026-09-21-01 · N4）
// ---------------------------------------------------------------------------

/**
 * Feature **六出口归属校验**（§2.3 / §1.3 R-3 / G2）：`identity` = 本次连接身份（组名）。
 *
 * - `identity === null`（无身份）⇒ **全量放行**，不校验归属 —— 未配组环境的匿名入口与
 *   web 运维视图（§2.7「3300 非身份面」）皆走此路，零破坏；
 * - `identity` 非空 ⇒ **Feature 谁建谁见**（§6.1-5）：
 *   - `owner_group === identity` ⇒ 放行；
 *   - `owner_group === null` ⇒ 拒绝，文案 A（**无归属 / 非本组可见对象**，配组环境
 *     fail-closed，不猜默认组，§1.3 R-3 / G2）；
 *   - `owner_group === 其它组名` ⇒ 拒绝，文案 B（**属另一项目组**，跨组操作归 v0.11.0）。
 *
 * 两类拒绝**错误码与文案不同**（供测试分别断言，§6.1-3 的 Feature 面对偶）；**不泄漏**他组组名
 * （只说「属另一项目组」，§6.1-9）。**注**：组不是鉴权边界（§2.7），此处仅是视野隔离，非安全机制。
 *
 * **v0.8.6 req01 补正 R-1 起本函数导出**：`bridge/index.ts` 的 `registerFeatureNode` 挂载前置
 * 复用**同一判据**（禁止第二套判据）—— 他组连接不得把本组项目挂进他组 Feature DAG。
 */
export function ownershipFailure(
  feature: FeatureRecord,
  identity: string | null,
): FeatureToolFailure | null {
  if (identity === null) return null;
  if (feature.ownerGroup === identity) return null;
  if (feature.ownerGroup === null) {
    return {
      ok: false,
      code: "feature_unowned",
      error:
        `Feature ${feature.featureId} 无归属（owner_group 为空），不是本组「${identity}」的可见对象：` +
        `已配组环境下，未配组时创建或配组改造前的存量 Feature 一律不可见（fail-closed，不猜默认组）。` +
        `如需纳入本组，请用迁移脚本显式改归属（scripts/migrate-feature-owner.mjs）。`,
    };
  }
  return {
    ok: false,
    code: "feature_not_owned",
    error:
      `Feature ${feature.featureId} 属另一项目组，不是本组「${identity}」的可见对象：` +
      `Feature 谁建谁见（跨组操作本版不支持，归 v0.11.0）。`,
  };
}

// ---------------------------------------------------------------------------
// 登记字段（v0.9.0 B1″ / B2″）：闭集校验 + 写口收敛
// ---------------------------------------------------------------------------

/**
 * 入参里可能携带登记字段的动作（v0.10.5 O4 起只剩 `advance` —— create 摘 `stage`/`approval`
 * 两入参、`version` 走 {@link parseVersionInput}；本接口仍与 `FeatureAdvanceArgs` 共用同一校验）
 */
interface RegistrationInput {
  stage?: string;
  version?: string;
  approval?: string;
}

/**
 * 登记字段的**唯一闭集校验**（schema 侧只用 `z.string()`，不用 `.enum()` ⇒ 校验落这里）。
 *
 * - 只回传**已提供**的字段（undefined = 本次不写该列，交 `updateFeatureRegistration` 保留原值）；
 * - 非法值 ⇒ 结构化拒绝（`feature_invalid_stage` / `feature_invalid_approval`），**零写入**；
 * - **不校验序、不校验回退**（B5″：`stage` 序校验 / 回退限制都不做）。
 *
 * **v0.10.5 O4 契约注**：调用方只剩 `handleFeatureAdvance`（create 已摘 `stage`/`approval` 两入参、
 * 改走 {@link parseVersionInput}）⇒ `feature_invalid_stage` / `feature_invalid_approval` 两码在
 * **create 侧不可达**、advance 侧照常可达。**本函数本体不动**（这两码不是死码 —— 闭集校验是
 * 唯一判据，收 advance 与未来第二驱动口共用；「不可达」只是当前接线的事实，不得删代码）。
 *
 * **v0.10.0 O5 · `version` 写口格式校验（改造文档 §2.1(4)）**：
 * - **不校验** `undefined`（未提供 = 不写，保留原值）；
 * - **不校验** 空串（= 撤排期回「未登记」桶、非版号；见 {@link SessionStore.aggregateFeaturesByVersion} 未登记桶口径）；
 * - **trim** 后非空 ⇒ 必须命中 **semver 形状**（可选 `v` 前缀 + `MAJOR.MINOR.PATCH` + 可选 prerelease/build）；
 *   不合形状 ⇒ `feature_invalid_version_shape`，零写入；
 * - **不做脏值归一** —— 存量自由文本行**不被改写**、也不参与 shape 判定（此校验只作用于**写口**，
 *   与读侧 `readNullableString(...) ?? ""` 归一并存）；
 * - **存在性校验**（∈ O1 台账）由调用方（`handleFeatureCreate` / `handleFeatureAdvance`）在 shape
 *   过关后就近做 —— 需要 Feature 的 `owner_group`（advance 时）或连接身份（create 时），本函数不持有该上下文。
 */
type RegistrationParse =
  | { ok: true; patch: FeatureRegistrationPatch }
  | { ok: false; code: string; error: string };

/**
 * semver 形状（v0.10.0 O5）：**可选 `v` 前缀**（历史上板/宿主两种写法并存，宽松兼容）
 * + `X.Y.Z` 三段（不做前导零宽松）+ 可选 `-prerelease` + 可选 `+build`。
 * **不做** `~`/`^`/range 语法（那些是消费侧匹配符，不是登记值）。
 */
const VERSION_SHAPE_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function isVersionShapeValid(v: string): boolean {
  return VERSION_SHAPE_RE.test(v);
}

function parseRegistration(input: RegistrationInput): RegistrationParse {
  const patch: FeatureRegistrationPatch = {};
  if (input.stage !== undefined) {
    if (!isFeatureStage(input.stage)) {
      return {
        ok: false,
        code: "feature_invalid_stage",
        error: `非法 stage "${input.stage}"（闭集：${FEATURE_STAGES.join(" / ")}）`,
      };
    }
    patch.stage = input.stage;
  }
  if (input.approval !== undefined) {
    if (!isFeatureApproval(input.approval)) {
      return {
        ok: false,
        code: "feature_invalid_approval",
        error: `非法 approval "${input.approval}"（闭集：${FEATURE_APPROVALS.join(" / ")}）`,
      };
    }
    patch.approval = input.approval;
  }
  // v0.10.0 O5：`version` 写口 shape 校验（undefined / 空串 ⇒ 放行；trim 后非空 ⇒ 必须命中 semver）
  if (input.version !== undefined) {
    const trimmed = input.version.trim();
    if (trimmed !== "" && !isVersionShapeValid(trimmed)) {
      return {
        ok: false,
        code: "feature_invalid_version_shape",
        error:
          `非法 version "${input.version}"：期望 semver 形状 vX.Y.Z（可省 v、可带 -prerelease/+build）；` +
          `空串表示撤排期（回未登记桶）`,
      };
    }
    // 归一为 trim 后值落库，避免 `" v0.10.0 "` 与 `"v0.10.0"` 在台账 PK 上分裂
    patch.version = trimmed;
  }
  return { ok: true, patch };
}

/**
 * **版本台账存在性检查**（v0.10.0 O5 · 改造文档 §2.1(4)）：shape 过关后就近做，
 * 由调用方传入当前上下文里 Feature 将落的 `owner_group`（create = 连接身份 / advance = 已有归属）。
 *
 * 分流：
 * - **未写 version**（`undefined`）⇒ 放行（本次不动 version 列）；
 * - **空串**（撤排期 ⇒ 回未登记桶）⇒ 放行（不必 ∈ 台账；见 {@link aggregateFeaturesByVersion} 未登记桶）；
 * - **非空** ∧ **`ledgerReady = true`** ∧ **不在台账** ⇒ 拒（`orch_version_unknown`，409 语义 —— HTTP 面错误码由 O2 端点转；本处是 MCP 面）；
 * - **非空** ∧ **`ledgerReady = false`**（O1 版本台账尚未落地 ⇒ 过渡态）⇒ **放行**（shape 校验仍生效）；
 *   台账一建，本检查自动切执法路径，无需再改代码。
 */
function checkVersionLedger(
  ownerGroup: string | null | undefined,
  version: string | undefined,
): FeatureToolFailure | null {
  if (version === undefined || version === "") return null;
  const { exists, ledgerReady } = versionLedgerHas(ownerGroup, version);
  if (!ledgerReady) return null; // O1 未落表 ⇒ 跳过存在性检查（shape 已在前一步把关）
  if (exists) return null;
  return {
    ok: false,
    code: "orch_version_unknown",
    error:
      `version "${version}" 不在引擎版本台账（owner_group=${ownerGroup === null || ownerGroup === undefined ? "NULL" : `"${ownerGroup}"`}）` +
      `：先经板/宿主建版号或选已存在的版号；空串 = 撤排期（回未登记桶）不经本检`,
  };
}

// ---------------------------------------------------------------------------
// O4 · 版本写口执法（发版闸 + 两把锁 · 改造文档 §2.1(3)）
// ---------------------------------------------------------------------------

/**
 * **排期写执法**（v0.10.0 O4）—— 任意**写 `features.version`**（= 把需求排入某版）经此门，
 * **fail-fast、零写入**。宿主经 MCP 直写 `version` 同受执法（**后门不豁免 —— 引擎侧强制、非板**）。
 * 两把锁（改造文档 §2.1(3) / `需求流程.md` §7）：
 *
 * 1. **排期写状态锁** —— 仅 `stage = 需求分析 ∧ approval = 未发起` 的卡可写版号（= §7 改版纪律
 *    第一档「想法挪版」，零善后）。已过需求确认门（`stage ≠ 需求分析` ∨ `approval ≠ 未发起`）⇒ 拒
 *    `board_schedule_state_locked`（**跨单元引用码，字面不变**：原由板侧发起，v0.10.0 起改由引擎返回）。
 *    ⚠ 本锁**只作用于 advance 的再排期路径**（对既有卡挪版 / 改期）；**create 不施本锁** —— create
 *    确立卡的初始态、无「先前态」可锁，且板「需求提出即入板」恒以 `需求分析 / 未发起` 建卡、天然满足。
 *    「有产出物的改版」（§7 第二档，卡已过门）不在此锁放行面 —— 由宿主善后轨处理，不在本节点范围。
 * 2. **`released` 锁** —— 目标版号在引擎版本台账为 `released` ⇒ 不可排入 / 不可改排期，拒
 *    `orch_version_released_locked`。trim 全等匹配（`parseRegistration` 已 trim）、**禁前缀**（按台账 PK 字面查）。
 *    台账未落地（`ledgerReady = false`）⇒ 过渡放行（同 O5 存在性检查：无表 ≠ 已发版，不得一刀切挡所有版号）。
 *    create 与 advance 同施本锁。
 *
 * 未写 version（`undefined`）/ 空串（撤排期 ⇒ 回未登记桶）⇒ 整门跳过（不针对某已存在版号排期）。
 */
function checkVersionWriteLocks(
  current: { stage: FeatureStage; approval: FeatureApproval },
  ownerGroup: string | null | undefined,
  version: string | undefined,
  opts: { applyStateLock: boolean },
): FeatureToolFailure | null {
  if (version === undefined || version === "") return null;
  // 1) 排期写状态锁（仅 advance 再排期路径执法；create 无先前态 ⇒ 由 applyStateLock=false 跳过）
  if (opts.applyStateLock && (current.stage !== "需求分析" || current.approval !== "未发起")) {
    return {
      ok: false,
      code: "board_schedule_state_locked",
      error:
        `排期写状态锁：version "${version}" 仅当 stage=需求分析 ∧ approval=未发起 时可写；` +
        `当前 stage=${current.stage} / approval=${current.approval}（已过需求确认门 ⇒ 不可挪版/改期；` +
        `有产出物的改版走 §7 第二档善后轨，不在本锁放行面）`,
    };
  }
  // 2) released 锁（create / advance 同施）
  const { status, ledgerReady } = versionLedgerStatus(ownerGroup, version);
  if (ledgerReady && status === "released") {
    return {
      ok: false,
      code: "orch_version_released_locked",
      error:
        `已发版锁：version "${version}" 在引擎版本台账为 released（owner_group=` +
        `${ownerGroup === null || ownerGroup === undefined ? "NULL" : `"${ownerGroup}"`}），不可排入 / 不可改排期`,
    };
  }
  return null;
}

/** 发版闸入参（O2b 设状态端点 / O7 标记 released 同事务前调用） */
export interface ReleaseGateInput {
  ownerGroup: string | null | undefined;
  /** 已 trim 的目标版号 */
  version: string;
}

/** 发版闸 verdict（成功回该版号名下三桶计数，供调用方留痕 / 快照） */
export type ReleaseGateResult =
  | {
      ok: true;
      counts: { total: number; completed: number; cancelled: number; open: number };
    }
  | FeatureToolFailure;

/**
 * **发版闸**（v0.10.0 O4 · 改造文档 §2.1(3) / `需求流程.md` §8）—— 「标记 released」的准入判据，
 * **执法落引擎**；写端点（O2b `PATCH /api/versions/{version}/status`）与快照同事务（O7）**共用本判据**。
 *
 * 判据**不变**（`需求流程.md` §8 收口口径，本节点不改语义）：
 *   `total > 0 ∧ completed + cancelled === total ∧ completed > 0`
 *   - `failed` **不计入收口**（`open` 含 `failed`，与 O3 三桶口径同源）⇒ 名下有 `open`（含 `failed`）⇒ 未收口；
 *   - **全 `cancelled`**（`total>0 ∧ completed=0`）⇒ 无任何交付 ⇒ 挡闸；
 *   - **全 `failed`**（未收口）⇒ 须先经 `cancel` 归档再判 ⇒ 挡闸。
 *
 * **中间态禁令作发版闸判据**（★R2 加严，非仅纪律）：发版事实源必须在引擎 —— 台账未落地
 * （`ledgerReady = false`）或版号不在引擎台账 ⇒ **fail-closed** 拒 `orch_version_unknown`
 * （不得发布「既写本地台账又读引擎」的中间态版本）。
 *
 * 已 `released` 的重复标记交调用方（O2a 幂等）处理，本闸不再判（`status` 在此只作读、不挡同版重复标记）。
 * ⚠ `owner_group` 为 NULL（未配组 / 匿名）时聚合走**全量**（{@link aggregateFeaturesByVersion} 无「IS NULL」
 *   过滤档）；带组环境按组精确计数，与本闸判据一致。
 */
export function evaluateReleaseGate(input: ReleaseGateInput): ReleaseGateResult {
  const ownerGroup = input.ownerGroup;
  const version = input.version;
  // 事实源在引擎 / 中间态禁令：版号须已在引擎台账登记（表就绪 ∧ 命中），否则 fail-closed
  const { exists, ledgerReady } = versionLedgerHas(ownerGroup, version);
  if (!ledgerReady || !exists) {
    return {
      ok: false,
      code: "orch_version_unknown",
      error:
        `发版闸：version "${version}" 不在引擎版本台账（owner_group=` +
        `${ownerGroup === null || ownerGroup === undefined ? "NULL" : `"${ownerGroup}"`}）` +
        `${ledgerReady ? "" : "（台账尚未落地 ⇒ 既写本地台账又读引擎的中间态，fail-closed 不得发布）"}；` +
        `发版事实源须在引擎，先经引擎建版号`,
    };
  }
  // 收口判据：取该版号名下卡三桶计数（可见性同源，与板 / 聚合面同口径）
  const agg = aggregateFeaturesByVersion(ownerGroup ?? undefined);
  const bucket = agg.buckets.find((b) => b.version === version);
  const counts = bucket?.counts ?? { total: 0, completed: 0, cancelled: 0, open: 0 };
  if (counts.total === 0 || counts.completed + counts.cancelled !== counts.total) {
    return {
      ok: false,
      code: "orch_version_not_converged",
      error:
        `发版闸：version "${version}" 未收口（total=${counts.total} completed=${counts.completed} ` +
        `cancelled=${counts.cancelled} open=${counts.open}）；` +
        `须 total>0 ∧ completed+cancelled===total（open 含 failed，failed 不计收口、须先 cancel 归档）`,
    };
  }
  if (counts.completed === 0) {
    return {
      ok: false,
      code: "orch_version_all_cancelled",
      error:
        `发版闸：version "${version}" 名下 ${counts.total} 张卡全部 cancelled（无任何 completed 交付）；` +
        `全取消版本不得标记 released`,
    };
  }
  return { ok: true, counts };
}

// ---------------------------------------------------------------------------
// v0.10.1 O2 · 归属写执法（C-3 / C-15 / C-2）+ project 侧 releasable 判据（C-4 展示档）
// ---------------------------------------------------------------------------

/**
 * 归属写执法的 **`orch_*` 错误码**（改造文档 C-13 闭集的**门面子集**）。
 *
 * 数据面那三个（`_invalid_shape` / `_exists` / `_unknown`）由 store 侧导出并在此复用；本处三个是
 * **门判据**（O1 刻意不预定义「无人产的死码」，落到本节点才定义）。码值即契约：HTTP 信封
 * `error.code` 与 MCP 面共用；**未命中码原样展示、不 fail-closed**（板侧口径）。
 */
export const ERR_ATTRIBUTION_STATE_LOCKED = "orch_project_attribution_state_locked";
export const ERR_ATTRIBUTION_CONFLICT = "orch_project_attribution_conflict";
export const ERR_PROJECT_VERSION_RELEASED_LOCKED = "orch_project_version_released_locked";

/**
 * MCP `a2a_feature_advance` 入参 `projectVersions[]` 的**单条归属项**（C-17 入参形状）。
 *
 * `groupVersion` **不在入参里** —— 它由 Feature 当前的 `features.version` 派生（同单写定、此后
 * 不漂移，C-21），入参带一份反而会造出「两个事实源」；`ownerGroup` 同理取 Feature 的归属组。
 */
export interface ProjectVersionAttribution {
  projectId: string;
  /** Project Version（须已在 project 台账存在，C-15 ⇒ {@link ERR_PROJECT_VERSION_UNKNOWN}） */
  projectVersion: string;
}

/** 归属写执法入参（`applyFeatureAttributions` 用；`check*` 只吃后两件） */
export interface AttributionWriteArgs {
  featureId: string;
  /**
   * **全量**承诺集（C-3 ★R3：新增执行节点的同轮必须重发全量，配合同值幂等、重发安全）。
   * 空数组 = **零写 no-op**，**不是**「清空归属」—— 撤销一条承诺是显式的「先删后建」两笔（见 {@link applyFeatureAttributions}）。
   */
  projectVersions: ProjectVersionAttribution[];
  /** 写入来源（自由文本，落 `feature_projects.source`；供「可改须留痕」对照，引擎不解析） */
  source?: string | null;
}

/** 校验通过后待落库的单条归属（`groupVersion` 已从 Feature 派生、`source` 已按幂等档定值） */
interface AttributionPlanEntry {
  projectId: string;
  projectVersion: string;
  groupVersion: string;
  source: string | null;
}

export type AttributionWriteResult =
  | {
      ok: true;
      featureId: string;
      /** 本次新落行数 */
      created: number;
      /** 本次同键改写行数（值列不变时仅 `source` 变才走到，见 {@link AttributionPlanEntry} 的定值口径） */
      updated: number;
      /** 本次同值幂等重发 ⇒ 零写入的行数（C-3 ★R3「重发安全」的可观测面） */
      noop: number;
      attributions: FeatureProjectRecord[];
    }
  | FeatureToolFailure;

/**
 * **归属写执法（纯校验、零写入）**（改造文档 C-3 / C-15 / C-2 / C-6 ④）。
 *
 * 判据序（**任一不过 ⇒ 整单拒绝、零写入**；★N-8「归属拒 ⇒ 主链零迁移」的凭据就在这里 ——
 * 本函数**不碰** `features` 表，接线方（O3）把它放在任何状态写入**之前**）：
 *
 * 0. **身份字段**：`projectId` / `projectVersion` trim 后不得为空串 ⇒ {@link ERR_PROJECT_VERSION_SHAPE}
 *    （承诺集身份键成员；空串走到 store 只会抛裸错）；同批内同 `projectId` 出现**异值** ⇒
 *    {@link ERR_ATTRIBUTION_CONFLICT}（**单内自相矛盾**，不得「后者覆盖前者」），同值重复 ⇒ 去重。
 * 1. **(a) 未过门 ⇒ 挡**：判据 = `approval = 已通过`，**不看 `stage`**（C-3）。
 *    附带两条同源判据：`cancelled` 卡**不得新写**（★R3；已存在的行仍可幂等重发、但本档一律挡，
 *    不放开「只重发同值」的特例 —— 轨已终止，写归属会在版本面误导）；`features.version` 为空
 *    （无 Group Version）⇒ 落不下归属（C-21，`group_version` NOT NULL 的门面表达）。
 *    **`completed` 未发版仍可补写**（本档不看 `completed`，只认 `cancelled`）。
 * 2. **(c) 版本行须已存在**（C-15）：`projectVersionGet(ownerGroup, projectId, projectVersion)`
 *    为 `null` ⇒ {@link ERR_PROJECT_VERSION_UNKNOWN} —— **不隐式建版**，建版只走显式写口。
 * 3. **(b) 归属 released 门**（C-6 ④）：查到的行 `status = released` ⇒
 *    {@link ERR_PROJECT_VERSION_RELEASED_LOCKED} —— 一经 `released` 即冻结、不得复用为后续归属目标。
 *    （(c) 在 (b) 之前**只是取行的先后**，二者对同一行互斥：`released` 的行必然已存在。）
 * 4. **(d) 不变式继承判据**（C-2）：同 `(owner_group, group_version, project_id)` 名下
 *    **其它需求**已有归属 ⇒ 本次该 project 的 `project_version` **必须继承同值**，否则
 *    {@link ERR_ATTRIBUTION_CONFLICT}。**无父（主轨）不受额外约束** —— 本条读的是「已存在的承诺」，
 *    与 `parent_feature_id` 无关：主轨首条归属时该读集为空 ⇒ 自选版号；一旦有承诺即进入继承档。
 *    **不做前瞻**（只校验已落库的承诺，不猜「将来的需求该用哪个号」）。
 * 5. **(e) 幂等 / 重放**：本需求 own row 已存在 ∧ `projectVersion` / `groupVersion` **同值** ⇒
 *    no-op（`source` 沿用既有值，交 store 走「值全同 ⇒ 零写入、不改 `updated_at`」档，重发不制造活动痕迹）；
 *    **异值** ⇒ {@link ERR_ATTRIBUTION_CONFLICT} —— 改归属须显式「先删后建」两笔、逐笔留痕，
 *    不在写归属里隐式改口。
 */
export function checkFeatureAttributionWrites(
  feature: FeatureRecord,
  projectVersions: ProjectVersionAttribution[],
  source: string | null = null,
): { ok: true; entries: AttributionPlanEntry[] } | FeatureToolFailure {
  const fail = (code: string, error: string): FeatureToolFailure => ({ ok: false, code, error });
  const ownerGroup = feature.ownerGroup;
  const groupVersion = feature.version.trim();

  // (a) 未过门挡写 + cancelled 不得新写 + 无 Group Version 落不下归属（C-3 / ★R3 / C-21）
  if (feature.approval !== "已通过") {
    return fail(
      ERR_ATTRIBUTION_STATE_LOCKED,
      `归属写锁：Feature ${feature.featureId} approval=${feature.approval}（非「已通过」）⇒ 未过门不落归属；` +
        `归属写点 = approve 过门之后（**本锁**判据看 approval、不看 stage，改造文档 C-3；` +
        `门② 自身的过门条件自增补 \`ec93e1bd\` 起含 stage 一枚，与本锁判据分属两事、不得互相外推）`,
    );
  }
  if (feature.state === "cancelled") {
    return fail(
      ERR_ATTRIBUTION_STATE_LOCKED,
      `归属写锁：Feature ${feature.featureId} 已 cancelled ⇒ 不得新写归属（★R3：该轨已终止、无交付可承诺）`,
    );
  }
  if (groupVersion.length === 0) {
    return fail(
      ERR_ATTRIBUTION_STATE_LOCKED,
      `归属写锁：Feature ${feature.featureId} 无 Group Version（features.version 为空）⇒ 无归属可落` +
        `（C-21：须先经引擎排期写口把 version 写定）`,
    );
  }

  // 0) 身份字段 + 单内重复（同值去重、异值判矛盾）
  const seen = new Map<string, string>();
  for (const raw of projectVersions) {
    const projectId = raw.projectId.trim();
    const projectVersion = raw.projectVersion.trim();
    if (projectId.length === 0 || projectVersion.length === 0) {
      return fail(
        ERR_PROJECT_VERSION_SHAPE,
        `归属项身份字段不得为空串（project_id / project_version 是承诺集身份键成员）：` +
          `project_id="${raw.projectId}" project_version="${raw.projectVersion}"`,
      );
    }
    const previous = seen.get(projectId);
    if (previous !== undefined && previous !== projectVersion) {
      return fail(
        ERR_ATTRIBUTION_CONFLICT,
        `同一批归属里 project "${projectId}" 出现两个不同 Project Version（${previous} / ${projectVersion}）；` +
          `单内自相矛盾 ⇒ 整单拒绝（不得「后者覆盖前者」）`,
      );
    }
    seen.set(projectId, projectVersion);
  }

  // 本需求已有归属（(e) 的读凭据）：一次读全、按 project 索引
  const ownRows = new Map<string, FeatureProjectRecord>();
  for (const row of featureProjectListByFeature(feature.featureId)) ownRows.set(row.projectId, row);

  const entries: AttributionPlanEntry[] = [];
  for (const [projectId, projectVersion] of seen) {
    const where =
      `project_id="${projectId}" project_version="${projectVersion}" ` +
      `owner_group=${ownerGroup === null ? "NULL" : `"${ownerGroup}"`} group_version="${groupVersion}"`;

    // (c) 版本行须已存在（不隐式建版）
    const ledger = projectVersionGet(ownerGroup, projectId, projectVersion);
    if (ledger === null) {
      return fail(
        ERR_PROJECT_VERSION_UNKNOWN,
        `归属要求 project 台账已有该行（C-15 不隐式建版）：无此版本（${where}）；` +
          `建版只走显式写口（POST /api/project-versions）`,
      );
    }
    // (b) 归属 released 门（C-6 ④：一经 released 即冻结）
    if (ledger.status === "released") {
      return fail(
        ERR_PROJECT_VERSION_RELEASED_LOCKED,
        `归属写 released 门（= project 级的归属写锁，与 Group 级「排期锁」显式分名，C-14）：` +
          `project 版本已 released ⇒ 冻结、不得复用为后续归属目标（${where}）`,
      );
    }

    // (d) 不变式继承判据：同 (owner_group, group_version, project_id) 的**其它需求**承诺 ⇒ 必须同值
    for (const sibling of featureProjectListByVersion(ownerGroup, groupVersion, projectId)) {
      if (sibling.featureId === feature.featureId) continue;
      if (sibling.projectVersion !== projectVersion) {
        return fail(
          ERR_ATTRIBUTION_CONFLICT,
          `不变式违例（C-2「同一 Group Version + 同一 project + 同一条主轨 ⇒ 同一 Project Version」）：` +
            `${groupVersion} / ${projectId} 名下需求 ${sibling.featureId} 已承诺 ${sibling.projectVersion}，` +
            `本次要落 ${projectVersion} ⇒ 必须继承同值（${where}）`,
        );
      }
    }

    // (e) own row 同值 ⇒ 幂等重发（source 沿用，交 store 走零写入档）；异值 ⇒ 拒（改归属须先删后建）
    const own = ownRows.get(projectId);
    if (own !== undefined && (own.projectVersion !== projectVersion || own.groupVersion !== groupVersion)) {
      return fail(
        ERR_ATTRIBUTION_CONFLICT,
        `本需求对 project "${projectId}" 已有归属（${own.projectVersion} @ ${own.groupVersion}），` +
          `本次要改写为 ${projectVersion} @ ${groupVersion} ⇒ 拒；` +
          `改归属须显式「先删后建」两笔、逐笔留痕（C-3「可改须留痕」）`,
      );
    }
    entries.push({
      projectId,
      projectVersion,
      groupVersion,
      source: own === undefined ? source : own.source,
    });
  }
  return { ok: true, entries };
}

/**
 * **归属写执法（含落库）**（C-3 / C-17 的 MCP 路径落点）—— `advance` 携带 `projectVersions[]`
 * 时的**独立分支**实现体（接线 = O3：`to = 当前态 ∧ projectVersions` 非空即触发，
 * **不要求同单携带登记字段**、**不入 `hasRegistration`**）。
 *
 * 两拍：**先全量校验（{@link checkFeatureAttributionWrites}，零写入）→ 全过才逐条落库**
 * —— 校验期已排除 store 侧的 400 条件（身份列非空、group_version 非空），故写入期不再有
 * 「拒在第二批、第一批已落库」的半摊状态（★N-8 fail-fast 的落地形态）。
 */
export function applyFeatureAttributions(
  args: AttributionWriteArgs,
  identity: string | null = null,
): AttributionWriteResult {
  const feature = getFeature(args.featureId);
  if (feature === null) {
    return { ok: false, code: "feature_not_found", error: `未知 Feature ${args.featureId}` };
  }
  const denied = ownershipFailure(feature, identity);
  if (denied !== null) return denied;
  if (args.projectVersions.length === 0) {
    // 空集合 = 零写 no-op（**不是**清空归属；撤销承诺是显式删行）
    return { ok: true, featureId: feature.featureId, created: 0, updated: 0, noop: 0, attributions: [] };
  }
  const plan = checkFeatureAttributionWrites(feature, args.projectVersions, args.source ?? null);
  if (plan.ok === false) return plan;

  let created = 0;
  let updated = 0;
  let noop = 0;
  const attributions: FeatureProjectRecord[] = [];
  for (const entry of plan.entries) {
    const outcome = featureProjectUpsert({
      ownerGroup: feature.ownerGroup,
      featureId: feature.featureId,
      projectId: entry.projectId,
      projectVersion: entry.projectVersion,
      groupVersion: entry.groupVersion,
      source: entry.source,
    });
    if (outcome.ok === false) {
      return { ok: false, code: outcome.code, error: `${outcome.message}（status=${outcome.status}）` };
    }
    if (outcome.created) created += 1;
    else if (outcome.changed) updated += 1;
    else noop += 1;
    attributions.push(outcome.record);
  }
  return { ok: true, featureId: feature.featureId, created, updated, noop, attributions };
}

/** `evaluateProjectReleaseGate` 入参（project 台账行的身份三元组） */
export interface ProjectReleaseGateInput {
  /** 键的一部分：`null` = 匿名档（照 store 侧 project 读口口径） */
  ownerGroup: string | null;
  projectId: string;
  projectVersion: string;
}

/**
 * **project 侧收口判据的出参**（C-4 / C-7）—— **展示字段**，不是门：
 * 本结构里**没有 `ok` / `code`**，调用方拿到的永远是「计数 + 一句原因」。
 */
export interface ProjectReleaseGateResult {
  releasable: boolean;
  total: number;
  completed: number;
  cancelled: number;
  open: number;
  /** 判据说明（人类可读，供板 / 投影直接展示；**不是**错误码） */
  reason: string;
}

/**
 * **project 级收口判据 = 展示字段 `releasable`**（改造文档 C-4 ★用户 2026-10-09 裁定「级联档」）。
 *
 * 判据 = `total > 0 ∧ completed + cancelled === total`（**不含 `completed > 0`** —— 这是与 Group 闸
 * {@link evaluateReleaseGate} 的**唯一**判据差）。差别的由来：发版只有**一个动作**（标 Group
 * `released`），project 版本由引擎在**同一事务内级联**置 `released` ⇒ project 侧**不构成第二道发版门**、
 * **不产生拒绝码**，只供板 / 人对照。**「全 `cancelled` 的 project 也判 `releasable = true`」是级联档的
 * 前提** —— 若此处要求 `completed > 0`，全取消轨的 project 会永久 `open`，与「Group 已发版 ⇒ 名下
 * project 一律 `released`」的级联互斥（结构性死锁）。
 *
 * **两套计数不得横向相加 / 相等校验**（C-4 ★R2）：本判据从**归属表**派生，Group 闸从
 * `features.version` 派生，同名版号在两级里互不染色。
 * **project 面无本地读缓存 / 判定唯一在引擎**（C-7 / C-18）⇒ 板只投影本结构，**不重算**。
 */
export function evaluateProjectReleaseGate(input: ProjectReleaseGateInput): ProjectReleaseGateResult {
  const counts = featureProjectStateCounts(input.ownerGroup, input.projectId, input.projectVersion);
  const converged = counts.total > 0 && counts.completed + counts.cancelled === counts.total;
  const where =
    `project_id="${input.projectId}" project_version="${input.projectVersion}" ` +
    `owner_group=${input.ownerGroup === null ? "NULL" : `"${input.ownerGroup}"`}`;
  if (counts.total === 0) {
    return {
      ...counts,
      releasable: false,
      reason:
        `project 版本名下无归属需求（${where}）⇒ 未触达、不产生发版事实；` +
        `本字段仅展示，不构成发版口（C-4）`,
    };
  }
  if (!converged) {
    return {
      ...counts,
      releasable: false,
      reason:
        `未收口（${where}）：total=${counts.total} completed=${counts.completed} ` +
        `cancelled=${counts.cancelled} open=${counts.open}（open 含 failed —— 须先 cancel 归档）`,
    };
  }
  return {
    ...counts,
    releasable: true,
    reason:
      `已收口（${where}）：total=${counts.total} completed=${counts.completed} cancelled=${counts.cancelled}；` +
      `发版凭 Group 级动作同事务级联置 released，本判据不作门` +
      (counts.completed === 0 ? "（全 cancelled ⇒ 无交付仍判 releasable，级联档前提）" : ""),
  };
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export interface FeatureCreateArgs {
  title: string;
  requirement?: string;
  /** Feature 级会话上下文（落 `features.context_id`，跨任务 / 跨 worker 启停复用） */
  contextId?: string;
  /**
   * 版本登记（**排期语义**，v0.10.5 O4 起为 create 唯一保留的登记字段入参）：
   * 未传 ⇒ 空串（未排期停靠 / 撤排期）；非空 ⇒ trim 后须命中 semver 形状、且经台账存在性与
   * `released` 锁执法（见 {@link parseVersionInput} / {@link checkVersionLedger}）。
   */
  version?: string;
  /**
   * **父需求登记**（v0.9.3 O1）：增补轨挂主需求的单值父引用（落 `features.parent_feature_id`）。
   * 存在性 + 可见性校验 fail-closed（不可见 ⇒ 与不存在同一拒绝码，不泄漏他组存在性）；
   * 父链**只存不解析**（不递归、不判环）。
   */
  parentFeatureId?: string;
  // v0.10.5 O4：入参**不再含 `stage` / `approval`**（初值恒定，由本 handler 硬编码写入）。
  // 本接口**不 extends RegistrationInput** —— 摘键必须做成**类型级**事实：旧调用静态传这两枚
  // 时在编译期出声（测试面靠 cast 显式表达「旧参静默丢弃」锚，见验收判据 2）。
}

/**
 * `create` 成功出参（**additive** · 增补 `6cc46dd2` N4 起带本阶段明细）。
 *
 * 明细七枚**平铺在顶层**（{@link FeatureStageDetail} 的 `stage`/`approval`/`version` 三枚与本接口
 * 既有的登记字段回显**同一对键、同一来源** ⇒ 不构成第二份回显；`pending`/`gate`/`actor`/`action`
 * 四枚由出口 {@link deriveStageDetail} 装配）。必带性 = 下面出口字面量的类型标注 ⇒ 漏装即编译报错。
 */
export interface FeatureCreateSuccess extends FeatureStageDetail {
  ok: true;
  featureId: string;
  state: FeatureState;
  title: string;
  /** 回显入参 contextId（已随 createFeature 持久化到 features.context_id） */
  contextId?: string;
  /** 回显父需求（v0.9.3 O1：仅带父创建时出现，同 contextId 回显口径） */
  parentFeatureId?: string;
  /**
   * 登记字段回显（v0.9.0 B1″ 起**恒有值**；v0.10.5 O4 起 `stage` / `approval` 两枚是
   * **硬编码初值**「需求分析 / 未发起」，不再是入参回显；`version` 未传 ⇒ 空串）。
   * 三枚同时是 {@link FeatureStageDetail} 的**回显三枚**（增补 `6cc46dd2` N4 · 键与类型逐字相同）。
   */
  stage: FeatureStage;
  version: string;
  approval: FeatureApproval;
}

/**
 * `version` 入参的**单点校验**（shape + trim）—— {@link parseRegistration} 与 create 契约共用
 * 同一判据（v0.10.5 O4：create 摘 `stage`/`approval` 后不再走整包 `parseRegistration`，
 * 但 `version` 的 shape 挡门不得分叉）。
 */
type VersionParse = { ok: true; version: string } | { ok: false; code: string; error: string };

function parseVersionInput(version: string | undefined): VersionParse {
  if (version === undefined) return { ok: true, version: "" };
  const trimmed = version.trim();
  if (trimmed !== "" && !isVersionShapeValid(trimmed)) {
    return {
      ok: false,
      code: "feature_invalid_version_shape",
      error:
        `非法 version "${version}"：期望 semver 形状 vX.Y.Z（可省 v、可带 -prerelease/+build）；` +
        `空串表示撤排期（回未登记桶）`,
    };
  }
  // 归一为 trim 后值落库，避免 `" v0.10.0 "` 与 `"v0.10.0"` 在台账 PK 上分裂
  return { ok: true, version: trimmed };
}

export function handleFeatureCreate(
  args: FeatureCreateArgs,
  /** 连接身份（组名）；`null` / 缺省 = 无身份 ⇒ 落 `owner_group = NULL`（未配组 / 存量语义） */
  identity: string | null = null,
): FeatureCreateSuccess | FeatureToolFailure {
  const title = args.title.trim();
  if (title.length === 0) {
    return { ok: false, code: "feature_invalid_args", error: "title 不能为空" };
  }
  // v0.10.5 O4「初值恒定」：`stage` / `approval` **不是入参**（zod 默认 strip ⇒ schema 不声明的
  // 旧调用多传键被**静默丢弃**；本 handler 硬编码写入，**不存在**「未传 ⇒ 改造方案 + 待审批」
  // 的旧缺省路径）。`version` 仍是入参（未排期停靠 / 撤排期 / released 锁 / 板拖拽建卡都依赖它）。
  // v0.10.0 O5：shape 校验（与 advance 同一判据，见 {@link parseVersionInput}）
  const ver = parseVersionInput(args.version);
  if (ver.ok === false) return { ok: false, code: ver.code, error: ver.error };
  // v0.10.0 O5：shape 过关后做**存在性校验**（∈ O1 台账；台账未落地 ⇒ 过渡放行，见 {@link checkVersionLedger}）
  const ledgerFailure = checkVersionLedger(identity, ver.version);
  if (ledgerFailure !== null) return ledgerFailure;
  // v0.10.0 O4：create 只施 `released` 锁（无「先前态」可挡排期 ⇒ 不施排期写状态锁，见 {@link checkVersionWriteLocks}）
  const writeLockFailure = checkVersionWriteLocks(
    { stage: CREATE_INITIAL_STAGE, approval: CREATE_INITIAL_APPROVAL },
    identity,
    ver.version,
    { applyStateLock: false },
  );
  if (writeLockFailure !== null) return writeLockFailure;
  // 父需求校验（v0.9.3 O1，零写入前）：存在性 + 可见性走带身份过滤读口
  // （`ownershipFailure` 同源判据，禁止第二套）⇒ 不存在与他组不可见**同一拒绝码**
  // `feature_not_found`（不泄漏他组 Feature 的存在性，fail-closed）。只存不解析：不递归、不判环。
  if (args.parentFeatureId !== undefined) {
    const parent = getFeature(args.parentFeatureId);
    const visible = parent !== null && ownershipFailure(parent, identity) === null;
    if (!visible) {
      return {
        ok: false,
        code: "feature_not_found",
        error: `父 Feature ${args.parentFeatureId} 不存在或不可见（带身份过滤读口，fail-closed）`,
      };
    }
  }
  const featureId = randomUUID();
  const rec = createFeature({
    featureId,
    title,
    requirement: args.requirement ?? null,
    contextId: args.contextId ?? null,
    // 入口打标：归属 = 本次连接身份（组名）；无身份 ⇒ NULL（无归属，fail-closed 存量语义）
    ownerGroup: identity,
    // v0.9.3 O1：父需求一次性登记（重跑不改父，同 owner_group 语义）
    parentFeatureId: args.parentFeatureId ?? null,
    // 主链起点 = 审批门停靠点（REQ-v0.4.1-2026-09-16-01 §2.3）：引擎只做需求实现，
    // 前段讨论 / 方案（Step 0/1）不走引擎；`waiting_approval → executing` 只能经 `a2a_feature_approve`
    state: "waiting_approval",
    // v0.10.5 O4 初值恒定：`stage` / `approval` 由引擎硬编码（不再收两枚入参、无兼容分叉）
    stage: CREATE_INITIAL_STAGE,
    // v0.9.0 登记字段：`version` 未传 ⇒ NULL（读回归一为空串，不落 "null" 字面量）
    // v0.10.0 O5 / v0.10.5 O4：经 parseVersionInput trim 后取（脏形状已在前一步挡门）
    version: ver.version === "" ? null : ver.version,
    approval: CREATE_INITIAL_APPROVAL,
  });
  const success: FeatureCreateSuccess = {
    ok: true,
    featureId: rec.featureId,
    state: rec.state,
    title: rec.title,
    // 明细七枚（增补 `6cc46dd2` N4 · 平铺在顶层）= **按新行算**：`rec` 就是本次写入后读回的那一行
    // （读侧已归一 ⇒ `version` 恒非空，与后续 `status` 出参同源），`create` 没有「写前快照」问题，
    // 故不必绕 {@link stageDetailAfterWrite} 再读一次。
    // 其中**回显三枚**（`stage`/`approval`/`version`）此前是逐字段显式回显，现由本 spread 单源带入 ——
    // {@link deriveStageDetail} 对这三枚是**原样回显**（不翻译、不重新推导）⇒ 同源同值，非语义变化。
    ...deriveStageDetail(rec),
  };
  if (rec.contextId !== null) success.contextId = rec.contextId;
  // v0.9.3 O1：回显**落库后读回**的父需求（仅带父创建时出现，同 contextId 口径）
  if (rec.parentFeatureId !== null) success.parentFeatureId = rec.parentFeatureId;
  return success;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export interface FeatureStatusArgs {
  featureId?: string;
  /** 单查任务清单是否包含阶段成员行；缺省 true，列表分支不受影响。 */
  includeStageTasks?: boolean;
}

/**
 * **主链状态段轨迹**的一格（REQ-v0.9.1-2026-09-25-02 · B1）。
 *
 * ⚠ **stage 一词两义**：本结构的 `state` 承载的是**主链段轨迹**（`feature.state` 事件回放），
 * 与 Feature **登记字段** `stage`（需求分析/改造方案/…/发版，观测面）及事件 kind
 * `feature.stage`（登记流水）**同词不同物** —— 三者互不相干，读账时不得混用。
 */
export interface FeatureAcceptanceStage {
  /** 主链状态机态（FeatureState），不是登记字段 `stage` */
  state: FeatureState;
  enteredAt: string;
  /** 下一段的进入时刻；**末段 = null**（Feature 现停在此态） */
  leftAt: string | null;
}

/**
 * 一条 `feature.failure_report` 账单的**原样**投影（零去重；见 {@link FeatureAcceptance.failures}）。
 */
export interface FeatureAcceptanceFailure {
  eventId: number;
  /** = 事件 `created_at` */
  at: string;
  /** 事件 payload 原文（JSON 字符串：`failed[]` / `blockedSet`；可空） */
  payload: string | null;
}

/**
 * **acceptance 聚合块**（v0.9.1 起，仅 `a2a_feature_status` **单 Feature 分支**出参，additive）。
 *
 * - `stages`：主链段轨迹，回放本 Feature 的 `feature.state` 事件（新态在 `events.state` 列、
 *   时间在 `created_at`、`payload=NULL`）。**首段合成**：`createFeature` 不写事件 ⇒
 *   `waiting_approval` 的 `enteredAt` 从 `feature.createdAt` 合成；**不按 state 聚合去重** ⇒
 *   `executing → needs_input → executing` 得 ≥2 段同名 `executing`（轨迹本义；相邻同态由
 *   store 的「只在真变化时写事件」守卫保证不可能）。
 * - `failures`：`feature.failure_report` 按 `eventId` 升序**原样列出、零去重**（payload 无
 *   retryCount、调度器签名 Map 为进程内态重启失忆 ⇒ 按 payload 去重不可行，也不该做）。
 * - `stateCounts`：与**列表分支**同一事实源（`featureTaskStateCounts` 聚合 SQL，归属谓词同侧），
 *   不做 tasks 就地计数。
 */
export interface FeatureAcceptance {
  stages: FeatureAcceptanceStage[];
  failures: FeatureAcceptanceFailure[];
  stateCounts: Partial<Record<TaskState, number>>;
}

/**
 * `a2a_feature_status` 出参（**单查 / 列表两分支共用的兼容形**，所有键可选 ⇒ 两分支各取所需）。
 *
 * **本阶段明细七枚**（增补 `6cc46dd2` N5 · 由 {@link FeatureStageDetail} 以 `Partial` 带入）：
 * 与 {@link FeatureStateChangeSuccess}（`approve` / `cancel` 共用基形）同款分工：本接口是**两分支
 * 共用的兼容形**，故七枚在其上是**可选**的（列表分支恒不带 ⇒ 必填会连列表出口一起编译不过）；
 * **单查分支的「必带」由 {@link FeatureStatusSingleSuccess} 执法**。
 * 可见性口径：**仅单 Feature 查询返回**（列表分支出参逐字不变，含 MCP / HTTP 两个面）。
 */
export interface FeatureStatusSuccess extends Partial<FeatureStageDetail> {
  ok: true;
  feature?: FeatureRecord;
  tasks?: FeatureTaskSummary[];
  /**
   * **tasks 表截断标记**（v0.10.8 O-5 additive；**仅单 Feature 查询返回**，列表分支出参不变）。
   *
   * 判据 = `nodes.length === limit`（本分支 `limit = 1000`）：单查的 `tasks` 表按 `limit` 截断，
   * 而 **`acceptance.stateCounts` / 列表 `taskCount` 走聚合 SQL、不受 `limit` 约束**（计数不截断）⇒
   * 真节点数 > 1000 时 `tasks` 只剩前 1000 行、计数却仍是全量，二者**逐字对不上**。本标记解释这一
   * 差异：`true` ⇒ `tasks` 触顶、可能还有未展示的尾部（`stateCounts` 求和 > `tasks.length`）；
   * `false` ⇒ `tasks` 已含全部节点（`stateCounts` 求和 === `tasks.length`）。
   */
  tasksTruncated?: boolean;
  /** 该 Feature 已登记的产物（v0.4.0；仅单 Feature 查询返回） */
  artifacts?: ArtifactRecord[];
  /**
   * **acceptance 聚合块**（v0.9.1 / REQ-02 B1；**仅单 Feature 查询返回**，列表分支出参不变）。
   * 语义与「stage 一词两义」警示见 {@link FeatureAcceptance}。
   */
  acceptance?: FeatureAcceptance;
  /**
   * **归属（承诺集）只读面**（v0.10.1 O7 / C-19；**仅单 Feature 查询返回**）——
   * 本需求触达哪些 project、各自落哪个 Project Version。
   * **无归属 ⇒ 空数组**（键恒在，不省略、不报错）；排序 = `projectId` 字典序。
   */
  projects?: FeatureProjectAttributionItem[];
  /**
   * **阶段轮读面**（R1 · v0.11.0 orch-N7 / 改造文档 §2.5；**仅单 Feature 查询返回**，
   * 列表分支出参逐字不变）—— 一格 = 一个派生实例 `(stage, round)`，**零新表**（行集来自
   * `tasks` 的 `mode='stage'` 物化行，口径来自 `stage.round_open` 事件）。
   *
   * ⚠️ **三处同名 `stage` 互不覆盖（判据 4 的键名纪律）**：本键是**顶层复数** `stageRuns[]`，
   * 其**每格内部**的 `stage` 是阶段轮所属阶段名；它与
   * ① 顶层单数 `stage`（{@link FeatureStageDetail} 的 Feature 登记字段）
   * ② `acceptance.stages[]`（**主链状态段轨迹**，`feature.state` 事件回放）
   * 是三个不同的东西，**两枚既有键一字未改**（本卡只加这枚新键）。
   *
   * 出参口径全部在 `bridge/stage-round.ts` 单点实现（分子/分母、`settled` 三态、
   * `unanswered[]`、`reachability` 观测位）；**本读面无写副作用**（纯读，见
   * {@link buildStageRuns} 的读口清单）。排序 = `(stage, round)` 升序 ⇒ 旧轮在前、本轮在末位。
   */
  stageRuns?: StageRunCellView[];
  /**
   * 列表分支出参（v0.9.0 B3″ 起 **additive** 增 `stateCounts`）。
   *
   * - `stateCounts`：各**任务态**的节点数（事实源 = 一条 `GROUP BY feature_id, state` 聚合 SQL）；
   * - `taskCount`：**由 `stateCounts` 派生**（各态求和）—— 与改前「`listFeatureTasks` 数长度」**逐 Feature 同值**；
   * - 两者都**只走列表读的视野判据**（归属谓词与 `listFeatures` 同源），他组节点不计数。
   */
  features?: Array<FeatureRecord & { taskCount: number; stateCounts: Partial<Record<TaskState, number>> }>;
  /**
   * **归属（承诺集）只读面 · 列表批量档**（v0.10.1 O7 / C-19；**仅列表分支返回**）——
   * `featureId → 归属清单`，**一条 SQL** 取全量（照 `stateCounts` 的 B3″ 先例，**不可**逐 Feature 查
   * ⇒ 列表读的查询数不随 Feature 数增长）。
   * 键集 = 本次列出的**每一个** Feature（与 {@link FeatureStatusSuccess.features} 逐一对齐）；
   * **无归属的需求 ⇒ 值为空数组**（不省略键、不报错）。视野判据与 `features` 同源（同一条归属谓词）。
   */
  attributionsByFeature?: Record<string, FeatureProjectAttributionItem[]>;
}

/**
 * **单查分支**的出参形（增补 `6cc46dd2` N5 · C.1 的「单查必带、列表不带」执行面）=
 * 共用兼容形 {@link FeatureStatusSuccess} ∧ {@link FeatureStageDetail} 七枚**平级必填**
 * （**平铺**在顶层，与 `feature`/`tasks`/`acceptance` 同级，无包装对象）。
 *
 * 执法点 = {@link handleFeatureStatus} 单查分支的出口字面量以本形标注 ⇒ **漏装任一枚即编译报错**
 * （照 {@link FeatureAdvanceExit} / {@link FeatureApproveSuccess} 先例）。
 * 列表分支**不套本形**（仍按共用兼容形构造）⇒ 七枚在列表出参上恒缺，由测试锚 G11 负向把门。
 */
export type FeatureStatusSingleSuccess = FeatureStatusSuccess & FeatureStageDetail;

/**
 * 归属只读面的**单条形状**（v0.10.1 O7 / C-19）。
 *
 * 键名与 MCP 写面入参 `projectVersions[]` 的单条对齐（`projectId` + `version`，见
 * {@link ProjectVersionAdvanceItem}）⇒ **读回即可原样重发**（全量重发是同值幂等的标准动作，C-3 ★R3）。
 * `version` = 该 project 的 **Project Version**（不是 Group Version；落库侧列名 `project_version`）。
 * `ownerGroup` / `groupVersion` / `source` / 时间戳**不进本投影** —— 归属表完整行面经 store 读口，
 * 只读面按「这条需求触达哪些 project、各是什么版本」的用途收窄。
 */
export interface FeatureProjectAttributionItem {
  projectId: string;
  version: string;
}

/** 归属行 → 只读面投影（落库侧 `projectVersion` → 面侧 `version`，与写面入参同键名） */
function toAttributionView(rows: readonly FeatureProjectRecord[]): FeatureProjectAttributionItem[] {
  return rows.map((row) => ({ projectId: row.projectId, version: row.projectVersion }));
}


/** `listEvents` 的 limit clamp 上限 = 游标续读的单页大小（短页即读到末尾） */
const ACCEPTANCE_EVENT_PAGE = 1000;

/**
 * **游标续读**本 Feature 的全部事件（`listEvents` 单次调用被 clamp 在 1000 且无 kind 过滤 ⇒
 * 必须 `since` 循环读到短页为止，禁单次调用当作全量）。事件天然按 `eventId` 升序。
 */
function readAllFeatureEvents(featureId: string): EventRecord[] {
  const all: EventRecord[] = [];
  let since = 0;
  for (;;) {
    const page = listEvents({ featureId, since, limit: ACCEPTANCE_EVENT_PAGE });
    all.push(...page);
    const last = page[page.length - 1];
    if (page.length < ACCEPTANCE_EVENT_PAGE || last === undefined) return all;
    since = last.eventId;
  }
}

/** 异议事件正文投影（仅读已落库事件；写侧附加字段不参与本判据）。 */
export interface UnresolvedDocObjection {
  eventId: number;
  docVersion: string;
  sectionId: string;
  objectionText: string;
}

/**
 * **未处置异议判据单点**。
 *
 * 最小可核验口径：某条 `stage.doc_objection` 的目标 `docVersion` 与查询版本相同，
 * 且它之后没有新的 `stage.round_open` 事件。新一轮开轮即视为旧口径已交给新轮处置；
 * `stage.round_open` 的 payload 已同时携带 `basisRev` / `docVersion`，无需另加表或持久化“已读”位。
 * 事件按 `eventId` 升序，先后关系不依赖 wall-clock。
 */
export function unresolvedDocObjections(
  events: readonly EventRecord[],
  docVersion?: string,
): UnresolvedDocObjection[] {
  const opens = events
    .filter((event) => event.kind === EVENT_STAGE_ROUND_OPEN)
    .map((event) => event.eventId);
  const pending: UnresolvedDocObjection[] = [];
  for (const event of events) {
    if (event.kind !== EVENT_STAGE_DOC_OBJECTION || event.payload === null) continue;
    let parsed: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(event.payload);
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      parsed = value as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof parsed["docVersion"] !== "string") continue;
    if (docVersion !== undefined && parsed["docVersion"] !== docVersion) continue;
    if (opens.some((openEventId) => openEventId > event.eventId)) continue;
    if (
      typeof parsed["sectionId"] !== "string" ||
      typeof parsed["objectionText"] !== "string"
    ) {
      continue;
    }
    pending.push({
      eventId: event.eventId,
      docVersion: parsed["docVersion"],
      sectionId: parsed["sectionId"],
      objectionText: parsed["objectionText"],
    });
  }
  return pending;
}

/**
 * 构造 acceptance 聚合块（只读；不触任何写口 / 门）。
 *
 * `stateCounts` 归属不放宽：`identity` 透传口径与列表分支一致（无身份 ⇒ 全量视野）。
 */
function buildFeatureAcceptance(feature: FeatureRecord, identity: string | null): FeatureAcceptance {
  const events = readAllFeatureEvents(feature.featureId);
  const stateEvents = events.filter(
    (e) => e.kind === EVENT_FEATURE_STATE && typeof e.state === "string",
  );
  const stages: FeatureAcceptanceStage[] = [];
  // 首段合成：createFeature 不写 `feature.state` 事件，初态恒 waiting_approval
  let state: FeatureState = "waiting_approval";
  let enteredAt = feature.createdAt;
  for (const e of stateEvents) {
    stages.push({ state, enteredAt, leftAt: e.createdAt });
    state = e.state as FeatureState;
    enteredAt = e.createdAt;
  }
  stages.push({ state, enteredAt, leftAt: null });
  const failures: FeatureAcceptanceFailure[] = events
    .filter((e) => e.kind === EVENT_FAILURE_REPORT)
    .map((e) => ({ eventId: e.eventId, at: e.createdAt, payload: e.payload }));
  const counts = featureTaskStateCounts(identity === null ? undefined : identity);
  return { stages, failures, stateCounts: counts.get(feature.featureId) ?? {} };
}

export function handleFeatureStatus(
  args: FeatureStatusArgs,
  identity: string | null = null,
): FeatureStatusSuccess | FeatureToolFailure {
  if (args.featureId !== undefined && args.featureId.length > 0) {
    const feature = getFeature(args.featureId);
    if (feature === null) {
      return { ok: false, code: "feature_not_found", error: `未知 Feature ${args.featureId}` };
    }
    // 归属校验（谁建谁见）：非本组 ⇒ 拒绝（他组 Feature 不返回详情）
    const denied = ownershipFailure(feature, identity);
    if (denied !== null) return denied;
    const limit = 1000;
    const nodes = listFeatureTasks(feature.featureId, {
      limit,
      includeStageTasks: args.includeStageTasks ?? true,
    });
    const tasks = nodes.map(summarizeTask);
    // 表截断标记（v0.10.8 O-5）：nodes 触顶 limit ⇒ 表被截断而 `stateCounts`/`taskCount` 计数不截断
    const tasksTruncated = nodes.length === limit;
    const artifacts = listArtifactsByFeature(feature.featureId, 1000);
    // 明细七枚（增补 `6cc46dd2` N5 · 平铺在顶层）= 由**本次读到的那一行**派生。
    // 单查是**纯读**（此前无任何写入）⇒ 不需要 {@link stageDetailAfterWrite} 的写后重读，
    // 直接用 `feature` 即「当下那一行」；**回显三枚与同层 `feature.*` 逐字同值**（同一对象、
    // 同一读口，不存在两份事实源），派生四枚 = {@link deriveStageDetail} 单源值。
    const success: FeatureStatusSingleSuccess = {
      ok: true,
      feature,
      tasks,
      tasksTruncated,
      artifacts,
      acceptance: buildFeatureAcceptance(feature, identity),
      // v0.10.1 O7 / C-19：归属按 feature_id 单查（详情路径只有一个 Feature，无 1+N 之虞）；
      // 可见性已由上面的 ownershipFailure 把关 ⇒ store 读口不必再带组过滤。无归属 ⇒ 空数组。
      projects: toAttributionView(featureProjectListByFeature(feature.featureId)),
      // R1 · orch-N7：阶段轮读面（纯读装配，见 {@link buildStageRuns}）
      stageRuns: buildStageRuns(feature),
      ...deriveStageDetail(feature),
    };
    return success;
  }
  // 列表路径：配组 ⇒ 只列本组 Feature（`owner_group = identity`，NULL 无归属被排除 = fail-closed）；
  // 无身份 ⇒ 全量（未配组 / web 运维视图）。
  const features = listFeatures({
    limit: 1000,
    ownerGroup: identity === null ? undefined : identity,
  });
  // v0.9.0 B3″：节点计数改**一条聚合 SQL**（`GROUP BY feature_id, state`，归属谓词与上面
  // `listFeatures` 同源）⇒ 列表读由「1 + N」降为 **O(1)**。`taskCount` 由 `stateCounts` 求和派生，
  // 与改前逐 Feature 的 `listFeatureTasks(...).length` 同值（对照断言见 `test/v090-o2-read-plane.test.ts`）。
  const counts = featureTaskStateCounts(identity === null ? undefined : identity);
  // v0.10.1 O7 / C-19：归属同样走**一条 SQL**（照上面 B3″ 先例，**不得**逐 Feature 查 ⇒ 查询数
  // 不随 Feature 数增长）；归属谓词与 `listFeatures` 同源（store 侧复用同一谓词）。
  const attributionRows = featureProjectListByFeatures(identity === null ? undefined : identity);
  const attributionsByFeature: Record<string, FeatureProjectAttributionItem[]> = {};
  for (const f of features) {
    attributionsByFeature[f.featureId] = toAttributionView(attributionRows.get(f.featureId) ?? []);
  }
  return {
    ok: true,
    features: features.map((f) => {
      const stateCounts = counts.get(f.featureId) ?? {};
      const taskCount = Object.values(stateCounts).reduce((sum, n) => sum + (n ?? 0), 0);
      return { ...f, taskCount, stateCounts };
    }),
    attributionsByFeature,
  };
}

// ---------------------------------------------------------------------------
// 阶段轮（R1 · v0.11.0 orch-N7）：三枚写口 + 读面 `stageRuns[]`
// ---------------------------------------------------------------------------

/**
 * **阶段轮写口错误码**（六枚，全部 `stage_*` 前缀）。
 *
 * ⚠️ 与主链五口**双重区隔**（改造文档 §2.5 门① 条：「错误码与描述须与既有 `approve` 双重区隔，
 * 防执行侧混用真推状态机」）：本组码**既不复用** `feature_approval_required` /
 * `feature_transition_invalid` / `feature_invalid_stage`，文案也**不出现**「审批 / 流转」字样 ——
 * 阶段面三枚写口一律**不改主链**，撞见主链码会让宿主误以为「这是那道门没开」。
 */
export const ERR_STAGE_ROUND_INVALID_STAGE = "stage_round_invalid_stage";
export const ERR_STAGE_ROUND_NO_MEMBERS = "stage_round_no_members";
export const ERR_STAGE_ROUND_TARGET_NOT_MEMBER = "stage_round_target_not_member";
export const ERR_STAGE_ROUND_OPEN_DIRTY = "stage_round_open_record_dirty";
export const ERR_STAGE_OBJECTION_FIELD_REQUIRED = "stage_objection_field_required";
export const ERR_STAGE_OBJECTION_INVALID_TARGET = "stage_objection_invalid_target";
export const ERR_STAGE_GATE1_INVALID_ROUND = "stage_gate1_invalid_round";
/**
 * **门① 确认的三枚校验码**（v0.11.0 orch-N6 · 裁决 A9：签名早已含 `docHash`，本节点补的是校验）：
 * 确认对象 = **当前文档版本** ⇒「本轮无格」「哈希对不上在册那枚」「版本对不上那枚」三种情形一律
 * **结构化拒**（不静默放过）。
 */
export const ERR_STAGE_GATE1_ROUND_NOT_FOUND = "stage_gate1_round_not_found";
export const ERR_STAGE_GATE1_DOC_HASH_MISMATCH = "stage_gate1_doc_hash_mismatch";
export const ERR_STAGE_GATE1_DOC_VERSION_MISMATCH = "stage_gate1_doc_version_mismatch";

/** 阶段轮行的 `contextId` 形态：一项目一轮一枚上下文（同轮续接、跨轮不复用） */
export function stageRowContextId(featureId: string, stage: FeatureStage, round: number, projectId: string): string {
  // 阶段名取 `FEATURE_STAGES` 序号（1..6）而非原值：`contextId` 会跨进程进机器侧的会话映射，
  // 全 ASCII 的键形免去「中文进文件名 / 日志检索」这一族不确定性，且值本身可由 `stage` 复原。
  const stageNo = FEATURE_STAGES.indexOf(stage) + 1;
  return `stage-${featureId}-s${String(stageNo)}-r${String(round)}-${projectId}`;
}

/** 物化落库的单行回执（`created` / `existing` 两栏共用形：本轮该成员的行 + 其 taskId） */
export interface StageRoundRowRef {
  projectId: string;
  taskId: string;
}

/** `stage_round_open` 入参（§2.5 签名五枚，`stage` 必填） */
export interface StageRoundOpenArgs {
  featureId: string;
  /** **闭集原值**（`FEATURE_STAGES`）；不得取 Feature 派生 `stage`（`waiting_approval` 派生为 null） */
  stage: string;
  sources?: readonly string[];
  targetProjects?: readonly string[];
  basisRevInput?: string | null;
}

/**
 * `stage_round_open` 成功出参（§2.5 四枚 + 两枚可观测附加）。
 *
 * - `created` = **本次真落库**的行（新 taskId 走完了 INSERT）；
 * - `existing` = 撞 `idx_tasks_stage_round` 后**读回**的既有行 ⇒ 纯重放时 `created=[]` /
 *   `existing=全员`，这两栏的分工就是判据 3 的证据形（「索引真拒重」而非「应用层跳过」）；
 * - `replayed` = 开轮事件本已在册（`idx_events_idempotency_key` 命中）⇒ 本轮**未新开**。
 */
export interface StageRoundOpenSuccess {
  ok: true;
  featureId: string;
  stage: FeatureStage;
  round: number;
  basisRev: string;
  docVersion: string | null;
  created: StageRoundRowRef[];
  existing: StageRoundRowRef[];
  replayed: boolean;
}

export type StageRoundOpenExit = StageRoundOpenSuccess | FeatureToolFailure;

/**
 * **开一轮**（§2.5 写口 1）：一次事务物化「本轮应收 = 本轮物化行」，**不改主链**。
 *
 * 幂等的**两道索引闩**（判据 3 要求「端到端走索引、不是应用层 `if`」，本函数据此成形）：
 * 1. `idx_events_idempotency_key` —— 开轮事件键 = `(featureId, stage, basisRev)`（内容定义，
 *    见 {@link stageRoundOpenKey}）⇒ **同一口径 = 同一轮**：重放必命中既有事件、拿到它的 `round`，
 *    而不是静默 +1 开出内容相同的第二轮；
 * 2. `idx_tasks_stage_round` —— 行键 = `(feature_id, stage, task_key, project_id, round)` ⇒
 *    物化**逐行真插**，已存在的行由**索引**拒（`isUniqueConstraintError` 是唯一被吞的错误类，
 *    其余原样上抛回滚事务）。本函数**不**先查「行在不在」再决定插不插 —— 那样判据 3 就没了。
 *
 * 应收集口径（§2.5 / §2.2）：`targetProjects` 缺省 ⇒ **本组全员**（含上轮答 `not_involved` 的，
 * **不预筛**）；给定 ⇒ 只物化那几位（定向轮），但仍必须是本组成员（否则整单拒、零写入）。
 * `reachability` 是**观测位**（读面现算，§2.5），与「要不要给它建行」正交 ⇒ 离线成员照样建行、
 * 照样计入分母。
 *
 * ⚠️ **本函数零派发**：只 `enqueueTask`（写 `queue_state='queued'` + `dispatch_guard` 入队幂等
 * 占位，§3.1「物化即写 dispatchGuard」）。唤起 Runner 是 I/O，留在 `bridge/index.ts` 的出口做
 * （本文件是纯数据层，不 import `index.js` —— 那是反向成环）。
 *
 * @param memberProjectIds 本组成员清单（由调用方经 machines 配置解析后传入：feature-tools 不读
 *   配置面，且 `identity → group` 的解析单点在 `bridge/index.ts#resolveEventScope` 同一条路上）
 */
export function handleStageRoundOpen(
  args: StageRoundOpenArgs,
  memberProjectIds: readonly string[],
  identity: string | null = null,
): StageRoundOpenExit {
  const feature = getFeature(args.featureId);
  if (feature === null) {
    return { ok: false, code: "feature_not_found", error: `未知 Feature ${args.featureId}` };
  }
  const denied = ownershipFailure(feature, identity);
  if (denied !== null) return denied;
  // `stage` 闭集 fail-fast（§2.1 点名：脏值会让整条读口的 `readTaskStage` 炸掉 ⇒ 必须在写前拒）
  if (!isFeatureStage(args.stage)) {
    return {
      ok: false,
      code: ERR_STAGE_ROUND_INVALID_STAGE,
      error:
        `阶段轮入参 \`stage\`=${JSON.stringify(args.stage)} 越出 FEATURE_STAGES 闭集（${FEATURE_STAGES.join(" / ")}）：` +
        `本口**必须显式传闭集原值**，不得取 Feature 的派生 stage（waiting_approval 派生为 null），也不得自造阶段名。`,
    };
  }
  const stage = args.stage;
  const members = Array.from(new Set(memberProjectIds.filter((p) => p.trim() !== ""))).sort();
  if (members.length === 0) {
    return {
      ok: false,
      code: ERR_STAGE_ROUND_NO_MEMBERS,
      error: `Feature ${args.featureId} 的本组成员清单为空 ⇒ 阶段轮无应收对象，不开空轮（应收集恒等于本轮物化行，零成员即零行）。`,
    };
  }
  const requested = args.targetProjects === undefined || args.targetProjects.length === 0
    ? members
    : Array.from(new Set(args.targetProjects)).sort();
  const strays = requested.filter((p) => !members.includes(p));
  if (strays.length > 0) {
    return {
      ok: false,
      code: ERR_STAGE_ROUND_TARGET_NOT_MEMBER,
      error:
        `定向轮的 targetProjects 越出本组成员：${strays.join(", ")}（本组成员 = ${members.join(", ")}）⇒ ` +
        `整单拒绝、零写入（不部分物化：半轮没有可核对的应收集）。`,
    };
  }
  const basisRev = computeBasisRev({
    requirement: feature.requirement,
    memberProjectIds: members,
    stage,
    ...(args.basisRevInput !== undefined ? { basisRevInput: args.basisRevInput } : {}),
  });
  const docVersion = (args.basisRevInput ?? "").trim() === "" ? null : (args.basisRevInput ?? "").trim();
  const suppliedSources = (args.sources ?? []).filter((s) => s.trim() !== "");
  // 尚未被后续开轮接续的异议自动并入 sources；新 docVersion 正是旧异议的接续轮，
  // 故这里跨版本收集，不要求异议版本与新轮版本相同。每条都保留段落定位与正文。
  const objectionSources =
    docVersion === null
      ? []
      : unresolvedDocObjections(readAllFeatureEvents(feature.featureId)).map(
          (objection) => `${objection.sectionId}：${objection.objectionText}`,
        );
  const sources = Array.from(new Set([...suppliedSources, ...objectionSources]));
  const key = stageRoundOpenKey(feature.featureId, stage, basisRev);

  // —— 闩①：开轮事件（= 本轮口径的登记处，也是「同一口径 = 同一轮」的裁决处）
  const readRound = (): { round: number; replayed: boolean } | FeatureToolFailure => {
    const hit = getEventByIdempotencyKey(key);
    const parsed = parseStageRoundOpenPayload(hit?.payload ?? null);
    if (hit === null || parsed === null) {
      return {
        ok: false,
        code: ERR_STAGE_ROUND_OPEN_DIRTY,
        error: `开轮登记（kind=${EVENT_STAGE_ROUND_OPEN}）在幂等键 ${key} 上缺失或 payload 不可解析 ⇒ 拒绝物化（不猜轮次，猜错会写出一整轮脏行）。`,
      };
    }
    return { round: parsed.round, replayed: true };
  };
  let round: number;
  let replayed: boolean;
  const existingEvent = getEventByIdempotencyKey(key);
  if (existingEvent !== null) {
    const resolved = readRound();
    if ("ok" in resolved && resolved.ok === false) return resolved;
    round = (resolved as { round: number }).round;
    replayed = true;
  } else {
    const candidate = maxStageRound(listStageRows(feature.featureId), stage) + 1;
    const payload: StageRoundOpenPayload = {
      featureId: feature.featureId,
      stage,
      round: candidate,
      basisRev,
      docVersion,
      sources,
      targetProjects: requested,
    };
    try {
      appendEvent({
        featureId: feature.featureId,
        taskId: null,
        kind: EVENT_STAGE_ROUND_OPEN,
        // `state` 列既有语义 = 「变化后的状态串」；开轮不是状态变化 ⇒ 恒 NULL（不冒充态）
        state: null,
        payload: stageRoundOpenPayload(payload),
        idempotencyKey: key,
      });
      round = candidate;
      replayed = false;
    } catch (err) {
      // 并发窗口：另一路同口径的开轮刚写了事件 ⇒ 与本口 `existingEvent !== null` 同解（返回既有轮）
      if (!isUniqueConstraintError(err)) throw err;
      const resolved = readRound();
      if ("ok" in resolved && resolved.ok === false) return resolved;
      round = (resolved as { round: number }).round;
      replayed = true;
    }
  }

  // —— 闩②：逐行真插（同轮同键已存在 ⇒ partial 唯一索引拒；本函数不预判、不跳过）
  const store = getDefaultStore();
  const created: StageRoundRowRef[] = [];
  const existing: StageRoundRowRef[] = [];
  store.runInTransaction(() => {
    for (const projectId of requested) {
      const taskId = randomUUID();
      const message = buildStageRowMessage({
        featureId: feature.featureId,
        title: feature.title,
        requirement: feature.requirement,
        stage,
        round,
        projectId,
        basisRev,
        sources,
      });
      try {
        createTask({
          taskId,
          projectId,
          contextId: stageRowContextId(feature.featureId, stage, round, projectId),
          state: "working",
          featureId: feature.featureId,
          // 通道位 = `stage`（§2.1：不复用 `inquiry` —— 那条会被 v0.10.8「待澄清收口」谓词
          // 把上一轮挂起的行自动置 completed，直接击穿「长期 pending 可见」）
          mode: "stage",
          // PM 三值回执是只读语义 ⇒ 恒 read 档（与 inquiry 的 O-N4 同一条理由）
          lane: "read",
          taskType: "product_manager",
          stage,
          taskKey: STAGE_ROUND_TASK_KEY,
          round,
          // 三值初态 = `pending`（§2.1 写入者列：物化写 `relevance` / `answer_state` 的缺省档）
          relevance: "pending",
          answerState: "pending",
          // 本轮口径指纹（`stale` 派生的唯一基准，§2.4）
          basedOnRev: basisRev,
          prompt: message,
          dispatchMessage: message,
        });
        created.push({ projectId, taskId });
      } catch (err) {
        if (!isUniqueConstraintError(err)) throw err;
        const hit = listStageRoundRows(feature.featureId, stage, round).find(
          (row) => row.projectId === projectId,
        );
        if (hit !== undefined) existing.push({ projectId, taskId: hit.taskId });
      }
    }
  });

  // —— 入队（事务外，照 `dispatchTask` ④ 的先例：体内不跨长 I/O 持锁）
  for (const row of created) enqueueTask(row.taskId);

  return {
    ok: true,
    featureId: feature.featureId,
    stage,
    round,
    basisRev,
    docVersion,
    created,
    existing,
    replayed,
  };
}

/** `doc_objection` 入参（§2.5 写口 2 签名七枚） */
export interface DocObjectionArgs {
  featureId: string;
  docVersion: string;
  sectionId: string;
  objectionText: string;
  /** 闭集见 {@link STAGE_OBJECTION_TARGETS}；缺省由 `projectIds` 推导 */
  targetType?: string | null;
  projectIds?: readonly string[];
}

/**
 * `doc_objection` 成功出参（§2.5 两枚 + 留痕可观测三枚）。
 * `staleRevPending` = **本次被异议的那个版本上，是否已有一轮答复**（口径漂移的提示位）：
 * `true` ⇒ 该版本上已开的轮需要在新口径上重答 ⇒ **提示**宿主重开一轮；本口**不自动开轮**
 * （§2.4 末句 + §2.5 签名条），也不动任何行的 `answer_state`。
 */
export interface DocObjectionSuccess {
  ok: true;
  featureId: string;
  docVersion: string;
  sectionId: string;
  objectionId: string;
  targetType: StageObjectionTarget;
  staleRevPending: boolean;
  replayed: boolean;
}

export type DocObjectionExit = DocObjectionSuccess | FeatureToolFailure;

/**
 * **记一段异议**（§2.5 写口 2）：只落一枚 `stage.doc_objection` 事件，**不自动开轮**、
 * **不触主链**、不改任何阶段行。
 *
 * 幂等 = §2.5 点名的 `(docVersion, sectionId, objectionId)`：签名里没有 `objectionId` 入参 ⇒
 * 由**异议正文内容**派生（{@link stageObjectionIdOf}），同段同文必得同一 id ⇒
 * `idx_events_idempotency_key` 真拒重（重放返回同一枚留痕、`replayed=true`，不新写一条）。
 */
export function handleDocObjection(args: DocObjectionArgs, identity: string | null = null): DocObjectionExit {
  const feature = getFeature(args.featureId);
  if (feature === null) {
    return { ok: false, code: "feature_not_found", error: `未知 Feature ${args.featureId}` };
  }
  const denied = ownershipFailure(feature, identity);
  if (denied !== null) return denied;
  const docVersion = args.docVersion.trim();
  const sectionId = args.sectionId.trim();
  const objectionText = args.objectionText.trim();
  if (docVersion === "" || sectionId === "" || objectionText === "") {
    return {
      ok: false,
      code: ERR_STAGE_OBJECTION_FIELD_REQUIRED,
      error: `doc_objection 的 docVersion / sectionId / objectionText 三枚均必填非空（收到 docVersion=${JSON.stringify(docVersion)} sectionId=${JSON.stringify(sectionId)} objectionText=${objectionText === "" ? "空" : "非空"}）：确认对象是**具体版本的具体段落**，缺一枚就无法定位被异议的依据。`,
    };
  }
  const projectIds = Array.from(
    new Set((args.projectIds ?? []).map((p) => p.trim()).filter((p) => p !== "")),
  ).sort();
  let targetType: StageObjectionTarget;
  if (args.targetType === undefined || args.targetType === null || args.targetType.trim() === "") {
    targetType = projectIds.length > 0 ? "project" : "basis";
  } else {
    const given = args.targetType.trim();
    if (!(STAGE_OBJECTION_TARGETS as readonly string[]).includes(given)) {
      return {
        ok: false,
        code: ERR_STAGE_OBJECTION_INVALID_TARGET,
        error: `targetType=${JSON.stringify(given)} 越出闭集（${STAGE_OBJECTION_TARGETS.join(" / ")}）：值域归引擎，板侧只原样转发。`,
      };
    }
    targetType = given as StageObjectionTarget;
  }
  const objectionId = stageObjectionIdOf(objectionText);
  const key = stageDocObjectionKey(feature.featureId, docVersion, sectionId, objectionId);
  let replayed = getEventByIdempotencyKey(key) !== null;
  if (!replayed) {
    try {
      appendEvent({
        featureId: feature.featureId,
        taskId: null,
        kind: EVENT_STAGE_DOC_OBJECTION,
        state: null,
        // camelCase 单形（§2.5 命名条）；`raisedAt` 由调用方给串，缺省交 store 补落库时刻
        payload: JSON.stringify({
          featureId: feature.featureId,
          docVersion,
          sectionId,
          objectionId,
          objectionText,
          targetType,
          projectIds,
        }),
        idempotencyKey: key,
      });
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      replayed = true; // 并发同键：与 pre 命中同解（一条留痕，不双写）
    }
  }
  // 提示位：该版本上**已有轮次**在答 ⇒ 口径漂移需重开（本口只提示，不开轮）
  const staleRevPending = buildStageRuns(feature).some((cell) => cell.docVersion === docVersion);
  return {
    ok: true,
    featureId: feature.featureId,
    docVersion,
    sectionId,
    objectionId,
    targetType,
    staleRevPending,
    replayed,
  };
}

/** `gate1_confirm` 入参（§2.5 写口 3 签名三枚 + N6 增补的可选 `docVersion`） */
export interface Gate1ConfirmArgs {
  featureId: string;
  round: number;
  docHash: string;
  /**
   * 被确认的确认单版本（A7 冻结口径 `docVersion = v{round}`）。**可缺省** ⇒ 本口按 `v{round}`
   * 归一后照做等价校验：板侧漏传不会退化成「只认哈希」，只会认「那一轮的当前版」。
   */
  docVersion?: string | null;
  /**
   * 可选 Group Version。传入即请求“确认并过门”：在同一事务内写排期、确认留痕并迁
   * `需求分析 → 改造方案`；省略时保持既有“只确认、不推进”的行为。
   */
  version?: string;
}

/** 传 `version` 但本次未迁移阶段时的结构化原因（缺哪报哪）。 */
export interface Gate1AdvanceReason {
  code: string;
  error: string;
  missing: "version" | "sealed_round" | "confirmation_doc" | "stage";
}

/** `gate1_confirm` 成功出参（`confirmedAt` = **首次**确认时刻，重放不改写） */
export interface Gate1ConfirmSuccess {
  ok: true;
  featureId: string;
  /** 命中合成行所在阶段（`round` 可跨阶段重号 ⇒ 回给调用方指名是哪一格） */
  stage: FeatureStage;
  round: number;
  /** 校验通过的版本号（缺省入参经 `v{round}` 归一后的现值） */
  docVersion: string;
  docHash: string;
  confirmedAt: string;
  replayed: boolean;
  /** 本次是否真的把 Feature 阶段迁入「改造方案」；仅传 `version` 时下发。 */
  stageAdvanced?: boolean;
  /** 确认/排期后 Feature 的阶段；仅传 `version` 时下发。 */
  featureStage?: FeatureStage;
  /** 本次未推进时的结构化原因；仅传 `version` 时可能出现。 */
  reason?: Gate1AdvanceReason;
  /** 本次确认绑定并落库的 Group Version；仅传 `version` 时下发。 */
  version?: string;
}

export type Gate1ConfirmExit = Gate1ConfirmSuccess | FeatureToolFailure;

/**
 * **门① 确认留痕**（§2.5 写口 3）：校验通过 ⇒ 写一枚 `stage.gate1_confirm` 事件 + 把确认落到
 * 当轮合成行的 `confirmed_doc_hash` / `confirmed_at`，**只记录、不流转**。
 *
 * ★ 判据 2 的静态锚 = 本函数体（含其调用的每一枚被调函数）**零状态机触达**：只读 `features`
 * 一行做归属校验、只写 `events` 与那一枚 `tasks` 合成行。真推进仍走 `a2a_feature_approve`
 * —— 两口错误码与文案互不复用（见 {@link ERR_STAGE_GATE1_INVALID_ROUND} 组），防执行侧混用。
 *
 * **N6 补的三枚断言**（裁决 A9）：本轮格必须在册、`docHash` 必等于该在册合成行的 `doc_hash`、
 * `docVersion`（缺省按 `v{round}` 归一）必等于那一行正文头部 ⇒ 任一不符**结构化拒**（不留痕、
 * 不落列）。「确认了一份没在册的文档」因此在机制上不可能。
 *
 * 幂等 = `(featureId, round, docHash)`：同一版确认两次 ⇒ 同一串 ⇒ 索引真拒重 ⇒ 返回**首次**那条
 * 事件的 `created_at`（`confirmedAt` 稳定；落列侧另有一道同值守卫）。
 */
export function handleGate1Confirm(args: Gate1ConfirmArgs, identity: string | null = null): Gate1ConfirmExit {
  const feature = getFeature(args.featureId);
  if (feature === null) {
    return { ok: false, code: "feature_not_found", error: `未知 Feature ${args.featureId}` };
  }
  const denied = ownershipFailure(feature, identity);
  if (denied !== null) return denied;
  if (!Number.isInteger(args.round) || args.round < 1) {
    return {
      ok: false,
      code: ERR_STAGE_GATE1_INVALID_ROUND,
      error: `round=${String(args.round)} 不是正整数（阶段轮次从 1 起，§2.1 round 值域）：确认必须指向一格具体的轮，不接受 0 / 负数 / 小数。`,
    };
  }
  const docHash = args.docHash.trim();
  if (docHash === "") {
    return {
      ok: false,
      code: ERR_STAGE_OBJECTION_FIELD_REQUIRED,
      error: "gate1_confirm 的 docHash 必填非空：确认对象是**具体版本**（§5 用户语言 4），空哈希等于「确认了一份不存在的文档」。",
    };
  }
  // `docVersion` 缺省 = 按 A7 冻结口径 `v{round}` 归一（给了就原样 trim，不做二次推导）
  const given = args.docVersion?.trim() ?? "";
  const docVersion = given === "" ? synthesisDocVersion(args.round) : given;
  // 断言 1 · 本轮格必须在册（合成行 = 当轮文档的唯一登记处）
  const rows = listStageSynthesisRows(feature.featureId).filter((row) => row.round === args.round);
  if (rows.length === 0) {
    return {
      ok: false,
      code: ERR_STAGE_GATE1_ROUND_NOT_FOUND,
      error: `第 ${String(args.round)} 轮在本 Feature 没有在册的合成行（引擎尚未产出本轮《需求确认单》）：确认只能指向「已产出」的那一版，无格可确认 ⇒ 拒。`,
    };
  }
  // 断言 2 · docHash 必等于在册那一枚（`round` 可跨阶段重号 ⇒ 逐格比到命中为止）
  const hit = rows.find((row) => (row.docHash ?? "").trim() === docHash) ?? null;
  if (hit === null) {
    return {
      ok: false,
      code: ERR_STAGE_GATE1_DOC_HASH_MISMATCH,
      error:
        `docHash=${docHash} 不等于第 ${String(args.round)} 轮在册合成行的 doc_hash（在册 = ` +
        `${rows.map((row) => row.docHash ?? "无").join(" / ")}）：文档已换版或传入的是另一版的哈希，` +
        "确认必须先对齐**当前在册那一版**（§5 用户语言 4）。",
    };
  }
  // 断言 3 · docVersion 必等于那一行正文头部（正文不可读 ⇒ 无从确认，一并拒）
  const onFile = parseStageSynthesisDocVersion(hit.synthesisJson);
  if (onFile !== docVersion) {
    return {
      ok: false,
      code: ERR_STAGE_GATE1_DOC_VERSION_MISMATCH,
      error:
        `docVersion=${docVersion} 与第 ${String(args.round)} 轮在册确认单的版本不符（在册 = ` +
        `${onFile ?? "无（正文未在册）"}）：版本口径归引擎（A7 ` +
        "`docVersion = v{round}`），板侧不得自造版本号。",
    };
  }
  const key = stageGate1ConfirmKey(feature.featureId, args.round, docHash);
  const { stage } = hit;
  const advanceRequested = args.version !== undefined;
  const version = (args.version ?? "").trim();

  // 传入 version 时先完成“可排期”判据；任一不过都在任何写入之前拒，保持零写入。
  if (advanceRequested && version !== "") {
    if (!isVersionShapeValid(version)) {
      return {
        ok: false,
        code: "feature_invalid_version_shape",
        error: `非法 version "${version}"：期望 semver 形状 vX.Y.Z（可省 v、可带 -prerelease/+build）`,
      };
    }
    const ledger = versionLedgerHas(feature.ownerGroup, version);
    if (ledger.ledgerReady && !ledger.exists) {
      return {
        ok: false,
        code: "orch_version_unknown",
        error:
          `version "${version}" 不在引擎版本台账（owner_group=` +
          `${feature.ownerGroup === null ? "NULL" : `"${feature.ownerGroup}"`}）：` +
          "先建版或改传台账内版号；本次零写入。",
      };
    }
    const status = versionLedgerStatus(feature.ownerGroup, version);
    if (status.ledgerReady && status.status === "released") {
      return {
        ok: false,
        code: "orch_version_released_locked",
        error: `version "${version}" 已在版本台账 released ⇒ 不可排入或据此过门；本次零写入。`,
      };
    }
  }

  // 异议互斥：同 docVersion 的异议若尚未被后续开轮接续，确认整单拒绝且零写入。
  const pendingObjections = unresolvedDocObjections(
    readAllFeatureEvents(feature.featureId),
    docVersion,
  );
  if (pendingObjections.length > 0) {
    return {
      ok: false,
      code: "stage_objection_pending",
      error:
        `docVersion=${docVersion} 存在 ${String(pendingObjections.length)} 条未处置异议` +
        `（${pendingObjections.map((item) => item.sectionId).join(", ")}）：` +
        "先记录修正并开新一轮，使异议被新轮 basisRev/docVersion 接续后再确认；本次零写入。",
    };
  }

  const sealedRound = gate1SettledRound(feature);
  const docPresent = gate1DocPresent(feature) !== null;
  const advanceReason: Gate1AdvanceReason | null = !advanceRequested || feature.stage !== "需求分析"
    ? {
        code: "stage_gate1_stage_not_requirement_analysis",
        error:
          `Feature 当前阶段为「${feature.stage}」，本次不重复推进；` +
          "传 version 的过门仅从「需求分析」迁往「改造方案」。",
        missing: "stage",
      }
    : version === ""
      ? {
          code: ERR_GROUP_VERSION_REQUIRED,
          error: "version 为空（未排期）⇒ 本次只确认，不推进阶段；请传版本台账内非空版号。",
          missing: "version",
        }
      : !docPresent
        ? {
            code: ERR_CONFIRMATION_DOC_REQUIRED,
            error: "《需求确认单》未登记（decisions 档名与合成行双档均未命中）⇒ 本次不推进阶段。",
            missing: "confirmation_doc",
          }
        : sealedRound === null
          ? {
              code: ERR_STAGE_ROUND_REQUIRED,
              error: "「需求分析」尚无 settled=true 的阶段轮（轮未封口）⇒ 本次不推进阶段。",
              missing: "sealed_round",
            }
          : null;
  const shouldAdvance = advanceRequested && advanceReason === null;

  const store = getDefaultStore();
  const outcome = store.runInTransaction(() => {
    const pre = getEventByIdempotencyKey(key);
    let confirmedAt: string;
    let replayed: boolean;
    if (pre !== null) {
      confirmedAt = pre.createdAt;
      replayed = true;
    } else {
      let event: EventRecord;
      try {
        event = appendEvent({
          featureId: feature.featureId,
          taskId: null,
          kind: EVENT_STAGE_GATE1_CONFIRM,
          state: null,
          payload: JSON.stringify({
            featureId: feature.featureId,
            round: args.round,
            docHash,
            featureState: feature.state,
            ...(advanceRequested ? { version, stageAdvanced: shouldAdvance } : {}),
          }),
          idempotencyKey: key,
        });
        confirmedAt = event.createdAt;
        replayed = false;
      } catch (err) {
        if (!isUniqueConstraintError(err)) throw err;
        const concurrent = getEventByIdempotencyKey(key);
        if (concurrent === null) throw err;
        confirmedAt = concurrent.createdAt;
        replayed = true;
      }
    }
    // 留痕与列值同事务；重放时同值守卫不改首次确认时刻。
    confirmStageSynthesis(hit.taskId, docHash, confirmedAt);
    if (shouldAdvance) {
      updateFeatureRegistration(feature.featureId, {
        version,
        stage: "改造方案",
      });
    }
    const stored = getFeature(feature.featureId) ?? feature;
    return { confirmedAt, replayed, stored };
  });

  const success: Gate1ConfirmSuccess = {
    ok: true,
    featureId: feature.featureId,
    stage,
    round: args.round,
    docVersion,
    docHash,
    confirmedAt: outcome.confirmedAt,
    replayed: outcome.replayed,
  };
  if (advanceRequested) {
    success.stageAdvanced = shouldAdvance;
    success.featureStage = outcome.stored.stage;
    success.version = version;
    if (advanceReason !== null) success.reason = advanceReason;
  }
  return success;
}

/**
 * **读面装配**（§2.5 `stageRuns[]`）—— ★ **纯读**（判据 4）：只走五枚读口
 * （{@link listStageRows} / {@link listStageSynthesisRows} / {@link listEvents} /
 * {@link listRunners} / {@link listRunnerProjects}），**零写**：
 * `listStageRows` 因此**刻意不接** `warnIfListTruncated`（那条触顶会 `appendEvent` 写一条
 * `list.truncated`，读面带写 = 断言破功）；`listEvents` 走 store 的纯读过滤侧，
 * **不碰** `a2a_events` 的按身份游标（那条会推进游标、静默吃掉宿主的事件）。
 *
 * 口径单点：分子/分母、`settled` 三态、`unanswered[]`、`allowedActions[]` 全在
 * `bridge/stage-round.ts` 里算（与 N4 结算钩子、N8 收口判定器**共用同一条** §2.2 判据）；
 * 本函数只做「取行 → 分组 → 装配」，**不再算第二份判据**。
 *
 * `basisRev` / `docVersion` 取值序（强档在前）：开轮事件 payload → 行集众数推断
 * （{@link resolveStageRoundBasisRev}，N8 的弱档）→ `""`（无从判定，板侧照实显形、不猜）。
 */
export function buildStageRuns(feature: FeatureRecord): StageRunCellView[] {
  const rows = listStageRows(feature.featureId);
  const groups = groupStageRoundRows(rows);
  const events = readAllFeatureEvents(feature.featureId);
  // 本轮口径的**强档凭据**：开轮事件（`tasks.based_on_rev` 会被回执覆写，事件不会）
  const opens = new Map<string, StageRoundOpenPayload>();
  for (const e of events) {
    if (e.kind !== EVENT_STAGE_ROUND_OPEN) continue;
    const parsed = parseStageRoundOpenPayload(e.payload);
    if (parsed !== null && parsed.featureId === feature.featureId) {
      opens.set(stageRoundKey(parsed.stage, parsed.round), parsed);
    }
  }
  const runners = listRunners();
  const projectsByRunner = new Map<string, ReturnType<typeof listRunnerProjects>>();
  for (const runner of runners) projectsByRunner.set(runner.runnerId, listRunnerProjects(runner.runnerId));
  const reachabilityOf = (projectId: string) =>
    projectStageReachability(projectId, runners, projectsByRunner);
  // 合成行按 `(stage, round)` 挂格（N5 · A8）：一格至多一枚（partial 唯一索引保证），取不到 ⇒ null。
  const synthesisByKey = new Map<string, ReturnType<typeof listStageSynthesisRows>[number]>();
  // 轮次谱系 = 行集 ∪ 开轮事件 ∪ 合成行去重后的 `(stage, round)` 数（进 `synthesis.rounds`）。
  const roundsOfStage = new Map<string, Set<number>>();
  const noteRound = (stage: string, round: number): void => {
    const set = roundsOfStage.get(stage) ?? new Set<number>();
    set.add(round);
    roundsOfStage.set(stage, set);
  };
  for (const group of groups) noteRound(group.stage, group.round);
  for (const open of opens.values()) noteRound(open.stage, open.round);
  for (const row of listStageSynthesisRows(feature.featureId)) {
    synthesisByKey.set(stageRoundKey(row.stage, row.round), row);
    noteRound(row.stage, row.round);
  }
  const synthesisOf = (stage: string, round: number) => {
    const row = synthesisByKey.get(stageRoundKey(stage, round));
    return row === undefined ? null : { row, rounds: roundsOfStage.get(stage)?.size ?? 0 };
  };
  const cells: StageRunCellView[] = [];
  const covered = new Set<string>();
  for (const group of groups) {
    const key = stageRoundKey(group.stage, group.round);
    covered.add(key);
    const open = opens.get(key);
    cells.push(
      buildStageRunCell({
        stage: group.stage,
        round: group.round,
        basisRev: open?.basisRev ?? resolveStageRoundBasisRev(group.rows) ?? "",
        docVersion: open !== undefined ? open.docVersion : null,
        rows: group.rows,
        reachabilityOf,
        synthesis: synthesisOf(group.stage, group.round),
        events,
      }),
    );
  }
  // 开轮在册、行集为空（崩在物化前半 / 手工删过行）⇒ 仍出一格（`expected=0` + `settled=null`）：
  // 「一轮存在但没收齐任何东西」必须可见，不许从读面凭空消失。
  for (const [key, open] of opens) {
    if (covered.has(key)) continue;
    cells.push(
      buildStageRunCell({
        stage: open.stage,
        round: open.round,
        basisRev: open.basisRev,
        docVersion: open.docVersion,
        rows: [],
        reachabilityOf,
        synthesis: synthesisOf(open.stage, open.round),
        events,
      }),
    );
  }
  // 格序 = (stage, round) 升序（旧轮在前、本轮在末位）；`groupStageRoundRows` 已按行集排好，
  // 事件补的空格可能插在任何位置 ⇒ 这里统一再排一次（出参确定性不取决于 Map 插入序）。
  return cells.sort((a, b) =>
    a.stage === b.stage ? a.round - b.round : a.stage < b.stage ? -1 : 1,
  );
}

/**
 * **门① 第三前提「需求分析至少收口一轮」判据单点**（v0.11.0 O1）—— ★ **与读面同源**：
 * 直接吃 {@link buildStageRuns} 的格（= `a2a_feature_status.stageRuns[]` 那一份装配，同一趟
 * `listStageRows` + `groupStageRoundRows`），整格 `settled` 由 `bridge/stage-round.ts` 的
 * {@link isQualifiedStageRow} 单点决定 ⇒ **执法面看到的「收没收到」与板上看到的逐字一致**，
 * 不引入第二套收口判据、不引新表、**不读 synthesis、不看 `confirmedDocHash`**。
 *
 * 取值 = 最小的满足 `round ≥ 1 ∧ settled === true` 的「需求分析」轮次（**任意一轮即可**，
 * 轮次数量不设上限判据）；一格都没有 / 有格但全未收口 / 零行格（`settled = null` 三态）
 * ⇒ `null`（**空集合不构成一轮**，与 {@link buildStageRunCell} 的「零行 ⇒ null 而不是 true」同锁）。
 */
export function gate1SettledRound(feature: FeatureRecord): number | null {
  for (const cell of buildStageRuns(feature)) {
    if (cell.stage === "需求分析" && cell.round >= 1 && cell.settled === true) return cell.round;
  }
  return null;
}

// ---------------------------------------------------------------------------
// advance
// ---------------------------------------------------------------------------

/**
 * `advance` 入参（v0.9.0 起 `extends RegistrationInput`）。
 *
 * **登记字段写入**（`stage` / `version` / `approval`，见 {@link parseRegistration}）：
 *
 * - **additive**：三者全省略 = 既有行为逐字不变；
 * - `to` **等于当前态** ∧ 带任一登记字段 ⇒ 走**显式特例**（同 `retryTaskIds` 先例：跳过
 *   `canTransition`，转移表**零改动**、不出现自环），**只写登记、不动主链**；
 * - 特例**不加终态守卫**（否则 `completed` 后永远写不进 `发版`）；
 * - 非法值 ⇒ `feature_invalid_stage` / `feature_invalid_approval`（**在任何写入之前**拒绝）；
 * - **门① `version` 守卫（v0.10.5 O4）**：`stage` 由「需求分析」外迁时 `features.version` 非空是
 *   **前提** —— 未排期 ⇒ `feature_group_version_required`，整单拒绝、零写入（判据见
 *   {@link handleFeatureAdvance} 内的守卫条）。
 */
export interface FeatureAdvanceArgs extends RegistrationInput {
  featureId: string;
  to: string;
  /** 统一方案 / 备注：落 Feature Context 的 `plan`（供审批与派发注入） */
  note?: string;
  /** 决策记录（JSON 字符串；落 Feature Context 的 `decisions`） */
  decisions?: string;
  /** 契约（JSON 字符串；落 Feature Context 的 `contracts`） */
  contracts?: string;
  /** needs_input 补齐：以同 contextId 续接待澄清任务 */
  answer?: string;
  /**
   * **重派与解冻**（REQ-v0.6.1-2026-09-17-05 §2.3）：给一组**本 Feature 内当前 `failed`** 的节点 id。
   *
   * - **additive**：省略 = 既有行为（状态机正常流转路径）完全不变；
   * - 非空 ⇒ 走**显式特例**（跳过 `canTransition`，`TRANSITIONS` **不加自环**），`to` 必须显式
   *   `"executing"`；与 `answer` **互斥**；
   * - 空数组 / 任一 id 非法（未知 / 非 `failed` / 重复）⇒ `feature_nothing_to_resume`（**整单拒绝**，
   *   不做部分重派，Feature 态不变）。
   */
  retryTaskIds?: string[];
  /**
   * **归属（承诺集）写**（v0.10.1 O3 / C-17）：本需求触达哪些 project、各自落哪个 Project Version。
   *
   * - **additive**：省略 = 既有行为逐字不变；
   * - **独立分支**：`projectVersions` **非空**即触发归属写；`to` **等于当前态**时该分支**跳过
   *   `canTransition`**（照 `retryTaskIds` 先例，转移表零改动、不出现自环）—— 否则「只补归属」的
   *   调用会落进 `executing → executing` 被判非法；`to` 为合法后继时归属写与主链迁移**同单生效**；
   * - **不要求同单携带登记字段**、**不入 {@link hasRegistration} 判据**（★R3：塞进去会污染既有登记语义）；
   * - **全量重发**（C-3 ★R3）：每次带的是该需求的全量承诺集，同值幂等 ⇒ 重发安全；
   * - 判据不过 ⇒ **整单拒绝在任何写入之前**（★N-8「归属拒 ⇒ 主链零迁移」）；
   * - 空数组 = **零写 no-op**（不是「清空归属」，撤销承诺是显式删行）。
   */
  projectVersions?: ProjectVersionAdvanceItem[];
}

/**
 * MCP `a2a_feature_advance` 入参 `projectVersions[]` 的**单条形状**（C-17 写面形态）。
 *
 * 与 O2 执法面的 {@link ProjectVersionAttribution} 差一个键名（`version` → `projectVersion`）：
 * 顶层 `version` 在 `advance` 里**已被 Group Version 登记字段占用**，归属项的版号在入参里叫
 * `version`、在落库侧叫 `projectVersion`，由本节点做映射（不做双键兼容，避免两个事实源）。
 *
 * `groupVersion` / `ownerGroup` **不在入参里** —— 由 Feature 当前记录派生（C-21，见
 * {@link ProjectVersionAttribution}）。
 */
export interface ProjectVersionAdvanceItem {
  projectId: string;
  /** 该 project 的 **Project Version**（落 O2 执法时映射为 `projectVersion`） */
  version: string;
  /**
   * **接受即忽略**：归属表无 `repo_id` / `ref` 列（C-16 列面），二者只在**交付快照回读**方向存在
   * （C-5：由发版意图带入、不回查注册表）⇒ 本入参不持久化、不校验其内容。
   */
  repoId?: string;
  ref?: string;
}

/** 入参形状 → O2 执法面形状（`repoId` / `ref` 到此为止，不落库） */
function toAttributionWrites(
  items: readonly ProjectVersionAdvanceItem[],
): ProjectVersionAttribution[] {
  return items.map((item) => ({ projectId: item.projectId, projectVersion: item.version }));
}

/**
 * 归属写落笔 + 出参回显（v0.10.1 O3）—— 三条 `advance` 路径共用。
 *
 * **校验已在任何写入之前完成**（{@link checkFeatureAttributionWrites} 经
 * {@link applyFeatureAttributions} 内部再跑一遍，判据唯一、零第二套），本函数只负责
 * 「全量重发 + 把三档计数挂进出参」。
 */
function writeAttribution<T extends FeatureAdvanceSuccess>(
  success: T,
  args: AttributionWriteArgs,
  identity: string | null,
): T | FeatureToolFailure {
  const written = applyFeatureAttributions(args, identity);
  if (written.ok === false) return written;
  success.attribution = { created: written.created, updated: written.updated, noop: written.noop };
  return success;
}

// ---------------------------------------------------------------------------
// **本阶段明细**（增补 `6cc46dd2` N2 · 派生单源）
//
// 本块只是「派生单源」：类型 + 文案表 + 纯函数。**接线归 N3/N4/N5** —— 各成功出口
// （`advance` 四出口 / `create` / `approve` / `feature_status` 单查）在此之后才装配这七枚，
// `FeatureStateChangeSuccess`（`cancel` 共用）逐字不动。
// ---------------------------------------------------------------------------

/**
 * 「本阶段还差哪件**登记欠账**」的枚名（增补 `6cc46dd2` N2；推导输入五维 = `state`·`stage`·
 * `approval`·`version`·**`decisions`**）。
 *
 * 五枚分两族（归向按枚点名，见 {@link PENDING_HOST_SIDE_ITEMS} / {@link PENDING_USER_CREDENTIAL_ITEMS}）：
 * 新增枚名**必须**同轮归入这两族之一，否则 `actor` 归向静默落错。
 */
export type FeaturePendingItem =
  "requirement-doc" | "version" | "stage" | "design-doc" | "approval";

/**
 * 两道用户门的机器名（增补 `6cc46dd2` N2）：`gate1` = **需求确认门**（「我理解你要解决的是不是
 * 这个问题」）· `gate2` = **改造文档确认门**（`approve` 唯一准入）。
 */
export type FeatureGateId = "gate1" | "gate2";

/**
 * **本阶段（推进后）的推动方 / 执行方**（增补 `6cc46dd2` N2 · **★确认单 v22 用户更正**：
 * 旧措辞「当前卡在谁那儿 / 等谁」**作废**；取值枚举与推导式不变）。
 *
 * 三值对应 flow `引擎映射.md` §2 表「驱动方」列的 宿主 / 用户 / 引擎 ⇒ `actor` 是该列的**同源投影**，
 * **不新增语义**；但它是**单值投影**（§2 表存在复合值「宿主（+ 用户确认）」与「主链不推进」行）
 * ⇒ **投影有损，不得当该表的等价替身读**。
 *
 * ⚠ **护栏**：`actor` **不得被用作「谁卡住了」的凭据** —— 静止与失败由 `tasks[]` /
 * {@link handleFeatureTrace} 承载（`executing` 格的 `engine` 不表示「现在有在跑」）。
 */
export type FeatureStageActor = "host" | "user" | "engine";

/**
 * **本阶段明细**（增补 `6cc46dd2` N2 / 确认单 v15 扁平版）——「回显三枚 + 派生四枚」的
 * **平级七键**结构，**不是**嵌套对象：出口出参 `extends` 本类型 ⇒ 七枚都落在顶层
 * （与既有 `state`/`note` 等同层，无 `next` 包装、无 `next.state`）。
 *
 * - **回显三枚**（`stage`/`approval`/`version`）= 引擎已存的登记字段**原样回显**，
 *   **恒等、不重新推导、不翻译**（`stage` 的中文值必须逐字）；
 * - **派生四枚**（`pending`/`gate`/`actor`/`action`）= 由五维输入的**纯函数**（{@link deriveStageDetail}）。
 */
export interface FeatureStageDetail {
  /** 回显登记字段 `features.stage`（**原样**，见本类型「回显三枚」条） */
  stage: FeatureStage;
  /** 回显登记字段 `features.approval`（原样） */
  approval: FeatureApproval;
  /** 回显登记字段 `features.version`（原样；未排期 = 空串） */
  version: string;
  /**
   * 本阶段还差的**登记欠账全清单**（**恒为数组**，0–n 枚；终态/异常态取 `[]`）。
   *
   * 语义 = **登记事实**：只答「`decisions` 里有没有登记过那个档名」，**不证文件存在**
   * （`decisions` 是宿主自报的自由文本、且整值替换 ⇒ 漏重发会让明细倒退，这是**正常后果**）。
   */
  pending: FeaturePendingItem[];
  /** 本阶段卡在 / 奔向哪道用户门（非 `waiting_approval` ⇒ `null`） */
  gate: FeatureGateId | null;
  /** 本阶段推动方 / 执行方（**终态 ⇒ `null`** = 本阶段无推动方，**不得读成「卡住」**） */
  actor: FeatureStageActor | null;
  /** 本阶段该做什么（**能力陈述式**英文一句，单源 = {@link STAGE_DETAIL_ACTIONS} 旁的文案表） */
  action: string;
}

/** 宿主自办登记的欠账枚（⇒ `actor = "host"`）：三份产出物 / 排期写 */
export const PENDING_HOST_SIDE_ITEMS: readonly FeaturePendingItem[] = [
  "requirement-doc",
  "version",
  "design-doc",
];

/** 人的确认凭据的欠账枚（⇒ `actor = "user"`）：门① 抬位 · 门② 放行（宿主只是记录者） */
export const PENDING_USER_CREDENTIAL_ITEMS: readonly FeaturePendingItem[] = ["stage", "approval"];

/**
 * **`action` 文案表 · 非 `waiting_approval` 各格**（增补 `6cc46dd2` N2 · 单源在此，改造文档 §6 只登记指针）。
 *
 * **写法约束**（C.1#9，flow D4'）：只写「此处**可执行的操作**」（**能力陈述**），
 * **不得**写成「应当推进 / 前置已满足」；**流程判断**（判据清单是否满足 / 三档定性 / 名额是否空 /
 * 载体是否旧码）**一个字都不进 `action`** —— 那些归 flow 与人判。
 *
 * 键型逐态穷举（照 {@link STAGE_DERIVATION} 先例）：引擎加态 ⇒ 本表编译期报错，不会静默缺文案。
 * `waiting_approval` 不在此表（该态的文案按 `pending` 分格，见 {@link WAITING_APPROVAL_ACTIONS}）。
 */
export const STAGE_DETAIL_ACTIONS: Record<Exclude<FeatureState, "waiting_approval">, string> = {
  version_planning:
    "Run the PjM procedure (each project's project_manager) and write the attribution, then advance to decomposing.",
  decomposing:
    "Dispatch each project's dev_manager for its node list, register the DAG, then advance to executing.",
  // ★用户 2026-10-13 亲自点名的字面（宿主已裁本卡保留；改口代价 = 本行文案 + 一条锚字面）
  executing: "Hook `watch-feature.mjs` to monitor the feature.",
  integrating: "Advance to testing.",
  testing: "Run the on-box acceptance, then advance to reviewing.",
  reviewing: "Wait for the user's acceptance verdict, then advance to completed.",
  completed: "Wait for the release order (§8).",
  needs_input: 'Answer the clarification: advance(to="executing", answer=…).',
  failed: "Cancel the feature to archive it (a2a_feature_cancel).",
  cancelled: "Nothing left to run — this track is cancelled.",
};

/**
 * **`action` 文案表 · `waiting_approval` 段按欠账分格**（增补 `6cc46dd2` N2）。
 *
 * 键 = 该段的 `pending` 首枚（无欠账 ⇒ `"settled"` = 两道门之间的停靠格，等用户过门②）。
 * `settled` 之外另两格（`approval` / `integrating`）的文案**不在确认单逐行草案内**
 * （草案表把它们折进了相邻行），落地时按同款**能力陈述**式补齐，不引入流程判断。
 */
export const WAITING_APPROVAL_ACTIONS: Record<FeaturePendingItem | "settled", string> = {
  "requirement-doc":
    "Dispatch each project's product_manager for the requirements analysis (Step 0), and land the 需求确认单.",
  version: "Schedule a version first, then get the user to confirm the problem (gate 1).",
  stage: "Get the user to confirm the problem, then migrate stage (gate 1).",
  "design-doc":
    "Dispatch each project's dev_manager for its side-plan and the boundary round, and land the 改造文档.",
  approval: "Set approval to 待审批, then wait for the user's approval (gate 2).",
  settled: "Wait for the user's approval, then call approve (gate 2).",
};

/**
 * `actor` 逐态归向（增补 `6cc46dd2` N2 · ★v22 语义 = 本阶段推动方 / 执行方）。
 *
 * `"by-pending"` = 该态按 {@link PENDING_HOST_SIDE_ITEMS} 判交（含宿主自办项 ⇒ `host`，否则 ⇒ `user`）
 * —— 只有 `waiting_approval` 用这一格：**不逐枚点名**则该态会一律报错方，与确认单逐格表冲突。
 * `executing` ⇒ `engine` **无条件**，不因「失败静止」改写（静止不属本表判据，见 {@link FeatureStageActor} 护栏）。
 */
const ACTOR_BY_STATE: Record<FeatureState, FeatureStageActor | null | "by-pending"> = {
  waiting_approval: "by-pending",
  version_planning: "host",
  decomposing: "host",
  executing: "engine",
  integrating: "host",
  testing: "host",
  reviewing: "user",
  completed: null,
  needs_input: "host",
  failed: null,
  cancelled: null,
};

/**
 * `pending` 扫描开关（增补 `6cc46dd2` N2）：`true` = **终态 / 异常态 ⇒ 恒取 `[]`**（四格不携带登记欠账）。
 *
 * 逐态穷举同 {@link ACTOR_BY_STATE}；`needs_input` 是**异常态但非终态**，仍在本列内（澄清走
 * `answer`，不是登记欠账）。
 */
const PENDING_NOT_TRACKED: Record<FeatureState, boolean> = {
  waiting_approval: false,
  version_planning: false,
  decomposing: false,
  executing: false,
  integrating: false,
  testing: false,
  reviewing: false,
  completed: true,
  needs_input: true,
  failed: true,
  cancelled: true,
};

/**
 * 登记欠账**全清单**（增补 `6cc46dd2` N2）—— 固定序逐项查五枚欠账，报**首个未清项**；
 * **不按当前格过滤**（本函数内不引入第二套判据：欠账的有无只由登记字段、`decisions` 与
 * 确认单双档的**同源谓词** {@link gate1DocPresent} 决定 · v0.11.0 orch-N7）。
 *
 * 顺序 = 流程的实际前置：确认单 → 排期 → 门① 抬 `stage` → 改造文档 → `approval` 置待审批。
 * 数组形态保留（当前各行至多 1 枚，将来「两件事同时等」不必改形状）。
 */
function derivePendingItems(
  state: FeatureState,
  stage: FeatureStage,
  version: string,
  approval: FeatureApproval,
  feature: Pick<FeatureRecord, "featureId" | "decisions">,
): FeaturePendingItem[] {
  if (PENDING_NOT_TRACKED[state]) return [];
  if (gate1DocPresent(feature) === null) return ["requirement-doc"];
  if (version === "") return ["version"];
  if (stage === "需求分析") return ["stage"];
  if (!docRegistered(feature.decisions, undefined, DESIGN_DOC_MARKER)) return ["design-doc"];
  if (approval === "未发起") return ["approval"];
  return [];
}

/**
 * 用户门归属（增补 `6cc46dd2` N2 · 三段式）：`waiting_approval ∧ stage=需求分析 ⇒ gate1`；
 * `waiting_approval ∧ 否则 ⇒ gate2`（门① 已过 ⇒ 前方是门②）；其余态 ⇒ `null`（不在用户门上）。
 */
function deriveGate(state: FeatureState, stage: FeatureStage): FeatureGateId | null {
  if (state !== "waiting_approval") return null;
  return stage === "需求分析" ? "gate1" : "gate2";
}

/**
 * **本阶段明细的派生单源**（增补 `6cc46dd2` N2）—— 纯函数、零写入、零查询、零副作用。
 *
 * **入参 = 按 `featureId` 写后重读的那一行**（**语义要求**，非实现细节）：`actor` 报的是
 * **本阶段**（推进后）的推动方，出口若拿**写前快照**就会报「**被离开的那一格**」的人、
 * 明细也系统性落后一帧（典型：门① 刚抬完 `stage` 仍报 `pending:["stage"]`）。
 * 出口非事务（写与重读同函数不同语句，**不追求**快照一致性）。
 *
 * 三条语义限定（读账方须知，改造文档 §6 同步登记）：
 * 1. **`pending` = 登记事实**，**不证文件存在**；`decisions` 是宿主自报自由文本且**整值替换**
 *    ⇒ 漏重发 ⇒ 明细倒退属正常后果；
 * 2. **护栏**：`actor` **不得被用作「谁卡住了」的凭据** —— 静止 / 失败由 `tasks[]` 与
 *    {@link handleFeatureTrace} 承载；
 * 3. **`actor` 语义 = 本阶段（推进后）推动方 / 执行方**（★确认单 v22），是 flow
 *    `引擎映射.md` §2 表「驱动方」列的**同源投影**、**不得当该表等价替身读**（该列有复合值）。
 *
 * 异常 / 终态四格（`needs_input` / `completed` / `failed` / `cancelled`）的 `stage` **保持当时值、
 * 不参与推导** ⇒ 本函数**照读不臆造**、也**不另存第五枚**去标记「陈旧 `stage`」。
 */
export function deriveStageDetail(feature: FeatureRecord): FeatureStageDetail {
  const pending = derivePendingItems(
    feature.state,
    feature.stage,
    feature.version,
    feature.approval,
    feature,
  );
  const actorKind = ACTOR_BY_STATE[feature.state];
  return {
    stage: feature.stage,
    approval: feature.approval,
    version: feature.version,
    pending,
    gate: deriveGate(feature.state, feature.stage),
    actor:
      actorKind === "by-pending"
        ? pending.some((item) => PENDING_HOST_SIDE_ITEMS.includes(item))
          ? "host"
          : "user"
        : actorKind,
    action:
      feature.state === "waiting_approval"
        ? WAITING_APPROVAL_ACTIONS[pending[0] ?? "settled"]
        : STAGE_DETAIL_ACTIONS[feature.state],
  };
}

/**
 * **出口装配的唯一读口**（增补 `6cc46dd2` N3）—— **写后重读**：按 `featureId` 取回本单全部写入
 * 落定后的那一行，再交 {@link deriveStageDetail}。
 *
 * ⚠ 语义要求（非实现细节，改造文档 C.1#2 / R3）：`actor` 报的是**本阶段（推进后）**的推动方，
 * 出口若吃 `handleFeatureAdvance` 开头那份**写前快照**，报的就是「**被离开的那一格**」的人，
 * 明细也系统性落后一帧（典型：门① 刚抬完 `stage` 仍报 `pending:["stage"]`）。
 * 出口**非事务**（R7）：重读与写同函数不同语句，不追求快照一致性。
 *
 * `fallback` 只兜「重读落空」这一不可达形态（行刚被本单写过 ⇒ 必在）；不为它另设错误码。
 */
function stageDetailAfterWrite(featureId: string, fallback: FeatureRecord): FeatureStageDetail {
  return deriveStageDetail(getFeature(featureId) ?? fallback);
}

export interface FeatureStateChangeSuccess {
  ok: true;
  featureId: string;
  from: FeatureState;
  state: FeatureState;
  note?: string;
}

/**
 * **`approve` 成功出参**（增补 `6cc46dd2` N4 · 本增补域含 `create` 与 `approve`，不含 `cancel`）。
 *
 * 为什么要新类型、而不是给共用的 {@link FeatureStateChangeSuccess} 加字段：`approve` 与 `cancel`
 * 历史上**共用**这一枚基类型，而本增补只让 `approve` 带明细 ⇒ 明细必须挂在 `approve` 自己的出口形上。
 * **基类型逐字不动**（它是「`cancel` 不受染」的判据 —— 宽化基类型 = 连带改 `cancel` 出参）。
 *
 * - 本形 = 基形 ∧ {@link FeatureStageDetail} 七枚**平级必填**（平铺在顶层，与 `ok`/`featureId`/
 *   `from`/`state` 同级，无包装对象）；本接口无自有键，全部键由两枚父形带入；
 * - **必带性由 TS 穷举执法**：{@link handleFeatureApprove} 的出口字面量以本形标注 ⇒ 漏装任一枚即编译报错；
 * - **入参面零改动**（`FeatureApproveArgs` 不动）：本节点只动出参。
 */
export interface FeatureApproveSuccess
  extends FeatureStateChangeSuccess,
    FeatureStageDetail {}

/**
 * `advance` 成功出参（**additive**）。
 *
 * `retryTaskIds` 路径额外回显本次动作面（便于宿主 / 测试核对**实际生效**的节点集）；
 * 非该路径不设这两个字段（出参形状与既有调用方兼容）。
 *
 * ⚠ **明细七枚不在本接口上声明**（增补 `6cc46dd2` N3 · 与 C.1#2 的偏离已回传宿主）：本接口是
 * `BridgeCore.featureAdvance` 的**对外兼容形**，既有套件（`test/v0101-o3-advance-attribution.test.ts`
 * 的 Proxy 假出参 `satisfies FeatureAdvanceSuccess`，C.1#7「既有套件一条不改」范围内）在此接口上
 * 声明七枚**必填**即编译不过 ⇒ 必带性改由 {@link FeatureAdvanceExit} 执法：{@link handleFeatureAdvance}
 * 与其内部四条出口字面量**均以本形为出参**（C.1#2 的目的 =「四个出口任一漏装即编译报错」，
 * 在该形下**全额达成**；消费侧从 handler 拿到的静态类型即含七枚）。
 */
export interface FeatureAdvanceSuccess extends FeatureStateChangeSuccess {
  /** 本次**实际重派**（`rearmForRetry` CAS 命中）的节点 id */
  rearmed?: string[];
  /** 本次**实际解冻**（`blocked` → `working`）的节点 id */
  unfrozen?: string[];
  /**
   * 本次**归属写**的三档计数（v0.10.1 O3；非该路径不设此字段）。
   * `noop` = 同值幂等重发的行数（C-3 ★R3「重发安全」的可观测面）。
   */
  attribution?: { created: number; updated: number; noop: number };
}

/**
 * `advance` **四条成功出口**的装配形（增补 `6cc46dd2` N3 · C.1#2 的执行面）= 对外兼容形 ∧
 * {@link FeatureStageDetail} 七枚**平级必填**（**平铺**在顶层，与 `state`/`note` 同级，无包装对象）。
 *
 * 执法点 = {@link handleFeatureAdvance} 的**出参声明**与其四条出口字面量：登记特例 / 只补归属 /
 * 合法流转 / `retryTaskIds` 重派四条各以本形构造，**任一漏装即编译报错**
 * （`writeAttribution` 的泛型 `T extends FeatureAdvanceSuccess` 逐字不动，在本形下透传 `T` ⇒ 明细不丢）。
 *
 * 与兼容形的分工见 {@link FeatureAdvanceSuccess} 的 ⚠ 条（既有套件假出参不改一行）。
 */
export type FeatureAdvanceExit = FeatureAdvanceSuccess & FeatureStageDetail;

/**
 * **`stage` 半派生映射表**（v0.10.5 O2 / 改造文档 §2.2「半派生映射表（定稿 6 格，全态覆盖）」）：
 * 引擎随 `state` 迁移**同轮**派生写 `stage` 的**唯一表单源**（flow 不重述、board 不硬编码）。
 *
 * `null` = **不派生**（保持当时值），三处语义各不相同：
 * - `waiting_approval` —— `需求分析` / `改造方案` 两值**由宿主经门①写**，state 决定不了哪一格；
 * - `completed` —— 保持上一格（`验收`）；发版后的 `发版` 由宿主经登记特例写（`to` = 当前态），
 *   本态若派生会把那枚显式写覆盖掉；
 * - `needs_input` / `failed` / `cancelled` —— 异常/终态**保留当时值**（不是主链格，不携带段语义）。
 *
 * 键型取 `Record<FeatureState, …>` **逐态穷举**：引擎再加态 ⇒ 本表编译期报错，
 * 不会出现「新态静默不派生、stage 永久滞后」这种无声缺口。
 */
const STAGE_DERIVATION: Record<FeatureState, FeatureStage | null> = {
  waiting_approval: null,
  version_planning: "改造",
  decomposing: "改造",
  executing: "改造",
  integrating: "回归",
  testing: "回归",
  reviewing: "验收",
  completed: null,
  needs_input: null,
  failed: null,
  cancelled: null,
};

/** 目标态 → 应派生的 `stage`（`null` = 该态不派生）；唯一调用点见 {@link handleFeatureAdvance} */
function deriveStageForState(state: FeatureState): FeatureStage | null {
  return STAGE_DERIVATION[state];
}

export function handleFeatureAdvance(
  args: FeatureAdvanceArgs,
  identity: string | null = null,
): FeatureAdvanceExit | FeatureToolFailure {
  const feature = getFeature(args.featureId);
  if (feature === null) {
    return { ok: false, code: "feature_not_found", error: `未知 Feature ${args.featureId}` };
  }
  // 归属校验（谁建谁见）：非本组 ⇒ 在任何写入之前拒绝（Feature 态与节点态零变更）
  const denied = ownershipFailure(feature, identity);
  if (denied !== null) return denied;

  // 登记字段：**先解析校验**（非法 ⇒ 任何写入之前拒绝，Feature 态与登记值零变更）
  const reg = parseRegistration(args);
  if (reg.ok === false) return reg;
  // v0.10.0 O5：shape 过关后做**存在性校验**（∈ O1 台账；台账未落地 ⇒ 过渡放行，见 {@link checkVersionLedger}）
  // ⚠ 归属取**当前 Feature 的 ownerGroup**（谁建谁见 ⇒ 与 identity 一致已由 `ownershipFailure` 把关）；
  // 台账 PK 用 `(owner_group, version)`，故按 Feature 归属查、不按连接身份查（后者可能为 null 但 Feature 非空）。
  const ledgerFailure = checkVersionLedger(feature.ownerGroup, reg.patch.version);
  if (ledgerFailure !== null) return ledgerFailure;
  // v0.10.0 O4：shape + 存在性过关后做**排期写执法**（两把锁；宿主 MCP 直写同受、后门不豁免）。
  // 位置在存在性检查**之后** ⇒ 保留 O5「未登记版号 ⇒ orch_version_unknown」的判据优先序。
  const writeLockFailure = checkVersionWriteLocks(
    { stage: feature.stage, approval: feature.approval },
    feature.ownerGroup,
    reg.patch.version,
    { applyStateLock: true },
  );
  if (writeLockFailure !== null) return writeLockFailure;

  // ---- 门①（需求确认）`version` 守卫（v0.10.5 O4 / 引擎映射 §3 门表）----------------------------
  // 触发判据四条件**逐字** = 「本次携带 `stage` 写」∧「写的目标值 ≠ 需求分析」∧「当前 stage = 需求分析」
  // ∧「当前 features.version 为空」。任一不过 ⇒ **整单拒绝、零写入**（state / stage / approval /
  // version 全不动、零事件）—— 未排期的卡不得过需求确认门。
  // 位置在 `retryTaskIds` / 登记特例 / 只补归属三条分叉**之前** ⇒ 三条路径同受此守卫。
  // 拒绝**不改 stage** ⇒ 拒后卡仍 `需求分析 ∧ 未发起` ⇒ 排期写状态锁仍开，补写 version 后可重试同一迁移。
  // 守卫**不判 `state`、不校验 stage 迁移序**（与 `version` 守卫同款的最小判据面）。
  if (
    reg.patch.stage !== undefined &&
    reg.patch.stage !== "需求分析" &&
    feature.stage === "需求分析" &&
    (feature.version ?? "") === ""
  ) {
    return {
      ok: false,
      code: ERR_GROUP_VERSION_REQUIRED,
      error:
        `门①（需求确认）version 守卫：Feature ${feature.featureId} 的 features.version 为空（未排期）⇒ 不得把 stage 由「需求分析」迁往 "${reg.patch.stage}"；` +
        "整单拒绝、零写入（state / stage / approval / version 全不动）。" +
        "先经引擎排期写口写定 version（advance 的「to = 当前态 ∧ 带 version」特例 —— 拒后卡仍「需求分析 ∧ 未发起」⇒ 排期锁开着），再重试本迁移",
    };
  }

  // ---- 门①（需求确认）《需求确认单》已登记守卫（增补 bbc7ea28 O3 / v0.11.0 orch-N7 双档 / 引擎映射 §3 门表 案 (a)）------
  // **第二前提**，叠在同一条 version 守卫的判据面上：前三条件逐字相同（「本次携带 `stage` 写」∧
  // 「写的目标值 ≠ 需求分析」∧「当前 stage = 需求分析」），第四条件换为「确认单**双档**任一命中」
  // = {@link gate1DocPresent}（旧档 `decisions` 文件名 ∪ 本单同写；新档 = 本轮合成行在册且
  // sections 非空。**旧档必须保留** —— 存量卡的 `decisions` 只有文件路径）。approve 条件 ④ 与
  // derivePendingItems 的确认单欠项**同源引本函数**，文件名子串判断不再各处各判一遍。
  // **两前提顺序 = version 在前、本前提在后**（缺哪报哪，不合并成一个错误码）。
  // 位置同样在三条分叉**之前** ⇒ 登记特例 / 合法流转两路同受；**唯一豁免 = `retryTaskIds` 重派路径**
  // （那是派发语义操作、不是过门，携 `stage` 写的行为逐字不变）—— 与 version 守卫的「三路同受」不同。
  // 拒绝**不改任何值** ⇒ 拒后卡仍 `需求分析`，排期锁与本前提均可善后后重试同一迁移。
  if (
    args.retryTaskIds === undefined &&
    reg.patch.stage !== undefined &&
    reg.patch.stage !== "需求分析" &&
    feature.stage === "需求分析" &&
    gate1DocPresent(feature, args.decisions) === null
  ) {
    return {
      ok: false,
      code: ERR_CONFIRMATION_DOC_REQUIRED,
      error:
        `门①（需求确认）第二前提：Feature ${feature.featureId} 的《需求确认单》两档均未命中` +
        `（已落库与本单同写的并集内无 "${CONFIRMATION_DOC_MARKER}" 档名 ∧ 本轮「需求分析」无在册合成行或其 sections 为空）` +
        `⇒ 不得把 stage 由「需求分析」迁往 "${reg.patch.stage}"；` +
        "整单拒绝、零写入（state / stage / approval / version 全不动）。" +
        "先把 doc/{版本}/{topic}-需求确认单.md 经同一 advance 的 decisions 登记（「to = 当前态」登记写，不属迁移）、" +
        "或等引擎产出本轮合成《需求确认单》，再重试本迁移",
    };
  }

  // ---- 门①（需求确认）第三前提：「需求分析」至少存在一轮 `settled=true`（v0.11.0 O1 / 引擎映射 §3 门表）------
  // **硬判据（不可跳步）**：用户裁定 2026-10-20「未来一律通过板操作、板也不允许跳步」⇒ 板不画按钮
  // 也挡不住宿主直调本口 ⇒ 由引擎执法。**前三条件与上面两条前提逐字相同**（同一触发面、同一
  // `retryTaskIds` 豁免形状 ⇒ ①② 的既有负锚逐字不翻），第四条件 = {@link gate1SettledRound} 为空。
  // **序 = 版本 → 确认单 → 阶段轮**（缺哪报哪，三枚独立码不合并 ⇒ 三笔善后动作各是不同一件事）。
  // **零迁移**：本 `return` 早于下面所有写入（`applyFeatureContext` / `updateFeatureRegistration` /
  // 归属 / 版本激活）⇒ 拒后 `state` / `stage` / `version` 逐字不动，卡仍 `需求分析` 可善后重试。
  // **无豁免名单**（本卡裁定）：补丁卡同样要开轮；历史已跳步的卡只登记、不回填、不加旁路。
  if (
    args.retryTaskIds === undefined &&
    reg.patch.stage !== undefined &&
    reg.patch.stage !== "需求分析" &&
    feature.stage === "需求分析" &&
    gate1SettledRound(feature) === null
  ) {
    return {
      ok: false,
      code: ERR_STAGE_ROUND_REQUIRED,
      error:
        `门①（需求确认）第三前提：Feature ${feature.featureId} 在「需求分析」阶段不存在任何一轮 \`settled=true\` 的阶段轮` +
        `（读面 \`stageRuns[]\` 同口径：零格 / 零行格（\`settled=null\`）/ 有格但未收口，三态都不算一轮）` +
        `⇒ 不得把 stage 由「需求分析」迁往 "${reg.patch.stage}"；` +
        "整单拒绝、零写入（state / stage / approval / version 全不动）。" +
        "先经 a2a_stage_round_open 开一轮（需求分析）、等全员回执到齐使该轮 settled=true（口径见 stageRuns[].settled），再重试本迁移；**本前提无豁免名单**",
    };
  }

  const hasRegistration =
    reg.patch.stage !== undefined ||
    reg.patch.approval !== undefined ||
    reg.patch.version !== undefined;

  // ---- 归属独立分支（v0.10.1 O3 / C-17 ★R3）：**先全量校验、零写入** ------------------------------
  // 位置在所有写入（登记 / Context / 主链 / 归属）**之前** ⇒ ★N-8「归属拒 ⇒ 主链零迁移」的凭据。
  // 判据唯一来自 O2 的 {@link checkFeatureAttributionWrites}（本节点不另写一套）；`hasRegistration`
  // **不受影响**（归属不是登记字段语义，折进去会污染既有登记特例）。
  const attributionArgs: AttributionWriteArgs | null =
    args.projectVersions !== undefined && args.projectVersions.length > 0
      ? {
          featureId: feature.featureId,
          projectVersions: toAttributionWrites(args.projectVersions),
          source: "mcp_advance",
        }
      : null;
  /**
   * 归属**校验计划**（同单非空归属入参时才有）—— 既作 ★N-8 的「校验先于写入」凭据，也作
   * {@link handleFeatureAdvance} 下方**归属门双挂**的「本单即将落入 N 条」计数（v0.10.5 O4）。
   * 不另写第二套判据：计数取自 O2 的同一函数返回。
   */
  let attributionPlan: { entries: AttributionPlanEntry[] } | null = null;
  if (attributionArgs !== null) {
    const plan = checkFeatureAttributionWrites(
      feature,
      attributionArgs.projectVersions,
      attributionArgs.source,
    );
    if (plan.ok === false) return plan;
    attributionPlan = plan;
  }

  // ---- 重派与解冻（§2.3 / N4）：**显式特例**，不得给 `TRANSITIONS` 加自环 ----------------------
  // `retryTaskIds` 是**派发语义操作**（重派指定失败节点 + 解冻其闭包外下游），不是状态流转
  // ⇒ 跳过 `canTransition`（转移表保持单一事实源、不出现 `executing → executing` 自环）；
  // `to` 必须**显式** `"executing"`，以防借本参数做状态流转。
  if (args.retryTaskIds !== undefined) {
    // ⚠ **不派生 `stage`**（v0.10.5 O2）：本路径无状态流转（Feature 态逐字不变）⇒ 派生无目标态可推；
    // 同单显式登记的 `stage` 照原样落笔，不被任何派生覆盖。
    const resume = handleRetryResume(feature, { ...args, retryTaskIds: args.retryTaskIds }, reg.patch);
    if (resume.ok === false || attributionArgs === null) return resume;
    // 重派校验全过 ⇒ 同单归属写才落笔（归属 + 重派任一不过，都不留半摊）
    return writeAttribution(resume, attributionArgs, identity);
  }

  // ---- 登记字段特例（v0.9.0 B1″）：`to` = 当前态 ∧ 带登记字段 ⇒ **只写登记、不做流转** ------------
  // 与 `retryTaskIds` 同族：跳过 `canTransition`（转移表零改动、`executing → executing` 仍无路径）。
  // ⚠️ **刻意不加终态守卫** —— 发版流程要在 `completed` 之后写 `stage = 发版`（`需求流程.md` §7）；
  // 加了守卫就永远写不进去。主链态在此路径**逐字不变**（`from === state`）。
  // F2（v0.9.0 O4 门禁报告）：早退**不得**丢弃同单 Feature Context —— 与合法流转同一出口落库。
  if (hasRegistration && args.to === feature.state) {
    // ⚠ **不派生 stage**（v0.10.5 O2）：本路径无状态迁移 ⇒ 无派生目标态；此处的 `stage` 是
    // **宿主显式登记写**（门①抬「改造方案」、发版流程写「发版」都走这一格），派生若介入即覆盖显式写。
    applyFeatureContext(feature.featureId, args);
    updateFeatureRegistration(feature.featureId, reg.patch);
    // ---- 门①（需求确认）= 版本 `notstart → active` 的**首触发点**（v0.10.7 n3 / 引擎映射 §3.5）----
    // 判据逐字 = 门① 两守卫的前三条件（「本次携带 `stage` 写」∧「目标值 ≠ 需求分析」∧「当前 stage =
    // 需求分析」）⇒ 由「需求分析迁入」才算过门。**位置硬约束**：必须在 `updateFeatureRegistration`
    // **成功之后** —— 上面两处门① 守卫的拒因 `return` 都发生在本行之前 ⇒ 守卫未过永不触发，
    // 否则等于开出「没过门也抬版」的第二条旁路。**禁挂 store 层 `updateFeatureRegistration`**
    // （五条路径共用同一写口，挂在那里语义即崩）。
    // ⚠ 版号显式传**生效值** `reg.patch.version ?? feature.version`：门① 允许同单写 `version` + 抬
    // `stage`，套 `activateVersionForFeature(feature)` 吃的是写前快照 ⇒ 会激活**旧**版号。
    // 三护栏（幂等 / 不阻断 / 节流）照旧，`approve` 与首派发两处保留作幂等兜底。
    if (
      reg.patch.stage !== undefined &&
      reg.patch.stage !== "需求分析" &&
      feature.stage === "需求分析"
    ) {
      versionActivator.activate(
        feature.ownerGroup,
        reg.patch.version ?? feature.version,
        "gate1",
      );
    }
    const success: FeatureAdvanceExit = {
      ok: true,
      featureId: feature.featureId,
      from: feature.state,
      state: feature.state,
      // 明细装配 = **写后重读**（登记写已落笔；本档不派生 `stage`，显式写即最终值）
      ...stageDetailAfterWrite(feature.featureId, feature),
    };
    if (args.note !== undefined) success.note = args.note;
    if (attributionArgs === null) return success;
    return writeAttribution(success, attributionArgs, identity);
  }

  // ---- 归属独立分支的**只补归属**档（C-17 ★R3）：`to` = 当前态 ∧ `projectVersions` 非空 ------------
  // 不携带登记字段时，`to = 当前态` 在主链上**没有路径**（`canTransition` 会拒）⇒ 本分支替它跳过
  // 状态机校验；`state` 逐字不变、不发状态事件、不写登记（转移表仍零改动、无自环）。
  if (attributionArgs !== null && args.to === feature.state) {
    // ⚠ **不派生 stage**（v0.10.5 O2）：只补归属档同样无状态迁移（`state` 逐字不变、不发状态事件）。
    applyFeatureContext(feature.featureId, args);
    const success: FeatureAdvanceExit = {
      ok: true,
      featureId: feature.featureId,
      from: feature.state,
      state: feature.state,
      // 明细装配 = **写后重读**（本档只落 Context；`decisions` 参与 `pending` 推导，故必须读回写后的行）
      ...stageDetailAfterWrite(feature.featureId, feature),
    };
    if (args.note !== undefined) success.note = args.note;
    return writeAttribution(success, attributionArgs, identity);
  }

  if (!isFeatureState(args.to)) {
    return {
      ok: false,
      code: "feature_invalid_state",
      error: `非法目标状态 ${args.to}（合法后继：${allowedTransitions(feature.state).join(" / ") || "无（终态）"}）`,
    };
  }
  if (!canTransition(feature.state, args.to)) {
    return {
      ok: false,
      code: "feature_transition_invalid",
      error: `非法状态流转：${feature.state} → ${args.to}（合法后继：${allowedTransitions(feature.state).join(" / ") || "无（终态）"}）`,
    };
  }

  // 唯一准入门（REQ-v0.4.1-2026-09-16-01 §2.4）：`approve` 是**离开 `waiting_approval` 的唯一通道**。
  // 判据 = **行前提**三条件合取：`feature.state` 为 `waiting_approval` ∧ 目标是该态的**转移表出边**
  // ∧ 目标在**主链上后于**本态 ⇒ 拒。**不按 `to` 取值点名**：「转移表出边」分量令事实源 = 转移表本身
  // （将来给本态再加任何前进边即自动被本守卫覆盖、不复现旁路）；「主链行序」分量令
  // `cancelled` / `failed` **天然放行**（非主链态 ⇒ `indexOf` 为 `-1`，不大于本态索引）—— 归档边被拒
  // 会误伤 §8 收口归档路径，故此处**不得**写成 `|| 转移表出边`。
  // 位置在 `canTransition` **之后** ⇒ `waiting_approval → integrating` 之类非法目标仍报
  // `feature_transition_invalid`（错误区分），只有"合法但须审批"的这几步改为 `feature_approval_required`。
  // ⚠️ 第一条件严格限定 `feature.state`：**不得**误伤 `needs_input → executing`（人工澄清续推，属设计内）。
  // 注：状态机层保留 `waiting_approval → executing` 边（转移表 = 单一事实源；approve 自身不经 canTransition）。
  if (
    feature.state === "waiting_approval" &&
    canTransition(feature.state, args.to) &&
    FEATURE_MAIN_CHAIN.indexOf(args.to) > FEATURE_MAIN_CHAIN.indexOf(feature.state)
  ) {
    return {
      ok: false,
      code: "feature_approval_required",
      error:
        `非法状态流转：${feature.state} → ${args.to} 须经审批门（请用 a2a_feature_approve；` +
        "该操作 = 记录用户已给的方案确认，一对一映射，不可预领 / 不可补领）",
    };
  }

  // ---- 归属门双挂（v0.10.5 O4 / 改造文档 §2.6）：出工序格的「归属非空」转移守卫 --------------------
  // 两枚转移 = `version_planning → decomposing`（主轨出 PjM 工序格）与
  // `decomposing → executing`（兜**增补 / 承接轨** —— 它们跳过了前一格，归属在这格补齐）。
  // 判据 = **本需求归属清单非空**，两笔来源相加：已落库的行（`featureProjectListByFeature`，
  // 与 `checkFeatureAttributionWrites` 内部读的是同一个函数 ⇒ 不另写第二套归属判据）+ 本单即将写入的行
  // （上面那份已通过校验的 plan）。
  // 位置在 `canTransition` 与 `feature_approval_required` **之后**、任何写入（Context / 登记 /
  // 归属 / 主链）**之前** ⇒ 拒绝时主链**零迁移**（★N-8 同款）。
  // 错误码用**新增独立码** `feature_attribution_required`，**不复用** `orch_project_attribution_state_locked`
  // —— 后者语义 =「该态**不允许写**归属」，与本判据「**缺归属而不许离开**该态」方向相反（宿主裁定）。
  const crossesAttributionGate =
    (feature.state === "version_planning" && args.to === "decomposing") ||
    (feature.state === "decomposing" && args.to === "executing");
  if (crossesAttributionGate) {
    const settled = featureProjectListByFeature(feature.featureId).length;
    const planned = attributionPlan?.entries.length ?? 0;
    if (settled + planned === 0) {
      return {
        ok: false,
        code: ERR_FEATURE_ATTRIBUTION_REQUIRED,
        error:
          `归属门：Feature ${feature.featureId} 无归属记录（承诺集为空）⇒ 不得离开 ${feature.state}` +
          `（本单也未携带 projectVersions 写入）；整单拒绝、主链零迁移。` +
          `顺序 = 先经 project 台账建版、再经 advance 的 projectVersions 写归属，然后重试本迁移` +
          `（工序格内不派发任何节点，归属是出格的凭据）`,
      };
    }
  }

  // needs_input → executing：以同 contextId 续接待澄清任务（补齐 answer 后续推）
  // **v0.10.8 O-4（④）**：取集先过 `isDagNode`。`mode="inquiry"` 自 O-2 起亦携带 `featureId` ⇒ 会落进
  // 本读集；它的 `input-required` 是**边界轮**的待澄清（由 `a2a_ask` 侧自行续接，不经 Feature 主链）。
  // 若不过滤：`rearmTask` 会把 inquiry 行清 `dispatch_guard` 重排成 `working` ⇒ 被调度器当**就绪 DAG
  // 节点**重派（且 `find` 命中谁取决于行序，可能顶掉真正待澄清的 DAG 节点）。
  if (feature.state === "needs_input" && args.to === "executing") {
    const pending = listFeatureTasks(feature.featureId, { limit: 1000 })
      .filter(isDagNode)
      .find((n) => n.state === "input-required");
    if (pending !== undefined) {
      const base = pending.dispatchMessage ?? pending.prompt ?? "";
      const answer = args.answer === undefined || args.answer.length === 0 ? "" : args.answer;
      rearmTask(
        pending.taskId,
        answer.length > 0 ? `${base}\n\n[用户澄清]\n${answer}` : base,
      );
    }
  }

  // Feature Context 落库（v0.4.0 §2.5）：note → plan；decisions / contracts 可选
  applyFeatureContext(feature.featureId, args);

  // 登记字段与**合法流转同单**写入（v0.9.0）：先落登记，再迁主链 ⇒ 出参回显的 `state` 是迁移后的态
  if (hasRegistration) updateFeatureRegistration(feature.featureId, reg.patch);

  // 归属与**合法流转同单**写入（v0.10.1 O3 / C-17）：位置在主链迁移**之前** ——
  // 校验早已完成（★N-8），这里只是落笔顺序上让「归属没落成」时主链也不迁移。
  let attributionCounts: { created: number; updated: number; noop: number } | null = null;
  if (attributionArgs !== null) {
    const written = applyFeatureAttributions(attributionArgs, identity);
    if (written.ok === false) return written;
    attributionCounts = { created: written.created, updated: written.updated, noop: written.noop };
  }

  // ---- `stage` 半派生（v0.10.5 O2 / 改造文档 §2.2）：本行是 `deriveStageForState` 的**唯一调用点** ----
  // 位置钉在「主链迁移**之前**、登记显式写**之后**」：显式 `stage` 先落、派生随后按 `state` 为准回写
  // （`引擎映射.md` §3.5 一致性判据「state 与 stage 不一致 ⇒ 以 state 为准并回写 stage」）。
  // patch **仅 `stage` 一键** ⇒ 同单的 `approval` / `version` 不被派生动到（不扩观测面写集）；
  // 同值重放由 store 的真变化守卫归零事件（`updateFeatureRegistration` 的 diff 在读侧归一之后做）。
  // 三条分叉（`retryTaskIds` / 登记特例 `to` = 当前态 / 只补归属）**不派生** —— 见各分支内注释钉。
  const derivedStage = deriveStageForState(args.to);
  if (derivedStage !== null) {
    updateFeatureRegistration(feature.featureId, { stage: derivedStage });
  }

  const updated = updateFeatureState(feature.featureId, args.to);
  const state = updated === null ? args.to : updated.state;
  const success: FeatureAdvanceExit = {
    ok: true,
    featureId: feature.featureId,
    from: feature.state,
    state,
    // 明细装配 = **写后重读**（Context / 登记 / 派生 `stage` / 主链四写均已落笔 ⇒ 明细报的是**迁入的那一格**）
    ...stageDetailAfterWrite(feature.featureId, updated ?? feature),
  };
  if (args.note !== undefined) success.note = args.note;
  if (attributionCounts !== null) success.attribution = attributionCounts;
  return success;
}

/**
 * Feature Context 落库的唯一出口（v0.4.0 §2.5）：`note` → `plan`；`decisions` / `contracts` 可选。
 *
 * 三条 `advance` 路径共用（合法流转 / `retryTaskIds` 重派 / 登记字段特例）——
 * **同一单不得出现「一条路径丢 Context」的口径差**（v0.9.0 O4 门禁报告 F2）。
 */
function applyFeatureContext(
  featureId: string,
  args: Pick<FeatureAdvanceArgs, "note" | "decisions" | "contracts">,
): void {
  const patch: FeatureContextPatch = {};
  if (args.note !== undefined) patch.plan = args.note;
  if (args.decisions !== undefined) patch.decisions = args.decisions;
  if (args.contracts !== undefined) patch.contracts = args.contracts;
  if (Object.keys(patch).length > 0) updateFeatureContext(featureId, patch);
}

/**
 * `retryTaskIds` 路径实体（§2.3 / N4）：**校验 → 重派 → 解冻**，在 `handleFeatureAdvance` 内联可达。
 *
 * 顺序纪律（**先校验后改库**）：任何拒绝都在**任何写入之前**返回 ⇒ Feature 态与节点态**零变更**（不抖振）。
 * 通过后才：① `rearmForRetry` 逐 id 重派 + 逐条 `task.rearmed`；② 解冻闭包**外**的 `blocked` 节点。
 *
 * 边界说明：
 * - **不做**状态流转（不调 `updateFeatureState`）；`from` / `state` 为**相等值回显**（皆当前态，
 *   正常静止期即 `executing`）—— §2.3 的「均为 `executing`」在本路径的正常用法下成立；
 * - **不新增自环**：`to` 只被**校验**、不被应用（转移表零改动）；非终态的其它态如实回显；
 * - 「清 `not_before`」条目**已删除**：N2 已删写口 `setTaskNotBefore` 与判据 `isPastNotBefore`
 *   （挡门不存在 ⇒ **无对象可清**；休眠列不读不写）；
 * - **「新增业务节点」不走本路径**：就绪节点用 `a2a_call(mode="execute", featureId=…)` 登记
 *   （现成通道）；本参数只重派**既有** `failed` 节点，不实现「重试新事件」。
 */
function handleRetryResume(
  feature: FeatureRecord,
  args: FeatureAdvanceArgs & { retryTaskIds: string[] },
  /** 已校验的登记字段（v0.9.0）；**在所有重派校验通过之后**才落笔，避免半生效 */
  registration: FeatureRegistrationPatch,
): FeatureAdvanceExit | FeatureToolFailure {
  // 互斥：`answer` 仅承载 needs_input 澄清（走 needs_input→executing 常规路径），不得与重派同传
  if (args.answer !== undefined) {
    return {
      ok: false,
      code: "feature_conflicting_args",
      error:
        "retryTaskIds 与 answer 互斥：answer 只承载 needs_input 澄清（请用 to=executing + answer、" +
        "不带 retryTaskIds）；重派失败节点请勿携带 answer",
    };
  }
  if (args.to !== "executing") {
    return {
      ok: false,
      code: "feature_invalid_args",
      error: `retryTaskIds 路径要求 to 显式为 "executing"（当前 "${args.to}"）：本参数只做「重派 + 解冻」，不做状态流转`,
    };
  }
  if (isTerminalFeatureState(feature.state)) {
    // 终态 Feature 的节点即使重排也不会被调度（tick 只扫 executing）⇒ 显式拒绝，不留半生效状态
    return {
      ok: false,
      code: "feature_terminal",
      error: `Feature 已终态（${feature.state}），重派无意义（节点不会被调度）`,
    };
  }
  if (args.retryTaskIds.length === 0) {
    return {
      ok: false,
      code: "feature_nothing_to_resume",
      error: "retryTaskIds 为空数组：无可重派对象（至少给一个本 Feature 内 failed 节点 id）",
    };
  }

  // 先校验：任一 id 非法 ⇒ 整单拒绝（**不静默跳过、不做部分重派**）
  // **v0.10.8 O-4（⑤）**：节点集先过 `isDagNode` ⇒ inquiry 行**不进** `planResume`：
  // 传 inquiry id 当 `retryTaskIds` 即「id 不在本 Feature 的 DAG 节点集」⇒ 落 `plan.invalid` 整单拒；
  // 解冻集合同样只含 DAG 节点（inquiry 不是可解冻的闭包成员）。
  const nodes = listFeatureTasks(feature.featureId, { limit: 1000 }).filter(isDagNode);
  const plan = planResume(nodes, args.retryTaskIds);
  if (plan.invalid.length > 0) {
    return {
      ok: false,
      code: "feature_nothing_to_resume",
      error: `无可重派对象（逐 id）：${plan.invalid.map((i) => `${i.taskId} → ${i.reason}`).join("；")}`,
    };
  }

  // ① 重派原语：复用 `rearmForRetry`（CAS `WHERE state='failed'`；清 remote_task_id / finished_at、
  //    `retry_count` +1 记账、`exhausted` 归零）；消息 = `dispatch_message` 原文（**同 ctx 续接**）。
  const byId = new Map(nodes.map((n) => [n.taskId, n]));
  const rearmed: string[] = [];
  for (const id of plan.rearmIds) {
    const node = byId.get(id);
    if (node === undefined) continue;
    if (!rearmForRetry(id, node.dispatchMessage ?? node.prompt ?? "")) continue; // CAS 未命中 ⇒ 本 id 未重派
    rearmed.push(id);
    appendEvent({
      featureId: feature.featureId,
      taskId: id,
      kind: EVENT_TASK_REARMED,
      state: "working",
      payload: JSON.stringify({ projectId: node.projectId, contextId: node.contextId }),
    });
  }

  // ② 解冻：闭包**外**的 `blocked` → `working`。`updateTaskState` **只改 state**：
  //    不清 `remote_task_id`（已派发被冻节点的防双派防线）、不动 `finished_at`；
  //    `working` 不写事件（store 既有纪律：仅非 `working` 的新态才落 `task.settled` / `task.blocked`）。
  const unfrozen: string[] = [];
  for (const id of plan.unfreezeIds) {
    const rec = updateTaskState(id, "working");
    if (rec !== null && rec.state === "working") unfrozen.push(id);
  }

  // Feature Context 同常规路径（note → plan；decisions / contracts 可选）；**Feature 态不动**
  applyFeatureContext(feature.featureId, args);

  // 登记字段（v0.9.0）：与 Context 同族，**在全部重派校验通过之后**才写 ⇒ 拒绝路径零变更；
  // **Feature 态仍不动**
  if (
    registration.stage !== undefined ||
    registration.approval !== undefined ||
    registration.version !== undefined
  ) {
    updateFeatureRegistration(feature.featureId, registration);
  }

  return {
    ok: true,
    featureId: feature.featureId,
    // 相等值回显：本路径**无状态转移** ⇒ `from === state`（§2.3「均为 executing」的静止期用法）
    from: feature.state,
    state: feature.state,
    rearmed,
    unfrozen,
    // 明细装配 = **写后重读**（节点重派/解冻不改 features 行，但同单的 Context 与登记字段改 ⇒ 须读回）
    ...stageDetailAfterWrite(feature.featureId, feature),
  };
}

// ---------------------------------------------------------------------------
// approve（审批门）
// ---------------------------------------------------------------------------

export interface FeatureApproveArgs {
  featureId: string;
}

export function handleFeatureApprove(
  args: FeatureApproveArgs,
  identity: string | null = null,
): FeatureApproveSuccess | FeatureToolFailure {
  const feature = getFeature(args.featureId);
  if (feature === null) {
    return { ok: false, code: "feature_not_found", error: `未知 Feature ${args.featureId}` };
  }
  // 归属校验（谁建谁见）：非本组 ⇒ 拒绝（过审批门是操作，只能由归属组驱动）
  const denied = ownershipFailure(feature, identity);
  if (denied !== null) return denied;
  if (feature.state !== "waiting_approval") {
    return {
      ok: false,
      code: "feature_state_invalid",
      error: `审批门仅适用于 waiting_approval（当前 ${feature.state}）`,
    };
  }
  // **①② = 门看 `state` 与 `approval`**（v0.9.0 B2″）：这两条各自只查当场值，**不查 `stage`**。
  // ⚠ **口径变更（增补 `ec93e1bd` / 引擎映射 §3 门②行「过门判据 = 六条」）**：原句「门看 approval、
  // 不看 stage」自本卡起只剩「**①② 这两条不查 stage**」这一半为真 —— `stage` 已进入过门条件（下方 ⑤），
  // 但**仍不校验 `stage` 迁移序**（⑤ 只读当场值、不追问它经由哪条迁移抵达），正交的原句在这半句上照旧。
  // 不满足 ⇒ 结构化拒绝，**不放行、不改状态、不落 `approval = 已通过`**。
  // ⚠ v0.10.5 O4 起 `create` 初值恒定 `未发起`（原「create 缺省即待审批 ⇒ 既有调用零红」句作废）：
  // 过审前必须由宿主经 advance 写 `approval = 待审批`（改造文档落文件之时，规范 §3.5 的既定顺序）。
  if (feature.approval !== "待审批") {
    return {
      ok: false,
      code: "feature_approval_not_ready",
      error:
        `审批门未发起或已不可过审（approval = ${feature.approval}，仅「待审批」可放行）：` +
        `approve = 记录用户已给的方案确认，前置是改造文档已落文件且 approval 已置「待审批」` +
        `（经 a2a_feature_advance 写登记字段）。`,
    };
  }
  // ---- 门②（改造文档确认）过门条件 ③④⑤⑥（增补 `ec93e1bd` / 引擎映射 §3 门②行六条）------------
  // **位置硬约束**：本串必须早于下面**三笔写** —— `updateFeatureState`（主链迁 `target`）/
  // `updateFeatureRegistration{ approval: "已通过" }` / `activateVersionForFeature`（版本 `notstart→active`）。
  // **后人不得把任何判据插进这三笔之间**：`feature` 是写前快照、三笔写非事务，中途回头返工会留下
  // 「态已迁、门没过」的**不可回滚半态**（`approval` 已单向落「已通过」，无回边可撤）。
  // **序 = ③ → ④ → ⑤ → ⑥**（与门① 两前提同序）⇒ ①② 的既有负锚逐字不翻；**缺哪报哪、不合并**。
  // ③④ **照抄门① 的两条前提**（同一批码、同一 {@link gate1DocPresent} 双档单源 · v0.11.0 orch-N7，
  // 不造第二套判据）：本串堵的洞是「**登记写 `approval = 待审批` 不要求先过门①**」⇒ 只做门②、
  // 省略门① 的卡此前能直行至此并放行。
  if ((feature.version ?? "") === "") {
    return {
      ok: false,
      code: ERR_GROUP_VERSION_REQUIRED,
      error:
        `门②（改造文档确认）条件 ③：Feature ${feature.featureId} 的 features.version 为空（未排期）⇒ 不得过 approve；` +
        "零迁移（state / approval 逐字不动）。" +
        "先经引擎排期写口写定 version（advance 的「to = 当前态 ∧ 带 version」特例），再重试过门",
    };
  }
  // **第二入参恒不传**：{@link gate1DocPresent} 旧档的并集豁免是为门① 服务的（宿主「同一单先登记
  // 路径、再抬 `stage`」是既有合法用法）；**approve 无 `decisions` 入参 ⇒ 并集豁免在本侧不存在**，
  // 本串只看已落库的那一行（改造文档 §C.2「当场查」）。
  if (gate1DocPresent(feature) === null) {
    return {
      ok: false,
      code: ERR_CONFIRMATION_DOC_REQUIRED,
      error:
        `门②（改造文档确认）条件 ④：Feature ${feature.featureId} 的《需求确认单》两档均未命中` +
        `（已落库值内无 "${CONFIRMATION_DOC_MARKER}" 档名 ∧ 本轮「需求分析」无在册合成行或其 sections 为空）` +
        `⇒ 不得过 approve；零迁移（state / approval 逐字不动）。` +
        "门② 的 ③④ 照抄门① 两条前提 ⇒ 未过门① 的卡不得直接过门②；" +
        "先用 advance 的登记写把确认单路径登记进去，或等引擎产出本轮合成《需求确认单》",
    };
  }
  if (feature.stage === "需求分析") {
    return {
      ok: false,
      code: ERR_REQUIREMENT_GATE_NOT_PASSED,
      error:
        `门②（改造文档确认）条件 ⑤：Feature ${feature.featureId} 的 stage 仍为「需求分析」⇒ 需求确认门（门①）未过，` +
        "不得过 approve；零迁移（state / approval 逐字不动）。" +
        "判据 = derivePendingItems 的 stage 欠项同款（只查当场值、不校验迁移序）；先经 advance 把 stage 迁往「改造方案」（该单同受门① 两前提执法）",
    };
  }
  if (!docRegistered(feature.decisions, undefined, DESIGN_DOC_MARKER)) {
    return {
      ok: false,
      code: ERR_DESIGN_DOC_REQUIRED,
      error:
        `门②（改造文档确认）条件 ⑥：Feature ${feature.featureId} 的 decisions 未登记《改造文档》档名` +
        `（已落库值内无 "${DESIGN_DOC_MARKER}"）⇒ 不得过 approve；零迁移（state / approval 逐字不动）。` +
        "⚠ 两枚档名（《需求确认单》与《改造文档》）**须同时在册** —— " +
        "decisions 是**整值替换**，补登记时须**重发全量两枚**（只发新枚会把条件 ④ 打回）。",
    };
  }
  /**
   * **目标态按父链分流（v0.10.5 O4 / 改造文档 §2.6）** —— 判据 = `parentFeatureId !== null`：
   * - **无父（主轨）** ⇒ `waiting_approval → version_planning`：PjM 版本规划工序自占一格；
   * - **有父（增补轨 / 承接轨）** ⇒ 直接 `→ decomposing`：**跳过** `version_planning`，
   *   因两者均不重走 PjM 工序（版本规划已随主轨落定，规范 §2 Step 3「增补轨」条）。
   *
   * **不为此在转移表加 `waiting_approval → decomposing` 边**：`approve` 是本格的**唯一准入**，
   * 走的是上面的直写路径（不经 `canTransition`）；一旦加边，`advance(to="decomposing")` 在
   * `waiting_approval` 也会合法 ⇒ 等于开了绕过 `approve` 的第二道门。边留在表上只服务 `advance`，
   * 而 `advance` 已被 `feature_approval_required` 守卫挡死。
   */
  const target: FeatureState = feature.parentFeatureId === null ? "version_planning" : "decomposing";
  /**
   * **`stage` 半派生（v0.10.8 O-2 / 范围扩展）**：`approve` 迁入的目标态（`version_planning` 主轨 /
   * `decomposing` 增补·承接轨）此前**只经 `updateFeatureState` 落主链、不派生 `stage`** ⇒ `version_planning`
   * 停在门① 显式写的「改造方案」，`STAGE_DERIVATION.version_planning` 一行运行时不生效。
   * 这里补齐派生，**与 `handleFeatureAdvance` 的唯一调用点同源**：同一 `deriveStageForState`、同一
   * `updateFeatureRegistration({ stage })` 写口，不另立第二份映射。落点在主链迁移**之前**、与 `advance`
   * 路「派生先于 `updateFeatureState`」同序。
   */
  const derivedStage = deriveStageForState(target);
  if (derivedStage !== null) {
    updateFeatureRegistration(feature.featureId, { stage: derivedStage });
  }
  const updated = updateFeatureState(feature.featureId, target);
  // 过审即把门状态落定（**单向、无回边**）：同一张单不得被重复过审解释
  updateFeatureRegistration(feature.featureId, { approval: "已通过" });
  // v0.10.0 O2c：`approve` 放行 = 版本「notstart → active」的触发点之一；v0.10.7 n3 起该点**前移门①**，
  // 本格降级为**幂等兜底**（门① 已抬版 ⇒ 此处恒 `activated = false`、零事件）。
  // （引擎内部 · 幂等 · 不阻断；事件 `version.activated` 由 store 写口同事务落，`trigger = "approve"`）。
  // 版本面故障绝不拖垮过审：`activateVersionForFeature` 自带 try/catch 护栏（见 versions-activation.ts）。
  activateVersionForFeature(feature, "approve");
  const success: FeatureApproveSuccess = {
    ok: true,
    featureId: feature.featureId,
    from: feature.state,
    state: updated === null ? target : updated.state,
    // 明细装配（增补 `6cc46dd2` N4）= **写后重读**：本格两条写笔（主链迁 `target`、`approval` 落
    // 「已通过」）都在 `feature` 这份**写前快照**之后 ⇒ 直接用快照会报「被离开的那一格」（`waiting_approval`
    // 的 `gate` / `pending`）且 `approval` 回显成「待审批」。`fallback` 只兜重读落空（行刚被本单写过）。
    ...stageDetailAfterWrite(feature.featureId, feature),
  };
  return success;
}

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

export interface FeatureCancelArgs {
  featureId: string;
}

export function handleFeatureCancel(
  args: FeatureCancelArgs,
  identity: string | null = null,
): FeatureStateChangeSuccess | FeatureToolFailure {
  const feature = getFeature(args.featureId);
  if (feature === null) {
    return { ok: false, code: "feature_not_found", error: `未知 Feature ${args.featureId}` };
  }
  // 归属校验（谁建谁见）：非本组 ⇒ 拒绝（取消只能由归属组驱动）
  const denied = ownershipFailure(feature, identity);
  if (denied !== null) return denied;
  // v0.9.5（REQ-2026-09-28-10 O1）：`failed` 放行 —— cancel 是 failed 的唯一收口归档口
  // （迁 `cancelled`，仅改 Feature 态、不动节点账面）。`completed` / `cancelled` 照旧拒绝；
  // 转移表 `failed: []` 不改（本守卫直写放行，不经 canTransition）。
  // **与 :905 retry 守卫刻意分叉**：那里仍拒全部三终态（终态节点不会被调度），不得顺手同步。
  if (feature.state === "completed" || feature.state === "cancelled") {
    return {
      ok: false,
      code: "feature_terminal",
      error: `Feature 已收口（${feature.state}），不可取消（failed 可经 cancel 归档为 cancelled）`,
    };
  }
  const updated = updateFeatureState(feature.featureId, "cancelled");
  return {
    ok: true,
    featureId: feature.featureId,
    from: feature.state,
    state: updated === null ? "cancelled" : updated.state,
  };
}

// ---------------------------------------------------------------------------
// trace（v0.8.8 §2.10(c) 只读查询；v0.8.10 O-N3 起同时是 MCP 工具 `a2a_feature_trace`）
// ---------------------------------------------------------------------------

/**
 * 「这个 Feature 为什么还没完成」的**只读投影**（REQ-v0.8.8-2026-09-22-01 §2.10(c) · O7；
 * **REQ-v0.8.10-2026-09-23-01 O-N3 扩档位可见面并挂成 MCP 只读工具**）。
 *
 * 纯计算（store 只读 + 现成判据），**不落库、不加写口、不改调度器行为**；
 * 出参为**独立新增只读面**（不改既有工具出参形状）。两个出口复用**本实现**、不写第二套判据：
 * MCP `a2a_feature_trace`（按连接身份做归属校验）与工作台 `GET /api/features/:id/trace`（无身份）。
 *
 * 口径：
 * - 只输出**非终态**且**是 DAG 节点**（`isDagNode`，v0.10.8 O-4）的行（`working` / `input-required`；
 *   `completed` / `failed` / `blocked` 不出；`mode="inquiry"` 的归属行不出 —— 但它仍可作为
 *   `readOccupants[]` 的只读占位者出现，二者是两套集合）；
 * - **项目忙判定走队列态**（`state='working' ∧ queue_state IN ('queued','claimed','running') ∧ 写档`，
 *   经 `listBusyTasksForProject` = `listBusyProjectIds` 同一谓词的行级展开）——
 *   **不走 `remote_task_id`**（pull 模型下该列在飞期间恒 NULL，用了永远判「不忙」）；
 *   占用者可跨 Feature（项目串行是全局事实）。调度器**进程内** `reservedProjects` 只守
 *   「入队未落库」的同 tick 窗口（毫秒级），本查询覆盖不到，口径上按已落库事实回答；
 * - ★ **`projectBusy` 只反映写门**（v0.8.10 起谓词排除只读档）⇒ 「被长跑 read 占着 machine 读闸」
 *   这一格由 **`readOccupants[]`** 补答，`waitReason='read_lane_running'` 标记该情形
 *   （否则「写门没挡、却没开工」= **假空洞**，跨侧不变量 U9）；
 * - `blockedOn` = **直接依赖**中未达 `completed` 者（含 failed/blocked 上游）；
 * - `position` = **与实领序同键**的 FIFO 位次：`queue_state='queued' ∧ queued_at < 我的入队时刻` 计数 +1。
 *   v0.8.8 用 `created_at`（登记时刻）与 `claimTask` 的 `queued_at`（入队时刻）**两套时钟** ⇒ 位次
 *   系统性偏离实领序；O-N3 改键后**同源**（不再是"估计量"）。**未入队**（就绪待派）节点没有
 *   `queued_at` ⇒ 按「不设上界」投影 = 「此刻入队会排在所有在队者之后」。
 *   唯一残余偏差 = `claimTask` 的**写优先**第一键（跨档纯 FIFO 计数消除不了，见 `countQueuedBefore` 注记）。
 */
export function handleFeatureTrace(
  args: FeatureTraceArgs,
  identity: string | null = null,
): FeatureTraceSuccess | FeatureToolFailure {
  const feature = getFeature(args.featureId);
  if (feature === null) {
    return { ok: false, code: "feature_not_found", error: `未知 Feature ${args.featureId}` };
  }
  // 归属校验（谁建谁见）：与其它出口同一判据；无身份（web 运维面）⇒ 全量放行
  const denied = ownershipFailure(feature, identity);
  if (denied !== null) return denied;

  // **v0.10.8 O-4（trace 侧）**：节点集先过 `isDagNode` ⇒ inquiry 行**不进** `nodes[]`（它不是 DAG
  // 节点，答不了「这个 Feature 为什么还没完成」）。⚠ 只收窄**本 Feature 的节点集**；下面
  // `readOccupants[]` 是**项目级只读占位**（可跨 Feature）⇒ **一字不剔**，inquiry 的只读行仍是
  // 「为什么没跑」的真占位答案（验收锚见 `test/v0108-n6-*.test.ts` 的 grep 断言）。
  const nodes = listFeatureTasks(feature.featureId, { limit: 1000 }).filter(isDagNode);
  const byId = new Map(nodes.map((n) => [n.taskId, n]));
  /** 读缓存：同项目写档忙明细 / 同项目只读档占位 / 同一位次上界的计数各查一次（节点上限 1000，纯读、量小） */
  const busyByProject = new Map<string, QueuedTaskRecord[]>();
  const readLaneByProject = new Map<string, QueuedTaskRecord[]>();
  /** 位次缓存键：入队时刻；`NO_QUEUED_AT` = 未入队（不设上界）那一档 */
  const NO_QUEUED_AT = "";
  const aheadByUpperBound = new Map<string, number>();

  const traced: FeatureTraceNode[] = [];
  for (const n of nodes) {
    if (n.state !== "working" && n.state !== "input-required") continue;
    const q = getQueuedTask(n.taskId);
    // 仅在队时报告队列态；NULL（未入队）与 `working ∧ settled` 残留（重排后待再派）一律归 null
    const queueState: QueueState | null =
      n.state === "working" && q !== null && q.queueState !== "settled" ? q.queueState : null;

    const blockedOn = (n.dependencies ?? []).filter((id) => byId.get(id)?.state !== "completed");

    let busyTasks = busyByProject.get(n.projectId);
    if (busyTasks === undefined) {
      busyTasks = listBusyTasksForProject(n.projectId);
      busyByProject.set(n.projectId, busyTasks);
    }
    const others = busyTasks.filter((t) => t.taskId !== n.taskId);
    // 占位者优先取在飞（claimed/running，携带 claimed_by = 占位机）；否则取最早入队者
    const occupier =
      others.find((t) => t.queueState === "claimed" || t.queueState === "running") ??
      others[0] ??
      null;
    const projectBusy: FeatureTraceProjectBusy = {
      busy: occupier !== null,
      taskId: occupier?.taskId ?? null,
      machineId: occupier?.claimedBy ?? null,
    };

    // ★ 只读档占位面（写忙集 O-N1 起排除 read ⇒ 这一格不能空着，否则假空洞 = U9）
    // ⚠ **项目级只读占位、不是 Feature 节点集** ⇒ v0.10.8 O-4 的 `isDagNode` 收窄**不作用于这里**
    //   （N6-READ-OCCUPANTS-NO-MODE-FILTER）：inquiry 的只读行是本 machine 真占位者，剔掉即把
    //   「为什么没跑」答丢；收窄只发生在上面的 nodes[]。
    let readLaneTasks = readLaneByProject.get(n.projectId);
    if (readLaneTasks === undefined) {
      readLaneTasks = listReadLaneTasksForProject(n.projectId);
      readLaneByProject.set(n.projectId, readLaneTasks);
    }
    const readOccupants: FeatureTraceReadOccupant[] = readLaneTasks
      .filter((t) => t.taskId !== n.taskId)
      .map((t) => ({
        taskId: t.taskId,
        featureId: t.featureId,
        queueState: t.queueState,
        machineId: t.claimedBy,
        queuedAt: t.queuedAt,
      }));

    let position: number | null = null;
    if (n.state === "working" && (queueState === "queued" || queueState === null)) {
      // 上界 = 自己的入队时刻（与 `claimTask` 实领序同键）；未入队 ⇒ 不设上界（此刻入队即在队尾）
      const upperBound = queueState === "queued" ? (q?.queuedAt ?? null) : null;
      const cacheKey = upperBound ?? NO_QUEUED_AT;
      let ahead = aheadByUpperBound.get(cacheKey);
      if (ahead === undefined) {
        ahead = countQueuedBefore(upperBound);
        aheadByUpperBound.set(cacheKey, ahead);
      }
      position = ahead + 1;
    }

    traced.push({
      taskId: n.taskId,
      projectId: n.projectId,
      state: n.state,
      lane: n.lane,
      taskType: n.taskType,
      queueState,
      waitReason: waitReasonOf(
        feature,
        n.state,
        queueState,
        blockedOn,
        projectBusy,
        readOccupants.length > 0,
      ),
      blockedOn,
      projectBusy,
      readOccupants,
      position,
      waitedSince: waitedSinceOf(n, q, queueState),
    });
  }
  return { ok: true, featureId: feature.featureId, featureState: feature.state, nodes: traced };
}

export interface FeatureTraceArgs {
  featureId: string;
}

/**
 * 节点「为何未完成」（闭集；排队可见面 / 限流后续在此之上叠加）。
 *
 * ★ v0.8.10 O-N3 起为**八值**（末位 `read_lane_running` 是读写分道后补上的一格）：
 * 写忙集（`busyProjectPredicate`）排除只读档 ⇒ 光看 `project_busy` 会把「被长跑 read 占着
 * machine 读闸」读成「没人挡、却没开工」的**假空洞**，故必须有一个显式类别 + `readOccupants[]` 明细
 * （跨侧不变量 U9：谓词改动与本档**同节点交付**）。
 */
export type FeatureWaitReason =
  /** `input-required`：等用户澄清 */
  | "awaiting_user"
  /** 在飞（claimed/running）：等远端执行结果回传 */
  | "running_remote"
  /** 已入队：等 Runner 领取 */
  | "queued"
  /** 直接依赖未 completed（含上游 failed/blocked） */
  | "upstream_dependencies"
  /** Feature 不在 `executing`：调度器不派发（waiting_approval / 主链后段 / 静止期外的停留） */
  | "feature_not_executing"
  /** 依赖已满足但同项目被**写档**占（项目串行门） */
  | "project_busy"
  /**
   * 依赖已满足、写门不挡，但同项目有**未落定的只读档**行在占位（v0.8.10 O-N3）。
   *
   * 挡人的不是 orch 的门（只读档不入写忙集），而是 machine 侧同 project 读并发闸
   * （`maxConcurrentReads`，缺省 1）⇒ **两个时钟不得相加**（口径 U6）：本值只说明
   * 「同项目有 read 未落定」，不推断对方还要跑多久。明细见 `readOccupants[]`。
   */
  | "read_lane_running"
  /** 就绪且项目空闲（写门、只读档均无占用）：等调度器 tick 的派发窗口 */
  | "ready_pending_dispatch";

/** 项目占用（串行门）视图：bool + 占位节点 + 占位机 */
export interface FeatureTraceProjectBusy {
  busy: boolean;
  /** 占用项目的节点 id（`working ∧ queue_state 忙 ∧ 写档` 的他节点，可跨 Feature）；无占用 ⇒ null */
  taskId: string | null;
  /** 占位机（占用节点的 `claimed_by`）；占用者已入队未被领取 ⇒ null */
  machineId: string | null;
}

/**
 * **只读档占位**（v0.8.10 O-N3；`lane='read' ∧ 未落定` 的他节点，可跨 Feature / 散活）。
 *
 * 与 {@link FeatureTraceProjectBusy} 的分工：后者 = **orch 写门**的事实（谁能挡派发），
 * 本视图 = **被写门让开的那片占用面**（不挡 orch 派发、但会占住 machine 侧该项目的执行位）。
 */
export interface FeatureTraceReadOccupant {
  taskId: string;
  /** 占位节点归属的 Feature；`null` = 散活行（不经调度器、无 Feature 归属） */
  featureId: string | null;
  /** 占位行的队列态（`queued` = 已入队未被领取；`claimed` / `running` = 已在机上执行） */
  queueState: QueueState;
  /** 占位机（`claimed_by`）；已入队未被领取 ⇒ null */
  machineId: string | null;
  /** 该行的入队时刻（「等了多久」的原料）；未入队的老行 ⇒ null */
  queuedAt: string | null;
}

/** trace 单节点视图（仅非终态节点） */
export interface FeatureTraceNode {
  taskId: string;
  projectId: string;
  state: TaskRecord["state"];
  /** **并发档**（v0.8.10 O-N3 additive；`read` = 只读档，不参与写忙集） */
  lane: TaskLane;
  /**
   * **职责位**（v0.10.2 O-3 additive；来源 `tasks.task_type`）：与 `lane` 同款**恒有值**
   * （读侧 NULL 已归一 `unit_agent`）⇒ **不得省略字段**。
   */
  taskType: TaskType;
  /** 队列态；null = 不在队（未入队 / 重排后待再派 / input-required） */
  queueState: QueueState | null;
  waitReason: FeatureWaitReason;
  /** 未 completed 的直接依赖 id（与真实依赖一致；含 failed/blocked 上游） */
  blockedOn: string[];
  projectBusy: FeatureTraceProjectBusy;
  /**
   * 同项目**只读档**占位明细（不含自己；空数组 = 无只读占位）。
   * `projectBusy.busy === false` 而本数组非空 ⇒ 即 `waitReason='read_lane_running'` 那一格。
   */
  readOccupants: FeatureTraceReadOccupant[];
  /**
   * FIFO 位次（1 起）；不适用（在飞 / 待澄清）⇒ null。
   * **与 `claimTask` 实领序同键**（`queued_at`，v0.8.10 O-N3）；未入队节点 = 「此刻入队」的投影位次。
   */
  position: number | null;
  /** 等待起点（在飞 = 领取时刻；排队 = 入队时刻；未入队 = 登记时刻；待澄清 = 最后更新时刻） */
  waitedSince: string | null;
}

export interface FeatureTraceSuccess {
  ok: true;
  featureId: string;
  featureState: FeatureState;
  nodes: FeatureTraceNode[];
}

/** `waitReason` 判定（优先级自上而下；与 `computeReadyNodes` 的判据族一致但面向解释） */
function waitReasonOf(
  feature: FeatureRecord,
  state: TaskRecord["state"],
  queueState: QueueState | null,
  blockedOn: readonly string[],
  projectBusy: FeatureTraceProjectBusy,
  hasReadLaneOccupant: boolean,
): FeatureWaitReason {
  if (state === "input-required") return "awaiting_user";
  if (queueState === "claimed" || queueState === "running") return "running_remote";
  if (queueState === "queued") return "queued";
  if (blockedOn.length > 0) return "upstream_dependencies";
  if (feature.state !== "executing") return "feature_not_executing";
  if (projectBusy.busy) return "project_busy";
  // 写门不挡却没开工 ⇒ 先看是不是只读档占着 machine 的读位（v0.8.10 O-N3，消「假空洞」）
  if (hasReadLaneOccupant) return "read_lane_running";
  return "ready_pending_dispatch";
}

/** 等待起点（按队列态选取对应时刻列；老记录时刻列为 null 时逐级回退） */
function waitedSinceOf(
  node: TaskRecord,
  q: QueuedTaskRecord | null,
  queueState: QueueState | null,
): string | null {
  if (node.state === "input-required") return node.updatedAt;
  if (queueState === "claimed" || queueState === "running") {
    return q?.claimedAt ?? node.startedAt ?? node.createdAt;
  }
  if (queueState === "queued") return q?.queuedAt ?? node.createdAt;
  return node.createdAt;
}
