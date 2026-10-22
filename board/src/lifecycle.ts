/**
 * 板服务生命周期落盘件（BD13″ · v0.9.0）—— **pidfile 由板自己写**（listening 之后），
 * `scripts/boardctl.mjs` 只读不写（与 orch 桥 / machine launcher 同口径）。
 *
 * - pidfile = `board/.a2a/board.pid`，JSON `{ pid, port, host, startedAt }`；
 *   `port`/`host` = 实际绑定值 ⇒ 启停脚本探测端点的**唯一事实源**（脚本不解析配置内容，BD12″）。
 * - 停机（信号 / `POST /shutdown`）路径删除；异常退出留下的陈旧文件由 `boardctl stop/status`
 *   识别并清理（陈旧 pidfile 不是锁，无害）。
 * - 另承载**退出卫生**两件：`createShutdownChain` 的兜底闸（BD19 缺陷①）与 `resumeAndUnref`
 *   （被继承管道写端钉住的 stdio 读端 ⇒ 撒手；B1 起板不再起 agent，本函数作为退出卫生出口保留）。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** pidfile 缺省落点：`<board 根>/.a2a/board.pid`。 */
export function defaultPidfilePath(boardRoot: string): string {
  return join(boardRoot, ".a2a", "board.pid");
}

/** pidfile 记录（板自写；形状校验见 {@link parsePidfileRecord}）。 */
export interface BoardPidRecord {
  readonly pid: number;
  readonly port: number;
  readonly host: string;
  /** UTC ISO 8601 */
  readonly startedAt: string;
}

export function buildPidRecord(input: { port: number; host: string }, now: Date = new Date()): BoardPidRecord {
  return { pid: process.pid, port: input.port, host: input.host, startedAt: now.toISOString() };
}

/** 写 pidfile（先建目录）；写失败只 warn 不崩服务（pidfile 是观测面，不是锁）。 */
export function writePidfile(path: string, record: BoardPidRecord): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(record) + "\n", "utf8");
    return true;
  } catch (err) {
    process.stderr.write(`pidfile 写入失败（不影响服务）：${path} · ${err instanceof Error ? err.message : String(err)}\n`);
    return false;
  }
}

/** 读 pidfile；缺失 / 坏 JSON / 形状不合法 ⇒ `null`（调用方按「无 pidfile」处理）。 */
export function readPidfile(path: string): BoardPidRecord | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    return parsePidfileRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** 形状校验（纯函数，供单测直接喂对象）：`pid`/`port` 必须正整数，`host` 必须字符串；`startedAt` 可选。 */
export function parsePidfileRecord(parsed: unknown): BoardPidRecord | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  const { pid, port, host, startedAt } = rec;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) return null;
  if (typeof host !== "string" || host === "") return null;
  return {
    pid,
    port,
    host,
    startedAt: typeof startedAt === "string" ? startedAt : "",
  };
}

/** 删 pidfile（不存在 = 成功；其余错误只 warn，不抛）。 */
export function removePidfile(path: string): boolean {
  try {
    rmSync(path, { force: true });
    return true;
  } catch (err) {
    process.stderr.write(`pidfile 删除失败：${path} · ${err instanceof Error ? err.message : String(err)}\n`);
    return false;
  }
}

export interface ShutdownChainDeps {
  /** 停已托管的宿主桥（`HostBridgeManager.stopAll`）；抛错不阻断后续关卡口 */
  stopBridges: () => Promise<void>;
  /** 关卡的 HTTP（优雅 + 宽限后强断兜底） */
  closeServer: () => Promise<void>;
  /** pidfile 落点（停机末尾删） */
  pidfilePath: string;
  /** 退出码落法（缺省设 `process.exitCode`；测试可注入 recorder，不污染测试进程退出码） */
  setExitCode?: (code: number) => void;
  /** 日志出口（缺省 process.stdout.write） */
  log?: (line: string) => void;
  /**
   * **兜底闸**（BD19 缺陷①）：注入后，停机链完成 `exitGraceMs` 内进程仍未退出 ⇒ 调本回调强退。
   * 缺省不注入 ⇒ 链只设 `exitCode`，绝不碰 `process.exit`（测试进程靠这条）。
   * **只有入口 `index.ts` 会注入真的 `process.exit`**，全仓就那一处。
   */
  forceExit?: (code: number) => void;
  /** 兜底闸的宽限（缺省 {@link SHUTDOWN_EXIT_GRACE_MS}）；仅在注入了 `forceExit` 时生效。 */
  exitGraceMs?: number;
  /** 残余活跃资源探针（缺省 `process.getActiveResourcesInfo`）；仅用于兜底闸的取证日志。 */
  activeResources?: () => readonly string[];
}

/**
 * 兜底闸宽限（BD19）。**3s 的依据**：关卡口的强断兜底是 `HTTP_CLOSE_GRACE_MS`(5s) + 250ms，
 * 但那条定时器已 `unref()` ⇒ 正常收尾时不参与「进程该不该退」的判断；3s 足够让
 * 「链已完成、事件循环确已排空」的自然退出先发生，只在真有东西钉住循环时才介入。
 */
export const SHUTDOWN_EXIT_GRACE_MS = 3_000;

/**
 * 优雅停机链（BD13″）：SIGINT / SIGTERM 与 `POST /shutdown` **共用同一条链**，
 * **重入守卫幂等**（多次受理只走一次），顺序 = **先停宿主桥（不留孤儿后端）→ 关卡口 → 删 pidfile**。
 *
 * **退出卫生**：链内不 `process.exit`，只设 `exitCode`（末态经 `setExitCode` 注入），
 * 事件循环自然排空后按该码退出（治 Windows 退出期退出码被污染）。
 * 收尾判据由调用侧（`boardctl stop`）把 = 端口释放 ∧ 进程退出 —— 本链只保证「受理过的停机只发生一次」。
 *
 * **BD19 兜底闸（缺陷①）**：上面那条「靠事件循环自己排空」的纪律，在真机上被证伪过一次 ——
 * 停掉的只是 `cmd.exe` 那一层，**桥 / 后端孙进程仍活着并握着 spawn 时继承的 stdout/stderr 管道写端**
 * ⇒ 父进程那两个 `PipeWrap` 读端永远等不到 EOF ⇒ 循环排不空 ⇒ 端口没了、pidfile 没了、
 * 日志照打「已停止」，进程却能挂几小时（2026-09-25 真机 pid=12912）。故链完成后**再补一道闸**：
 * 注入了 `forceExit` 时，`exitGraceMs` 内还没退 ⇒ 打一条带**残余活跃资源清单**的日志再强退 0。
 * 该定时器 `unref()` ⇒ 它自己不钉住循环：排得空就永远走不到它（自然退出在前），
 * 排不空时循环仍在转、它照 fire。**顺序不变**：宿主桥仍先停（本闸只兜「退不出去」这一件事）。
 */
export function createShutdownChain(deps: ShutdownChainDeps): (via: string) => Promise<void> {
  let stopping = false;
  let done: Promise<void> | null = null;
  const log = deps.log ?? ((line: string) => void process.stdout.write(line));
  const setExitCode = deps.setExitCode ?? ((code: number) => void ((process as { exitCode?: number }).exitCode = code));
  const activeResources =
    deps.activeResources ??
    (() => (typeof process.getActiveResourcesInfo === "function" ? process.getActiveResourcesInfo() : []));
  /** 残余活跃资源按类型计数（`PipeWrap×2 · Timeout×1`）—— 兜底闸日志里的取证面。 */
  const residualText = (): string => {
    let counted: ReadonlyMap<string, number>;
    try {
      const tally = new Map<string, number>();
      for (const kind of activeResources()) tally.set(kind, (tally.get(kind) ?? 0) + 1);
      counted = tally;
    } catch {
      return "未知（探针抛错）";
    }
    const parts = [...counted].map(([kind, n]) => `${kind}×${String(n)}`);
    return parts.length > 0 ? parts.join(" · ") : "空（无活跃资源登记）";
  };
  const armExitGate = (): void => {
    const forceExit = deps.forceExit;
    if (forceExit === undefined) return;
    const graceMs = deps.exitGraceMs ?? SHUTDOWN_EXIT_GRACE_MS;
    setTimeout(() => {
      log(`兜底闸触发：停机链完成后 ${String(graceMs)}ms 仍未退出 ⇒ 强退 0 · 残余活跃资源 = ${residualText()}\n`);
      forceExit(0);
    }, graceMs).unref();
  };
  return (via: string): Promise<void> => {
    if (stopping) {
      log(`停机已在进行中（本次来源 = ${via}）：忽略重入\n`);
      return done ?? Promise.resolve();
    }
    stopping = true;
    done = (async () => {
      log(`收到停机请求（${via}）：停宿主桥 → 关卡口 → 删 pidfile\n`);
      const startedAt = Date.now();
      try {
        await deps.stopBridges().catch(() => undefined);
        // 关卡口抛错也不让链 reject：停机已受理，失败只登记可见，收尾（删 pidfile · 落退出码）照走
        await deps.closeServer().catch((err: unknown) => {
          log(`关卡口异常（仍继续收尾）：${err instanceof Error ? err.message : String(err)}\n`);
        });
      } finally {
        removePidfile(deps.pidfilePath);
        log(`已停止（耗时 ${Date.now() - startedAt}ms）\n`);
        setExitCode(0);
        armExitGate();
      }
    })();
    return done;
  };
}

/**
 * **排空 + 撒手**（BD19 缺陷①的主修，v0.11.0 B1 起随宿主面退役从 `host-process.ts` 迁入本模块）：
 * `resume()` 让管道持续被消费（否则子进程写满 64KB 会阻塞），紧接着 `unref()` 让这两个句柄
 * **不再参与父进程的存活判定**。
 *
 * 为什么必须撒手：Windows 上板 spawn 的是 `cmd.exe → 桥 → 后端`，**停止时只 SIGTERM 了直接子进程
 * `cmd.exe`**（它退了就不再树杀），而孙进程**继承着同一根 stdout/stderr 管道的写端**
 * ⇒ 父进程那头的读端永远等不到 EOF ⇒ 只要 `resume()` 过，它就是**一个有主的活跃句柄** ⇒
 * 停机链跑完、端口已释放、日志已打「已停止」，进程却钉在事件循环上不走（2026-09-25 真机僵尸数小时）。
 * 实测残余活跃资源清单 = `PipeWrap×2`（`process.getActiveResourcesInfo()`，见 {@link createShutdownChain} 兜底闸）。
 *
 * 只在**父进程侧**解除引用，不动子进程的 stdio 形态（仍 `pipe`，管道内容照旧可被消费）⇒
 * 「不 `unref()` 子进程句柄：仍需 `exit` 事件跟踪该子进程」那条既有口径不受影响。
 *
 * 本函数是**板侧一旦引入子进程就该走的退出卫生出口**：B1 退役后板不再起宿主 agent，
 * 生产侧暂无调用方，但「被继承管道钉住退出」这条教训的可执行形态保留在此并被 BD19 钉住，
 * 不再回指已删除的宿主桥实现。
 */
export function resumeAndUnref(stream: NodeJS.ReadableStream | null | undefined): void {
  // `stdio` 该槽为 `ignore` 时流是 `null` ⇒ 本就无句柄可钉，等同于已撒手。
  if (stream === null || stream === undefined) return;
  stream.resume();
  // spawn 出来的 stdio 管道在 Node 里是 net.Socket 形态（有 unref）；拿不到就当已撒手（不抛）。
  const maybe = stream as NodeJS.ReadableStream & { unref?: () => void };
  maybe.unref?.();
}
