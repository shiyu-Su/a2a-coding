/**
 * M2 定向单测（REQ-v0.8.2 · A4/B4）—— `resolveSpawnCommand`：命令别名 / PATHEXT 候选补全。
 *
 * 探针实证（P1 第 5 项，本机 win32 + shell:false）：
 * - `.cmd`/`.bat` 绝对路径直调 ⇒ **EINVAL**（抛出）；
 * - 裸命令名仅存 `.cmd` 壳 ⇒ **ENOENT**；
 * ⇒ B4 退化成立：**候选只补 `.exe`**（本文件以「只命中 `.exe`、`.cmd`/`.ps1` 不入候选」锁定）。
 *
 * 判据：命中 PATHEXT 候选 / 绝对路径与已带（非拒绝）扩展名不变 / 显式 `.cmd`/`.bat`/`.ps1` ⇒ 明确报错 /
 * 候选全不命中 ⇒ 原样返回（保持现状 ENOENT 失败路径）。
 * win32 语义经 deps 注入（platform/env/isFile）在任意宿主平台可测；真实 spawn 用例仅 win32 执行。
 *
 * 运行：`npm test`。
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpError, createNodeAcpSpawn, resolveSpawnCommand } from "../acp-bridge/acp/client.js";

const DIR = mkdtempSync(join(tmpdir(), "a2a-acp-m2-"));
after(() => {
  rmSync(DIR, { recursive: true, force: true });
});

function winEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  return { PATHEXT: ".COM;.EXE;.BAT;.CMD", ...env } as NodeJS.ProcessEnv;
}

/** 以注入文件系统判据的 win32 解析（files = 存在集，比较用小写全路径）。 */
function win32Resolve(
  command: string,
  opts: { env: Record<string, string>; files?: Set<string>; cwd?: string },
): string {
  const present = opts.files ?? new Set<string>();
  return resolveSpawnCommand(command, {
    platform: "win32",
    cwd: opts.cwd ?? "C:\\work",
    env: winEnv(opts.env),
    isFile: (candidate) => present.has(candidate.toLowerCase()),
  });
}

test("POSIX ⇒ 一律原样返回（PATHEXT 为 Windows 专属，不做候选检索）", () => {
  for (const platform of ["linux", "darwin"] as const) {
    for (const command of ["qoderclicn", "C:\\tools\\qoderclicn", "./bin/tool", "tool.cmd", ""]) {
      assert.equal(
        resolveSpawnCommand(command, {
          platform,
          env: { PATH: "/usr/bin", PATHEXT: ".EXE" },
          isFile: () => true,
        }),
        command,
      );
    }
  }
});

test("绝对路径不动（.exe / 无扩展名 / UNC）", () => {
  const cases: Array<[string, Record<string, string>, Set<string>]> = [
    ["C:\\bin\\qoderclicn.exe", { PATH: "C:\\bin" }, new Set(["c:\\bin\\qoderclicn.exe"])],
    ["C:\\bin\\qoderclicn", { PATH: "C:\\bin" }, new Set(["c:\\bin\\qoderclicn.exe"])],
    ["\\\\srv\\share\\tool", {}, new Set(["\\\\srv\\share\\tool.exe"])],
  ];
  for (const [command, env, files] of cases) {
    assert.equal(win32Resolve(command, { env, files }), command, command);
  }
});

test("显式 .cmd/.bat/.ps1（含绝对路径）⇒ 明确报错，不喂给 spawn；其它扩展名不动", () => {
  const rejected: string[] = [
    "C:\\npm\\opencode.cmd",
    "opencode.cmd",
    "C:\\npm\\INSTALL.BAT",
    "tool.ps1",
  ];
  for (const command of rejected) {
    assert.throws(
      () => resolveSpawnCommand(command, { platform: "win32", cwd: "C:\\work", env: winEnv({ PATH: "C:\\npm" }), isFile: () => true }),
      (err: unknown) =>
        err instanceof AcpError &&
        err.kind === "spawn" &&
        /\.exe 真身的绝对路径/.test(err.message),
      command,
    );
  }
  // 已带非拒绝扩展名（.exe/.com）⇒ 一律不动
  assert.equal(win32Resolve("qoderclicn.EXE", { env: {}, files: new Set() }), "qoderclicn.EXE");
  assert.equal(win32Resolve("tool.com", { env: {}, files: new Set() }), "tool.com");
});

test("裸命令名命中候选：cwd 优先 → PATH 目录序；候选集退化为只 .exe", () => {
  // cwd 有 qoderclicn.exe ⇒ 取 cwd（PATH 上的同名者不参与）
  assert.equal(
    win32Resolve("qoderclicn", {
      env: { PATH: "C:\\other" },
      files: new Set(["c:\\work\\qoderclicn.exe", "c:\\other\\qoderclicn.exe"]),
    }),
    "C:\\work\\qoderclicn.exe",
  );
  // cwd 无 ⇒ 按 PATH 目录序取第一个命中（C:\\a 在 C:\\b 之前）
  assert.equal(
    win32Resolve("opencode", {
      env: { PATH: "C:\\a;C:\\b" },
      files: new Set(["c:\\b\\opencode.exe", "c:\\a\\opencode.exe"]),
    }),
    "C:\\a\\opencode.exe",
  );
  // 退化锁定：仅 .cmd/.ps1 壳存在 ⇒ 不入候选（shell:false EINVAL 实证），原样返回保持现状 ENOENT
  assert.equal(
    win32Resolve("opencode", {
      env: { PATH: "C:\\npm" },
      files: new Set(["c:\\npm\\opencode.cmd", "c:\\npm\\opencode.ps1"]),
    }),
    "opencode",
  );
  // PATHEXT 不含 .EXE ⇒ 无候选可补，原样返回
  assert.equal(
    win32Resolve("tool", {
      env: { PATH: "C:\\bin", PATHEXT: ".CMD;.BAT" },
      files: new Set(["c:\\bin\\tool.exe"]),
    }),
    "tool",
  );
});

test("相对路径（带目录）：仅检索自身目录（对齐 CreateProcess，不并入 PATH），返回绝对路径", () => {
  assert.equal(
    win32Resolve("bin\\tool", {
      env: { PATH: "C:\\other" },
      files: new Set(["c:\\work\\bin\\tool.exe"]),
    }),
    "C:\\work\\bin\\tool.exe",
  );
  // 同名 .exe 只在 PATH 目录里 ⇒ 不命中（带目录的相对路径不查 PATH），原样返回
  assert.equal(
    win32Resolve("bin\\tool", {
      env: { PATH: "C:\\other" },
      files: new Set(["c:\\other\\bin\\tool.exe"]),
    }),
    "bin\\tool",
  );
});

test("候选全不命中 ⇒ 原样返回（失败路径与现状一致，不静默改写）", () => {
  assert.equal(
    win32Resolve("ghost", { env: { PATH: "C:\\a;.\\;C:\\b" }, files: new Set(["c:\\b\\ghost.cmd"]) }),
    "ghost",
  );
});

test("PATHEXT/PATH 缺省与容错：无 PATHEXT 视同 .EXE；引号/空白条目忽略；不检索 `.` 条目", () => {
  assert.equal(
    resolveSpawnCommand("tool", {
      platform: "win32",
      cwd: "C:\\work",
      env: { PATH: '"C:\\Program Files";  ; .; C:\\x' } as NodeJS.ProcessEnv,
      isFile: (c) => c.toLowerCase() === "c:\\program files\\tool.exe",
    }),
    "C:\\Program Files\\tool.exe",
  );
});

test("桥级逐字：现状可用形态（绝对路径 + 任意 args）command 零改写", () => {
  const abs = process.execPath;
  assert.equal(
    resolveSpawnCommand(abs, { platform: "win32", env: winEnv({ PATH: DIR }), isFile: () => true }),
    abs,
  );
  // 现状 spawn 的 argv 组装不受解析影响（args 原样透传由 createNodeAcpSpawn `[...args]` 保证，见 e2e/m1 断言）
});

test(
  "真实 spawn（win32）：裸 `node` 名解析命中后可起进程；不存在的命令仍走 ENOENT 失败路径",
  { skip: process.platform !== "win32" },
  async () => {
    const resolved = resolveSpawnCommand("node", { env: process.env, cwd: process.cwd() });
    const child = spawn(resolved, ["-e", ""], { stdio: "ignore", windowsHide: true });
    const code = await new Promise<number | null>((resolve, reject) => {
      const guard = setTimeout(() => reject(new Error("spawn 等待超时")), 15_000);
      child.on("error", (e) => {
        clearTimeout(guard);
        reject(e);
      });
      child.on("exit", (c) => {
        clearTimeout(guard);
        resolve(c);
      });
    });
    assert.equal(code, 0, `node 裸名解析=${resolved}`);

    const missing = resolveSpawnCommand("a2a-no-such-cmd-9f3c", { env: process.env, cwd: process.cwd() });
    assert.equal(missing, "a2a-no-such-cmd-9f3c");
    const ghost = spawn(missing, [], { stdio: "ignore", windowsHide: true });
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      ghost.on("error", (e) => resolve(e as NodeJS.ErrnoException));
      ghost.on("exit", () => resolve(null));
    });
    assert.equal(err?.code, "ENOENT");
  },
);

// ---- M4 断言收口：解析在 createNodeAcpSpawn 通道上的集成面（B4 纪律到 spawn 为止）----

test("M4 集成：createNodeAcpSpawn 显式 .cmd/.bat/.ps1 ⇒ 构造期同步抛 AcpError(spawn)，不喂任何 spawn", { skip: process.platform !== "win32" }, () => {
  for (const command of ["opencode.cmd", "C:\\npm\\install.bat", "tool.ps1"]) {
    assert.throws(
      () => createNodeAcpSpawn()(command, ["--acp"], { env: process.env }),
      (err: unknown) => err instanceof AcpError && err.kind === "spawn",
      command,
    );
  }
});

test("M4 集成：裸名命中 .exe 真身 ⇒ spawn 收改写后命令并可起进程；无匹配仍原样送（ENOENT 现状）", { skip: process.platform !== "win32" }, async () => {
  const child = createNodeAcpSpawn()("node", ["-e", ""], { env: process.env, cwd: process.cwd() });
  const code = await new Promise<number | null>((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error("spawn 等待超时")), 15_000);
    child.onExit((c) => {
      clearTimeout(guard);
      resolve(c);
    });
    child.onError((e) => {
      clearTimeout(guard);
      reject(e);
    });
  });
  assert.equal(code, 0, "裸 node 名经 PATH 解析出 .exe 真身后应可直调");

  const spawned = createNodeAcpSpawn()("a2a-no-such-cmd-m4", ["--acp"], { env: process.env, cwd: process.cwd() });
  const err = await new Promise<Error | null>((resolve) => {
    spawned.onError((e) => resolve(e));
    spawned.onExit(() => resolve(null));
  });
  assert.equal((err as NodeJS.ErrnoException | null)?.code, "ENOENT", "候选不命中 ⇒ 原样送，失败路径与现状一致");
});

test("M4 负向锚点（源码级）：createNodeAcpSpawn 的 spawn options 恒不含 shell（不退回 shell:true）", () => {
  // 运行时 = dist/test/*.js，源码在 machine 根（../../）
  const src = readFileSync(new URL("../../acp-bridge/acp/client.ts", import.meta.url), "utf8");
  const spawnCall = src.slice(src.indexOf("= spawn("), src.indexOf("});", src.indexOf("= spawn(")));
  assert.ok(spawnCall.length > 5, "应能定位 createNodeAcpSpawn 内的 spawn 调用");
  assert.ok(!/\bshell\s*:/.test(spawnCall), `spawn options 不得出现 shell 键：${spawnCall}`);
});
