/**
 * 阶段回执解析器（R1 · v0.11.0 orch-N3）——**纯函数、零副作用**（不 import store、不 import fs，
 * 唯一依赖 = `types.ts` 的三值闭集常量）。
 *
 * 定位：从成员回信的**全文**里定位三值（relevance/decision/reason）与口径指纹（basedOnRev），
 * 出参另带回执态 `answerState`（pending=尚无回执 / valid=解析合格 / invalid=解析失败）。
 * `invalid` 只是**回执态**——出参闭集里没有 failed 档，解析失败**不判任务失败**
 * （改造文档 §2.3 不变量「解析问题绝不误判为失败」）。
 *
 * 载体与裁定口径（冻结）：
 * - **主载体** = 键值行 `RELEVANCE:` / `DECISION:` / `REASON:` / `BASED_ON_REV:`，全文定位
 *   （不假定列首锚点：缩进、行内、正文中段/尾部均算命中；枚举值取行首 token）；
 * - **次级载体** = ` ```a2a-json ` 围栏块；多块**末块胜**；坏块/未闭合块 ⇒ invalid（不静默吞掉）；
 * - ` ```a2a-outcome ` 围栏一旦出现 ⇒ 直接 invalid（机器侧会整块删除并把 state 回退 completed，
 *   三值被静默吃掉 ⇒ 本解析器拒绝给出任何可信三值）；
 * - 同名键重复出现 ⇒ **末次出现胜**（与机器侧 last-block-wins 同策略）；
 * - 主/次载体同时出现且冲突 ⇒ **主载体优先**（按字段级主优先，次级只补主载体缺的字段）。
 *
 * 分诊口径（**先按 A2A `state` 分诊、再取三值，两态不互推**）：
 * - `state` 不参与三值合法性判定：`completed`+`rejected`、`input-required`+带全键都是合法组合，
 *   后者照收（**不得**因提问态把三值强制回 pending）；
 * - **两载体皆缺**时由 state 定落点：`input-required` / `failed` ⇒ `pending`（尚在等回执，
 *   不算格式违规）；`completed` ⇒ `invalid`（宣告完成却不带回执块 = 违回执契约）；
 * - 空文本 ⇒ `invalid`（不分 state——收到空回信本身即违约）。
 *
 * 三值口径：
 * - `relevance` 必在闭集内（缺省/越域 ⇒ invalid；大小写敏感，闭集是小写形态）；
 * - `decision` **仅 `involved` 行有值**：`involved` 缺 DECISION ⇒ 归 `pending`（已涉及、未决定，
 *   非格式错误）；非 involved 行带 DECISION ⇒ 按「否则 NULL」口径归一为 NULL（不因此判 invalid）；
 * - `reason` 在 `not_involved` / `rejected` **必填**（缺失 ⇒ invalid）；上限 200 字（按码点计），
 *   超限 ⇒ 截断到 200 并置 `reasonTruncated` 标记；
 * - `basedOnRev` 可选，缺省/空 ⇒ null；`stale` 是读侧派生态，不在本解析器落值。
 */
import {
  STAGE_DECISIONS,
  STAGE_RELEVANCES,
  type StageAnswerState,
  type StageDecision,
  type StageRelevance,
} from "../types.js";

/**
 * 解析器入参侧的 A2A 任务终态闭集（分诊用）。与回执三值正交：任何一向都**不得**由另一向推出。
 * 运行期仍做闭集校验（远端回信属系统边界），未知 state ⇒ invalid。
 */
export const STAGE_A2A_STATES = ["completed", "input-required", "failed"] as const;

/** A2A 任务态（由 `STAGE_A2A_STATES` 派生；勿另立第二份清单） */
export type StageA2aState = (typeof STAGE_A2A_STATES)[number];

/** 回执 `reason` 字数上限（按 Unicode 码点计，超出截断并置标记） */
export const REASON_LIMIT_CODEPOINTS = 200;

/** 解析结果：三值 + 口径指纹 + 回执态 + 截断标记。invalid/pending 时四值一律 null。 */
export interface StageReplyParseResult {
  /** 参与性三值（{@link STAGE_RELEVANCES}；null = 本解析不落值） */
  relevance: StageRelevance | null;
  /** 决定三值（{@link STAGE_DECISIONS}；**仅 relevance=involved 时非 null**） */
  decision: StageDecision | null;
  /** 理由文本（≤200 码点；not_involved / rejected 时必非 null） */
  reason: string | null;
  /** 口径指纹（sha256 hex 字符串；缺省 null，stale 由读侧派生） */
  basedOnRev: string | null;
  /** 回执态三值（与任务 failed 正交，闭集里没有 failed 档） */
  answerState: StageAnswerState;
  /** `reason` 是否因超 200 码点被截断（= 判据要求的「标记」位） */
  reasonTruncated: boolean;
}

/** 四枚主/次载体字段名（键值行大写形态；次级 JSON 归一后再并入） */
type StageField = "RELEVANCE" | "DECISION" | "REASON" | "BASED_ON_REV";

/** 键值行：`KEY:` 后取到行尾（REASON 值可含冒号/空格）；`\b` 前锚防误配 `SOMEREASON:` 类串 */
const KEY_LINE_RE = /\b(RELEVANCE|DECISION|REASON|BASED_ON_REV)[ \t]*:[ \t]*([^\r\n]*)/g;

/** 次级载体完整围栏（捕获块体；末块胜由调用侧取 blocks 尾部实现） */
const JSON_FENCE_RE = /```[ \t]*a2a-json[ \t]*\r?\n([\s\S]*?)```/g;

/** 次级载体开栏计数（与 JSON_FENCE_RE 完整配对数比对 ⇒ 未闭合块 = 坏块） */
const JSON_FENCE_OPEN_RE = /```[ \t]*a2a-json\b/g;

/** 禁用围栏检出：出现即 invalid，不看块体 */
const OUTCOME_FENCE_RE = /```[ \t]*a2a-outcome\b/;

/**
 * 该回信全文是否含**禁用**的 ` ```a2a-outcome ` 围栏（R1 · orch-N4 重派诊断用）。
 * 单点导出防漂移：invalid 归因文案与本解析器第 3 道门必须同一条正则（N4 节点口径）。
 */
export function hasOutcomeFence(text: string): boolean {
  return OUTCOME_FENCE_RE.test(text);
}

/** 枚举行值 = 行首连续 [a-z_] token（"involved（详见下）" → "involved"；大小写敏感） */
const ENUM_TOKEN_RE = /^[a-z_]+/;

/** 指纹行值 = 行首非空白 token */
const REV_TOKEN_RE = /^\S+/;

/** 次级 JSON 键 → 统一字段名（based_on_rev 与 basedOnRev 两种拼法都收） */
const JSON_KEY_FIELDS: ReadonlyArray<readonly [jsonKey: string, field: StageField]> = [
  ["relevance", "RELEVANCE"],
  ["decision", "DECISION"],
  ["reason", "REASON"],
  ["based_on_rev", "BASED_ON_REV"],
  ["basedOnRev", "BASED_ON_REV"],
];

/** 空值结果（invalid / pending 共用：四值 null、无截断标记） */
function blankResult(answerState: StageAnswerState): StageReplyParseResult {
  return {
    relevance: null,
    decision: null,
    reason: null,
    basedOnRev: null,
    answerState,
    reasonTruncated: false,
  };
}

/** 收窄：字符串 → 闭集成员（越域 / null 输入 ⇒ null） */
function onlyIn<T extends string>(v: string | null, set: readonly T[]): T | null {
  return v !== null && (set as readonly string[]).includes(v) ? (v as T) : null;
}

/** 取行值首 token（无匹配 ⇒ null） */
function leadToken(re: RegExp, raw: string): string | null {
  return re.exec(raw.trim())?.[0] ?? null;
}

/** 扫主载体键值行（同名键重复 = 末次出现覆盖 ⇒ last-wins） */
function scanKeyLines(text: string): Map<StageField, string> {
  const out = new Map<StageField, string>();
  for (const m of text.matchAll(KEY_LINE_RE)) {
    const key = onlyIn(m[1] ?? null, ["RELEVANCE", "DECISION", "REASON", "BASED_ON_REV"] as const);
    const value = m[2];
    if (key === null || value === undefined) continue;
    out.set(key, value.trim());
  }
  return out;
}

/**
 * 解析次级载体块体：要求 JSON 对象；字符串值收用（空串按「缺省」处理），null 按「缺省」跳过，
 * 其它类型/非对象/语法错 ⇒ 返回 null（= 坏块，调用侧落 invalid）。
 */
function parseJsonBlock(body: string): Map<StageField, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const out = new Map<StageField, string>();
  for (const [jsonKey, field] of JSON_KEY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, jsonKey)) continue;
    const v = record[jsonKey];
    if (v === null) continue;
    if (typeof v !== "string") return null;
    out.set(field, v.trim());
  }
  return out;
}

/**
 * 解析一条阶段轮回信。`text` = 回信全文（`input-required`/`failed` 是「短文 + 剥块全文」两段
 * 拼接，本函数按全文定位、不假定任何列首锚点）；`a2aState` = A2A 任务态，只用于「两载体皆缺」
 * 时的分诊，不参与三值合法性判定（两态不互推）。
 */
export function parseStageReply(text: string, a2aState: StageA2aState): StageReplyParseResult {
  // 1) 空回信 = 契约违反，先于 state 分诊。
  if (text.trim() === "") return blankResult("invalid");
  // 2) 未知 state（边界防御，类型闭集之外的运行期脏值）⇒ 不可信分诊。
  if (!(STAGE_A2A_STATES as readonly string[]).includes(a2aState)) return blankResult("invalid");
  // 3) 禁用围栏：三值已被机器侧吃掉，拒绝给出可信三值。
  if (OUTCOME_FENCE_RE.test(text)) return blankResult("invalid");

  // 4) 摘出次级载体（完整块），主载体扫描前先掩蔽 ⇒ 块内文本不会被键值行正则重复计数。
  const blocks: string[] = [];
  const masked = text.replace(JSON_FENCE_RE, (_whole, body: string) => {
    blocks.push(body);
    return "\n";
  });
  const opens = (text.match(JSON_FENCE_OPEN_RE) ?? []).length;
  const mainFields = scanKeyLines(masked);

  // 5) 两载体皆缺 ⇒ 由 state 定 pending/invalid（不互推三值本身）。
  if (mainFields.size === 0 && opens === 0) {
    return blankResult(a2aState === "completed" ? "invalid" : "pending");
  }
  // 6) 坏次级载体（未闭合 / 非对象 / 语法错 / 值型不合法）⇒ invalid，不静默回退。
  if (opens !== blocks.length) return blankResult("invalid");
  let jsonFields = new Map<StageField, string>();
  if (opens > 0) {
    const lastBlock = parseJsonBlock(blocks[blocks.length - 1] ?? "");
    if (lastBlock === null) return blankResult("invalid");
    jsonFields = lastBlock;
  }

  // 7) 字段级合并：主载体优先，次级只补主载体缺的字段；空串按缺省处理。
  const pick = (key: StageField): string | undefined => {
    const primary = mainFields.get(key);
    if (primary !== undefined && primary !== "") return primary;
    const secondary = jsonFields.get(key);
    return secondary !== undefined && secondary !== "" ? secondary : undefined;
  };

  const relevance = onlyIn(
    pick("RELEVANCE") === undefined ? null : leadToken(ENUM_TOKEN_RE, pick("RELEVANCE") ?? ""),
    STAGE_RELEVANCES,
  );
  if (relevance === null) return blankResult("invalid");

  let decision: StageDecision | null = null;
  const decRaw = pick("DECISION");
  if (decRaw !== undefined) {
    const tok = onlyIn(leadToken(ENUM_TOKEN_RE, decRaw), STAGE_DECISIONS);
    if (tok === null) return blankResult("invalid");
    // 「仅 involved 有值，否则 NULL」按存储不变量归一：非 involved 行的 DECISION 落 NULL。
    if (relevance === "involved") decision = tok;
  } else if (relevance === "involved") {
    decision = "pending";
  }

  const reasonRaw = pick("REASON");
  let reason: string | null = null;
  let reasonTruncated = false;
  if (reasonRaw !== undefined) {
    const codepoints = [...reasonRaw];
    if (codepoints.length > REASON_LIMIT_CODEPOINTS) {
      reason = codepoints.slice(0, REASON_LIMIT_CODEPOINTS).join("");
      reasonTruncated = true;
    } else {
      reason = codepoints.join("");
    }
  }
  const reasonRequired = relevance === "not_involved" || decision === "rejected";
  if (reasonRequired && reason === null) return blankResult("invalid");

  const revRaw = pick("BASED_ON_REV");
  const basedOnRev = revRaw === undefined ? null : leadToken(REV_TOKEN_RE, revRaw);

  return { relevance, decision, reason, basedOnRev, answerState: "valid", reasonTruncated };
}
