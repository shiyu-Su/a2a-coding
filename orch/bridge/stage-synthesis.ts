/**
 * 收口后**综合分析**（v0.11.0 orch-N4 · 裁决 A3/A4/U4）：`stage.round_settled` 真写出后事务外异步
 * 触发一次 ⇒ 物化合成行 + 落 `synthesis_json`/`doc_hash`；失败只 `state='failed'` + 一句原因进
 * `text`。**不入队、不重试、不 append 事件、不动 `features.state`**。判据 2 两道闩 = 调用侧
 * `seal.event !== null` 门 + `writeStageSynthesisOutcome` 的 `state <> ?`；判据 1 =
 * `idx_tasks_stage_round` 真拒 + 吞冲突 + 回读既有（非应用层 `if`）。
 * ⚠ 不 import `state-machine`/`scheduler`；`__engine__` 不入 machines 配置。
 */
import { randomUUID } from "node:crypto";
import {
  createTask,
  getDefaultStore,
  getFeature,
  isUniqueConstraintError,
  listEvents,
  listRunnerProjects,
  listRunners,
  listStageRoundRows,
  listStageSynthesisRows,
  writeStageSynthesisOutcome,
} from "../session/store.js";
import { SYNTHESIS_TASK_KEY, type FeatureStage, type TaskState } from "../types.js";
import { bridgeLog } from "./bridge-log.js";
import type { LlmClient } from "./llm-client.js";
import type { StageRoundSealVerdict } from "./stage-seal.js";
import {
  EVENT_STAGE_DOC_OBJECTION,
  EVENT_STAGE_ROUND_OPEN,
  parseStageRoundOpenPayload,
  projectStageReachability,
} from "./stage-round.js";
import {
  synthesisDocVersion,
  synthesizeStageRound,
  type SynthesisInput,
} from "./synthesis.js";

const LOG_SCOPE = "a2a-stage-synthesis";
const ENGINE_PROJECT_ID = "__engine__";
/** `listEvents` 单次被 clamp 在 1000（无 kind 过滤 ⇒ 游标续读到短页；同 `readAllFeatureEvents`） */
const EVENT_PAGE = 1000;

let llmProvider: (() => LlmClient | null) | null = null;

/** 挂接/清空 LLM provider（传 `null` 复位；生产接线归后续节点，测试注入假 client） */
export function setStageSynthesisLlmProvider(p: (() => LlmClient | null) | null): void {
  llmProvider = p;
}

/** 装配 N3 输入（只走既有读口；`features.state` / `approval` 不进 ⇒ 主链零触达） */
function assembleInput(
  featureId: string,
  stage: FeatureStage,
  round: number,
  basisRev: string | null,
): SynthesisInput | null {
  const feature = getFeature(featureId);
  if (feature === null) return null;
  const memberRows = listStageRoundRows(featureId, stage, round);
  const runners = listRunners();
  const byRunner = new Map(runners.map((r) => [r.runnerId, listRunnerProjects(r.runnerId)] as const));
  const rows: SynthesisInput["rows"] = memberRows.map((row) => ({
    projectId: row.projectId,
    relevance: row.relevance,
    decision: row.decision,
    reason: row.reason,
    answerState: row.answerState,
    basedOnRev: row.basedOnRev,
    stale: row.basedOnRev !== null && basisRev !== null && row.basedOnRev !== basisRev,
    reachability: projectStageReachability(row.projectId, runners, byRunner),
    taskState: row.state,
    text: row.text,
  }));
  const thisDoc = synthesisDocVersion(round);
  const rounds: SynthesisInput["rounds"] = [];
  const objections: SynthesisInput["objections"] = [];
  let openDocVersion: string | null = null;
  let materials: string[] = [];
  let targetProjects: string[] = memberRows.map((r) => r.projectId);
  let since = 0;
  for (;;) {
    const page = listEvents({ featureId, since, limit: EVENT_PAGE });
    for (const e of page) {
      if (e.kind === EVENT_STAGE_ROUND_OPEN) {
        const p = parseStageRoundOpenPayload(e.payload);
        if (p === null || p.featureId !== featureId || p.stage !== stage) continue;
        rounds.push({ round: p.round, basisRev: p.basisRev, docVersion: p.docVersion });
        if (p.round === round) {
          openDocVersion = p.docVersion;
          materials = p.sources;
          if (p.targetProjects.length > 0) targetProjects = p.targetProjects;
        }
      } else if (e.kind === EVENT_STAGE_DOC_OBJECTION && e.payload !== null) {
        let v: Record<string, unknown> | null;
        try {
          v = JSON.parse(e.payload) as Record<string, unknown>;
        } catch {
          v = null;
        }
        const dv = v?.["docVersion"], sid = v?.["sectionId"], txt = v?.["objectionText"];
        if (typeof dv !== "string" || dv === thisDoc) continue;
        if (typeof sid !== "string" || typeof txt !== "string") continue;
        objections.push({ sectionId: sid, objectionText: txt });
      }
    }
    const last = page[page.length - 1];
    if (page.length < EVENT_PAGE || last === undefined) break;
    since = last.eventId;
  }
  return {
    feature: { featureId, title: feature.title, requirement: feature.requirement, stage, ownerGroup: feature.ownerGroup },
    round: { basisRev: basisRev ?? "", round, docVersion: openDocVersion, materials, targetProjects },
    rows,
    rounds,
    objections,
  };
}

/** 物化或回读（判据 1 机制本体）：真插 ⇒ 索引拒 ⇒ 吞冲突 ⇒ 回读既有；不入队。 */
function materializeRow(featureId: string, stage: FeatureStage, round: number) {
  const find = () =>
    listStageSynthesisRows(featureId).find((r) => r.stage === stage && r.round === round) ?? null;
  return getDefaultStore().runInTransaction(() => {
    const hit = find();
    if (hit !== null) return hit;
    try {
      createTask({
        taskId: randomUUID(),
        projectId: ENGINE_PROJECT_ID,
        contextId: `synthesis:${featureId}:${stage}:${String(round)}`,
        state: "working",
        featureId,
        mode: "stage",
        taskKey: SYNTHESIS_TASK_KEY,
        stage,
        round,
        prompt: "引擎内综合分析（正文在 synthesis_json，失败原因在 text）",
      });
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
    }
    return find();
  });
}

/**
 * 一次合成（判据 4 失败落点在此）；顶层不抛、不重试；终态再进来 ⇒ 早退（判据 2 第二道闩：
 * 即便 `runInTransaction` 里再物化，`writeStageSynthesisOutcome` 的 `state <> ?` 同值守卫 ⇒ 零改行）。
 */
export async function runStageSynthesisOnce(verdict: StageRoundSealVerdict): Promise<void> {
  const { featureId, stage, round, basisRev } = verdict;
  const row = materializeRow(featureId, stage, round);
  if (row === null) {
    bridgeLog.warn(LOG_SCOPE, `合成行物化未命中：featureId=${featureId} stage=${stage} round=${String(round)}`);
    return;
  }
  if (row.state === "completed" || row.state === "failed") return;
  const input = assembleInput(featureId, stage, round, basisRev);
  const llm = llmProvider === null ? null : llmProvider();
  let next: { state: TaskState; synthesisJson?: string | null; docHash?: string | null; text?: string | null };
  if (input === null) {
    next = { state: "failed", text: "Feature 记录缺席，本轮合成未发起" };
  } else {
    const result = await synthesizeStageRound(input, llm);
    next = result.ok
      ? {
          state: "completed",
          synthesisJson: JSON.stringify({ docVersion: result.docVersion, sections: result.doc.sections }),
          docHash: result.docHash,
        }
      : { state: "failed", text: `${result.reason}：${result.detail}` };
  }
  const written = writeStageSynthesisOutcome(row.taskId, next);
  bridgeLog.info(
    LOG_SCOPE,
    `综合分析落库${written ? "" : "（同值守卫幂等）"}：featureId=${featureId} stage=${stage} ` +
      `round=${String(round)} state=${next.state} taskId=${row.taskId}`,
  );
}

/** **触发入口**（`stage-settle.ts` 在 `seal.event !== null` 分支 `void`-调用）：吞一切异常。 */
export async function triggerStageSynthesis(verdict: StageRoundSealVerdict): Promise<void> {
  try {
    await runStageSynthesisOnce(verdict);
  } catch (err) {
    bridgeLog.warn(
      LOG_SCOPE,
      `综合分析异步异常（吞掉、不改主链、不重派）：featureId=${verdict.featureId} ` +
        `err=${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
