/**
 * 阶段轮**收口判据**与 `stage.round_settled` **事件写入点**（R1 · v0.11.0 orch-N8）。
 *
 * 定位（改造文档 §2.2 + §2.5 收口事件条 + 宿主裁定 ⑤）：一格阶段轮 `(feature, stage, round)`
 * 是否**收口**，是一条**唯一**的三条件合取（逐行、阶段内）：
 *
 * ```
 * 收口 ⟺ ∀ 本轮应收行：answer_state = 'valid'
 *                     ∧ based_on_rev = 本轮 basisRev
 *                     ∧ (relevance = 'involved' ⇒ decision ≠ 'pending')
 * ```
 *
 * 本件把这条判据从**库里**（{@link SessionStore.listStageRoundRows} 取本轮原始行集）搬到
 * **应用层**跑，再在**首次跃迁**时写一枚事件。三件职责、三种落点，边界如下：
 *
 * - **判据单点**：三条件谓词与四分类次序**不在本件重写**，直接消费 `bridge/stage-round.js` 的
 *   {@link isQualifiedStageRow} / {@link classifyStageRow}（N7 建的同一条 §2.2 判据）。
 *   全仓两处判据 = 读面分子与收口事件迟早对不上（板面「N/N 已回执」与引擎挡位名单打脸）。
 * - **`stale` 读时派生、不落列**（宿主裁定 ⑤：判据函数在应用层跑、**不进 SQL**——SQL 里
 *   算不出「行值 ≠ 本轮口径」这种跨行比较，硬要落列就得回填、就得二次改写，那是第二套事实源）。
 *   本件对 `stale` 的唯一动作是**读** `based_on_rev` 现值做比对（{@link isStageRowStale}），
 *   零写：库里那一行的 `answer_state` 照旧是 `valid`，被挡在名单里的是**派生态**。
 * - **不复用 scheduler 收敛路径**（§2.2 明文「自建判定器」）：`bridge/scheduler.js` 的
 *   `reduceConvergence` / `featureAtRest` / `isFeatureSealed` 对 `inquiry` **全盲**是**刻意排除**
 *   （N2 的 `isDagNode` 肯定式翻转 + N6 的读面 mode 补批共同保证），本件**不 import** 该文件、
 *   也不得被它的调用链接入（结构锚见 `test/v0110-n8-stage-seal.test.ts` 判据 4）。
 *
 * 停靠形态（§2.2 末条，本件的**负向**职责）：**轮停在未收口 = 合法停靠形态**。未收口时本件
 * 零写、只出指名名单；**禁止**任何形式的「超时自动标 `not_involved`」兜底——离线成员长期
 * `pending`、`queued` 未派发行计入分母，都是设计要的样子（板面长期可见即告警面）。
 * 收口**不推进主链**：不调 `canTransition`、不改 `features.stage`、不构成门。
 *
 * 事件负向句（§2.5 命名条要求随事件登记）：`stage.round_settled` **不属于**既有「需动作」
 * 三时点、**不构成第四时点**；唤醒面由板自管（板心跳 `scan()` 见本事件 ⇒ `fireWake` 拉起
 * 宿主综合分析），**引擎只发事件、不拉确认者、不发文件**（§2.6）。
 */
import type { EventRecord, FeatureStage, TaskRecord } from "../types.js";
import { isUniqueConstraintError, type SessionStore } from "../session/store.js";
import {
  classifyStageRow,
  idempotencyKeyOf,
  isStageRowStale,
  type StageRowJudgementInput,
} from "./stage-round.js";

/** 事件 kind（`域.下划线段` 形态，与 `task.settled` / `stage.doc_objection` 同形） */
export const EVENT_STAGE_ROUND_SETTLED = "stage.round_settled";

/**
 * 整轮级挡位（行级三分类**装不下**的两类，故另立一枚；`null` = 挡位全在 {@link
 * StageRoundSealVerdict.blockers} 里）。
 * - `empty-round`：本轮零行 ⇒ 应收集为空。**不得**据此判收口（空集合上的真空真 = 把
 *   「一轮还没物化完」显示成「已收齐」，直接伪造门① 前提）。
 * - `basis_undeterminable`：本轮口径指纹**无从判定**（物化行全缺 `based_on_rev`，或未回执行
 *   之间出现两枚以上指纹 = 脏数据）。宁可挡收口，也不猜一个口径把 已答的行判成陈旧。
 */
export type StageRoundBlocker = "empty-round" | "basis_undeterminable" | null;

/** 行级挡位类别（= {@link classifyStageRow} 的非 `settled` 三值，次序口径同一条） */
export type StageSealBlockerKind = Extract<ReturnType<typeof classifyStageRow>, "pending" | "invalid" | "stale">;

/** 一枚被指名挡位（改造文档 §2.2「一律挡收口**且被指名**」的返回体原料：`task_key`/`round`/`projectId` 三枚齐带） */
export interface StageSealBlocker {
  taskId: string;
  /** 引擎侧命名键（读口只取 `task_key` 非空的物化行 ⇒ 本枚恒有值；类型仍留 `null` 以照 `TaskRecord` 的读形） */
  taskKey: string | null;
  projectId: string;
  stage: FeatureStage;
  round: number;
  kind: StageSealBlockerKind;
  /** 人读短句（板侧「查看依据」直接渲，不再自行翻译分类） */
  detail: string;
}

/** 一格阶段轮的收口裁定（纯函数出参；读面与事件写入点共用同一枚形） */
export interface StageRoundSealVerdict {
  featureId: string;
  stage: FeatureStage;
  round: number;
  /** 本轮口径指纹（`stale` 比对的基准）；`null` = 无从判定 ⇒ 必不收口 */
  basisRev: string | null;
  /** 分母 = 本轮物化行数（= 本轮应收集，含离线/未派发成员） */
  expected: number;
  /** 分子 = 三条件全合格的行数 */
  settledCount: number;
  /** 收口 ⟺ 行集非空 ∧ 口径可判 ∧ `blockers` 为空 */
  sealed: boolean;
  /** 挡位指名名单，按 `projectId` 字典序（本件排序 ⇒ 与入参行序无关） */
  blockers: StageSealBlocker[];
  /** 整轮级挡位（行级装不下的两类；与 `blockers` 互斥非空） */
  roundBlocker: StageRoundBlocker;
}

/** 单行判定料装配（`reachability` 不参与收口 ⇒ 直接喂 {@link StageRowJudgementInput} 的四枚） */
function judgementOf(row: TaskRecord, basisRev: string): StageRowJudgementInput {
  return {
    stale: isStageRowStale(row, basisRev),
    answerState: row.answerState,
    relevance: row.relevance,
    decision: row.decision,
  };
}

/**
 * **本轮口径指纹 `basisRev` 的推断单点**（调用方**不**已知本轮指纹时的兜底）。
 *
 * 取值序（严格优先，写死在此，不留给调用方猜）：
 * 1. **未回执行的指纹**——`answer_state ≠ 'valid'` 的行**必然还带着物化写进去的原值**：
 *    `based_on_rev` 的唯一覆写点是 N4 结算钩子的 `valid` 分支，而该分支每行至多进一次
 *    （`already-valid` 早退）。故这一档是**免校验的口径原值**；
 * 2. 本轮**已全部 valid**（= 首次跃迁的那一刻）⇒ 取行集指纹的**众数**；
 * 3. 平局、或行集内指纹为空 ⇒ `null`（无从判定 ⇒ 挡收口）。
 *
 * ⚠️ 第 2 档是**弱档**：全员 valid 时未覆写行已不存在，多数派只是「最可能是物化值」——
 * 极端情形（两行都回了同一个越界 `BASED_ON_REV`）会把旧口径认成本轮口径、假收口一次。
 * ⇒ **结算钩子不走本函数**：它手里有该行**写前**的 `based_on_rev`（那时该行还未被覆写 =
 * 第 1 档的凭据），故显式传入。本函数只服务「无写前快照」的调用方（对账/读面重算）。
 */
export function resolveStageRoundBasisRev(rows: readonly TaskRecord[]): string | null {
  const fresh = new Set<string>();
  for (const row of rows) {
    if (row.answerState === "valid") continue;
    if (row.basedOnRev !== null) fresh.add(row.basedOnRev);
  }
  if (fresh.size === 1) return [...fresh][0] ?? null;
  if (fresh.size > 1) return null; // 物化一次事务写同值 ⇒ 多枚 = 脏数据，不猜

  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.basedOnRev === null) continue;
    counts.set(row.basedOnRev, (counts.get(row.basedOnRev) ?? 0) + 1);
  }
  let winner: string | null = null;
  let winnerCount = 0;
  let tie = false;
  for (const [rev, count] of counts) {
    if (count > winnerCount) {
      winner = rev;
      winnerCount = count;
      tie = false;
    } else if (count === winnerCount) {
      tie = true;
    }
  }
  return tie ? null : winner;
}

/**
 * **收口判据本体**（纯函数，零 IO；入参 = 本轮物化行集 + 本轮口径）。
 *
 * `basisRev` 传入非空 ⇒ 以调用方为准（结算钩子的写前快照）；缺省 / `null` ⇒ 走
 * {@link resolveStageRoundBasisRev} 现算。行集**应为** {@link SessionStore.listStageRoundRows}
 * 的原始返回（`mode` 归属 + `task_key IS NOT NULL` 两道门已在那侧做完）；本件不再筛 mode，
 * 只做「三条件合取 + 挡位指名」。
 */
export function evaluateStageRoundSeal(input: {
  featureId: string;
  stage: FeatureStage;
  round: number;
  rows: readonly TaskRecord[];
  basisRev?: string | null;
}): StageRoundSealVerdict {
  const basisRev = input.basisRev ?? resolveStageRoundBasisRev(input.rows);
  const blockers: StageSealBlocker[] = [];
  let settledCount = 0;
  if (basisRev !== null) {
    for (const row of input.rows) {
      const judgement = judgementOf(row, basisRev);
      const kind = classifyStageRow(judgement);
      if (kind === "settled") {
        settledCount += 1;
        continue;
      }
      blockers.push({
        taskId: row.taskId,
        taskKey: row.taskKey,
        projectId: row.projectId,
        stage: row.stage ?? input.stage,
        round: row.round ?? input.round,
        kind,
        detail: blockerDetail(row, kind, basisRev),
      });
    }
  }
  // 名单序 = `projectId` 字典序（与归属读面同序，板侧两份清单可直接比对）；
  // 在**本件**排、不靠调用方传序 ⇒ 纯函数的出参确定性不取决于入参行序（纯判据 1 的 8 例可逐字节比）。
  blockers.sort((a, b) =>
    a.projectId === b.projectId ? (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0)
    : a.projectId < b.projectId ? -1 : 1,
  );
  const roundBlocker: StageRoundBlocker =
    input.rows.length === 0 ? "empty-round" : basisRev === null ? "basis_undeterminable" : null;
  return {
    featureId: input.featureId,
    stage: input.stage,
    round: input.round,
    basisRev,
    expected: input.rows.length,
    settledCount,
    // 未收口就是未收口：整轮级挡位在 ⇒ `blockers` 为空也**不得**放行（真空真禁令的直接兑现）
    sealed: roundBlocker === null && basisRev !== null && blockers.length === 0,
    blockers,
    roundBlocker,
  };
}

/** 挡位短句（分类已由 {@link classifyStageRow} 定死，本函数只负责把它说成人话） */
function blockerDetail(row: TaskRecord, kind: StageSealBlockerKind, basisRev: string): string {
  switch (kind) {
    case "stale":
      return `答在旧口径上：行 based_on_rev=${row.basedOnRev} ≠ 本轮 ${basisRev}（读时派生，库里 answer_state 仍为 ${row.answerState ?? "null"}）`;
    case "invalid":
      return "回执不合阶段三值契约（重派一次后仍不合规）：answer_state=invalid";
    case "pending":
      return row.relevance === "involved" && (row.decision === "pending" || row.decision === null)
        ? "已答涉及但未给决定：decision=pending"
        : "尚未有效回执：answer_state=pending（离线/未派发同样计入分母）";
  }
}

/** `stage.round_settled` 的**幂等键**（内容定义串：同一 `(featureId, stage, round)` 必得同一串 ⇒ `idx_events_idempotency_key` 真拒重） */
export function stageRoundSettledIdempotencyKey(featureId: string, stage: FeatureStage, round: number): string {
  return idempotencyKeyOf(EVENT_STAGE_ROUND_SETTLED, [featureId, stage, String(round)]);
}

/** 事件 payload（**camelCase 单形**，§2.5 命名条：五枚键逐字 `featureId`/`stage`/`round`/`basisRev`/`settledAt`，不做事后双形） */
export function stageRoundSettledPayload(input: {
  featureId: string;
  stage: FeatureStage;
  round: number;
  basisRev: string;
  settledAt: string;
}): string {
  return JSON.stringify({
    featureId: input.featureId,
    stage: input.stage,
    round: input.round,
    basisRev: input.basisRev,
    settledAt: input.settledAt,
  });
}

/** 事件写入点的出参（三段都可观测；调用方据此打日志，不据它改判据） */
export interface StageRoundSealWrite {
  verdict: StageRoundSealVerdict;
  /** 本轮**首次跃迁**新写的事件；非跃迁（未收口 / 已记过）⇒ `null` */
  event: EventRecord | null;
  /** pre 快照：本行进入判定前，本轮是否**已有**收口事件（幂等早退凭据） */
  alreadySettled: boolean;
}

/**
 * **首次跃迁写事件**（改造文档 §2.5 收口事件条的机制本体；照 `bridge/runner.ts:1166`
 * 「先读 `existing.state` 再写」的 pre/post 习语）。
 *
 * ⚠️ **必须在调用方的事务内调用**（本件自不开事务，开了就是嵌套 `BEGIN IMMEDIATE` = 直接抛）：
 * 「与状态写同事务」不是修辞——阶段行落列与事件写入之间若隔开一个事务边界，并发结算会出现
 * 「行已全合格、事件未写」或反之的**半套副作用**，板面据此永不唤醒（或空唤醒）。
 * `BEGIN IMMEDIATE` 在事务开头取写锁 ⇒ 体内的「读 pre ⇒ 判 post ⇒ 插事件」三步对外原子，
 * 两条触发路径（runner `/runner/result` 与 watcher `onSettled`）先后到达时**至多一条真写**。
 *
 * pre/post 比对的两侧各是什么（判据 3 的兑现形式）：
 * - **pre** = `getEventByIdempotencyKey(key)` 是否已有行 —— 已有 ⇒ `alreadySettled=true`、零写
 *   （「只在本轮**首次**跃迁写」的直接锁；`settled` 是派生态、库里无列，故事件表**就是**跃迁记录）；
 * - **post** = 本轮行集现判（行集在事务内重读 ⇒ 看到同事务里刚写完的那一行）。
 *
 * 索引是**第二道**闩：pre 查空但插撞 `idx_events_idempotency_key`（跨进程/存量库并发的残余窗口）
 * ⇒ 按 `isUniqueConstraintError` 语义**只吞这一种**错误、回读既有行并报 `alreadySettled`，
 * 其余异常原样上抛（吞真错误 = 事件静默丢失，唤醒面永久失真）。
 */
export function sealStageRoundOnce(
  store: SessionStore,
  input: {
    featureId: string;
    stage: FeatureStage;
    round: number;
    /** 本轮口径（结算钩子传该行**写前**的 `based_on_rev`）；缺省 ⇒ 现算，见 {@link resolveStageRoundBasisRev} */
    basisRev?: string | null;
    /** 收口时刻（注入位：单测钉 payload 用固定串，生产缺省 = 落库时刻由 store 补齐） */
    settledAt?: string;
  },
): StageRoundSealWrite {
  const key = stageRoundSettledIdempotencyKey(input.featureId, input.stage, input.round);
  const pre = store.getEventByIdempotencyKey(key);
  const verdict = evaluateStageRoundSeal({
    featureId: input.featureId,
    stage: input.stage,
    round: input.round,
    rows: store.listStageRoundRows(input.featureId, input.stage, input.round),
    ...(input.basisRev !== undefined ? { basisRev: input.basisRev } : {}),
  });
  // 未收口 = 合法停靠：零写、只带名单回去
  if (!verdict.sealed || pre !== null) {
    return { verdict, event: null, alreadySettled: pre !== null };
  }
  // `sealed` 的定义已含 `basisRev !== null`（见 {@link evaluateStageRoundSeal} 末行），
  // 本分支是类型收窄、不是业务分支：宁可零写，也不写一枚口径为空串的假收口事件。
  const basisRev = verdict.basisRev;
  if (basisRev === null) {
    return { verdict, event: null, alreadySettled: false };
  }
  const settledAt = input.settledAt ?? new Date().toISOString();
  try {
    const event = store.appendEvent({
      featureId: input.featureId,
      taskId: null,
      kind: EVENT_STAGE_ROUND_SETTLED,
      // `state` 列 = 「变化后的状态串」既有语义；收口事件的状态就是 `settled` 本身
      state: "settled",
      payload: stageRoundSettledPayload({
        featureId: input.featureId,
        stage: input.stage,
        round: input.round,
        basisRev,
        settledAt,
      }),
      idempotencyKey: key,
    });
    return { verdict, event, alreadySettled: false };
  } catch (err) {
    // 第二道闩：`idx_events_idempotency_key` 真拒重。**只**吞这一种错误（pre 查空后仍撞 =
    // 跨进程/存量库并发的残余窗口，事实已是「本轮早已记过收口」⇒ 与 pre 命中同解），
    // 其余异常原样上抛让事务回滚——吞真错误 = 事件静默丢失、唤醒面永久失真。
    if (!isUniqueConstraintError(err)) throw err;
    return { verdict, event: null, alreadySettled: true };
  }
}
