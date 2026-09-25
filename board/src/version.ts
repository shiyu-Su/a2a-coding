/**
 * 从 `package.json` 读取本单元版本号（**不硬编码**）。
 *
 * 编译产物落在 `dist/`，`package.json` 位于其上一级（board/）⇒ 相对 `dist/*.js`
 * 用 `../package.json` 定位。运行时读取（非 `resolveJsonModule` 内联），避免把版本
 * 快照进构建产物。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

export function readVersion(): string {
  if (cached !== null) return cached;
  const pkgUrl = new URL("../package.json", import.meta.url);
  const raw = readFileSync(fileURLToPath(pkgUrl), "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  cached = typeof parsed.version === "string" ? parsed.version : "0.0.0-unknown";
  return cached;
}
