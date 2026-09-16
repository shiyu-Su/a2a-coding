/**
 * orch 单元版本（**单一事实源**）。
 *
 * `package.json` 的 `version` 是唯一版本来源，两个消费者共用本模块：
 * - `/health` 报出的版本（http 接入面的 `version` 字段）
 * - MCP server 标识（`createServer()` 的 `McpServer({ version })`，client 握手时可见）
 *
 * 为什么单列一个模块：这两处一度各自为政（`/health` 读 `package.json`，server 标识硬编码 `0.2.0`），
 * 版本一升就漂移。把读取收在一处，谁都不许再硬编码版本号。
 *
 * 定位方式与 `app-root.ts` 同因：源码运行（`<root>/orch/*`）与构建运行（`<root>/orch/dist/*`）
 * 到应用根的深度不同，故自模块目录向上查找含 `package.json` 的目录。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appRootFromModule } from "./app-root.js";

/** 读 `package.json` 的 `version`；读取 / 解析失败回落 `"0.0.0"`（不阻塞启动） */
export function readPackageVersion(): string {
  try {
    const raw = readFileSync(join(appRootFromModule(import.meta.url), "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return "0.0.0";
    const version = (parsed as { version?: unknown }).version;
    return typeof version === "string" && version.length > 0 ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** 进程内缓存的版本（模块加载时读一次；`/health` 与 server 标识共用同一值） */
export const BRIDGE_VERSION = readPackageVersion();
