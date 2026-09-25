/**
 * BD19 板停启可靠性自测（v0.9.0 收口轨 15）—— 两条缺陷各钉一层，纯函数层与**真实进程层**都要有：
 *  ① 缺陷①（停机后进程不退出）：
 *     - `resumeAndUnref`：真实 spawn 出来的 stdio 管道，经本函数后底层句柄 `_handle.hasRef() === false`
 *       （对照：只 `resume()` 仍 `true`）⇒ 钉住「这一票不投了」；
 *     - 三进程同构复现（缺陷本体的形态）：父 spawn 子、子 spawn 孙后立刻自退、孙握着继承来的管道写端
 *       ⇒ 只 resume 的父**退不掉**（对照组），撒过手的父自己退 0（修复组）；
 *     - 兜底闸（链内单元层）：注入 `forceExit` + 故意钉住循环 ⇒ 完成链后 `exitGraceMs` 内强退 0，
 *       日志带**残余活跃资源清单**；未注入 ⇒ 一次都不碰 `process.exit`（测试进程靠这条）；
 *       闸的定时器必须 `unref()`（它自己不许成为新的钉子）、停机顺序仍是桥→口→收尾；
 *     - 真实进程端到端：拉起板（**临时副本 + 临时配置 + 空闲端口**，绝不碰真 `dist` / 真 pidfile）
 *       ⇒ `/health ok` → `POST /shutdown` → **5s 内自行退出且 exit code 0**、pidfile 已删、**且没惊动兜底闸**；
 *     - 真实进程端到端（兜底闸）：脚本链完成后被 ref'd 定时器钉住 ⇒ 进程仍由闸收口退 0。
 *  ② 缺陷②（启动失败不可观测）：真实进程两条崩溃路径 ——
 *     `main()` 抛（非法配置）/ `uncaughtException`（dist 副本里注入一次异步抛 + 抑制 logger 切换），
 *     钉 `board.fatal.log` 的 **ISO 时间戳 + `[fatal]` + 启动阶段 + 堆栈**，且**不写 pidfile**；
 *     logger 就绪后 ⇒ 切正常日志（不双写）；两通道皆不可写 ⇒ 如实 `lost`；
 *     `boardctl` 输出面 = 有 fatal 则连尾部一起打并点名路径，没有则一字不出。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";

import { createShutdownChain, readPidfile } from "../dist/lifecycle.js";
import { resumeAndUnref } from "../dist/host-process.js";
import { createFatalRecorder, defaultFatalLogPath } from "../dist/fatal-log.js";
import { printFatalTail } from "../scripts/boardctl.mjs";

const BOARD_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function tmp() {
  return mkdtempSync(join(tmpdir(), "board-bd19-"));
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 抢一个空闲端口（listen 0 → 读回 → 立刻关）。 */
async function freePort() {
  const srv = createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  return port;
}

/** 把真 `dist/` + `package.json` 复制到临时板根 ⇒ pidfile / fatal / 台账全落临时目录，不碰现场。 */
function copyBoardRoot(targetRoot, mutate) {
  cpSync(join(BOARD_ROOT, "dist"), join(targetRoot, "dist"), { recursive: true });
  cpSync(join(BOARD_ROOT, "package.json"), join(targetRoot, "package.json"));
  mutate?.(targetRoot);
  return targetRoot;
}

async function waitForHealth(host, port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://${host}:${port}/health`);
      const body = await res.json();
      if (res.status === 200 && body?.status === "ok") return body;
    } catch {
      /* 还没起来 */
    }
    if (Date.now() >= deadline) return null;
    await delay(150);
  }
}

// ---------------------------------------------------------------------------
// ① 缺陷① —— 句柄层与真机同构复现
// ---------------------------------------------------------------------------

test("BD19-① resumeAndUnref：真实 spawn 的 stdio 管道，经本函数后底层句柄不再 ref'd（对照组：只 resume() 仍 ref'd）；null/undefined 不抛", () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  try {
    // 判据取 libuv 句柄层（Node 26 的 stdio Socket 上没有公开的 `hasRef()`）：
    // `hasRef()` 正是「本句柄是否参与进程存活判定」= 「事件循环排不排得空」的那一票。
    const out = child.stdout._handle;
    const err = child.stderr._handle;
    child.stdout.resume();
    child.stderr.resume();
    assert.equal(out.hasRef(), true, "对照基准：resume() 后管道就是**有主的活跃句柄**（真机僵尸的根）");
    resumeAndUnref(child.stdout);
    resumeAndUnref(child.stderr);
    assert.equal(out.hasRef(), false, "修复面：unref 后不再投这一票");
    assert.equal(err.hasRef(), false);
    assert.equal(child.stdout.destroyed, false, "撒手 ≠ 拆流：管道照样可被消费（排空语义不变，不会憋死子进程）");
    assert.equal(resumeAndUnref(null), undefined, "该 stdio 槽为 ignore ⇒ 流是 null，当已撒手（不抛）");
    assert.equal(resumeAndUnref(undefined), undefined);
  } finally {
    child.kill();
  }
});

/**
 * 真机僵尸形态的**最小同构体**（三进程）：父（=板）spawn 直接子（= Windows 上的 `cmd.exe` 壳），
 * 子再 spawn 孙（= 桥 / 后端 CLI）并 `stdio: "inherit"` 后**立刻自己退** ⇒ 孙进程仍握着那两根管道写端
 * ⇒ 父侧读端永远等不到 EOF。对照（只 `resume()`）⇒ 父被钉住不退；修复（{@link resumeAndUnref}）⇒ 父自然退 0。
 */
test("BD19-① 同构复现：直接子已退、孙握着管道写端 ⇒ 只 resume 的父进程退不掉（缺陷本体）；撒过手的父进程自己退 0（修复）", () => {
  const dir = tmp();
  const posixDir = dir.replace(/\\/g, "/");
  const hostProcess = pathToFileURL(join(BOARD_ROOT, "dist", "host-process.js")).href;
  writeFileSync(
    join(dir, "parent.mjs"),
    [
      `import { spawn } from "node:child_process";`,
      `import { resumeAndUnref } from ${JSON.stringify(hostProcess)};`,
      `const dir = ${JSON.stringify(posixDir)};`,
      `const kid = spawn(process.execPath, [dir + "/spawner.mjs"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });`,
      `if (process.argv[2] === "unref") { resumeAndUnref(kid.stdout); resumeAndUnref(kid.stderr); } else { kid.stdout.resume(); kid.stderr.resume(); }`,
      `kid.on("exit", () => console.log("KID_EXITED"));`,
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(dir, "spawner.mjs"),
    [
      `import { spawn } from "node:child_process";`,
      `import { writeFileSync } from "node:fs";`,
      `const dir = ${JSON.stringify(posixDir)};`,
      `const g = spawn(process.execPath, [dir + "/holder.mjs"], { stdio: "inherit", detached: true, windowsHide: true });`,
      `writeFileSync(dir + "/holder.pid", String(g.pid));`,
      `g.unref();`,
    ].join("\n"),
    "utf8",
  );
  writeFileSync(join(dir, "holder.mjs"), "setTimeout(() => process.exit(0), 6000);\n", "utf8");
  const parent = join(dir, "parent.mjs");
  try {
    const zombied = spawnSync(process.execPath, [parent, "resume"], { encoding: "utf8", timeout: 2_500, windowsHide: true });
    assert.match(zombied.stdout ?? "", /KID_EXITED/, "钉住发生在直接子进程已退**之后**（正是缺陷①的形态）");
    assert.equal(zombied.status, null, "对照组：父进程本该被这根管道钉住 = 真机僵尸");

    const drained = spawnSync(process.execPath, [parent, "unref"], { encoding: "utf8", timeout: 2_500, windowsHide: true });
    assert.equal(drained.status, 0, `修复组：同一形态下父进程自己排空退出（stderr=${drained.stderr}）`);
    assert.match(drained.stdout, /KID_EXITED/);
  } finally {
    try {
      process.kill(Number(readFileSync(join(dir, "holder.pid"), "utf8")));
    } catch {
      /* 孙进程已自行到点退出 */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BD19-① 兜底闸：链完成后循环仍被钉住 ⇒ exitGraceMs 到点打取证日志（含残余活跃资源清单）并 forceExit(0) 恰好一次", async () => {
  const dir = tmp();
  const calls = [];
  const lines = [];
  const pinned = setInterval(() => undefined, 1_000); // 故意钉住 = 真机「孙进程握管道」的等价条件
  try {
    await createShutdownChain({
      stopBridges: async () => undefined,
      closeServer: async () => undefined,
      pidfilePath: join(dir, ".a2a", "board.pid"),
      log: (line) => lines.push(line),
      forceExit: (code) => calls.push(code),
      exitGraceMs: 60,
    })("POST /shutdown");
    assert.deepEqual(calls, [], "闸在宽限内还没 fire");
    await delay(250);
    assert.deepEqual(calls, [0], "退 0（停机终点是正常收口，不是失败）");
    assert.match(lines.join(""), /兜底闸触发[\s\S]*残余活跃资源 = .*Timeout×/);
  } finally {
    clearInterval(pinned);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BD19-① 兜底闸：未注入 forceExit ⇒ 不设闸、不建定时器（链只设 exitCode，测试进程零污染）", async () => {
  const dir = tmp();
  const realSetTimeout = globalThis.setTimeout;
  const scheduled = [];
  try {
    globalThis.setTimeout = (...args) => {
      scheduled.push(args[1]);
      return realSetTimeout(...args);
    };
    await createShutdownChain({
      stopBridges: async () => undefined,
      closeServer: async () => undefined,
      pidfilePath: join(dir, ".a2a", "board.pid"),
      log: () => undefined,
      setExitCode: () => undefined,
    })("SIGTERM");
    assert.deepEqual(scheduled, [], "没注入强退回调 ⇒ 一颗定时器都不该建");
  } finally {
    globalThis.setTimeout = realSetTimeout;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BD19-① 兜底闸的定时器自己 unref（不许成为新的钉子），且停机顺序仍是桥→口→收尾", async () => {
  const dir = tmp();
  const realSetTimeout = globalThis.setTimeout;
  const handles = [];
  const order = [];
  try {
    await createShutdownChain({
      stopBridges: async () => {
        order.push("stopBridges");
      },
      closeServer: async () => {
        order.push("closeServer");
      },
      pidfilePath: join(dir, ".a2a", "board.pid"),
      log: () => undefined,
      setExitCode: () => order.push("setExitCode"),
      forceExit: () => order.push("forceExit"),
      exitGraceMs: 20_000, // 长到本用例内绝不 fire（fire 会污染 order）；unref ⇒ 它也不钉住循环
    })("SIGTERM");
    assert.deepEqual(order, ["stopBridges", "closeServer", "setExitCode"], "既有停机顺序不动：宿主桥仍先停");
    // 上面那次在 stub 之前 ⇒ 这里补一次带探针的，只验句柄形态
    globalThis.setTimeout = (...args) => {
      const h = realSetTimeout(...args);
      handles.push(h);
      return h;
    };
    await createShutdownChain({
      stopBridges: async () => undefined,
      closeServer: async () => undefined,
      pidfilePath: join(dir, ".a2a", "board.pid"),
      log: () => undefined,
      setExitCode: () => undefined,
      forceExit: () => undefined,
      exitGraceMs: 20_000,
    })("SIGTERM");
    assert.equal(handles.length, 1, "闸就一颗定时器");
    assert.equal(handles[0].hasRef(), false, "闸定时器必须已 unref ⇒ 事件循环排得空时永远轮不到它");
    handles[0].close();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BD19-① 兜底闸：重入停机（POST /shutdown 与 SIGTERM 先后到）⇒ 链只走一次、闸只装一次、grace 到点 forceExit(0) 恰一次", async () => {
  const dir = tmp();
  const calls = [];
  const lines = [];
  let closeCount = 0;
  try {
    const shutdown = createShutdownChain({
      stopBridges: async () => undefined,
      closeServer: async () => {
        closeCount += 1;
      },
      pidfilePath: join(dir, ".a2a", "board.pid"),
      log: (line) => lines.push(line),
      forceExit: (code) => calls.push(code),
      exitGraceMs: 80,
    });
    await Promise.all([shutdown("POST /shutdown"), shutdown("SIGTERM")]);
    assert.equal(closeCount, 1, "重入守卫：关卡口只发生一次");
    assert.match(lines.join(""), /忽略重入/);
    assert.deepEqual(calls, [], "宽限内还没 fire");
    await delay(300);
    assert.deepEqual(calls, [0], "两次停机请求只装一颗闸 ⇒ 恰一次强退 0（不双 fire）");
    assert.equal(
      lines.join("").match(/兜底闸触发/g)?.length,
      1,
      "取证日志也只有一条",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ② 缺陷① —— 真实进程端到端
// ---------------------------------------------------------------------------

test("BD19-① 真机收口：临时副本拉起板 ⇒ /health ok → POST /shutdown → 5s 内退 0 且 pidfile 已删", async () => {
  const root = copyBoardRoot(tmp());
  const port = await freePort();
  const cfgPath = join(root, "config.json");
  writeFileSync(cfgPath, JSON.stringify({ port, host: "127.0.0.1", machineDist: root }), "utf8");
  const pidfilePath = join(root, ".a2a", "board.pid");
  const child = spawn(process.execPath, [join(root, "dist", "index.js")], {
    cwd: root,
    env: { ...process.env, BOARD_CONFIG: cfgPath },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const out = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => out.push(c));
  child.stderr.on("data", (c) => out.push(c));
  const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
  try {
    const health = await waitForHealth("127.0.0.1", port);
    assert.notEqual(health, null, `板未起：${out.join("")}`);
    const rec = readPidfile(pidfilePath);
    assert.equal(rec.port, port, "pidfile 的端口 = 实际绑定值（boardctl 定位端点的唯一事实源）");

    const res = await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST" });
    assert.equal(res.status, 200);
    const winner = await Promise.race([exited.then((v) => ({ ...v, at: "exit" })), delay(5_000).then(() => null)]);
    assert.notEqual(winner, null, "缺陷①回归：停机链走完后进程必须自己在 5s 内退出去（不等兜底闸、不等强杀）");
    assert.equal(winner.signal, null, "自行退出，不是被信号打死");
    assert.equal(winner.code, 0, "退出码 0（优雅收口）");
    assert.equal(readPidfile(pidfilePath), null, "链末删 pidfile");
    assert.match(out.join(""), /已停止（耗时 \d+ms）/);
    assert.doesNotMatch(out.join(""), /兜底闸触发/, "自然排空在前 ⇒ 兜底闸本就不该被用到（用到即说明还有钉子）");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.race([exited, delay(3_000)]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("BD19-① 兜底闸真机收口：链完成后仍被 ref'd 定时器钉住 ⇒ 进程照样由闸退 0（僵尸的最后一道防线）", () => {
  const dir = tmp();
  const lifecycle = pathToFileURL(join(BOARD_ROOT, "dist", "lifecycle.js")).href;
  const pidfile = join(dir, ".a2a", "board.pid").replace(/\\/g, "/");
  const script = [
    `import { createShutdownChain } from ${JSON.stringify(lifecycle)};`,
    `const pinned = setInterval(() => {}, 1000);`,
    `const shutdown = createShutdownChain({`,
    `  stopBridges: async () => undefined,`,
    `  closeServer: async () => undefined,`,
    `  pidfilePath: ${JSON.stringify(pidfile)},`,
    `  exitGraceMs: 300,`,
    `  forceExit: (code) => process.exit(code),`,
    `});`,
    `await shutdown("BD19");`,
  ].join("\n");
  const startedAt = Date.now();
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  const took = Date.now() - startedAt;
  try {
    assert.equal(r.status, 0, `子进程应被闸收口退 0：${r.stderr}`);
    assert.ok(took < 5_000, `退出让位不能拖到分钟级（实测 ${String(took)}ms）`);
    assert.match(r.stdout, /兜底闸触发[\s\S]*Timeout×/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ③ 缺陷② —— 真实进程：死在 logger 之前也要留下取证面
// ---------------------------------------------------------------------------

/** 跑一份临时副本，返回 { status, stdout, stderr, fatal, fatalPath, pidfilePath, root }。 */
function runCopy(mutation, { configFor } = {}) {
  const root = copyBoardRoot(tmp(), mutation);
  const pidfilePath = join(root, ".a2a", "board.pid");
  const fatalPath = defaultFatalLogPath(root);
  const env = { ...process.env };
  if (configFor !== undefined) {
    const cfgPath = join(root, "config.json");
    writeFileSync(cfgPath, configFor(root), "utf8");
    env.BOARD_CONFIG = cfgPath;
  } else {
    delete env.BOARD_CONFIG;
  }
  const r = spawnSync(process.execPath, [join(root, "dist", "index.js")], {
    encoding: "utf8",
    cwd: root,
    env,
    windowsHide: true,
    timeout: 20_000,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    fatal: existsSync(fatalPath) ? readFileSync(fatalPath, "utf8") : null,
    fatalPath,
    pidfilePath,
    root,
  };
}

test("BD19-② 真机 fatal 落盘（配置校验抛 ⇒ main() 拒）：退 1 + fatal 文件带 ISO/[fatal]/启动阶段/堆栈，且 pidfile 不写", () => {
  const r = runCopy(undefined, { configFor: () => '{ "port": this-is-not-json' });
  try {
    assert.equal(r.status, 1, "装了钩子后必须把 Node 默认的「崩即退 1」显式补回来");
    assert.notEqual(r.fatal, null, "board.log 一片空白的年代，fatal 文件是唯一的取证面");
    assert.match(r.fatal, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[error\] \[fatal\] /m);
    assert.match(r.fatal, /启动阶段 = 配置加载 · 来源 = main\(\)/);
    assert.match(r.fatal, /at .*config\.js/, "必须含堆栈（只有一行 message 定位不到）");
    assert.equal(existsSync(r.pidfilePath), false, "崩在监听之前 ⇒ pidfile 本就不该存在（老版 boardctl 只能报「pid 未知」）");
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("BD19-② 真机 uncaughtException 钩子：logger 就绪前的异步抛 ⇒ 落 fatal 文件（带未完成的启动阶段）并退 1", async () => {
  const port = await freePort();
  const r = runCopy(
    (root) => {
      const entry = join(root, "dist", "index.js");
      const src = readFileSync(entry, "utf8");
      const crashNeedle = "installBootstrapGuards();";
      const switchNeedle = "fatal.markLoggerReady();";
      assert.ok(src.includes(crashNeedle) && src.includes(switchNeedle), "入口形态变了 ⇒ 本用例的两处注入点要跟着挪");
      writeFileSync(
        entry,
        src
          // ① 在钩子装好后排一次异步抛（不经由 main() 的 rejection ⇒ 走 uncaughtException 通道）
          .replace(crashNeedle, `${crashNeedle}\n    setTimeout(() => { throw new Error("BD19 构造的异步崩溃"); }, 0);`)
          // ② 抑制「切正常日志」那一步 ⇒ 逼这条记录只能落 fatal 文件（副本内改动，真 dist 不碰）
          .replace(switchNeedle, "// 用例抑制：保持 logger 未就绪"),
        "utf8",
      );
    },
    { configFor: (root) => JSON.stringify({ port, host: "127.0.0.1", machineDist: root }) },
  );
  try {
    assert.equal(r.status, 1);
    // 阶段取决于 0ms 定时器与 listen 回调谁先（两种都是「启动段没走完」），只钉它必须是已登记的启动段之一
    assert.match(r.fatal ?? "", /启动阶段 = (HTTP 监听|pidfile 写入) · 来源 = uncaughtException/);
    assert.match(r.fatal ?? "", /BD19 构造的异步崩溃/);
    assert.doesNotMatch(r.stderr, /\[fatal\]/, "fatal 文件与正常日志**不双写**（就绪前只落文件）");
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("BD19-② 真机 unhandledRejection 钩子：logger 就绪前的未接住 rejection ⇒ 落 fatal 文件（来源 = unhandledRejection）并退 1", async () => {
  const port = await freePort();
  const r = runCopy(
    (root) => {
      const entry = join(root, "dist", "index.js");
      const src = readFileSync(entry, "utf8");
      const crashNeedle = "installBootstrapGuards();";
      const switchNeedle = "fatal.markLoggerReady();";
      assert.ok(src.includes(crashNeedle) && src.includes(switchNeedle), "入口形态变了 ⇒ 本用例的两处注入点要跟着挪");
      writeFileSync(
        entry,
        src
          // ① 钩子装好后排一次**只 reject 不 catch** 的 promise（main() 那条 .catch 接不到它）
          //    —— 经 setTimeout 推到下一个宏任务：同步 reject 会等整个 main() 跑完才触发钩子，
          //       那时 pidfile 已写、监听已成，钉不到「死在启动段」这一形态
          .replace(crashNeedle, `${crashNeedle}\n    setTimeout(() => { Promise.reject(new Error("BD19 构造的 rejection")); }, 0);`)
          // ② 抑制「切正常日志」⇒ 逼这条记录只能落 fatal 文件（副本内改动，真 dist 不碰）
          .replace(switchNeedle, "// 用例抑制：保持 logger 未就绪"),
        "utf8",
      );
    },
    { configFor: (root) => JSON.stringify({ port, host: "127.0.0.1", machineDist: root }) },
  );
  try {
    assert.equal(r.status, 1, "装了钩子后「退 1」必须显式补回来（rejection 通道与 exception 通道同判据）");
    assert.match(r.fatal ?? "", /来源 = unhandledRejection/, "钩子确实挂上了 rejection 通道");
    assert.match(r.fatal ?? "", /BD19 构造的 rejection/);
    assert.match(r.fatal ?? "", /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[error\] \[fatal\] /m);
    // 时序注：unhandledRejection 在当前宏任务尾才触发 ⇒ 慢一步时 main() 已跑完（pidfile 可能已写）；
    // 「不写 pidfile」是崩在监听**之前**那条通道（main() 同步抛）判据，本用例只钉 rejection 通道本身。
    assert.match(r.fatal ?? "", /启动阶段 = /, "记录必须带启动阶段（死在哪一步的事实源）");
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("BD19-② boardctl 输出面：fatal 存在 ⇒ 打尾部并点名路径；不存在 / deps 未注入 ⇒ 一字不出（不造噪音）", () => {
  const dir = tmp();
  const path = join(dir, "board.fatal.log");
  const lines = [];
  const realError = console.error;
  try {
    console.error = (msg) => lines.push(String(msg));
    assert.equal(printFatalTail({ fatalLogPath: path }, 5), false, "文件不存在 ⇒ 不打印");
    writeFileSync(path, "旧的一行\n[2026-09-25T01:00:00.000Z] [error] [fatal] 启动阶段 = 配置加载\n", "utf8");
    assert.equal(printFatalTail({ fatalLogPath: path }, 5), true);
    const text = lines.join("\n");
    assert.match(text, /启动期致命日志尾部 5 行（/);
    assert.ok(text.includes(path), "文案必须点名文件路径（用户据此直接打开它）");
    assert.match(text, /\[fatal\] 启动阶段 = 配置加载/);
    assert.equal(printFatalTail({}, 5), false, "老 deps 没这个键 ⇒ 静默跳过（不抛）");
  } finally {
    console.error = realError;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ④ 致命记录器纯函数面
// ---------------------------------------------------------------------------

test("BD19-④ 缺省落点 = <板根>/.a2a/logs/board.fatal.log（与 board.log 同目录）", () => {
  assert.equal(defaultFatalLogPath("/x/board"), join("/x/board", ".a2a", "logs", "board.fatal.log"));
});

test("BD19-④ 记录器：logger 就绪前落 fatal 文件（同步、含阶段与堆栈）；就绪后切正常日志且**不双写**", () => {
  const dir = tmp();
  const file = join(dir, "logs", "board.fatal.log");
  const consoleLines = [];
  const rec = createFatalRecorder({
    file,
    now: () => new Date("2026-09-25T01:02:03.004Z"),
    consoleWrite: (line) => consoleLines.push(line),
  });
  try {
    assert.equal(rec.phase(), "模块加载", "未打点时的初值（入口 import 完立刻改）");
    rec.setPhase("HTTP 监听");
    assert.equal(
      rec.record("main()", new Error("boom")),
      "fatal-log",
    );
    const raw = readFileSync(file, "utf8");
    assert.ok(
      raw.startsWith("[2026-09-25T01:02:03.004Z] [error] [fatal] 启动阶段 = HTTP 监听 · 来源 = main()\nError: boom\n"),
      `首行 = ISO 时间戳 + [tag] + [fatal] + 阶段 + 来源，实际：${JSON.stringify(raw.slice(0, 120))}`,
    );
    assert.match(raw, /at .*bd19-stop-exit\.test\.mjs/, "必须带堆栈（只有一行 message 定位不到落点）");
    assert.deepEqual(consoleLines, [], "就绪前不碰正常日志（那正是它不可用的年代）");

    rec.markLoggerReady();
    assert.equal(rec.loggerReady(), true);
    assert.equal(rec.record("uncaughtException", "字符串原因"), "normal-log");
    assert.equal(readFileSync(file, "utf8"), raw, "就绪后**不再**开 fatal 文件（同一堆栈不落两份）");
    assert.deepEqual(consoleLines, ["[fatal] 启动阶段 = 运行期（logger 已就绪） · 来源 = uncaughtException\n字符串原因\n"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BD19-④ 记录器自身绝不抛：fatal 写不进 ⇒ 回落正常日志；两条通道都写不进 ⇒ 如实报 lost（入口据此再出声）", () => {
  const boom = () => {
    throw new Error("只读盘");
  };
  const sunk = createFatalRecorder({
    file: "X:/nope/board.fatal.log",
    makeDir: boom,
    consoleWrite: () => undefined,
  });
  assert.equal(sunk.record("main()", new Error("boom")), "normal-log", "写盘失败（含建目录失败）⇒ 回落日志，不抛");
  const lost = createFatalRecorder({
    file: "X:/nope/board.fatal.log",
    append: boom,
    consoleWrite: boom,
  });
  assert.equal(lost.record("main()", new Error("boom")), "lost");
  assert.equal(lost.record("main()", null), "lost", "原因非 Error（null / 字符串）也照落，不炸在格式化上");
});
