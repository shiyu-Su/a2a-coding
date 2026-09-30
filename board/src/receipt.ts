/**
 * 板轮回执契约（REQ-2026-09-30-02 · Feature b65b4974 · v0.9.6 · 改造文档 §2-1）。
 *
 * 零依赖叶模块：不 import 任何板内模块，供收口点（host-turn）、prompt 组装点（host-face /
 * host-relay / heartbeat）与台账渲染共同引用。落点先例 = machine 侧 `agent-outcome.ts`。
 */

/**
 * 回执三行块的格式定义（写入 agent 提示的契约文案）。
 *
 * 两条硬规则显式写明：块放整轮输出**最末尾**；**不得放进 ```a2a-outcome 围栏内**
 * （桥剥围栏后文本尾部才是判据位，放围栏内会导致回执被剥掉而丢失）。
 * 文案内不出现任何 MCP 工具全名（§3.6 硬约束，由测试正则守）。
 */
export const RECEIPT_CONTRACT = `每轮收尾时，在整轮输出的**最末尾**追加一个「回执」块，供板解析成结构化卡片：

【回执】
要点:
- <本轮做了什么，最多 3 行，每行以减号 - 开头>
待用户: <需要用户拍板的事项，逐条用 ①② 标号；若没有则写「无」>
下一步: <一句话说明接下来打算做什么>

硬规则（两条，必须遵守）：
1. 回执块必须放在整轮输出的最末尾，其后不得再有任何正文。
2. 回执块不得放进 \`\`\`a2a-outcome 代码围栏内部——桥会剥掉该围栏，围栏内的文本不参与尾部判据解析，放里面会导致回执丢失。`;

/** 解析结果（未命中 ⇒ null）。要点 = head，待用户 = todo，下一步 = next。 */
export type Receipt = { head: string[]; todo: string[]; next: string } | null;

/**
 * 尾部【回执】块提取（容错口径照 `extractRegisteredDocPath` 族：返回 null 不抛）。
 * 兼容多空行、中文/半角冒号混用；块未落在文本尾或三键不全 ⇒ null。
 */
const RECEIPT_RE =
  /【回执】[^\S\n]*(?:\r?\n[^\S\n]*)*要点[^\S\n]*[:：]?[^\S\n]*([\s\S]*?)待用户[^\S\n]*[:：][^\S\n]*([\s\S]*?)下一步[^\S\n]*[:：][^\S\n]*([\s\S]*)$/;

/** ①-⑩ 圈号（待用户逐条分隔）。 */
const CIRCLED_SPLIT_RE = /[①②③④⑤⑥⑦⑧⑨⑩]/;

/** 从要点段取 `-` 起行的清单（≤3 行，逐行去减号、去空）。 */
function parseHeadLines(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "") continue;
    if (!t.startsWith("-")) continue;
    const body = t.slice(1).trim();
    if (body !== "") out.push(body);
    if (out.length >= 3) break;
  }
  return out;
}

/** 从待用户段拆圈号清单；「无」或空 ⇒ []。 */
function parseTodoLines(raw: string): string[] {
  const flat = raw.replace(/\s+/g, " ").trim();
  if (flat === "" || flat === "无") return [];
  if (CIRCLED_SPLIT_RE.test(flat)) {
    return flat
      .split(CIRCLED_SPLIT_RE)
      .map((s) => s.trim())
      .filter((s) => s !== "");
  }
  return [flat];
}

/** 从下一步段取首行（一句话）。 */
function parseNextLine(raw: string): string {
  const first = raw.split(/\r?\n/).map((s) => s.trim()).find((s) => s !== "");
  return first ?? "";
}

export function parseReceiptBlock(text: string): Receipt {
  const m = RECEIPT_RE.exec(text);
  if (m === null) return null;
  const head = parseHeadLines(m[1] ?? "");
  const todo = parseTodoLines(m[2] ?? "");
  const next = parseNextLine(m[3] ?? "");
  if (head.length === 0 && todo.length === 0 && next === "") return null;
  return { head, todo, next };
}
