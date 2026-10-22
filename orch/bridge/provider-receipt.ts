/**
 * v0.11.0（O2 · 修假完成-provider错误结算）：provider 短回执判定**纯函数**。
 *
 * 判定门（PROTOCOL.md 2.4「provider 门详规」+ 改造文档 §7 宿主裁定）：
 * **未 trim** 的 `text.length < 300`（UTF-16 长度，两侧统一）∧ 大小写不敏感子串命中
 * `PROVIDER_ERROR_MARKERS` 五串之一。五模式字面的规范单源 = 根 `PROTOCOL.md`，
 * 本清单由 `test/provider-receipt.test.ts` 读该文件逐串比对锁定，勿单侧改字面。
 *
 * 本文件只做识别，不接调用点（挂点在 O3/O4 的终态写口前）。
 */

/** provider 五模式（小写字面量，匹配用 `toLowerCase()` 后做子串包含） */
export const PROVIDER_ERROR_MARKERS: readonly string[] = [
  "402 payment required",
  "insufficient balance",
  "unexpected status",
  "rate limit",
  "insufficient_quota",
] as const;

/** 短回执门：UTF-16 `string.length` 严格小于该值（两侧统一，不 trim） */
export const PROVIDER_RECEIPT_GATE_LENGTH = 300;

/** `failureSnippet` 上限（码点，含省略号），PROTOCOL.md 2.4「原文保留」条 */
export const PROVIDER_SNIPPET_MAX_CODEPOINTS = 120;

/** 命中结果：`marker` = 命中的小写规范串；`snippet` = 截断 + 脱敏后的命中片段 */
export interface ProviderFailureReceipt {
  marker: string;
  snippet: string;
}

/**
 * 判定入口：非短回执 / 未命中 ⇒ `null`（调用方按原路径结算，不产出 failureKind）。
 */
export function detectProviderFailureReceipt(text: string): ProviderFailureReceipt | null {
  if (text.length >= PROVIDER_RECEIPT_GATE_LENGTH) return null;
  const lowered = text.toLowerCase();
  const marker = PROVIDER_ERROR_MARKERS.find((m) => lowered.includes(m));
  if (marker === undefined) return null;
  return { marker, snippet: buildSnippet(text) };
}

/** 先脱敏再按码点截断：截断可能把凭据拦腰切断导致脱敏漏匹配，顺序不可反 */
function buildSnippet(text: string): string {
  const codepoints = Array.from(redactSecrets(text));
  if (codepoints.length <= PROVIDER_SNIPPET_MAX_CODEPOINTS) return codepoints.join("");
  return codepoints.slice(0, PROVIDER_SNIPPET_MAX_CODEPOINTS - 1).join("") + "…";
}

/** 凭据脱敏：`sk-…` 密钥与 URL userinfo（`://user:pass@`）打掩码 */
function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9]{8,}/g, "sk-***")
    .replace(/(:\/\/)[^\s/@:]*:[^\s/@]*@/g, "$1***:***@");
}
