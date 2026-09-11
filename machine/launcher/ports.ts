/**
 * 端口分配与就绪探测：ensure 启动 Agent 前分配空闲端口、启动后必须等到就绪才算成功。
 * - `waitForPort`：TCP 可连接即就绪。
 * - `waitForHttpOk`：HTTP GET 返回 200 即就绪（opencode serve 健康检查）。
 * 纯 `node:*` 实现，无外部依赖。
 */
import { connect, createServer } from "node:net";

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

/**
 * 申请一个空闲的本机端口：bind 到 port 0，读取系统分配端口后立即释放。
 * 释放与调用方实际占用之间存在极小的竞态窗口（本机按需启动场景可接受）。
 */
export async function allocateFreePort(host = "127.0.0.1"): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", (err) => {
      reject(err);
    });
    server.listen({ port: 0, host }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("无法获取系统分配的空闲端口"));
        return;
      }
      const port = address.port;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
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

export interface WaitForHttpOptions {
  /** 总超时（毫秒），超时抛错 */
  timeoutMs: number;
  /** 轮询间隔，默认 200ms */
  intervalMs?: number;
  /** 单次 HTTP 请求超时，默认 1000ms */
  probeTimeoutMs?: number;
  /** 返回 true 时提前中止（如子进程已退出），抛错 */
  shouldAbort?: () => boolean;
}

/** 单次 HTTP 就绪探测：GET 返回 200 即就绪；网络错误/超时/非 200 返回 false */
export async function probeHttpOk(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const ok = response.status === 200;
    try {
      // 健康检查响应体无业务价值：主动取消以释放连接，避免轮询期间 keep-alive 堆积
      await response.body?.cancel();
    } catch {
      // 取消失败不影响就绪判定
    }
    return ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 轮询等待 URL 返回 HTTP 200；进程提前退出或超时则抛错 */
export async function waitForHttpOk(url: string, options: WaitForHttpOptions): Promise<void> {
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  await waitForProbe(() => probeHttpOk(url, probeTimeoutMs), {
    timeoutMs: options.timeoutMs,
    intervalMs: options.intervalMs,
    shouldAbort: options.shouldAbort,
    abortMessage: `进程在 ${url} 就绪前退出`,
    timeoutMessage: `等待 ${url} 返回 HTTP 200 超时（${options.timeoutMs}ms）`,
  });
}
