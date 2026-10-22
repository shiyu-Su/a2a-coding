/**
 * provider 失败判定的常量单源（零依赖叶模块，REQ-v0.11.0 · M2）。
 *
 * 规范单源 = 仓库根 `PROTOCOL.md` 2.4「`provider` 门详规」：本模块只做**逐字落地**，
 * 由 `test/provider-markers.test.ts` 读本文件逐串比对锁定；改五模式清单必先改 PROTOCOL.md。
 * 消费方（入口 ①/② 判定逻辑）归 M3+，本模块**不含任何判定逻辑**。
 * 匹配口径 = 对文本做**大小写不敏感子串**匹配（故此处存小写字面量）。
 */

/** 五模式冻结清单（字面定稿权归宿主，实现期不得自行增删 / 改写） */
export const PROVIDER_ERROR_MARKERS: readonly string[] = [
  "402 payment required",
  "insufficient balance",
  "unexpected status",
  "rate limit",
  "insufficient_quota",
];

/** 入口 ② 正文长度阈值上限（UTF-16 长度，即 JS `string.length`；`< 300` 才评估） */
export const PROVIDER_RECEIPT_MAX_TEXT_CHARS = 300;
