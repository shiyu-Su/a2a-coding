/**
 * 端口就绪探测：ensure 启动 Agent 后必须等到就绪才算成功。
 * - `waitForPort`：TCP 可连接即就绪。
 * 纯 `node:*` 实现，无外部依赖。
 */
import { connect } from "node:net";

const DEFAULT_PROBE_TIMEOUT_MS = 1000;
const DEFAULT_INTERVAL_MS = 200;

export interface WaitForPortOptions {
  /** 探测地址，默认 127.0.0.1（与 endpoint 约定一致） */
  host?: string;
  /** 总超时（毫秒），超时抛错 */
  timeoutMs: number;
  /** 轮询间隔，默认 200ms */
  intervalMs?: number;
  /** 单次 TCP 连接超时，默认 1000ms */
  probeTimeoutMs?: number;
  /** 返回 true 时提前中止（如子进程已退出），抛错 */
  shouldAbort?: () => boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 单次 TCP 连接探测：能连上即认为端口就绪 */
export function probePort(port: number, host: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ port, host });
    const finish = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

interface WaitProbeOptions {
  timeoutMs: number;
  /** 轮询间隔，默认 200ms */
  intervalMs?: number;
  /** 返回 true 时提前中止（如子进程已退出），抛错 */
  shouldAbort?: (() => boolean) | undefined;
  /** shouldAbort 命中时的错误信息 */
  abortMessage: string;
  /** 超时时的错误信息 */
  timeoutMessage: string;
}

/** 通用轮询：探测成功返回；进程提前退出或超时抛错 */
async function waitForProbe(
  probe: () => Promise<boolean>,
  options: WaitProbeOptions,
): Promise<void> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deadline = Date.now() + options.timeoutMs;

  for (;;) {
    if (options.shouldAbort?.() === true) {
      throw new Error(options.abortMessage);
    }
    if (await probe()) return;
    if (Date.now() >= deadline) {
      throw new Error(options.timeoutMessage);
    }
    await delay(intervalMs);
  }
}

/** 轮询等待端口可连接；进程提前退出或超时则抛错 */
export async function waitForPort(port: number, options: WaitForPortOptions): Promise<void> {
  const host = options.host ?? "127.0.0.1";
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  await waitForProbe(() => probePort(port, host, probeTimeoutMs), {
    timeoutMs: options.timeoutMs,
    intervalMs: options.intervalMs,
    shouldAbort: options.shouldAbort,
    abortMessage: `进程在端口 ${port} 就绪前退出`,
    timeoutMessage: `等待端口 ${port} 就绪超时（${options.timeoutMs}ms）`,
  });
}
