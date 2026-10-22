/**
 * 引擎内建轻量分析 Agent 的**合成循环**（v0.11.0 orch-N3）—— 纯函数模块，**零 IO、零落库**。
 * 冻结口径：取本轮数据 → 组提示词 → 调 {@link LlmClient.complete} → 严格解析 → 结构化文档；
 * `docVersion = v{round}`。落库（`task_key='synthesis'` 行 + `synthesis_json` / `doc_hash`）归 **N4**，
 * 摘要 / 压缩归 **R1.5**。三条边界：① **失败不重试**（只出一条结构化失败 + 一句原因）；
 * ② **超限判 invalid 而非截断**（A6：截断会造出「看着在册、实际缺半」的确认单）；
 * ③ **主链零触达** —— 入参面与提示词都不含 `features.state` / `approval`。
 * ⚠ 两枚 `sources` 同名不同物（A6 ④）：开轮的**自由文本材料**在本件形参改名 `materials`，
 * 节级 `sources[]` = **projectId 依据指向**，原词保留。
 */
import { createHash } from "node:crypto";
import type { StageAnswerState, StageDecision, StageRelevance, TaskState } from "../types.js";
import type { LlmClient } from "./llm-client.js";
import type { StageReachability } from "./stage-round.js";

/** 单节 `content` 码点上限（越线 = 整单失败，不截断） */
export const SECTION_MAX_CODEPOINTS = 4000;

/** 全文（逐节 `content` 求和）码点上限 */
export const DOC_MAX_CODEPOINTS = 16000;

/**
 * **五节闭集**（A6）：**登记序 = `docHash` 的冻结序列化序**（⇒ 与入参序 / JSON 键序 / Map 迭代序无关），
 * 板侧与 flow 模板 §1 按同一清单渲染，不得另立第二份。
 */
export const SYNTHESIS_SECTION_IDS = [
  "problem",
  "impact",
  "constraints",
  "open-questions",
  "decisions",
] as const;

/** 合成文档节 id（由 {@link SYNTHESIS_SECTION_IDS} 派生；勿另立第二份清单） */
export type SynthesisSectionId = (typeof SYNTHESIS_SECTION_IDS)[number];

/** 五节固定标题（进提示词契约；落库正文取模型给的 `title` 现值） */
const SECTION_TITLES: Record<SynthesisSectionId, string> = {
  problem: "问题定义",
  impact: "影响面",
  constraints: "约束",
  "open-questions": "未解问题",
  decisions: "待拍板决策",
};

/** 一节（= 落 `tasks.synthesis_json` 的单节形状，N4 只原样序列化本结构） */
export interface SynthesisSection {
  id: SynthesisSectionId;
  title: string;
  /** 节正文（trim 后非空、≤{@link SECTION_MAX_CODEPOINTS} 码点） */
  content: string;
  /** **节级依据指向** = projectId 清单（空数组 = 该节不指向具体成员） */
  sources: string[];
}

export interface SynthesisDoc {
  /** 本轮确认单版本（冻结口径 `v{round}`） */
  docVersion: string;
  /** 恒按 {@link SYNTHESIS_SECTION_IDS} 登记序（解析口归一化 ⇒ docHash 与 hash 输入同序） */
  sections: SynthesisSection[];
}

/**
 * **失败归因闭集**（进合成行 `text` 的一句原因；三枚 `llm_*` 与 {@link LlmClient} 的三分类一一对应，
 * `llm_unavailable` = 注入口没给 = 装配缺件而非通路故障）。
 */
export type SynthesisFailureReason =
  | "llm_network"
  | "llm_http_status"
  | "llm_parse"
  | "llm_unavailable"
  | "doc_unparsable"
  | "doc_shape"
  | "doc_sections_missing"
  | "doc_section_id_unknown"
  | "doc_section_id_duplicate"
  | "doc_section_content_blank"
  | "doc_section_blank_source"
  | "doc_section_over_limit"
  | "doc_over_limit";

/** 一句结构化失败（`reason` 供分流、`detail` 给人读） */
export interface SynthesisError {
  ok: false;
  reason: SynthesisFailureReason;
  detail: string;
}

function fail(reason: SynthesisFailureReason, detail: string): SynthesisError {
  return { ok: false, reason, detail };
}

/** 码点数（按 Unicode 码点而非 UTF-16 长度：emoji / 生僻字不该算两个字符把上限撑歪） */
function codepoints(text: string): number {
  return [...text].length;
}

/**
 * `docHash` = `sha256(docVersion \x1f 逐节 id \x1f content …)`（A6 原式，**冻结序列化序**）。
 * 原料另带节数与逐节码点数：自由文本永不含 `\x1f`，但 `["ab","c"]` 与 `["a","bc"]` 拼起来同一串。
 * `title` / `sources` **不进哈希**：改措辞不改口径，不该把已确认的 docHash 判成换版。
 */
export function computeDocHash(doc: SynthesisDoc): string {
  const byId = new Map(doc.sections.map((s) => [s.id, s]));
  const parts: string[] = [doc.docVersion, String(doc.sections.length)];
  for (const id of SYNTHESIS_SECTION_IDS) {
    const section = byId.get(id);
    if (section === undefined) continue; // 缺节在解析口已整单拒 ⇒ 合法文档恒五节齐
    parts.push(id, String(codepoints(section.content)), section.content);
  }
  return createHash("sha256").update(parts.join("\x1f"), "utf8").digest("hex");
}

/**
 * **严格解析单点**（A6「禁止缺节渲空串」的执法处）：文本 → {@link SynthesisDoc}，越界即**整单**失败。
 * 门序（先形状后语义）：非合法 JSON / 非对象 / 字段越形 ⇒ `doc_unparsable`·`doc_shape`；闭集外 id ⇒
 * `doc_section_id_unknown`；重复 id ⇒ `doc_section_id_duplicate`；`content` trim 空 ⇒
 * `doc_section_content_blank`；空白指向 ⇒ `doc_section_blank_source`；缺任一节 ⇒ `doc_sections_missing`；
 * 超限 ⇒ `doc_*_over_limit`。唯一宽容：外层 markdown 围栏**只剥壳**。
 */
export function parseSynthesisDoc(text: string, docVersion: string): SynthesisDoc | SynthesisError {
  let payload: unknown;
  try {
    payload = JSON.parse(stripFence(text));
  } catch (err) {
    return fail(
      "doc_unparsable",
      `合成正文不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return fail("doc_shape", "合成正文不是 JSON 对象");
  }
  const given = payload as Record<string, unknown>;
  if (typeof given["docVersion"] !== "string" || given["docVersion"].trim() === "") {
    return fail("doc_shape", "合成正文缺少字符串 docVersion");
  }
  if (!Array.isArray(given["sections"])) return fail("doc_shape", "合成正文缺少数组 sections");
  const known = new Set<string>(SYNTHESIS_SECTION_IDS);
  const byId = new Map<SynthesisSectionId, SynthesisSection>();
  for (const item of given["sections"]) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return fail("doc_shape", "sections 里出现非对象条目（每节须为对象）");
    }
    const node = item as Record<string, unknown>;
    const id = node["id"];
    if (typeof id !== "string") return fail("doc_shape", "某节缺少字符串 id");
    if (!known.has(id))
      return fail("doc_section_id_unknown", `出现闭集外的节 id「${id}」（五节固定，不得自造）`);
    const key = id as SynthesisSectionId;
    if (byId.has(key)) return fail("doc_section_id_duplicate", `节 id「${id}」重复出现`);
    const sources = node["sources"];
    if (
      typeof node["title"] !== "string" ||
      typeof node["content"] !== "string" ||
      !Array.isArray(sources) ||
      sources.some((s) => typeof s !== "string")
    ) {
      return fail(
        "doc_shape",
        `节「${id}」字段越形（须 title/content 为字符串、sources 为字符串数组）`,
      );
    }
    const content = node["content"];
    if (content.trim() === "")
      return fail("doc_section_content_blank", `节「${id}」正文 trim 后为空`);
    const list = sources.map((s) => s.trim());
    if (list.some((s) => s === ""))
      return fail("doc_section_blank_source", `节「${id}」的依据指向含空白项`);
    byId.set(key, { id: key, title: node["title"].trim(), content, sources: list });
  }
  const missing = SYNTHESIS_SECTION_IDS.filter((id) => !byId.has(id));
  if (missing.length > 0)
    return fail("doc_sections_missing", `缺少节：${missing.join("、")}（五节必齐）`);
  // 归一化输出序 = 登记序（与 computeDocHash 同一条序 ⇒ 二者不可能打脸）
  const sections = SYNTHESIS_SECTION_IDS.flatMap((id) => {
    const section = byId.get(id);
    return section === undefined ? [] : [section];
  });
  for (const section of sections) {
    const len = codepoints(section.content);
    if (len > SECTION_MAX_CODEPOINTS) {
      return fail(
        "doc_section_over_limit",
        `节「${section.id}」正文 ${String(len)} 码点，超单节上限 ${String(SECTION_MAX_CODEPOINTS)}`,
      );
    }
  }
  const total = sections.reduce((sum, s) => sum + codepoints(s.content), 0);
  if (total > DOC_MAX_CODEPOINTS) {
    return fail(
      "doc_over_limit",
      `全文正文合计 ${String(total)} 码点，超全文上限 ${String(DOC_MAX_CODEPOINTS)}`,
    );
  }
  return { docVersion, sections };
}

/** 剥外层 markdown 围栏（只认首尾各一枚 ``` 壳；壳内仍是正文，不做任何修补） */
function stripFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const firstBreak = trimmed.indexOf("\n");
  if (firstBreak < 0) return trimmed;
  const body = trimmed.slice(firstBreak + 1).trim();
  return body.endsWith("```") ? body.slice(0, -3).trim() : body;
}

// ---------------------------------------------------------------------------
// 提示词（入参 = N4 经既有读面装配的投影；snake_case 列名不出现在此形）
// ---------------------------------------------------------------------------

export interface SynthesisFeatureInput {
  featureId: string;
  title: string;
  /** 需求**全文**、不截断（截断让分析只能复述三值） */
  requirement: string | null;
  stage: string;
  ownerGroup: string | null;
  /** ⚠ 本形**刻意没有** `state` / `approval`：主链态不得进提示词（判据 4 的负向断言锚） */
}

/** 本轮格（读面 `stageRuns[]` 单格的本件所需子集） */
export interface SynthesisRoundContextInput {
  basisRev: string;
  round: number;
  /** 开轮传入的口径修订标识（未给 ⇒ null；照实写「未给」，**不**拿它替代 `v{round}`） */
  docVersion: string | null;
  /** 开轮入参 `sources` = 宿主给的**自由文本材料**（与节级依据指向不同物） */
  materials: string[];
  /** 本轮物化到的成员清单（定向轮 ⊆ 本组全员） */
  targetProjects: string[];
}

/** 逐成员行 = 读面 {@link StageReachability} 所在行形的判定料 + **回执原文 `text`**（读面出参不带原文 ⇒ 由装配侧附带） */
export interface SynthesisMemberRow {
  projectId: string;
  relevance: StageRelevance | null;
  decision: StageDecision | null;
  reason: string | null;
  answerState: StageAnswerState | null;
  basedOnRev: string | null;
  stale: boolean;
  reachability: StageReachability;
  taskState: TaskState;
  /** `tasks.text` 现值（未回执 ⇒ null） */
  text: string | null;
}

/** 轮次谱系（`stage.round_open` 事件投影：本阶段开过的每一轮） */
export interface SynthesisRoundGenealogy {
  round: number;
  basisRev: string;
  docVersion: string | null;
}

/** 未处置异议（`stage.doc_objection` 事件投影；「未处置」的筛选归装配侧） */
export interface SynthesisObjection {
  sectionId: string;
  objectionText: string;
}

export interface SynthesisInput {
  feature: SynthesisFeatureInput;
  round: SynthesisRoundContextInput;
  rows: SynthesisMemberRow[];
  /** 轮次谱系（含本轮） */
  rounds: SynthesisRoundGenealogy[];
  objections: SynthesisObjection[];
}

/** 本轮确认单版本（冻结口径 `v{round}`，与开轮的口径修订标识无关） */
export function synthesisDocVersion(round: number): string {
  return `v${String(round)}`;
}

function dash(v: string | number | null): string {
  return v === null ? "-" : String(v);
}

/**
 * 组提示词（纯函数）：需求全文 + 本轮 `basisRev` + 各成员三值 / 理由 / **回执原文** + 轮次谱系 +
 * 未处置异议 + 五节闭集与上限的原文契约。成员行按 `projectId` 字典序归一（与读面同序）
 * ⇒ 同一轮两次装配逐字相同，不受上游行集 / Map 顺序抖动影响。
 */
export function buildSynthesisPrompt(input: SynthesisInput): string {
  const rows = [...input.rows].sort((a, b) =>
    a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0,
  );
  const materials = input.round.materials.filter((s) => s.trim() !== "");
  const requirement = input.feature.requirement ?? "";
  const docVersion = synthesisDocVersion(input.round.round);
  const lines: string[] = [
    "【引擎内综合分析 · 本轮《需求确认单》】你是 orch 引擎内部的轻量分析 Agent，" +
      `对本 Feature 的第 ${String(input.round.round)} 轮阶段轮做**一次**综合分析。`,
    "只做分析与成文：**不要**执行任何代码改动，不要把结论复述成结论块，也不要向用户提问。",
    "",
    "== 需求 ==",
    `featureId: ${input.feature.featureId}`,
    `标题: ${input.feature.title}`,
    `阶段: ${input.feature.stage}`,
    `归属组: ${dash(input.feature.ownerGroup)}`,
    `需求原文（全文，共 ${String(codepoints(requirement))} 码点）：`,
    `"""\n${requirement}\n"""`,
    "",
    "== 本轮口径 ==",
    `basisRev（口径指纹）: ${input.round.basisRev}`,
    `round: ${String(input.round.round)}`,
    `docVersion（本轮确认单版本）: ${docVersion}`,
    `口径修订标识（开轮传入）: ${dash(input.round.docVersion)}`,
    `本轮物化成员: ${input.round.targetProjects.join(", ") || "-"}`,
  ];
  if (materials.length > 0) {
    lines.push(
      "开轮材料（宿主给定的自由文本，仅作背景，**不是**节级依据指向）：",
      ...materials.map((m) => `- ${m}`),
    );
  }
  lines.push("", "== 轮次谱系（本阶段已开轮次） ==");
  for (const r of [...input.rounds].sort((a, b) => a.round - b.round)) {
    lines.push(
      `- 第 ${String(r.round)} 轮 basisRev=${r.basisRev} docVersion=${dash(r.docVersion)}`,
    );
  }
  lines.push("", "== 成员回执逐行（三值 + 理由 + 回执原文） ==");
  if (rows.length === 0) lines.push("（本轮无成员行）");
  for (const row of rows) {
    lines.push(
      `### ${row.projectId}`,
      `- relevance=${dash(row.relevance)} decision=${dash(row.decision)} answerState=${dash(row.answerState)}`,
      `- reason: ${dash(row.reason)}`,
      `- basedOnRev=${dash(row.basedOnRev)} stale=${String(row.stale)} reachability=${row.reachability} taskState=${row.taskState}`,
      "- 回执原文：",
      `"""\n${row.text ?? "（无回执原文）"}\n"""`,
    );
  }
  lines.push("", "== 未处置异议 ==");
  if (input.objections.length === 0) lines.push("（无未处置异议）");
  for (const o of input.objections) lines.push(`- [${o.sectionId}] ${o.objectionText}`);
  lines.push(
    "",
    "== 输出契约（严格：违反任一条 = 整单作废，不做补救、不截断） ==",
    "只输出**一个 JSON 对象**，不得输出 JSON 之外的任何文字。形状：",
    `{"docVersion":"${docVersion}","sections":[{"id":"problem","title":"…","content":"…","sources":["<projectId>"]}, …]}`,
    "sections 必含且只含下列五节、每节恰一次（id 固定，title 用给定中文）：",
    ...SYNTHESIS_SECTION_IDS.map((id) => `- ${id}（${SECTION_TITLES[id]}）`),
    "  · problem：本轮要解决什么问题｜impact：对各 project 的影响面｜constraints：已成立的约束与前提",
    "  · open-questions：未解问题（逐条，注明卡在哪个 project 或还缺什么材料）",
    "  · decisions：需用户拍板的决策（逐条，给可选项与倾向）",
    "sources = **节级依据指向**，元素只允许取上面出现过的 projectId（可为空数组）；" +
      "它**不是**「开轮材料」的复述，两者不同物。",
    `content 为 Markdown 正文，trim 后不得为空；单节 ≤${String(SECTION_MAX_CODEPOINTS)} 码点、` +
      `全文五节合计 ≤${String(DOC_MAX_CODEPOINTS)} 码点，超限整单作废。`,
    `docVersion 恒为 ${docVersion}，不要另造版本号。`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 一次循环
// ---------------------------------------------------------------------------

export type SynthesisResult =
  | { ok: true; docVersion: string; prompt: string; doc: SynthesisDoc; docHash: string }
  | SynthesisError;

/** LLM 通路三分类 → 本件失败归因（单点映射，不在调用方各写一份 switch） */
const LLM_FAILURE_REASONS = {
  network: "llm_network",
  http_status: "llm_http_status",
  parse: "llm_parse",
} as const;

/**
 * 组提示词 → `complete()` → 严格解析 → 现算 `docHash`。**零落库、零重试、零副作用**
 * （除调用注入的客户端本身）：任一环节失败即出一条结构化结果且**不产出半成品文档**
 * （调用方据此落 `state='failed'` + 一句原因进 `text`）。
 */
export async function synthesizeStageRound(
  input: SynthesisInput,
  llm: LlmClient | null,
): Promise<SynthesisResult> {
  const prompt = buildSynthesisPrompt(input);
  const docVersion = synthesisDocVersion(input.round.round);
  if (llm === null) return fail("llm_unavailable", "未注入 LLM 客户端（装配缺件），本轮合成未发起");
  const outcome = await llm.complete(prompt);
  if (!outcome.ok) return fail(LLM_FAILURE_REASONS[outcome.kind], outcome.reason);
  const parsed = parseSynthesisDoc(outcome.text, docVersion);
  if ("sections" in parsed)
    return { ok: true, docVersion, prompt, doc: parsed, docHash: computeDocHash(parsed) };
  return parsed;
}
