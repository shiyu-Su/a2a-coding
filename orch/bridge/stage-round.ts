/**
 * 阶段轮（Stage Run）的**判据与装配单点**（R1 · v0.11.0 orch-N7）—— 纯函数模块，零 IO。
 *
 * 定位：改造文档 §2.4（`based_on_rev` 哈希输入序列表）、§2.5（读出面 `stageRuns[]` 形状 /
 * 三枚写口的幂等键）与 §2.2（收口三条件）在 orch 侧的**唯一实现处**。写口 handler
 * （`bridge/feature-tools.ts`）与读面（同文件 `handleFeatureStatus`）都消费本件，
 * **不得**在别处再算一份哈希、再拼一份完成度（两处口径分叉 = 板面分子分母与写面对不上）。
 *
 * ★ N5 起本件另负**读面合成对象**的单点：`synthesis` 四值态映射、`sections` 填充（正文一律走
 * N3 的严格解析单点 {@link parseSynthesisDoc}，本件不复述形状判据）、行形 `text` = 回执原文
 * （纯展示位：**不进判据入参**，宿主裁决 A5/A8）。
 *
 * ⚠️ 本件**不 import** `feature/state-machine.js`：阶段面三枚写口一律**不改主链**
 * （`canTransition` / 转移表零触达，判据 2 的静态锚）；也不 import `bridge/scheduler.ts`
 * （收口判据**不复用** DAG 收敛逻辑，§2.2 明文「自建判定器」）。
 *
 * ⚠️ 命名单形：DB 列 `answer_state` / `based_on_rev`（snake_case）**只出现在 `session/store.ts`**；
 * 本件的出参/payload 一律 camelCase（`answerState` / `basedOnRev`），**不做蛇形双形容错**（§2.5）。
 */
import { createHash } from "node:crypto";
import type { RunnerProjectRecord, RunnerRecord, StageSynthesisRecord } from "../session/store.js";
import type {
  EventRecord,
  StageAnswerState,
  StageDecision,
  StageRelevance,
  TaskRecord,
  TaskState,
} from "../types.js";
import { STAGE_REPLY_CONTRACT } from "./stage-settle.js";
import { parseSynthesisDoc } from "./synthesis.js";
import { SYNTHESIS_TASK_KEY } from "../types.js";

/**
 * 阶段轮行的**引擎侧命名键**（落 `tasks.task_key`）：一张轮格里每个成员恰一行。
 *
 * ⚠️ 非空才有幂等意义 —— partial 唯一索引 `idx_tasks_stage_round` 的谓词是
 * `WHERE task_key IS NOT NULL`（改造文档 §2.1），本常量恒非空 ⇒ 开轮重复调用必撞索引。
 * 值 = 改造文档 §2.1 点名的示例形态（`pm-relevance` = 「该 project 的 PM 答涉及性」），
 * 一张格一枚键（三值一次回齐，不拆成 `pm-decision` 等第二枚）。
 */
export const STAGE_ROUND_TASK_KEY = "pm-relevance";

/**
 * 事件 kind：**开轮登记**（落 `events`，= 零新表模型下「一轮的口径」唯一免推断的凭据）。
 *
 * 为什么必须留这枚事件（而不是只靠 `tasks.based_on_rev`）：`basisRev` 是**本轮口径**，
 * 而行的 `based_on_rev` 会被 N4 结算钩子的 `valid` 分支按回执覆写 ⇒ 全员答完的轮里
 * 库里可能一枚该轮指纹都不剩（都换成了回执带来的串）。`resolveStageRoundBasisRev` 的
 * 众数推断是**弱档兜底**（N8 文件头言明），开轮事件是**强档**：读面优先取它，取不到才回落。
 */
export const EVENT_STAGE_ROUND_OPEN = "stage.round_open";

/** 事件 kind：段落异议（沿用既有 `域.下划线段` 形态，§2.5 命名条） */
export const EVENT_STAGE_DOC_OBJECTION = "stage.doc_objection";

/** 事件 kind：门① 确认留痕（**只记录、不流转**，见 `handleGate1Confirm`） */
export const EVENT_STAGE_GATE1_CONFIRM = "stage.gate1_confirm";

/**
 * 可派达性闭集（读面行级 `reachability`，改造文档 §2.5 / 宿主裁定 A2）：
 * **观测位** —— 不预筛、不减少应收集（离线成员照样物化、照样计入分母）。
 */
export const STAGE_REACHABILITIES = ["dispatchable", "no_runner", "unknown"] as const;

/** 可派达性（由 {@link STAGE_REACHABILITIES} 派生；勿另立第二份清单） */
export type StageReachability = (typeof STAGE_REACHABILITIES)[number];

/**
 * 板侧门闩词元（= 改造文档 §2.5 两枚板侧写口同名；板视图按「本格是否含该词元」决定渲不渲控件）。
 * 门闩口径（R1 增补 · 缺陷二）：`stage_round_open` **只在收口后给**（未收口不给 ⇒ 同阶段不会并行
 * 两轮），`doc_objection` 恒给 ⇒ 装配单点见 {@link buildStageRunCell}。
 */
export const STAGE_ACTION_ROUND_OPEN = "stage_round_open";
export const STAGE_ACTION_DOC_OBJECTION = "doc_objection";

/**
 * **异议对象闭集**（`doc_objection` 的 `targetType`，改造文档 §2.5「只标记口径漂移 / 定向重评
 * 对象」的两类；**值域归引擎** —— 板侧不渲控件、只原样转发，闭集外值 ⇒ 结构化拒）。
 * - `basis`：整篇口径漂移（该段的答复基准整体重评，开轮由宿主决定 ⇒ 本口**不自动开轮**）；
 * - `project`：定向重评（只点 `projectIds` 里那几位的答复）。
 * 缺省推导（`targetType` 未给）：`projectIds` 非空 ⇒ `project`，否则 ⇒ `basis`。
 */
export const STAGE_OBJECTION_TARGETS = ["basis", "project"] as const;

/** 异议对象（由 {@link STAGE_OBJECTION_TARGETS} 派生；勿另立第二份清单） */
export type StageObjectionTarget = (typeof STAGE_OBJECTION_TARGETS)[number];

/**
 * **口径指纹 `basisRev`**（改造文档 §2.4，引擎现算、**不加 `features` rev 列**）。
 *
 * 输入按**冻结序列**拼接后取 `sha256`（UTF-8）：
 * 1. `features.requirement` 全文（该列引擎内不可改 ⇒ 取现值）；
 * 2. 本组成员 projectId 清单 —— **先 `Set` 去重再 `sort()`**（漏这一步 ⇒ config 顺序抖动即全量误 `stale`）；
 * 3. `stage`（闭集原值）；
 * 4. 宿主开轮时可选的 `basisRevInput`（口径修订标识）；**空值记字面 `-`** 以区分「未给」与「给了空串」。
 *
 * ⚠️ 分隔符取 `\x1f`（单元分隔符）：自由文本里不会出现，用 `,`/`|` 拼接会让
 * `["a,b"]` 与 `["a","b"]` 得同一串 = 两个不同输入集撞同一指纹（假 `stale` 判定）。
 * ⚠️ 成员集取的是**本组全员**（§2.4 第 2 项的 `members`），与「本轮物化了哪些」正交 ——
 * 定向轮只物化 `targetProjects`，但指纹仍按全员算 ⇒ 同一口径下全量轮与定向轮必得同值。
 */
export function computeBasisRev(input: {
  requirement: string | null;
  memberProjectIds: readonly string[];
  stage: string;
  basisRevInput?: string | null;
}): string {
  const members = Array.from(new Set(input.memberProjectIds)).sort();
  const given = input.basisRevInput?.trim() ?? "";
  const rev = given === "" ? "-" : given;
  const sequence = [input.requirement ?? "", members.join("\x1f"), input.stage, rev].join("\x1f");
  return createHash("sha256").update(sequence, "utf8").digest("hex");
}

/**
 * **内容定义的幂等串**（非物化写口的唯一键原料）：同一逻辑事实必得同一串 ⇒
 * partial 唯一索引 `idx_events_idempotency_key` 才真拒重（随机值等于那列白加）。
 */
export function idempotencyKeyOf(kind: string, parts: readonly string[]): string {
  return `${kind}:${createHash("sha256").update(parts.join("\x1f"), "utf8").digest("hex")}`;
}

/**
 * **开轮的幂等键** = `(featureId, stage, basisRev)` 三枚内容值。
 *
 * ⚠️ 键里放的是**指纹**而不是 `round`：本卡的重放语义是「**同一口径 = 同一轮**」——
 * 重复调用必得同一串 ⇒ 事件侧 `idx_events_idempotency_key` 与行侧
 * `idx_tasks_stage_round` **两道**都真拒重（判据 3 的端到端落点）。
 * 要开新一轮（口径未变但需要重问）= 显式换一个 `basisRevInput`（§2.4 第 4 项，
 * 如确认单版本号 v1.1）⇒ 指纹变 ⇒ 新轮 ⇒ 旧答复全量 `stale`（§2.4 末句），
 * 而不是在本串上偷偷加一枚时间戳/随机数（那会让幂等彻底失效）。
 */
export function stageRoundOpenKey(featureId: string, stage: string, basisRev: string): string {
  return idempotencyKeyOf(EVENT_STAGE_ROUND_OPEN, [featureId, stage, basisRev]);
}

/** 段落异议幂等键 = §2.5 点名的 `(docVersion, sectionId, objectionId)` 三元（+ featureId 定位） */
export function stageDocObjectionKey(
  featureId: string,
  docVersion: string,
  sectionId: string,
  objectionId: string,
): string {
  return idempotencyKeyOf(EVENT_STAGE_DOC_OBJECTION, [featureId, docVersion, sectionId, objectionId]);
}

/**
 * **异议内容 id**（签名里没有 `objectionId` 入参 ⇒ 由内容派生）：同一段落 + 同一段正文
 * 必得同一枚 id ⇒ 「同一条异议重复提交」在索引层就是一条。用随机 id 等于放弃这枚幂等键。
 */
export function stageObjectionIdOf(objectionText: string): string {
  return createHash("sha256").update(objectionText.trim(), "utf8").digest("hex").slice(0, 16);
}

/** 门① 确认留痕幂等键 = `(featureId, round, docHash)`（确认对象是**具体版本**，§5 用户语言 4） */
export function stageGate1ConfirmKey(featureId: string, round: number, docHash: string): string {
  return idempotencyKeyOf(EVENT_STAGE_GATE1_CONFIRM, [featureId, String(round), docHash]);
}

/**
 * 开轮事件 payload（**camelCase 单形**，§2.5 命名条）。
 *
 * `docVersion` = 开轮传入的 `basisRevInput` 原值（口径修订标识 = 确认单版本；§7.3 遗留条
 * 「`stage_view` 的 `docVersion` 数据源」在零新表下的落点 —— 不新列、不改 `decisions` 语义，
 * 宿主给什么就是什么，未给 ⇒ `null`，板侧不猜）。
 */
export interface StageRoundOpenPayload {
  featureId: string;
  stage: string;
  round: number;
  basisRev: string;
  docVersion: string | null;
  sources: string[];
  targetProjects: string[];
}

/** 开轮 payload → 事件正文（单点序列化，读侧 {@link parseStageRoundOpenPayload} 与之同形） */
export function stageRoundOpenPayload(payload: StageRoundOpenPayload): string {
  return JSON.stringify(payload);
}

/**
 * 事件正文 → 开轮登记（**容错读**：脏 payload ⇒ `null`，读面据此回落弱档推断，不抛）。
 * 收窄逐枚在函数内做（`round` 非正整数 / `basisRev` 非串 ⇒ 整枚判脏），不留半套对象。
 */
export function parseStageRoundOpenPayload(raw: string | null): StageRoundOpenPayload | null {
  if (raw === null || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const v = parsed as Record<string, unknown>;
  if (typeof v["featureId"] !== "string" || typeof v["stage"] !== "string") return null;
  if (typeof v["basisRev"] !== "string") return null;
  const round = v["round"];
  if (typeof round !== "number" || !Number.isInteger(round) || round < 1) return null;
  const strArray = (x: unknown): string[] =>
    Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];
  return {
    featureId: v["featureId"],
    stage: v["stage"],
    round,
    basisRev: v["basisRev"],
    docVersion: typeof v["docVersion"] === "string" ? v["docVersion"] : null,
    sources: strArray(v["sources"]),
    targetProjects: strArray(v["targetProjects"]),
  };
}

/** 本模块消费的注册表投影（`runnerId → 该项目清单`；由调用方从 store 取，本件不读库） */
export type RunnerProjectsByRunner = ReadonlyMap<string, readonly RunnerProjectRecord[]>;

/**
 * **开轮物化时按 runner 注册表投影**标注可派达性（§2.5 原句；观测位、不预筛）：
 * - `dispatchable`：某台 **online** Runner 的清单里有该 project；
 * - `no_runner`：注册表**非空**但没有任何在线 Runner 声明该 project（含「全部离线」）；
 * - `unknown`：注册表**空** ⇒ 无事实可判（桥刚起 / 尚无机器注册），不得据此断言「派不出去」。
 *
 * ⚠️ 三值都是**事实描述**，不含任何「要不要给它建行」的裁决 —— 应收集恒等于本轮物化行。
 */
export function projectStageReachability(
  projectId: string,
  runners: readonly RunnerRecord[],
  projectsByRunner: RunnerProjectsByRunner,
): StageReachability {
  if (runners.length === 0) return "unknown";
  for (const runner of runners) {
    if (runner.state !== "online") continue;
    const declared = projectsByRunner.get(runner.runnerId) ?? [];
    if (declared.some((p) => p.projectId === projectId)) return "dispatchable";
  }
  return "no_runner";
}

/**
 * 阶段行派发正文（开轮物化逐行写入 `tasks.dispatch_message`）：需求上下文 +
 * **格式契约原文逐字注入**（裁定 A3「重派不得原样重发」的对偶 ⇒ 首轮就带契约，
 * 契约文案单源在 `stage-settle.ts`，本件**不复述**、只引用，防两处漂移）。
 *
 * ⚠️ **需求全文内嵌、不截断**（R1 增补 · 缺陷一）：截断让 PM 只能答 `involved`+`pending`，
 * 按 §2.2 判据该行**永久挡收口**，再开轮只是重复同一截断。领取侧下发的是 `dispatch_message`
 * 全文（`runner.ts` 的 `toDispatchCommand`，无上限），装配侧不得另立第二道闸。
 */
export function buildStageRowMessage(input: {
  featureId: string;
  title: string;
  requirement: string | null;
  stage: string;
  round: number;
  projectId: string;
  basisRev: string;
  sources?: readonly string[];
}): string {
  const requirement = input.requirement ?? "";
  const sources = (input.sources ?? []).filter((s) => s.trim() !== "");
  return (
    `【阶段轮 · ${input.stage} · 第 ${input.round} 轮】你作为 project「${input.projectId}」的 ` +
    `产品经理（PM）对本阶段做**涉及性三值回执**。归属需求：${input.featureId}｜${input.title}\n` +
    `需求原文（全文，共 ${requirement.length} 字符）：\n"""\n${requirement}\n"""\n` +
    (sources.length > 0 ? `本轮来源（宿主给定的口径材料）：\n${sources.map((s) => `- ${s}`).join("\n")}\n` : "") +
    `口径指纹（回执请原样带在 BASED_ON_REV 里）：${input.basisRev}\n\n` +
    "判定对象 = **本 project 在本阶段是否涉及、涉及则做何决定**；只回答这三值，" +
    "不要执行任何代码改动，也不要把结论复述成结论块。\n\n" +
    STAGE_REPLY_CONTRACT
  );
}

/** 一格阶段轮的成员应答行（读面 `stageRuns[].projects[]` 的出参形） */
export interface StageRunProjectRow {
  projectId: string;
  taskId: string;
  relevance: StageRelevance | null;
  decision: StageDecision | null;
  reason: string | null;
  answerState: StageAnswerState | null;
  /** 行 `based_on_rev` 现值（stale 的唯一原料，§2.5 点名必须随出参下发） */
  basedOnRev: string | null;
  /** 读面现算的派生态：行指纹**非空**且 ≠ 本轮 `basisRev`（**不落列**，§2.4） */
  stale: boolean;
  reachability: StageReachability;
  taskState: TaskState;
  /**
   * **回执原文**（`tasks.text` 全文；A5 · N5 纯增列）：`reason` 只是写侧截 200 字的摘要位。
   * ★ 展示与合成原料位，**不进判据入参**（见 {@link StageRowJudgementInput}）。
   */
  text: string | null;
}

/**
 * 一格阶段轮的完成度（**分子/分母由引擎直出**，板不重演判据）。
 *
 * 四计数是**恰好一次的划分**（序：`stale` > `invalid` > `pending` > 合格）⇒
 * `expected = settledCount + pendingCount + invalidCount + staleCount` 恒成立，
 * 板面四格相加不会凭空多/少一行（判据「分子/分母由引擎出」的兑现形式）。
 */
export interface StageRunCompleteness {
  /** 分母 = 本轮物化行数（= 本轮应收集，含离线成员） */
  expected: number;
  /** 分子 = 收口三条件全合格的行数 */
  settledCount: number;
  /** 尚未回执（`answerState` = `pending` / NULL 且指纹未偏离） */
  pendingCount: number;
  /** 回执无效（格式不合契约，且未被判陈旧） */
  invalidCount: number;
  /** 答过但答在旧口径上（`basedOnRev` 非空且 ≠ 本轮 `basisRev`） */
  staleCount: number;
}

/**
 * **合成行态四值闭集**（宿主裁决 A8：读面**不新增状态词汇**；板侧 parse 同闭集、越界归 `null`）。
 * 映射单点：`completed ⇒ done`，未落终局的态一律 `pending`（= 行在册、循环未收，不含裁决）。
 */
export const SYNTHESIS_STATES = ["pending", "working", "done", "failed"] as const;

/** 合成行态（由 {@link SYNTHESIS_STATES} 派生；勿另立第二份清单） */
export type StageSynthesisState = (typeof SYNTHESIS_STATES)[number];

const SYNTHESIS_STATE_BY_TASK_STATE: Partial<Record<TaskState, StageSynthesisState>> = {
  working: "working",
  completed: "done",
  failed: "failed",
};

/** 合成确认单的一节（A8：字段名沿用 N7 那份，只换填充源 = 合成行 `synthesis_json`） */
export interface StageRunSectionView {
  id: string;
  title: string;
  content: string;
  /** **节级依据指向** = projectId 清单（与开轮的自由文本 `sources` 不同物，A6） */
  sources: string[];
}

/** 轮格上的异议投影（仅本格 `docVersion` 的事件；无异议恒为 `[]`） */
export interface StageRunObjectionView {
  objectionId: string;
  sectionId: string;
  sectionTitle: string;
  text: string;
  docVersion: string;
  createdAt: string;
  disposed: boolean;
}

/** 轮格上的合成对象（A8 冻结形状；引擎只**如实下发**两枚哈希，比较归板侧派生层） */
export interface StageSynthesisView {
  state: StageSynthesisState;
  taskId: string;
  /** 本轮确认单版本 = 正文里的 `docVersion`（读不出 ⇒ null，不拿 `round` 兜底） */
  docVersion: string | null;
  docHash: string | null;
  confirmedDocHash: string | null;
  confirmedAt: string | null;
  /** 本阶段**轮次谱系**的轮数（= 行集 ∪ 开轮事件 ∪ 合成行去重后的 `(stage, round)` 数） */
  rounds: number;
}

/** 装配一格时附带的合成行原料（读面侧按冻结四元组定位后传入、本件零 IO） */
export interface StageSynthesisSource {
  row: StageSynthesisRecord;
  rounds: number;
}

/** 承载列无 CHECK ⇒ 写侧塞了空串不得在板面渲成「空哈希」/「空版本」 */
function blankToNull(value: string | null): string | null {
  return value !== null && value.trim() !== "" ? value : null;
}

/**
 * 合成行正文 → 本轮确认单版本（**读单点**：`{docVersion, …}` 头部串，脏 / 缺 ⇒ `null`，不猜）。
 * 写侧 `gate1_confirm` 的版本等价校验与读侧 `synthesis.docVersion` 都取本枚 ⇒ 两处不可能分叉。
 */
export function parseStageSynthesisDocVersion(synthesisJson: string | null): string | null {
  if (synthesisJson === null || synthesisJson === "") return null;
  let head: unknown;
  try {
    head = JSON.parse(synthesisJson);
  } catch {
    return null;
  }
  const v = typeof head === "object" && head !== null ? (head as Record<string, unknown>)["docVersion"] : undefined;
  return typeof v === "string" ? blankToNull(v) : null;
}

/**
 * 合成行 → 轮格的 `synthesis` 对象 + 五节 `sections`（一格解析一次）。形状与「缺节渲空串」之禁
 * **不在本件重演**：照 N3 严格解析单点 {@link parseSynthesisDoc} ⇒ 脏正文 / 缺节只落 `sections: []`。
 */
export function toStageSynthesisCell(source: StageSynthesisSource): {
  synthesis: StageSynthesisView;
  sections: StageRunSectionView[];
} {
  const { row, rounds } = source;
  const text = blankToNull(row.synthesisJson);
  const docVersion = parseStageSynthesisDocVersion(text);
  const parsed = text === null || docVersion === null ? null : parseSynthesisDoc(text, docVersion);
  const sections =
    parsed !== null && "sections" in parsed
      ? parsed.sections.map((s) => ({ id: s.id, title: s.title, content: s.content, sources: [...s.sources] }))
      : [];
  return {
    synthesis: {
      state: SYNTHESIS_STATE_BY_TASK_STATE[row.state] ?? "pending",
      taskId: row.taskId,
      docVersion,
      docHash: blankToNull(row.docHash),
      confirmedDocHash: blankToNull(row.confirmedDocHash),
      confirmedAt: blankToNull(row.confirmedAt),
      rounds,
    },
    sections,
  };
}

/** 异议事件 → 轮格投影（事件顺序即 `eventId` 顺序，不以 wall-clock 判定先后） */
function toStageRunObjections(
  events: readonly EventRecord[],
  sheetVersion: string | null,
  sections: readonly StageRunSectionView[],
): StageRunObjectionView[] {
  if (sheetVersion === null) return [];
  const openEventIds = events
    .filter((event) => event.kind === EVENT_STAGE_ROUND_OPEN)
    .map((event) => event.eventId);
  const objections: StageRunObjectionView[] = [];
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
    if (parsed["docVersion"] !== sheetVersion) continue;
    const sectionId = parsed["sectionId"];
    const text = parsed["objectionText"];
    if (typeof sectionId !== "string" || typeof text !== "string") continue;
    const givenId = parsed["objectionId"];
    const objectionId =
      typeof givenId === "string" && givenId !== "" ? givenId : stageObjectionIdOf(text);
    objections.push({
      objectionId,
      sectionId,
      sectionTitle: sections.find((section) => section.id === sectionId)?.title ?? sectionId,
      text,
      docVersion: sheetVersion,
      createdAt: event.createdAt,
      disposed: openEventIds.some((openEventId) => openEventId > event.eventId),
    });
  }
  return objections;
}

/**
 * 一格阶段轮（读面 `stageRuns[]` 的单格 = 写口出参的同源视图）。
 *
 * ⚠️ 键名纪律：本结构**自身**带 `stage`，但它挂在 `a2a_feature_status` **顶层** `stageRuns[]` 下 ⇒
 * 与顶层单数 `stage`（Feature 登记字段）、`acceptance.stages[]`（主链段轨迹）**三者互不覆盖**（判据 4）。
 */
export interface StageRunCellView {
  stage: string;
  round: number;
  basisRev: string;
  /** 本轮口径的确认单版本（= 开轮传入的 `basisRevInput`；未给 ⇒ null，板侧不猜） */
  docVersion: string | null;
  /** 三态：非真非假 ⇒ null（`settled` 由引擎按 §2.2 直出，见 {@link isQualifiedStageRow}） */
  settled: boolean | null;
  completeness: StageRunCompleteness;
  /** 未收口的 project 名单（板据此渲染「被指名」，只给计数无法指名） */
  unanswered: string[];
  projects: StageRunProjectRow[];
  /** 合成《需求确认单》五节（A8：**字段名不变、填充源换** = 本轮合成行；无合成行 ⇒ `[]`） */
  sections: StageRunSectionView[];
  /** 本格 `docVersion` 的异议；无异议 ⇒ `[]`（不是 `null`） */
  objections: StageRunObjectionView[];
  /** 本轮合成对象（A8 · N5）：合成行未出 ⇒ `null`；两枚哈希只下发、比较归板侧派生层 */
  synthesis: StageSynthesisView | null;
  allowedActions: string[];
}

/**
 * 派生行的 `stale`（§2.5：由**应用层判据函数**派生、不进 SQL）。
 *
 * ⚠️ `basedOnRev === null` **不算 stale**：那是「还没回执」的行（`answerState='pending'`），
 * 归 `pendingCount`。把空指纹说成「口径已变」会凭空造出一批陈旧行，
 * 板侧「陈旧 N」与 §2.4 的原意（答过、但答在旧指纹上）就对不上了。
 */
export function isStageRowStale(row: TaskRecord, basisRev: string): boolean {
  return row.basedOnRev !== null && row.basedOnRev !== basisRev;
}

/** 一格内单个成员行的出参装配（`reachability` 由调用方按注册表投影算好后传入） */
export function toStageRunProjectRow(
  row: TaskRecord,
  basisRev: string,
  reachability: StageReachability,
): StageRunProjectRow {
  return {
    projectId: row.projectId,
    taskId: row.taskId,
    relevance: row.relevance,
    decision: row.decision,
    reason: row.reason,
    answerState: row.answerState,
    basedOnRev: row.basedOnRev,
    stale: isStageRowStale(row, basisRev),
    reachability,
    taskState: row.state,
    text: row.text,
  };
}

/**
 * 收口判据的**入参形**（R1 · orch-N8 加宽）：出参行 {@link StageRunProjectRow} 的四枚判定料。
 *
 * 为什么加宽成 `Pick<>`：判据本身**只看这四枚**（`stale` / `answerState` / `relevance` /
 * `decision`），而 `reachability`（可派达性观测位）与 `reason` / `taskState` 一样都不参与收口。
 * 收紧在完整出参形上，调用方就得为「只差判定料四枚」的裸 `TaskRecord` **造一个假
 * `reachability`** 才能复用判据 ⇒ 观测位一旦进了判据入参，早晚有人拿它当条件（它不是）。
 * 加宽是**单向兼容**：`StageRunProjectRow` 依然满足本形 ⇒ 读面装配路径零改动。
 * ★ N5 新增的 `text`（回执原文）**刻意不在本形内**：它是展示/合成原料，不是判据料。
 */
export type StageRowJudgementInput = Pick<
  StageRunProjectRow,
  "stale" | "answerState" | "relevance" | "decision"
>;

/**
 * **收口三条件**（改造文档 §2.2，唯一判据；作用于已装配的出参行）：
 * `answerState='valid'` ∧ `basedOnRev = 本轮 basisRev`（即非 `stale`）∧
 * (`relevance='involved'` ⇒ `decision ≠ 'pending'`)
 *
 * - `pending` / `invalid` / `stale` 任一存在 ⇒ **不收口**且被指名；
 * - 本轮**零行** ⇒ 整格 `settled = null`（三态：无从判定）**而不是 `true`** ——
 *   空集合上的真空真会把「一轮还没物化完」显示成「已收齐」，直接伪造门① 前提。
 *   （本枚只答「这一行合不合格」，整格三态由调用侧的行集长度决定，见
 *   `bridge/stage-seal.ts` 的 {@link evaluateStageRoundSeal}。）
 *
 * 单点抽出 ⇒ {@link buildStageRunCell} 的分子、`unanswered[]` 与整格 `settled` 三处共用同一条
 * 谓词（分子 + 名单 + 布尔三者不可能互相打脸），并与 N8 的收口判定器**共用同一条**（判据唯一）。
 */
export function isQualifiedStageRow(row: StageRowJudgementInput): boolean {
  if (row.stale) return false;
  if (row.answerState !== "valid") return false;
  if (row.relevance === "involved" && (row.decision === "pending" || row.decision === null)) return false;
  return true;
}

/**
 * 行分类（四计数的唯一口径；序 = `stale` > `invalid` > `pending` > 合格）。
 *
 * R1 · orch-N8 起**对外可见**：收口判定器（`bridge/stage-seal.ts`）的挡位指名消费本枚，
 * ⇒ 「哪一类挡位优先」在全仓**只有一个次序**（两文件各写一份分类序 = 板面「陈旧 N」与
 * 引擎挡位名单可以互相打脸）。
 */
export type StageRowClass = "settled" | "pending" | "invalid" | "stale";

export function classifyStageRow(row: StageRowJudgementInput): StageRowClass {
  if (row.stale) return "stale";
  if (row.answerState === "invalid") return "invalid";
  if (row.answerState === "pending" || row.answerState === null) return "pending";
  return isQualifiedStageRow(row) ? "settled" : "pending";
}

/**
 * 装配一格 `stageRuns[]`（纯函数：入参 = 本轮行集 + 本轮口径 + 本轮合成行）。
 *
 * 排序口径：`projects[]` 按 `projectId` 字典序（与归属读面同序，两个面的清单可直接比对）；
 * `unanswered[]` = 不合格行的 projectId（同序）⇒ 「未收齐 + 被指名」是常态渲染面，不是异常。
 *
 * ★ 合成行是**加法**：`synthesis` 缺位 ⇒ `synthesis: null` + `sections: []`（照 N7 现行为），
 * 而 `completeness` / `settled` / `unanswered` / `allowedActions` 四组**只吃 `rows`** ⇒
 * 有没有合成行，这些既有字段的取值逐字不变（判据 1/2）。
 */
export function buildStageRunCell(input: {
  stage: string;
  round: number;
  basisRev: string;
  docVersion: string | null;
  rows: readonly TaskRecord[];
  reachabilityOf: (projectId: string) => StageReachability;
  /** 本轮合成行原料（读面侧按 `(feature, stage, round)` 定位后传入；未出 ⇒ null） */
  synthesis?: StageSynthesisSource | null;
  /** 本 Feature 的事件原料；异议只取本格 `docVersion`，未给 ⇒ 空投影 */
  events?: readonly EventRecord[];
}): StageRunCellView {
  const rows = [...input.rows].sort((a, b) => (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0));
  const projects = rows.map((row) => toStageRunProjectRow(row, input.basisRev, input.reachabilityOf(row.projectId)));
  const classes = projects.map(classifyStageRow);
  const settledCount = classes.filter((c) => c === "settled").length;
  const pendingCount = classes.filter((c) => c === "pending").length;
  const invalidCount = classes.filter((c) => c === "invalid").length;
  const staleCount = classes.filter((c) => c === "stale").length;
  const settled: boolean | null = rows.length === 0 ? null : settledCount === rows.length;
  // 门闩口径（R1 增补 · 缺陷二）：开轮只在**已收口**后给；未收口 / 零行（null）都不给 ⇒
  // 同阶段不会并行两轮。「一轮没收住想再开」「异议后定向重评」都是收口之后的动作。
  const actions: string[] = [];
  if (settled === true) actions.push(STAGE_ACTION_ROUND_OPEN);
  actions.push(STAGE_ACTION_DOC_OBJECTION);
  const source = input.synthesis ?? null;
  const cell = source === null ? null : toStageSynthesisCell(source);
  const sections = cell?.sections ?? [];
  const sheetVersion = cell?.synthesis?.state === "done" ? cell.synthesis.docVersion : null;
  const titledSections = cell?.synthesis.docVersion === sheetVersion ? sections : [];
  const objections = toStageRunObjections(input.events ?? [], sheetVersion, titledSections);
  return {
    stage: input.stage,
    round: input.round,
    basisRev: input.basisRev,
    docVersion: input.docVersion,
    settled,
    completeness: {
      expected: rows.length,
      settledCount,
      pendingCount,
      invalidCount,
      staleCount,
    },
    unanswered: projects.filter((_, i) => classes[i] !== "settled").map((p) => p.projectId),
    projects,
    sections,
    synthesis: cell?.synthesis ?? null,
    objections,
    allowedActions: actions,
  };
}

/** 阶段轮行的读面分组键（派生实例 `(feature, stage, round)` 的 orch 侧内存键） */
export function stageRoundKey(stage: string, round: number): string {
  return `${stage}\x1f${String(round)}`;
}

/**
 * 本 Feature 该阶段**已开过的最大轮次**（无 ⇒ 0，故「新一轮 = 本值 + 1」）。
 *
 * 只数 `task_key` 非空的行（= 物化产生的行）：手工写出的 `round` 不构成一轮的事实
 * （§2.1「写入者 = 物化」），拿它抬轮次会凭空跳号。
 */
export function maxStageRound(rows: readonly TaskRecord[], stage: string): number {
  let max = 0;
  for (const row of rows) {
    if (row.taskKey === null || row.round === null || row.stage !== stage) continue;
    if (row.round > max) max = row.round;
  }
  return max;
}

/**
 * 按 `(stage, round)` 分组阶段行 —— **只认 `task_key` 非空、且非合成行**的行：
 * `task_key` 是「本行由开轮物化产生」这一事实的唯一凭据（§2.1 写入者=物化）。
 * 缺 `stage`/`round` 的行（脏数据 / 早于本卡的手写行）一律不组入，免得拼出一个假轮格。
 *
 * ★ **第三处补批**（N1 · v0.11.0 综合分析落库）：引擎内综合分析的合成行
 * （`task_key = ${SYNTHESIS_TASK_KEY}`）也带非空键 + 同轮坐标 ⇒ 不在这里剔掉，读面
 * `stageRuns[].projects[]` 就多出一位 `__engine__` 成员，且它的 `answerState` 为 `null` ⇒
 * `classifyStageRow` 判 `pending` ⇒ `completeness.expected+1`、`unanswered` 含 `__engine__`、
 * 整格 `settled` 恒 `false`（与 store 侧两条读口同一条自锁，判据唯一性要求三处**逐处补齐**）。
 * 本件用**应用层等式**而非 SQL 片段：这里的入参已是 `TaskRecord[]`（`taskKey` 驼峰读形）。
 */
export function groupStageRoundRows(rows: readonly TaskRecord[]): Array<{ stage: string; round: number; rows: TaskRecord[] }> {
  const buckets = new Map<string, { stage: string; round: number; rows: TaskRecord[] }>();
  for (const row of rows) {
    if (row.taskKey === null || row.stage === null || row.round === null) continue;
    if (row.taskKey === SYNTHESIS_TASK_KEY) continue;
    const key = stageRoundKey(row.stage, row.round);
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, { stage: row.stage, round: row.round, rows: [row] });
    } else {
      bucket.rows.push(row);
    }
  }
  // 格序 = (stage, round) 升序：旧轮在前、本轮在后 ⇒ 板侧「取最大 round」与折叠区各自单点判定。
  return [...buckets.values()].sort((a, b) =>
    a.stage === b.stage ? a.round - b.round : a.stage < b.stage ? -1 : 1,
  );
}
