/**
 * **启动期致命错误落盘**（BD19 · 缺陷② · v0.9.0 收口轨 15）——
 * 「进程死在 logger 之前」时的唯一取证面。
 *
 * ## 为什么要单独一个文件级通道
 * `board.log` 由 `scripts/boardctl.mjs` 用 `cmd … >> board.log 2>&1` 重定向而来，
 * 且行级时间戳补丁装在 `main()` 首行 ⇒ 崩溃若发生在**模块加载 / 配置校验 / 监听之前**，
 * 账面三件全空：**零日志、pidfile 不写、boardctl 只能报「pid=未知 + 启动超时」**
 * （2026-09-25 真机就是这样丢了根因）。本模块用最原始的手段补这一段：
 * `mkdirSync` + `fs.appendFileSync`（同步、不经任何流包装、不依赖配置已解析）落
 * `board/.a2a/logs/board.fatal.log`，内容含 **ISO 时间戳 + 未完成的启动阶段 + 堆栈**。
 *
 * ## 两条口径
 * - **阶段标记**：`setPhase()` 由入口在每段启动动作前打点 ⇒ 记录里那行「启动阶段 = X」
 *   就是「死在哪一步」的唯一事实源（`markLoggerReady()` 之后不再有启动期含义）。
 * - **logger 就绪后切正常日志**：`markLoggerReady()` 之后不再开 fatal 文件，改走注入的正常
 *   日志出口（入口给的是 `process.stderr` ⇒ 带时间戳进 `board.log`）。两通道**不双写**，
 *   避免同一堆栈在两份文件里各存一份、还对不上。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { timestampPrefix } from "./log.js";

/** 启动期致命日志缺省落点：`<board 根>/.a2a/logs/board.fatal.log`（与 `board.log` 同目录）。 */
export function defaultFatalLogPath(boardRoot: string): string {
  return join(boardRoot, ".a2a", "logs", "board.fatal.log");
}

/** `record` 的落点结论（入口据此判断「fatal 文件也没写成」时还要不要另想办法出声）。 */
export type FatalSink = "fatal-log" | "normal-log" | "lost";

export interface FatalRecorder {
  /** 启动阶段打点（崩溃时账面上的「死在哪一步」）。 */
  setPhase(phase: string): void;
  /** 当前阶段（只读，供自测与横幅复用）。 */
  phase(): string;
  /** logger 就绪 ⇒ 之后的记录切正常日志出口（不再开 fatal 文件）。 */
  markLoggerReady(): void;
  /** 是否已切正常日志。 */
  loggerReady(): boolean;
  /**
   * 落一条致命记录。**自身绝不抛**：这一层已经是最后兜底，再抛就没地方记账了。
   * 返回落点（`lost` = 两条通道都写不出去，只能由调用方决定还需不需要别的动作）。
   */
  record(source: string, err: unknown): FatalSink;
}

export interface FatalRecorderDeps {
  /** fatal 文件落点（绝对路径；父目录由本模块建）。 */
  file: string;
  /** 启动阶段的初值（缺省 `模块加载` —— 入口在 import 完成后立刻改）。 */
  initialPhase?: string;
  /** 正常日志出口（`markLoggerReady()` 之后用）；缺省 `process.stderr.write`。 */
  consoleWrite?: (line: string) => void;
  /** 落盘实现（测试注入桩）；缺省 `fs.appendFileSync`。 */
  append?: (path: string, data: string) => void;
  /** 建目录实现（测试注入桩）；缺省 `fs.mkdirSync(recursive)`。 */
  makeDir?: (path: string) => void;
  /** 时间源（测试可固定）。 */
  now?: () => Date;
}

function errStack(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  if (typeof err === "string") return err;
  return String(err);
}

/**
 * 造一个致命记录器（**纯工厂，不注册任何进程钩子**）——
 * 钩子只在入口 `index.ts` 装（测试进程 import 本模块不得被挂上 uncaughtException）。
 */
export function createFatalRecorder(deps: FatalRecorderDeps): FatalRecorder {
  const append = deps.append ?? ((path: string, data: string) => void appendFileSync(path, data, "utf8"));
  const makeDir = deps.makeDir ?? ((path: string) => void mkdirSync(path, { recursive: true }));
  const consoleWrite =
    deps.consoleWrite ?? ((line: string) => void process.stderr.write(line));
  const now = deps.now ?? (() => new Date());
  let phase = deps.initialPhase ?? "模块加载";
  let ready = false;

  return {
    setPhase: (next) => {
      phase = next;
    },
    phase: () => phase,
    markLoggerReady: () => {
      ready = true;
      phase = "运行期（logger 已就绪）";
    },
    loggerReady: () => ready,
    record: (source, err) => {
      const body = `启动阶段 = ${phase} · 来源 = ${source}\n${errStack(err)}\n`;
      if (ready) {
        try {
          consoleWrite(`[fatal] ${body}`);
          return "normal-log";
        } catch {
          return "lost";
        }
      }
      try {
        makeDir(dirname(deps.file));
        append(deps.file, `${timestampPrefix("error", now())}[fatal] ${body}`);
        return "fatal-log";
      } catch {
        // fatal 文件也写不出去（只读盘 / 权限）⇒ 最后再试一次正常日志，仍失败就如实返回 lost
        try {
          consoleWrite(`[fatal] ${body}`);
          return "normal-log";
        } catch {
          return "lost";
        }
      }
    },
  };
}
