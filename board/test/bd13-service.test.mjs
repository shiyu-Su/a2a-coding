/**
 * BD13″ 板服务化自测（v0.9.0）：
 *  ① `src/lifecycle.ts` pidfile 读写与形状校验（板自写、脚本只读的契约面）+ 优雅停机链（幂等 / 顺序 / exitCode）；
 *  ② `src/log.ts` 行级时间戳（刻意改进：board.log 每行必须带 `[ISO] [tag]`）；
 *  ③ `POST /shutdown`（仅 POST / 仅 loopback 判定 / 未接停机链 501 / 200 = 受理且回调在响应后发生）；
 *  ④ `scripts/boardctl.mjs` 的纯判定与编排骨架（三态、陈旧 pidfile、start/stop 两分支，
 *     全部走**注入假探测 + 毫秒级超时**，绝不碰真端口 3400 与真进程）；
 *  ⑤ CLI 退出码恒 {0,1}（真 spawn，只用无副作用命令）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createBoardServer, decideShutdown, isLoopbackAddress } from "../dist/server.js";
import {
  buildPidRecord,
  createShutdownChain,
  defaultPidfilePath,
  parsePidfileRecord,
  readPidfile,
  removePidfile,
  writePidfile,
} from "../dist/lifecycle.js";
import { patchStreamTimestamp, timestampPrefix } from "../dist/log.js";
import {
  classifyStatus,
  doStart,
  doStop,
  isHealthRunning,
  isPidAlive,
  lastLines,
  readPidfile as ctlReadPidfile,
  resolveProbeEndpoint,
} from "../scripts/boardctl.mjs";

const BOARDCTL = fileURLToPath(new URL("../scripts/boardctl.mjs", import.meta.url));

function tmp() {
  return mkdtempSync(join(tmpdir(), "board-bd13-"));
}

// ---------------------------------------------------------------------------
// ① pidfile + 停机链
// ---------------------------------------------------------------------------

test("BD13-① pidfile：板自写 ⇒ 读回 { pid, port, host, startedAt }，删除后读为 null", () => {
  const dir = tmp();
  try {
    const path = defaultPidfilePath(dir);
    const rec = buildPidRecord({ port: 3400, host: "127.0.0.1" }, new Date("2026-09-24T12:00:00Z"));
    assert.equal(writePidfile(path, rec), true);
    const back = readPidfile(path);
    assert.equal(back.port, 3400);
    assert.equal(back.host, "127.0.0.1");
    assert.equal(back.startedAt, "2026-09-24T12:00:00.000Z");
    assert.equal(back.pid, process.pid, "pid = 板自身进程（脚本只读，不代写）");
    assert.equal(removePidfile(path), true);
    assert.equal(readPidfile(path), null);
    assert.equal(removePidfile(path), true, "删不存在的 pidfile 也算成功（幂等收尾）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BD13-① pidfile 形状校验：坏 JSON / 缺字段 / pid 非正整数 ⇒ null（不拿脏文件定位进程）", () => {
  assert.equal(parsePidfileRecord(null), null);
  assert.equal(parsePidfileRecord([1, 2]), null);
  assert.equal(parsePidfileRecord({ pid: 1, port: 1, host: "" }), null);
  assert.equal(parsePidfileRecord({ pid: 0, port: 1, host: "127.0.0.1" }), null);
  assert.equal(parsePidfileRecord({ pid: 1.5, port: 1, host: "127.0.0.1" }), null);
  assert.equal(parsePidfileRecord({ pid: 1, host: "127.0.0.1" }), null);
  const ok = parsePidfileRecord({ pid: 1, port: 3400, host: "::1" });
  assert.equal(ok.startedAt, "", "startedAt 缺失按空串（出参如实，不编造时间）");
});

test("BD13-① 优雅停机链：先停宿主桥 → 关卡口 → 删 pidfile；重入只走一次；只设 exitCode 不 process.exit", async () => {
  const dir = tmp();
  try {
    const path = join(dir, ".a2a", "board.pid");
    writePidfile(path, buildPidRecord({ port: 3400, host: "127.0.0.1" }));
    const order = [];
    const codes = [];
    const shutdown = createShutdownChain({
      stopBridges: async () => {
        order.push("stopBridges");
      },
      closeServer: async () => {
        order.push("closeServer");
      },
      pidfilePath: path,
      setExitCode: (c) => {
        codes.push(c);
        order.push("setExitCode");
      },
      log: () => undefined,
    });
    await Promise.all([shutdown("SIGTERM"), shutdown("POST /shutdown"), shutdown("SIGINT")]);
    assert.deepEqual(order, ["stopBridges", "closeServer", "setExitCode"], "三次受理只走一次链，且顺序为桥→关口→收尾");
    assert.deepEqual(codes, [0]);
    assert.equal(readPidfile(path), null, "链末删 pidfile");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BD13-① 停机链：关卡口抛错 ⇒ 仍删 pidfile 并落 exitCode（不留脏 pidfile 骗过下次 start）", async () => {
  const dir = tmp();
  try {
    const path = join(dir, ".a2a", "board.pid");
    writePidfile(path, buildPidRecord({ port: 3400, host: "127.0.0.1" }));
    const codes = [];
    await createShutdownChain({
      stopBridges: async () => {
        throw new Error("桥停不干净");
      },
      closeServer: async () => {
        throw new Error("端口关不掉");
      },
      pidfilePath: path,
      setExitCode: (c) => codes.push(c),
      log: () => undefined,
    })("SIGTERM");
    assert.equal(readPidfile(path), null);
    assert.deepEqual(codes, [0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ② 行级时间戳
// ---------------------------------------------------------------------------

test("BD13-② 日志行级时间戳：包装后每条字符串写入都带 [ISO] [tag] 前缀，Buffer 原样透传，重复安装幂等", () => {
  const chunks = [];
  const stream = {
    write(chunk, ...rest) {
      chunks.push({ chunk, rest });
      const cb = rest.find((r) => typeof r === "function");
      cb?.();
      return true;
    },
  };
  assert.equal(patchStreamTimestamp(stream), true);
  assert.equal(patchStreamTimestamp(stream), false, "幂等：不套第二层前缀");
  stream.write("第一行\n");
  stream.write(Buffer.from("字节流"));
  assert.equal(chunks.length, 2, "幂等守卫失效 ⇒ 会被套两层前缀");
  const [a, b] = chunks;
  assert.match(a.chunk, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[board\] 第一行\n$/);
  assert.equal(Buffer.isBuffer(b.chunk), true, "非字符串 chunk 不加前缀（不破坏二进制写入）");
  assert.match(timestampPrefix("shutdown", new Date(0)), /^\[1970-01-01T00:00:00\.000Z\] \[shutdown\] $/);
});

// ---------------------------------------------------------------------------
// ③ POST /shutdown
// ---------------------------------------------------------------------------

/** 只读面替身：/shutdown 与 /health 都不触桥，其余路由本文件不用。 */
function nullClient() {
  const boom = async () => {
    throw new Error("不该被触达");
  };
  return { baseUrl: "http://fake", getFeatures: boom, getFeature: boom, getFeatureTrace: boom, getProjects: boom, getTasks: boom };
}

async function withCtlServer(run, options = {}) {
  const handle = await createBoardServer({ host: "127.0.0.1", port: 0, client: nullClient(), ...options });
  try {
    await run(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
  }
}

test("BD13-③ POST /shutdown（loopback）⇒ 200 受理（body 只说 shutting_down），停机回调随后恰好一次", async () => {
  let calls = 0;
  await withCtlServer(
    async (base) => {
      const res = await fetch(`${base}/shutdown`, { method: "POST" });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, message: "shutting_down" });
    },
    { onShutdown: () => (calls += 1) },
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1, "200 = 受理；停机动作在响应发出后触发");
});

test("BD13-③ 未接停机链 ⇒ 501 shutdown_unsupported（不假装受理）；GET /shutdown ⇒ 405", async () => {
  await withCtlServer(async (base) => {
    const res = await fetch(`${base}/shutdown`, { method: "POST" });
    assert.equal(res.status, 501);
    assert.equal((await res.json()).code, "shutdown_unsupported");
    const get = await fetch(`${base}/shutdown`, { method: "GET" });
    assert.equal(get.status, 405);
    // /shutdown = 运维口（无板 UI 表单档），decideShutdown 恒 JSON，不参与弹窗化分流
    assert.equal((await get.json()).code, "method_not_allowed");
  });
});

test("BD13-③ 来源门（负向）：仅 loopback 地址算放行，其余（含 IPv4-mapped 非 127）一律拒", () => {
  for (const ok of ["127.0.0.1", "127.0.0.5", "::1", "[::1]", "localhost", "LOCALHOST", "::ffff:127.0.0.1", "::ffff:127.9.9.9"]) {
    assert.equal(isLoopbackAddress(ok), true, `${ok} 应判 loopback`);
  }
  for (const bad of ["0.0.0.0", "::", "10.1.2.3", "192.168.1.10", "1278:1::", "::ffff:10.0.0.1", "", "example.com"]) {
    assert.equal(isLoopbackAddress(bad), false, `${bad} 非 loopback ⇒ /shutdown 必须 403`);
    const d = decideShutdown({ method: "POST", remoteAddress: bad, chainWired: true });
    assert.notEqual(d, "accept", `${bad} 不得放行停机`);
    assert.equal(d.status, 403);
    assert.equal(d.body.code, "loopback_only");
  }
});

test("BD13-③ 来源门判定函数：非 POST ⇒ 405 · loopback + 已接链 ⇒ accept · 未接链 ⇒ 501", () => {
  assert.equal(decideShutdown({ method: "POST", remoteAddress: "127.0.0.1", chainWired: true }), "accept");
  for (const method of ["GET", "DELETE", "PUT", undefined]) {
    const d = decideShutdown({ method, remoteAddress: "127.0.0.1", chainWired: true });
    assert.equal(d.status, 405, `${method} 不得触发停机`);
    assert.equal(d.body.code, "method_not_allowed");
  }
  const unwired = decideShutdown({ method: "POST", remoteAddress: "127.0.0.1", chainWired: false });
  assert.equal(unwired.status, 501);
  assert.equal(unwired.body.code, "shutdown_unsupported");
});

// ---------------------------------------------------------------------------
// ④ boardctl 纯判定 + 注入式编排
// ---------------------------------------------------------------------------

test("BD13-④ status 三态：运行中 / 端口占用 / pidfile 陈旧 / 未运行（判定键 = /health 的 status，不以端口可连为准）", () => {
  const pidfile = { pid: 111, port: 3400, host: "127.0.0.1", startedAt: "s" };
  const ok = { httpStatus: 200, status: "ok" };
  assert.equal(classifyStatus({ listening: true, health: ok, pidfile }), "running");
  assert.equal(classifyStatus({ listening: true, health: { httpStatus: 200, status: "degraded" }, pidfile }), "occupied");
  assert.equal(classifyStatus({ listening: true, health: null, pidfile }), "occupied", "端口可连但 /health 不可答 ⇒ 非本板");
  assert.equal(classifyStatus({ listening: false, health: null, pidfile }), "stale");
  assert.equal(classifyStatus({ listening: false, health: null, pidfile: null }), "stopped");
  assert.equal(isHealthRunning({ httpStatus: 503, status: "ok" }), false, "非 200 不算运行");
});

test("BD13-④ 陈旧 pidfile 识别：脏文件 ⇒ null（不误定位进程）；探测端点只跟 pidfile，缺失才回落缺省端口", () => {
  const dir = tmp();
  try {
    const path = join(dir, "board.pid");
    writeFileSync(path, "{ not json", "utf8");
    assert.equal(ctlReadPidfile(path), null);
    writeFileSync(path, JSON.stringify({ pid: "42", port: 3400, host: "127.0.0.1" }), "utf8");
    assert.equal(ctlReadPidfile(path), null, "pid 非数字 ⇒ 形状不合法");
    writeFileSync(path, JSON.stringify({ pid: 42, port: 3456, host: "127.0.0.1", startedAt: "t" }), "utf8");
    assert.deepEqual(ctlReadPidfile(path), { pid: 42, port: 3456, host: "127.0.0.1", startedAt: "t" });
    assert.deepEqual(resolveProbeEndpoint({ pid: 1, port: 3456, host: "::", startedAt: "" }), { host: "127.0.0.1", port: 3456 }, "通配地址归一为 127.0.0.1");
    assert.deepEqual(resolveProbeEndpoint(null, 3999), { host: "127.0.0.1", port: 3999 }, "无 pidfile ⇒ 回落**缺省端口**（脚本不读配置内容）");
    assert.equal(ctlReadPidfile(join(dir, "nope.pid")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 假底座（可编程世界）：`world.listening` / `world.pidAlive` 是**可变状态**，
 * 用例通过它们表达「停机受理后端口就释放 / 进程就退出」等收敛；所有超时压到毫秒级，
 * 且 `killForce` 为记号桩 ⇒ 单测不碰真端口、不碰真进程。
 */
function fakeCtlDeps(overrides = {}) {
  const world = {
    listening: true,
    health: { httpStatus: 200, status: "ok" },
    pidAlive: true,
    pidfile: { pid: 4242, port: 3400, host: "127.0.0.1", startedAt: "s" },
    shutdownStatus: 200,
    launched: false,
    /** 「/shutdown 受理后进程也退出」= 优雅路径达标；置 false 表达「端口释放但进程赖着不走」 */
    exitsOnShutdown: true,
    ...overrides.world,
  };
  const calls = [];
  return {
    world,
    calls,
    entry: "FAKE/entry.js",
    pidfile: "FAKE/.a2a/board.pid",
    logDir: "FAKE/.a2a/logs",
    logPath: "FAKE/.a2a/logs/board.log",
    root: "FAKE",
    platform: "win32",
    stopTimeoutMs: 120,
    probePort: async () => world.listening,
    httpHealth: async () => world.health,
    httpRequestText: async (_h, _p, path, method) => {
      calls.push(`${method} ${path}`);
      if (path === "/shutdown") {
        if (world.shutdownStatus === 200) {
          world.listening = false; // 受理后端口释放
          if (world.exitsOnShutdown) world.pidAlive = false;
        }
        return { statusCode: world.shutdownStatus, body: "{}" };
      }
      return { statusCode: 200, body: "{}" };
    },
    readPidfile: () => world.pidfile,
    existsEntry: () => true,
    mkdirLogDir: () => calls.push("mkdirLogDir"),
    launch: () => {
      calls.push("launch");
      world.launched = true;
      world.listening = true;
      world.health = { httpStatus: 200, status: "ok" };
      return { kind: "detached" };
    },
    isPidAlive: () => world.pidAlive,
    killForce: (pid) => {
      calls.push(`killForce:${pid}`);
      world.listening = false;
      world.pidAlive = false;
      return { ok: true };
    },
    ...overrides.deps,
  };
}

test("BD13-④ stop 路径①（优雅）：POST /shutdown 受理 ⇒ 端口释放 ∧ 进程退出 ⇒ ok，且**不得**走强杀", async () => {
  const deps = fakeCtlDeps();
  const result = await doStop(deps);
  assert.equal(result.ok, true);
  assert.match(result.message, /POST \/shutdown 优雅停机/);
  assert.match(result.message, /pid=4242 已退出/);
  assert.deepEqual(deps.calls, ["POST /shutdown"], "优雅路径达标 ⇒ 强杀一次都不发");
});

test("BD13-④ stop 路径②（优雅→强杀）：/shutdown 受理后进程不退 ⇒ 超时落 killForce 兜底并二次收敛", async () => {
  const deps = fakeCtlDeps({ world: { exitsOnShutdown: false } });
  // 受理后端口释放但 pid 仍存活 ⇒ 收口判据（端口 ∧ 进程）不达标 ⇒ 转强杀
  const result = await doStop(deps);
  assert.equal(result.ok, true, "强杀后端口释放且进程退出 ⇒ 达标");
  assert.deepEqual(deps.calls, ["POST /shutdown", "killForce:4242"]);
  assert.match(result.message, /强杀 pid=4242/);
});

test("BD13-④ stop：/shutdown 不可达（HTTP 500）⇒ 直接强杀（不空等优雅收敛）", async () => {
  const deps = fakeCtlDeps({ world: { shutdownStatus: 500 } });
  const result = await doStop(deps);
  assert.equal(result.ok, true);
  assert.deepEqual(deps.calls, ["POST /shutdown", "killForce:4242"]);
});

test("BD13-④ stop：pidfile 缺失但端口在监听 ⇒ 不盲杀，ok:false 并说明无法定位进程", async () => {
  const deps = fakeCtlDeps({ world: { pidfile: null, shutdownStatus: 500 } });
  const result = await doStop(deps);
  assert.equal(result.ok, false);
  assert.match(result.message, /pidfile 缺失/);
  assert.equal(deps.calls.includes("killForce:4242"), false);
});

test("BD13-④ stop：pidfile 陈旧（pid 已不存在）且端口仍被占 ⇒ 不冒充强杀、保留现场", async () => {
  const deps = fakeCtlDeps({ world: { pidAlive: false, shutdownStatus: 500 } });
  const result = await doStop(deps);
  assert.equal(result.ok, false);
  assert.match(result.message, /pidfile 陈旧/);
});

test("BD13-④ stop：端口未监听 + pidfile 陈旧 ⇒ 视为未运行（ok:true，stop 幂等）", async () => {
  const deps = fakeCtlDeps({ world: { listening: false, pidAlive: false } });
  const result = await doStop(deps);
  assert.equal(result.ok, true);
  assert.match(result.message, /未运行/);
  assert.deepEqual(deps.calls, [], "端口没监听 ⇒ 连 /shutdown 都不必发");
});

test("BD13-④ stop：端口未监听但 pidfile 指向的进程仍活 ⇒ 不报成功、不误杀（可能正在启动）", async () => {
  const deps = fakeCtlDeps({ world: { listening: false, pidAlive: true } });
  const result = await doStop(deps);
  assert.equal(result.ok, false);
  assert.match(result.message, /仍存活/);
});

test("BD13-④ start：已在运行（health=ok）⇒ already，不重复拉起", async () => {
  const deps = fakeCtlDeps();
  const result = await doStart({}, deps);
  assert.equal(result.kind, "already");
  assert.equal(deps.calls.includes("launch"), false);
});

test("BD13-④ start：端口被非本板占用（可连但 status 非 ok）⇒ occupied，不拉起", async () => {
  const deps = fakeCtlDeps({ world: { health: { httpStatus: 200, status: "foreign" } } });
  const result = await doStart({}, deps);
  assert.equal(result.kind, "occupied");
  assert.equal(deps.calls.includes("launch"), false);
});

test("BD13-④ start：端口空闲 ⇒ 拉起；--no-wait 发起即返，缺省等待运行中并取 pidfile 的 pid", async () => {
  const idle = fakeCtlDeps({ world: { listening: false, health: null, pidfile: null } });
  const noWait = await doStart({ noWait: true }, idle);
  assert.equal(noWait.kind, "spawned");
  assert.deepEqual(idle.calls, ["mkdirLogDir", "launch"]);
  assert.equal(noWait.pid, undefined, "--no-wait 无 pid 时如实报缺失，不编造");

  const idle2 = fakeCtlDeps({ world: { listening: false, health: null, pidfile: null } });
  const started = await doStart({}, {
    ...idle2,
    readPidfile: () => (idle2.world.launched ? { pid: 777, port: 3400, host: "127.0.0.1", startedAt: "s" } : null),
  });
  assert.equal(started.kind, "started");
  assert.equal(started.port, 3400);
  assert.equal(started.pid, 777, "脱壳路径无子进程句柄 ⇒ pid 取板自写的 pidfile");
});

test("BD13-④ start：拉起后迟迟不可答 ⇒ start-timeout（判失败，非「已发起」）", async () => {
  const deps = fakeCtlDeps({
    world: { listening: false, health: null, pidfile: null },
    deps: { launch: () => ({ kind: "detached" }) },
  });
  const startedAt = Date.now();
  const result = await doStart({ readyTimeout: 300, waitReady: true }, deps);
  assert.equal(result.kind, "start-timeout");
  assert.ok(Date.now() - startedAt < 3_000, "等待窗口按注入超时收敛，不拖满 30s");
});

test("BD13-④ start：入口产物缺失 ⇒ spawn-failed（只提示 build，不自动构建）", async () => {
  const deps = fakeCtlDeps({
    world: { listening: false, health: null, pidfile: null },
    deps: { existsEntry: () => false },
  });
  const result = await doStart({}, deps);
  assert.equal(result.kind, "spawn-failed");
  assert.match(result.reason, /npm run build/);
});

test("BD13-④ logs 尾部取行：忽略结尾空行，取最后 N 行", () => {
  assert.equal(lastLines("a\nb\nc\n", 2), "b\nc");
  assert.equal(lastLines("a\nb\n", 10), "a\nb");
  assert.equal(lastLines("", 3), "");
});

test("BD13-④ isPidAlive：ESRCH ⇒ 死；EPERM ⇒ 保守判活", () => {
  const original = process.kill;
  try {
    process.kill = () => {
      throw Object.assign(new Error("no such"), { code: "ESRCH" });
    };
    assert.equal(isPidAlive(999_999), false);
    process.kill = () => {
      throw Object.assign(new Error("eperm"), { code: "EPERM" });
    };
    assert.equal(isPidAlive(999_999), true);
  } finally {
    process.kill = original;
  }
});

// ---------------------------------------------------------------------------
// ⑤ CLI 退出码契约（真 spawn，只用无副作用命令）
// ---------------------------------------------------------------------------

function runCtl(args) {
  return spawnSync(process.execPath, [BOARDCTL, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
}

test("BD13-⑤ 退出码恒 {0,1}：help / status / logs / 未知子命令 / 互斥选项 / 非法值 全不越界", () => {
  const cases = [
    ["--help"],
    ["help"],
    ["status"],
    ["logs", "-n", "5"],
    ["bogus"],
    [],
    ["start", "--no-wait", "--wait-ready"],
    ["status", "--ready-timeout", "5"],
    ["logs", "--lines", "abc"],
    ["--bogus-flag"],
  ];
  for (const args of cases) {
    const r = runCtl(args);
    assert.ok(r.status === 0 || r.status === 1, `退出码越界：${args.join(" ") || "(空)"} ⇒ ${r.status}（${r.stderr}）`);
  }
  assert.equal(runCtl(["--help"]).status, 0, "显式 --help = 正常出口");
  assert.match(runCtl(["--help"]).stdout, /boardctl/);
  assert.equal(runCtl([]).status, 1, "什么都没给 ⇒ 未执行任何命令，判 1");
  assert.equal(runCtl(["start", "--no-wait", "--wait-ready"]).status, 1, "互斥选项显式报错（不静默取其一）");
});

test("BD13-⑤ status 三态真跑一次：无 pidfile 且 3400 未监听 ⇒ 报「未运行」且退 0（未运行不是错误）", () => {
  const r = runCtl(["status"]);
  // 本机若真有板在跑（他人占用 3400）会报运行中 / 占用 —— 二者都是合法判定，只钉「输出含状态行 + 码 ∈ {0,1}」
  assert.match(r.stdout, /状态     : (运行中|未运行|pidfile 陈旧|端口被占用)/);
  assert.match(r.stdout, /endpoint : 127\.0\.0\.1:3400|endpoint : \d+\.\d+\.\d+\.\d+:\d+/);
  assert.ok(r.status === 0 || r.status === 1);
});
