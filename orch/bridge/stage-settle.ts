/**
 * 阶段轮回执结算钩子 · 结算后区（R1 · v0.11.0 orch-N4）——`/runner/result` 与后台看护两条触发路径
 * 共用的**唯一入口**。
 *
 * 定位（改造文档 §2.3 + 节点冻结口径）：阶段行（`mode='stage'`）结算后，从库里重读整行 ⇒
 * 按 N3 解析（`parseStageReply`：先按 A2A `state` 分诊、再取三值，两态不互推）⇒ 三分支：
 * - `valid` ⇒ {@link updateStageRow} 落结算列；回信显式带 `BASED_ON_REV` 才覆写，缺省**不触碰该列**
 *   （物化写的本轮指纹不得被空值抹掉——stale 派生唯一原料）；落列与**收口判定/`stage.round_settled`
 *   事件写入点**（`bridge/stage-seal.ts`，R1 · orch-N8）在**同一条事务**内完成——一轮收齐的那一刻
 *   就是本轮首次跃迁，此刻不写事件，板侧唤醒面（§2.6 板心跳）就永远不会被点亮；
 * - `pending`（`input-required`/`failed` 无载体的合法等待形态）⇒ **零写**，行留在 `pending` =
 *   合法停靠（§2.2「离线成员长期 pending」）；收口归 N8，本钩不抢语义；
 * - `invalid` ⇒ **先自动重派一次**（`rearmStageForRetry` CAS：终态 ∧ `retry_count=0` 才命中；
 *   新消息 = 原派发 base + **格式契约原文** + 上轮失败原因，裁定 A3「不得原样重发」）；
 *   `retry_count` 已 >0（即已烧掉唯一一次）⇒ 落 `answer_state='invalid'`——
 *   **不判任务失败**（`tasks.state` 不动）、**不落默认值**（其余四列不写）、不静默收口。
 *
 * 幂等与竞速（判据 1/2 的机制本体）：
 * - 函数**以库中重读行为准**，不消费调用方上下文 ⇒ 两条路径先后到达，同一行结果逐字段相同；
 * - `valid` 早退门（`answer_state='valid'`）⇒ 后到者零写、不留 `updated_at` 噪音；
 * - 同一 `invalid` 结算被两条路径同时看到 ⇒ **至多一条 CAS 命中**（`retry_count=0` 前置闩），
 *   落空者见行 `working`（非终态）早退 ⇒ 「恰好 1 次、不是 0、不是 2」由单点 SQL 保证。
 *
 * ⚠️ **不用 `RunnerStorePort` 装饰器**（改造文档 §3.1 点名）：装饰器漏三条路径——watcher 结算、
 * M1 predecessor 结算、orphan 墙钟终态；本件以**显式结算后钩子**挂两个触发点
 * （`bridge/runner.ts` handleResult 结算后区 + `bridge/index.ts` watcher `onSettled`），
 * orphan 终态由看护对账自然覆盖（watcher 见 `failed` 终态 ⇒ persist ⇒ 本钩）。
 *
 * 异常策略：写口异常**原样上抛**，由触发方兜底——runner 侧吞（绝不反噬 200 ack，machine outbox
 * 对非 2xx 无限退避）；watcher 侧 warn（DAG 续推信号不受影响）。失败行留在 `pending`，
 * 下一轮结算/重派照常到达（本钩无「半途状态」）。
 */
import { getDefaultStore, getTask, rearmStageForRetry, updateStageRow } from "../session/store.js";
import type { TaskRecord } from "../types.js";
import { bridgeLog } from "./bridge-log.js";
import { EVENT_STAGE_ROUND_SETTLED, sealStageRoundOnce } from "./stage-seal.js";
import { triggerStageSynthesis } from "./stage-synthesis.js";
import { hasOutcomeFence, parseStageReply, STAGE_A2A_STATES } from "./stage-parse.js";
import type { StageA2aState } from "./stage-parse.js";

/** 日志域：两触发点共用，不偏 runner（`a2a-runner`）也不偏看护（`a2a-bridge` 其余路径） */
const LOG_SCOPE = "a2a-stage-settle";

/**
 * 格式契约原文——重派时**逐字注入**（冻结口径：「重派消息必须注入格式契约原文」，裁定 A3）。
 * 四个键名 `RELEVANCE:` / `DECISION:` / `REASON:` / `BASED_ON_REV:` 逐字在列（判据 2 的字符串断言锚）；
 * 只给键值行形态、**不复述完整结论块**（改造文档 §2.3：整块复述会触机器侧
 * `containsFailedOutcomeBlock` 误判——契约本身就是给「吞了三值/回了散文」的失败态看的）。
 */
export const STAGE_REPLY_CONTRACT = [
  "【阶段回执格式契约】下列四个键按**键值行**书写（行首键名 + 冒号 + 值，可位于正文任意位置；同名键重复取末次）：",
  "RELEVANCE: pending | involved | not_involved —— 三值必填，小写闭集。",
  "DECISION: pending | accepted | rejected —— 仅 relevance=involved 的行携带值，缺省按 pending。",
  "REASON: 理由自由文本（≤200 字）—— relevance=not_involved 或 decision=rejected 时必填。",
  "BASED_ON_REV: 口径指纹串 —— 可选，缺省沿用本轮物化值。",
  "【禁用】正文不得携带 ```a2a-outcome 围栏——机器侧会整块删除，三值将被吞掉并判本轮违规。",
].join("\n");

/** 上轮失败正文摘录上限（码点；防超长回信撑爆重派消息） */
const PREV_TEXT_EXCERPT_CODEPOINTS = 400;

/** 钩子处置结果（可观测；触发方不消费，供单测/日志钉分支） */
export type StageSettleOutcome =
  | "not-a-stage-row" // 行不存在 / mode ≠ stage ⇒ 零写回
  | "not-a-settled-state" // 行 working / blocked ⇒ 非本钩的结算面
  | "already-valid" // 已落 valid ⇒ 幂等早退（判据 1）
  | "reply-in-flight" // 解析 = pending ⇒ 零写，合法停靠
  | "valid" // 三值已落结算列
  | "retry-dispatched" // 首次 invalid ⇒ CAS 命中，契约重派一次（判据 2）
  | "retry-cas-lost" // 首次 invalid 但 CAS 落空（另一路径已重派）⇒ 零写
  | "invalid"; // 已重派过一次仍不合规 ⇒ answer_state=invalid（不判任务失败）

/** 本钩可处理的结算态（= N3 解析器分诊闭集；`blocked` 不在内 = 交人工处置，不触发重派） */
function isStageSettledState(state: TaskRecord["state"]): state is StageA2aState {
  return (STAGE_A2A_STATES as readonly string[]).includes(state);
}

/** invalid 归因短句（进重派消息的「上轮失败原因」；禁用围栏与解析器第 3 道门共用单点正则） */
function diagnoseInvalid(text: string): string {
  if (text.trim() === "") return "回执正文为空";
  if (hasOutcomeFence(text)) return "正文携带禁用 ```a2a-outcome 围栏（三值已被机器侧吞掉）";
  return "四键键值行缺失或取值越出闭集（RELEVANCE 必填；not_involved / rejected 必附 REASON）";
}

/** 重派消息 = 原派发 base（未渲染、可原样重放）+ 重派段 + 上轮失败原因 + **格式契约原文** */
export function buildStageRetryMessage(rec: TaskRecord): string {
  const base = rec.dispatchMessage ?? rec.prompt ?? "";
  const prev = (rec.text ?? "").trim();
  const codepoints = [...prev];
  const excerpt =
    codepoints.length === 0
      ? "（空回执正文）"
      : codepoints.length > PREV_TEXT_EXCERPT_CODEPOINTS
        ? `${codepoints.slice(0, PREV_TEXT_EXCERPT_CODEPOINTS).join("")}…（已截断）`
        : prev;
  return (
    `${base}\n\n` +
    `【自动重派 · 阶段轮契约重试 1/1】上一轮回执不合阶段三值契约（归因：${diagnoseInvalid(prev)}）。上轮正文摘录：\n` +
    `"""${excerpt}"""\n` +
    "请按下方格式契约**重新回执**。这是本轮唯一一次自动重派：仍不合规则该行落 `invalid`、" +
    "挡住阶段收口并被指名，但**不判任务失败**。\n" +
    STAGE_REPLY_CONTRACT
  );
}

/**
 * 结算钩子入口（两条触发路径共用；口径见文件头）。`taskId` = 本地任务 id。
 * 返回值仅观测用；所有分支对**非阶段行零副作用**（DAG/inquiry 结算不经过本件任何写口）。
 */
export function settleStageTaskOnSettled(taskId: string): StageSettleOutcome {
  const rec = getTask(taskId);
  if (rec === null || rec.mode !== "stage") return "not-a-stage-row";
  if (rec.answerState === "valid") return "already-valid";
  if (!isStageSettledState(rec.state)) return "not-a-settled-state";

  const parsed = parseStageReply(rec.text ?? "", rec.state);
  switch (parsed.answerState) {
    case "valid": {
      /**
       * **状态写 + 收口判定 + 事件写入 = 同一条事务**（R1 · orch-N8 接线；改造文档 §2.5
       * 「pre/post 须落同一事务，否则并发可双写」）。隔开两个事务边界会留下「行已全合格、
       * 事件却未写」的半套副作用 ⇒ 板侧 armed 永不唤醒（或空唤醒）。
       *
       * `basisRev` 取本行**写前**的 `based_on_rev`：`valid` 分支每行至多进一次（上面的
       * `already-valid` 早退门在前）⇒ 此刻该列仍是开轮物化写进去的**本轮原值**，尚未被
       * 回执覆写。这就是「本轮口径」在零新表模型下唯一免推断的凭据（无写前快照的调用方才走
       * `bridge/stage-seal.ts` 的 `resolveStageRoundBasisRev` 众数推断）。
       *
       * 另两个分支**不接触**收口面：`pending` 零写（合法停靠）、`invalid` 只会**新增**挡位、
       * 不可能把一轮判成收口 ⇒ 事件写入点只挂在 `valid` 这一条状态写之后。
       */
      const store = getDefaultStore();
      const basisRev = rec.basedOnRev;
      const { written, seal } = store.runInTransaction(() => {
        const row = updateStageRow(taskId, {
          relevance: parsed.relevance,
          decision: parsed.decision,
          reason: parsed.reason,
          // 回信显式带 BASED_ON_REV 才覆写；缺省 ⇒ 键不出现 = 保留物化写进的本轮指纹
          ...(parsed.basedOnRev !== null ? { basedOnRev: parsed.basedOnRev } : {}),
          answerState: "valid",
        });
        if (row === null || row.featureId === null || row.stage === null || row.round === null) {
          // 竞态下行已非阶段行 / 脏行缺轮坐标 ⇒ 无本轮可判，事件面零写
          return { written: row, seal: null };
        }
        return {
          written: row,
          seal: sealStageRoundOnce(store, {
            featureId: row.featureId,
            stage: row.stage,
            round: row.round,
            ...(basisRev !== null ? { basisRev } : {}),
          }),
        };
      });
      if (written === null) return "not-a-stage-row"; // 竞态下行已非阶段行 ⇒ 零写
      bridgeLog.info(
        LOG_SCOPE,
        `阶段行结算落库：taskId=${taskId} relevance=${parsed.relevance} ` +
          `decision=${parsed.decision ?? "null"} answer_state=valid`,
      );
      // 收口事件只在**首次跃迁**出现（pre 已记过 / 本轮未收齐 ⇒ 零写；未收口是合法停靠形态，
      // 本钩不为它写任何东西、也不替它兜底标 `not_involved`）
      if (seal !== null && seal.event !== null) {
        bridgeLog.info(
          LOG_SCOPE,
          `阶段轮收口首次跃迁 ⇒ ${EVENT_STAGE_ROUND_SETTLED} 落账：featureId=${seal.verdict.featureId} ` +
            `stage=${seal.verdict.stage} round=${seal.verdict.round} 应收=${seal.verdict.expected}/` +
            `合格=${seal.verdict.settledCount} basisRev=${seal.verdict.basisRev ?? "null"}`,
        );
        /**
         * N4 · 事务外异步综合分析：`seal.event !== null` 是 `idx_events_idempotency_key` 之后**唯一**
         * 真写入信号 ⇒ 判据 2「至多触发一次」由此门承载；`triggerStageSynthesis` 顶层吞异常 ⇒
         * runner 200 ack / watcher 续推不被打断。
         */
        void triggerStageSynthesis(seal.verdict);
      }
      return "valid";
    }
    case "pending":
      return "reply-in-flight";
    case "invalid": {
      if (rec.retryCount <= 0) {
        const hit = rearmStageForRetry(taskId, buildStageRetryMessage(rec));
        if (!hit) return "retry-cas-lost"; // 另一触发路径已重派 ⇒ 本路径零写
        bridgeLog.warn(
          LOG_SCOPE,
          `阶段回执解析 invalid ⇒ 自动重派一次（注入格式契约）：taskId=${taskId} ` +
            `归因=${diagnoseInvalid((rec.text ?? "").trim())} 结算态=${rec.state}`,
        );
        return "retry-dispatched";
      }
      const written = updateStageRow(taskId, { answerState: "invalid" });
      bridgeLog.warn(
        LOG_SCOPE,
        written === null
          ? `阶段回执二次不合规则落 invalid 未命中（行已非阶段行）：taskId=${taskId}`
          : `阶段回执重派一次后仍不合规 ⇒ answer_state=invalid（tasks.state 保持 ${rec.state}，不判失败）：taskId=${taskId}`,
      );
      return "invalid";
    }
  }
}
