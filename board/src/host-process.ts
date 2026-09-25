/**
 * 宿主桥的**进程原语**（v0.9.0 · BD4a）—— spawn / 探活 / 树杀 / 端口分配，全部可注入。
 *
 * 为什么单列一个文件：本文件是板里**唯一碰 `node:child_process` / `node:net`** 的宿主面，
 * 其余编排（起停策略 · 空闲回收 · 故障归因）在 `host-bridge.ts` 里以**注入的函数**跑，
 * 于是单测可以在**不起真桥**的前提下断言全部生命周期语义（本节点硬约束）。
 *
 * **spawn 形态照 machine 侧既有实现**（改造文档 §3.4「板管两级进程」行：Launcher 为子进程做的两件事
 * 板也要复刻）——
 * - Windows：Node 不能直跑 npm 的 `.cmd` shim ⇒ 经 `cmd.exe`（`shell: true`）自行拼接并预转义参数；
 *   代价 = 中间多一层 `cmd.exe` ⇒ **普通 kill 杀不干净**，故停止必须走**树杀**；
 * - POSIX：`detached: true` 建独立进程组 ⇒ 停止走**组杀**（覆盖后端孙进程）。
 *
 * **PATH 前置 `<machine 根>/node_modules/.bin`**：后端命令解析（`getAdapter().buildLaunch()` 内部）
 * 依赖本地可执行依赖，源码运行与构建运行都得能解析到。
 *
 * **BD14 起的第二职责**：spawn 失败（`error` 事件）的**事实留存与根因归因** ——
 * {@link BridgeChildHandle.spawnError} 留住 `code`/`errno`/`message`，
 * {@link describeSpawnFailure} 把它落成可分流的码（`spawn_enoent` …）与含 cwd 的文案。
 * win32 实测：spawn 失败**不发 `exit` 事件**，只把负 libuv errno（`-4058` = ENOENT）塞进 `exitCode`
 * ⇒ 错误对象一旦不留，账面就只剩一个「像退出码」的负数，看不出是目录问题还是后端问题。
 */
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { delimiter, resolve } from "node:path";

/** 板 spawn 出去的子进程的**最小可注入面**（真 ChildProcess 与测试假对象共用同一形状）。 */
export interface BridgeChildHandle {
  readonly pid: number | null;
  /** 已退出 ⇒ true（exit 事件或 exitCode 任一命中）。 */
  exited(): boolean;
  /**
   * 退出信息（**未退出 ⇒ null**）。做成拉取式而非只靠 `onExit` 事件：
   * 板在 spawn 之后才挂监听，**进程若在那之前就没了**，事件会漏 ⇒ 账面变「未知」。
   */
  exitInfo(): { code: number | null; signal: NodeJS.Signals | null } | null;
  /**
   * **spawn 本身**的失败原因（BD14）；没报错 ⇒ `null`。做成可选：
   * 测试替身可以完全不报（⇒ 归因回落既有「桥进程启动后即退出」那一档，不假造原因）。
   */
  spawnError?(): SpawnErrorInfo | null;
  kill(signal?: NodeJS.Signals): boolean;
  onExit(listener: (info: { code: number | null; signal: NodeJS.Signals | null }) => void): void;
}

/**
 * spawn 失败（Node 以 `error` 事件给出，**不是** exit 事件）留下的三件事实。
 * BD14 之前这里整个错误对象被丢弃 ⇒ 账面只剩 `-4058`（= libuv `ENOENT` 的负 errno
 * 被 Windows 当成退出码打印），看不出是「目录不存在 / 命令不存在」还是「桥起来就崩」。
 */
export interface SpawnErrorInfo {
  /** libuv 名义码（`ENOENT` / `EACCES` / …）；拿不到 ⇒ null。 */
  readonly code: string | null;
  /** 数值 errno（Windows 上为负，如 -4058）；拿不到 ⇒ null。 */
  readonly errno: number | null;
  readonly message: string;
}

/** spawn 入参（`args` 已由 `getAdapter().buildLaunch()` 产出，本模块不拼 argv）。 */
export interface SpawnBridgeInput {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type SpawnBridgeFn = (input: SpawnBridgeInput) => BridgeChildHandle;
/** 探活：端口能连上即活（桥无 GET `/health`，见 `host-bridge.ts` 文件头）。 */
export type ProbePortFn = (port: number) => Promise<boolean>;
/** 树杀：覆盖「cmd.exe → 桥 → 后端」整棵子树。 */
export type KillTreeFn = (pid: number) => Promise<void>;
/** 空闲端口分配。 */
export type AllocatePortFn = () => Promise<number>;

/**
 * 子进程环境：把 `<machine 根>/node_modules/.bin` **前置**到 PATH。
 * Windows 上 PATH 键名可能是 `Path` ⇒ 沿用现有键名，避免大小写重复项。
 */
export function buildChildEnv(machineRoot: string, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const binDir = resolve(machineRoot, "node_modules", ".bin");
  const pathKey = Object.keys(baseEnv).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const currentPath = baseEnv[pathKey] ?? "";
  return {
    ...baseEnv,
    [pathKey]: currentPath.length > 0 ? `${binDir}${delimiter}${currentPath}` : binDir,
  };
}

/** Windows `shell: true` 不转义参数（DEP0190）⇒ 含空白/引号的取值自行加引号。 */
export function quoteForCmd(arg: string): string {
  if (!/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/** 把真 ChildProcess 包装成 {@link BridgeChildHandle}（exit 事件 + 已退出态收敛）。 */
function wrapChild(child: ChildProcess): BridgeChildHandle {
  let done = child.exitCode !== null || child.signalCode !== null;
  let spawnErr: SpawnErrorInfo | null = null;
  const listeners: Array<(info: { code: number | null; signal: NodeJS.Signals | null }) => void> = [];
  child.once("exit", (code, signal) => {
    done = true;
    for (const listener of listeners) listener({ code, signal });
  });
  // spawn 失败（ENOENT 等）以 error 事件给出；不接住会抛未捕获异常。
  // BD14：**错误对象必须留下**（code / errno / message），否则账面只剩一个负 errno 冒充退出码。
  child.once("error", (err: unknown) => {
    done = true;
    const e = err as NodeJS.ErrnoException;
    spawnErr = {
      code: typeof e?.code === "string" ? e.code : null,
      errno: typeof e?.errno === "number" ? e.errno : null,
      message: e instanceof Error ? e.message : String(err),
    };
  });
  return {
    pid: typeof child.pid === "number" ? child.pid : null,
    exited: () => done,
    exitInfo: () =>
      child.exitCode !== null || child.signalCode !== null
        ? { code: child.exitCode, signal: child.signalCode }
        : null,
    spawnError: () => spawnErr,
    kill: (signal) => child.kill(signal ?? "SIGTERM"),
    onExit: (listener) => {
      listeners.push(listener);
    },
  };
}

// ---------------------------------------------------------------------------
// spawn 失败归因（BD14）
// ---------------------------------------------------------------------------

/** spawn 类失败码（按 Node 的名义码分流；未列出的归 `spawn_error`）。 */
const SPAWN_ERROR_CODES: Readonly<Record<string, string>> = {
  ENOENT: "spawn_enoent",
  ENOTDIR: "spawn_enotdir",
  EACCES: "spawn_eacces",
  EPERM: "spawn_eperm",
};

/** `describeSpawnFailure` 的入参（全部来自句柄与启动计划，纯函数、不碰进程）。 */
export interface SpawnFailureInput {
  spawnError: SpawnErrorInfo | null;
  cwd: string;
  command: string;
}

/**
 * **起桥失败的根因归因**（BD14 · 纯函数）：把「spawn 根本没起来」与「桥起来后自己退了」分开。
 *
 * spawn 失败必然带 Node 的 `error` 事件（win32 实测：`code = ENOENT` / `errno = -4058`，
 * 且**没有** `exit` 事件、`exitCode` 被塞成那个负 errno）⇒ 命中即返回可分流的码 +
 * 含 **cwd 与命令行**的文案，那个负数只在「原始退出码位」里附注，**不再冒充退出码**。
 * 未命中（无 error 事件）⇒ `null` ⇒ 调用方按既有「桥进程启动后即退出 / 已消失」处理。
 */
export function describeSpawnFailure(
  input: SpawnFailureInput,
): { code: string; message: string } | null {
  const err = input.spawnError;
  if (err === null) return null;
  const name = err.code ?? "未知码";
  const bits: string[] = [];
  bits.push(`spawn 报 ${name}${err.errno !== null ? `（errno=${String(err.errno)}）` : ""}`);
  bits.push(`cwd = ${input.cwd}`);
  bits.push(`command = ${input.command}`);
  if (err.errno !== null && err.code === null) {
    bits.push(`注：该负值是 libuv 的错误码，被 win32 当成退出码上报，不是桥自己退的`);
  }
  bits.push(
    name === "ENOENT"
      ? "⇒ 落点目录不存在，或后端命令在这台机上不可解析（先确认组织目录已建，再确认该 kind 的后端命令可用）"
      : "⇒ 落点或命令不可访问（检查目录与后端命令的存在性与权限）",
  );
  bits.push(`底层原因 = ${err.message}`);
  return {
    code: SPAWN_ERROR_CODES[name] ?? "spawn_error",
    message: `桥进程未能启动：${bits.join(" · ")}`,
  };
}

/**
 * **排空 + 撒手**（BD19 · 缺陷①的主修）：`resume()` 让管道持续被消费（否则子进程写满 64KB 会阻塞），
 * 紧接着 `unref()` 让这两个句柄**不再参与父进程的存活判定**。
 *
 * 为什么必须撒手：Windows 上板 spawn 的是 `cmd.exe → 桥 → 后端`，**停止时只 SIGTERM 了直接子进程
 * `cmd.exe`**（`stopInternal` 见它退了就不再树杀），而孙进程**继承着同一根 stdout/stderr 管道的写端**
 * ⇒ 父进程那头的读端永远等不到 EOF ⇒ 只要 `resume()` 过，它就是**一个有主的活跃句柄** ⇒
 * 停机链跑完、端口已释放、日志已打「已停止」，进程却钉在事件循环上不走（2026-09-25 真机僵尸数小时）。
 * 实测残余活跃资源清单 = `PipeWrap×2`（`process.getActiveResourcesInfo()`，见改造文档「证据」段）。
 *
 * 只在**父进程侧**解除引用，不动子进程的 stdio 形态（仍 `pipe`，管道内容照旧可被消费）⇒
 * 「不 `unref()` 子进程句柄：仍需 `exit` 事件跟踪该子进程」那条既有口径不受影响。
 */
export function resumeAndUnref(stream: NodeJS.ReadableStream | null | undefined): void {
  // `stdio` 该槽为 `ignore` 时流是 `null` ⇒ 本就无句柄可钉，等同于已撒手。
  if (stream === null || stream === undefined) return;
  stream.resume();
  // spawn 出来的 stdio 管道在 Node 里是 net.Socket 形态（有 unref）；拿不到就当已撒手（不抛）。
  const maybe = stream as NodeJS.ReadableStream & { unref?: () => void };
  maybe.unref?.();
}

/**
 * 默认 spawn 实现（与 machine launcher `spawnAgentProcess` 同形态）。
 * `stdio` = `ignore / pipe / pipe`：板的宿主桥日志不进板的 stdout，但保留管道便于将来取证
 * —— **取证用管道不得反过来钉住板进程的退出**，故统一走 {@link resumeAndUnref}（BD19）。
 */
export function createNodeSpawnBridge(platform: NodeJS.Platform = process.platform): SpawnBridgeFn {
  return (input: SpawnBridgeInput): BridgeChildHandle => {
    const stdio: StdioOptions = ["ignore", "pipe", "pipe"];
    if (platform === "win32") {
      const commandLine = [input.command, ...input.args.map(quoteForCmd)].join(" ");
      const child = spawn(commandLine, {
        cwd: input.cwd,
        shell: true,
        windowsHide: true,
        stdio,
        env: input.env,
      });
      resumeAndUnref(child.stdout);
      resumeAndUnref(child.stderr);
      return wrapChild(child);
    }
    const child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      shell: false,
      // 独立进程组（组长 = 桥进程）⇒ 停止时可按组杀覆盖后端孙进程。
      // 注意**不 `unref()`**：仍需 `exit` 事件跟踪该子进程。
      detached: true,
      windowsHide: true,
      stdio,
      env: input.env,
    });
    resumeAndUnref(child.stdout);
    resumeAndUnref(child.stderr);
    return wrapChild(child);
  };
}

/** 单次 TCP 连接探测：能连上 = 端口在听（桥 listen 即就绪，无 HTTP 健康路由）。 */
export function probeTcpPort(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 1_000,
): Promise<boolean> {
  return new Promise<boolean>((res) => {
    const socket = createConnection({ port, host });
    const finish = (ok: boolean): void => {
      socket.destroy();
      res(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

/** 向进程组发信号（POSIX）；`ESRCH` / 非法 pid ⇒ false，绝不抛。 */
function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  if (pid <= 1) return false; // 防 `kill(-1)` 广播给自己全部进程
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * 默认树杀实现：win32 `taskkill /pid <pid> /T /F`（`/T` = 含子进程，覆盖桥 + 后端）；
 * POSIX 组杀 `SIGKILL`。任何失败都不抛（调用方已在收尾路径，抛错会污染停止结果）。
 */
export function createTreeKiller(platform: NodeJS.Platform = process.platform): KillTreeFn {
  return (pid: number): Promise<void> => {
    if (!Number.isInteger(pid) || pid <= 1) return Promise.resolve();
    if (platform === "win32") {
      return new Promise<void>((res) => {
        const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.once("exit", () => res());
        killer.once("error", () => res());
      });
    }
    signalProcessGroup(pid, "SIGKILL");
    return Promise.resolve();
  };
}

/** 分配一个当前空闲端口（listen 0 取端口后立刻放开）。 */
export function allocateFreePort(host = "127.0.0.1"): Promise<number> {
  return new Promise<number>((res, rej) => {
    const srv = createServer();
    srv.once("error", (err) => {
      rej(err);
    });
    srv.listen(0, host, () => {
      const addr = srv.address();
      const port = addr !== null && typeof addr === "object" ? addr.port : 0;
      srv.close(() => (port > 0 ? res(port) : rej(new Error("无法分配空闲端口"))));
    });
  });
}
