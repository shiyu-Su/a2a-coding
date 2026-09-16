/**
 * 桥内统一日志（REQ-v0.4.1-2026-09-15-02，日志收口）。
 *
 * 为什么存在：桥以 **stdio** 承载 MCP JSON-RPC，`stdout` 就是协议通道——
 * 任何 `console.log` 都会污染协议流、破坏宿主解析。本模块是桥内观测日志的
 * 统一出口：**只写 stderr（或被显式重定向的文件），绝不写 stdout**。
 *
 * 形态：结构化 JSON 行（一行一条），字段固定为
 * `{ ts, level, scope, msg, data? }`（`ts` 为 UTC ISO 8601）。
 *
 * 重定向：环境变量 `BRIDGE_LOG_FILE` 指向文件时改写该文件（追加，父目录自动创建）；
 * 未设置时写 stderr（stdio 模式下的安全默认）。可选 `BRIDGE_LOG_LEVEL` 过滤，
 * 默认 `debug`（全量），因此不改变既有日志的输出时机与语义。
 *
 * 约束：不引入新依赖（仅 Node 内置）；日志写失败一律吞掉，绝不影响业务。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface BridgeLogOptions {
  /** 目标文件（追加写入）；`null` / 省略 = 写 stderr。 */
  file?: string | null;
  /** 最低输出级别；默认 `debug`（全量）。 */
  minLevel?: LogLevel;
}

function normalizeFile(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function parseLevel(raw: string | undefined): LogLevel {
  switch (raw) {
    case "debug":
    case "info":
    case "warn":
    case "error":
      return raw;
    default:
      return "debug";
  }
}

/** 运行态配置：由环境变量初始化，可经 `configureBridgeLog` 覆盖。 */
let targetFile: string | null = normalizeFile(process.env["BRIDGE_LOG_FILE"]);
let minLevel: LogLevel = parseLevel(process.env["BRIDGE_LOG_LEVEL"]);

/** 覆盖日志配置（测试 / 嵌入式调用用；生产默认走环境变量）。 */
export function configureBridgeLog(options: BridgeLogOptions): void {
  if ("file" in options) targetFile = normalizeFile(options.file);
  if (options.minLevel !== undefined) minLevel = options.minLevel;
}

function serialize(record: Record<string, unknown>): string {
  try {
    return JSON.stringify(record);
  } catch {
    // 循环引用等不可序列化场景：退化为最小记录，绝不让日志本身抛错。
    return JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      scope: "bridge-log",
      msg: "日志序列化失败（疑似循环引用）",
    });
  }
}

/** 写出：文件重定向优先，否则 stderr；任何写失败都静默吞掉（日志不得反噬业务）。 */
function emit(line: string): void {
  const payload = `${line}\n`;
  if (targetFile !== null) {
    try {
      mkdirSync(dirname(targetFile), { recursive: true });
      appendFileSync(targetFile, payload, "utf8");
      return;
    } catch {
      // 文件不可写 → 退化到 stderr，保证日志不丢
    }
  }
  try {
    process.stderr.write(payload);
  } catch {
    // stderr 亦不可写：放弃本条（绝不抛）。
  }
}

function log(level: LogLevel, scope: string, msg: string, data?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg,
  };
  if (data !== undefined) record["data"] = data;
  emit(serialize(record));
}

/** 桥内统一日志出口（stdio 安全：只写 stderr / 重定向文件，绝不写 stdout）。 */
export const bridgeLog = {
  debug: (scope: string, msg: string, data?: Record<string, unknown>): void =>
    log("debug", scope, msg, data),
  info: (scope: string, msg: string, data?: Record<string, unknown>): void =>
    log("info", scope, msg, data),
  warn: (scope: string, msg: string, data?: Record<string, unknown>): void =>
    log("warn", scope, msg, data),
  error: (scope: string, msg: string, data?: Record<string, unknown>): void =>
    log("error", scope, msg, data),
};
