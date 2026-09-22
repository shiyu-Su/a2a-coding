/**
 * `adapters/backend-entry.ts` 的**纯单测**（REQ-v0.8.6-2026-09-21-02 · B3）。
 *
 * 全部经 `deps` 注入（`isFile` / `readJson` / `npmRoots` / `platform` / `homedir` / `env`），
 * **不依赖真机装了没装包**。路径一律用与实现相同的 `node:path` 现算（`join` / `resolve`）再按
 * 分隔符归一比较，避免绑定宿主分隔符。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import {
  BACKEND_LOOKUP_BY_KIND,
  formatBackendProbe,
  requireBackendEntry,
  resolveBackendEntry,
  type BackendEntryDeps,
  type BackendEntryProbe,
} from "../adapters/backend-entry.js";
import type { AgentKind } from "../types.js";

/** 分隔符归一（win 反斜杠 → 正斜杠），使断言不绑定宿主。 */
function n(p: string): string {
  return p.replace(/\\/g, "/");
}

/** 注入式文件系统：`files` 为存在的真身绝对路径集；`jsons` 按 package.json 路径返回对象。 */
function makeDeps(files: string[], jsons: Record<string, unknown> = {}, rest: BackendEntryDeps = {}): BackendEntryDeps {
  const set = new Set(files.map(n));
  const byPath = new Map(Object.keys(jsons).map((k) => [n(k), jsons[k]] as const));
  return {
    isFile: (c: string) => set.has(n(c)),
    readJson: (f: string) => {
      const v = byPath.get(n(f));
      if (v === undefined) throw new Error("no package.json fixture: " + f);
      return v;
    },
    ...rest,
  };
}

/** 造一个 npm 包根命中素材：`binRel` 存在与否决定 `bin` 目标是否落盘。 */
function pkgFixture(
  root: string,
  pkg: string,
  json: Record<string, unknown>,
  binRel?: string,
): { files: string[]; jsons: Record<string, unknown>; binAbs?: string } {
  const pkgDir = join(root, ...pkg.split("/"));
  const pkgJsonPath = join(pkgDir, "package.json");
  const files = [pkgJsonPath];
  const jsons: Record<string, unknown> = { [pkgJsonPath]: json };
  let binAbs: string | undefined;
  if (binRel !== undefined) {
    binAbs = resolve(pkgDir, binRel);
    files.push(binAbs);
  }
  return { files, jsons, binAbs };
}

function mergeFixtures(...fx: { files: string[]; jsons: Record<string, unknown> }[]) {
  return {
    files: fx.flatMap((f) => f.files),
    jsons: Object.assign({}, ...fx.map((f) => f.jsons)),
  };
}

// ── `bin` 解析规则（§2.2）──────────────────────────────────────────────

test("bin 为字符串 ⇒ 直接取", () => {
  const root = "/npm";
  const fx = pkgFixture(
    root,
    "opencode-ai",
    { name: "opencode-ai", bin: "bin/opencode.exe" },
    "bin/opencode.exe",
  );
  const deps = makeDeps(fx.files, fx.jsons, {
    npmRoots: [root],
    machineModulesRoot: "/empty",
    platform: "linux",
  });
  const r = resolveBackendEntry("opencode", undefined, deps);
  assert.equal(n(r.command ?? ""), n(fx.binAbs ?? ""));
  assert.ok(r.probes.some((p) => p.layer === "L2-npm-global" && p.status === "hit"));
});

test("bin 为对象、单条目但 key 不匹配 ⇒ 宽容取唯一值并记 bin-key-mismatch", () => {
  const root = "/npm";
  // 包名 opencode-ai ⇒ unscoped 键应为 "opencode-ai"，但实际 key = "opencode"（单条目）。
  const fx = pkgFixture(
    root,
    "opencode-ai",
    { name: "opencode-ai", bin: { opencode: "bin/opencode.js" } },
    "bin/opencode.js",
  );
  const deps = makeDeps(fx.files, fx.jsons, { npmRoots: [root], machineModulesRoot: "/empty", platform: "linux" });
  const r = resolveBackendEntry("opencode", undefined, deps);
  assert.equal(n(r.command ?? ""), n(fx.binAbs ?? ""));
  const hit = r.probes.find((p) => p.status === "hit");
  assert.equal(hit?.note, "bin-key-mismatch");
});

test("bin 多条目且不匹配 unscoped ⇒ 判未命中（不猜）", () => {
  const root = "/npm";
  const realFx = pkgFixture(
    root,
    "@agentclientprotocol/codex-acp",
    { name: "@agentclientprotocol/codex-acp", bin: { "cli-a": "dist/a.js", "cli-b": "dist/b.js" } },
  );
  const deps = makeDeps(realFx.files, realFx.jsons, {
    npmRoots: [root],
    machineModulesRoot: "/empty",
    platform: "linux",
    env: {}, // PATH 空 ⇒ 不命中 L3
  });
  const r = resolveBackendEntry("codex", undefined, deps);
  assert.equal(r.command, undefined);
  const amb = r.probes.find((p) => p.note === "bin-ambiguous");
  assert.ok(amb, "expect a bin-ambiguous miss");
});

test("claude 的 bin ≠ main ⇒ 必须取 bin，绝不回退 main", () => {
  const root = "/npm";
  const fx = pkgFixture(
    root,
    "@agentclientprotocol/claude-agent-acp",
    {
      name: "@agentclientprotocol/claude-agent-acp",
      bin: { "claude-agent-acp": "dist/index.js" },
      main: "dist/lib.js",
    },
    "dist/index.js",
  );
  const deps = makeDeps(fx.files, fx.jsons, { npmRoots: [root], machineModulesRoot: "/empty", platform: "linux" });
  const r = resolveBackendEntry("claude", undefined, deps);
  assert.ok(r.command?.endsWith("index.js"), "must resolve bin (index.js)");
  assert.ok(!(r.command ?? "").includes("lib.js"), "must NOT fall back to main (lib.js)");
});

test("bin 值带 ./ 前缀 ⇒ resolve(pkgDir, value) 归一", () => {
  const root = "/npm";
  const fx = pkgFixture(
    root,
    "opencode-ai",
    { name: "opencode-ai", bin: { opencode: "./bin/opencode.exe" } },
    "bin/opencode.exe",
  );
  const deps = makeDeps(fx.files, fx.jsons, { npmRoots: [root], machineModulesRoot: "/empty", platform: "linux" });
  const r = resolveBackendEntry("opencode", undefined, deps);
  assert.equal(n(r.command ?? ""), n(fx.binAbs ?? ""));
});

test("win32 且 bin 目标为壳扩展名 ⇒ 记 rejected-shell、不作命中", () => {
  const root = "/npm";
  const fx = pkgFixture(
    root,
    "opencode-ai",
    { name: "opencode-ai", bin: { opencode: "bin/opencode.cmd" } },
    "bin/opencode.cmd",
  );
  const deps = makeDeps(fx.files, fx.jsons, { npmRoots: [root], machineModulesRoot: "/empty", platform: "win32", env: {} });
  const r = resolveBackendEntry("opencode", undefined, deps);
  assert.equal(r.command, undefined);
  assert.ok(r.probes.some((p) => p.status === "rejected-shell" && p.target.toLowerCase().endsWith("opencode.cmd")));
});

// ── 四层顺序与命中即停（§2.1 / §2.3）──────────────────────────────────

test("L0 显式 backendCmd（存在且是文件）优先，命中即停（不再探下三层）", () => {
  // REQ-v0.8.6-2026-09-21-02 真机补正①：L0 新增存在性门 ⇒ 旧例的 `C:/custom/my-acp.exe`
  // 原本靠「不校验」而 hit；现须让该路径在注入 fs 中真实存在，才仍是 hit。
  const deps = makeDeps(["C:/custom/my-acp.exe"], {}, { npmRoots: ["/npm"], machineModulesRoot: "/empty", platform: "linux" });
  const r = resolveBackendEntry("codex", { backendCmd: "C:/custom/my-acp.exe" }, deps);
  assert.equal(r.command, "C:/custom/my-acp.exe");
  assert.equal(r.rejection, undefined);
  assert.deepEqual(
    r.probes.map((p) => p.layer),
    ["L0-explicit"],
  );
  assert.equal(r.probes[0]?.status, "hit");
});

test("L0 显式路径为 .js 脚本且存在 ⇒ 直用（不因扩展名判拒）", () => {
  const deps = makeDeps(["C:/own/adapter/index.js"], {}, { npmRoots: ["/npm"], machineModulesRoot: "/empty", platform: "linux" });
  const r = resolveBackendEntry("codex", { backendCmd: "C:/own/adapter/index.js" }, deps);
  assert.equal(r.command, "C:/own/adapter/index.js");
  assert.equal(r.probes[0]?.status, "hit");
});

test("L0 显式路径不存在 ⇒ rejected-missing、不回落下层、给出项目级失败文案", () => {
  const missing = "C:/__no_such_dir__/no_such_adapter_entry.js";
  // 下层（L2 npm 全局）备有可命中的包 ⇒ 若误回落会被探测到；断言 probes 只到 L0 即可证否。
  const root = "/npm";
  const fx = pkgFixture(
    root,
    "@agentclientprotocol/codex-acp",
    { name: "@agentclientprotocol/codex-acp", bin: { "codex-acp": "dist/index.js" } },
    "dist/index.js",
  );
  const deps = makeDeps(fx.files, fx.jsons, { npmRoots: [root], machineModulesRoot: "/empty", platform: "linux", env: { PATH: "/bin" } });
  const r = resolveBackendEntry("codex", { backendCmd: missing }, deps);
  assert.equal(r.command, undefined, "显式值被拒 ⇒ 不得有 command");
  assert.deepEqual(
    r.probes.map((p) => [p.layer, p.status, p.target]),
    [["L0-explicit", "rejected-missing", missing]],
  );
  assert.ok(r.rejection, "expect a rejection message");
  assert.match(r.rejection ?? "", /后端入口/); // 承重的分类关键字（classifySelfCheckCause）
  assert.ok((r.rejection ?? "").includes(missing), "文案须原样带出配置值");
  assert.match(r.rejection ?? "", /不存在/);
  assert.match(r.rejection ?? "", /删除 backendCmd 键/);
  // requireBackendEntry 抛的是精简专项文案，**不含**分层清单
  assert.throws(
    () => requireBackendEntry("codex", { backendCmd: missing }, "GENERIC_MSG", deps),
    (err: Error) => {
      assert.ok(err.message.includes("后端入口") && err.message.includes(missing));
      assert.ok(!err.message.includes("GENERIC_MSG"));
      assert.ok(!err.message.includes("L1-local"));
      return true;
    },
  );
});

test("L0 显式路径是目录 ⇒ rejected-not-file（区别于不存在）", () => {
  const dir = "C:/tools/my-adapter";
  // 目录不是文件 ⇒ `isFile` 集为空；`isDirectory` 认出该目录 ⇒ 文案区分「不是文件」。
  const deps = makeDeps([], {}, {
    npmRoots: ["/npm"],
    machineModulesRoot: "/empty",
    platform: "linux",
    isDirectory: (c: string) => n(c) === n(dir),
  });
  const r = resolveBackendEntry("codex", { backendCmd: dir }, deps);
  assert.equal(r.command, undefined);
  assert.deepEqual(
    r.probes.map((p) => [p.layer, p.status, p.target]),
    [["L0-explicit", "rejected-not-file", dir]],
  );
  assert.match(r.rejection ?? "", /不是文件/);
  assert.ok((r.rejection ?? "").includes(dir));
  assert.ok((r.rejection ?? "").includes("后端入口"));
});

test("空串 backendCmd ⇒ 回落解析（与 resolveAcpBackendCmd 宽容口径一致）", () => {
  const root = "/npm";
  const fx = pkgFixture(root, "opencode-ai", { name: "opencode-ai", bin: { opencode: "bin/opencode.js" } }, "bin/opencode.js");
  const deps = makeDeps(fx.files, fx.jsons, { npmRoots: [root], machineModulesRoot: "/empty", platform: "linux" });
  const r = resolveBackendEntry("opencode", { backendCmd: "" }, deps);
  assert.equal(r.probes.find((p) => p.layer === "L0-explicit")?.status, "miss");
  assert.equal(n(r.command ?? ""), n(fx.binAbs ?? ""));
});

test("四层顺序：L0 miss → L1 miss → L2 hit（命中即停，不含 L3）", () => {
  const localRoot = "/local";
  const globalRoot = "/global";
  // L1（local 空）无包，L2（global）命中。
  const hit = pkgFixture(
    globalRoot,
    "@agentclientprotocol/codex-acp",
    { name: "@agentclientprotocol/codex-acp", bin: { "codex-acp": "dist/index.js" } },
    "dist/index.js",
  );
  const deps = makeDeps(hit.files, hit.jsons, {
    npmRoots: [globalRoot],
    machineModulesRoot: join(localRoot, "node_modules"),
    platform: "linux",
    env: {},
  });
  const r = resolveBackendEntry("codex", undefined, deps);
  assert.equal(n(r.command ?? ""), n(hit.binAbs ?? ""));
  assert.deepEqual(
    r.probes.map((p) => [p.layer, p.status]),
    [
      ["L0-explicit", "miss"],
      ["L1-local", "miss"],
      ["L2-npm-global", "hit"],
    ],
  );
  assert.ok(!r.probes.some((p) => p.layer === "L3-path"), "命中即停：不得探 L3");
});

test("L1 命中优先于 L2（本地覆盖全局）", () => {
  const localRoot = join("/local", "node_modules");
  const globalRoot = "/global";
  const local = pkgFixture(
    localRoot,
    "opencode-ai",
    { name: "opencode-ai", bin: { opencode: "bin/opencode.js" } },
    "bin/opencode.js",
  );
  const global = pkgFixture(
    globalRoot,
    "opencode-ai",
    { name: "opencode-ai", bin: { opencode: "bin/opencode.js" } },
    "bin/opencode.js",
  );
  const m = mergeFixtures(local, global);
  const deps = makeDeps(m.files, m.jsons, { npmRoots: [globalRoot], machineModulesRoot: localRoot, platform: "linux" });
  const r = resolveBackendEntry("opencode", undefined, deps);
  assert.equal(n(r.command ?? ""), n(local.binAbs ?? ""));
  assert.deepEqual(
    r.probes.map((p) => p.layer),
    ["L0-explicit", "L1-local"],
  );
});

test("npm 包类全 miss 且 PATH 只有壳 ⇒ rejected-shell、command undefined", () => {
  const deps = makeDeps([], {}, {
    npmRoots: ["/empty"],
    machineModulesRoot: "/empty",
    platform: "win32",
    env: { PATH: "C:\\npm-global" },
  });
  // PATH 里有 codex-acp.cmd（无 .exe 真身）。
  const shellPath = "C:\\npm-global\\codex-acp.cmd";
  const set = new Set([n(shellPath)]);
  deps.isFile = (c: string) => set.has(n(c));
  const r = resolveBackendEntry("codex", undefined, deps);
  assert.equal(r.command, undefined);
  const rejected = r.probes.filter((p) => p.layer === "L3-path" && p.status === "rejected-shell");
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0]?.target.toLowerCase().endsWith("codex-acp.cmd"));
});

// ── PATH 铁律：只按适配器命令名查，绝不按 kind 名 ──────────────────────

test("PATH 层绝不用 kind 名（claude.exe 命中也不算），只认 claude-agent-acp", () => {
  const deps = makeDeps([], {}, {
    npmRoots: [],
    machineModulesRoot: "/empty",
    platform: "win32",
    env: { PATH: "C:\\bin" },
  });
  // 只有 kind 名命令 claude.exe（native CLI，不说 ACP），没有 claude-agent-acp.exe。
  const set = new Set([n("C:\\bin\\claude.exe")]);
  deps.isFile = (c: string) => set.has(n(c));
  const r = resolveBackendEntry("claude", undefined, deps);
  assert.equal(r.command, undefined, "must not match by kind name claude");
});

test("PATH 层按适配器命令名命中真身 exe", () => {
  const deps = makeDeps([], {}, {
    npmRoots: [],
    machineModulesRoot: "/empty",
    platform: "win32",
    env: { PATH: "C:\\bin" },
  });
  const exe = "C:\\bin\\claude-agent-acp.exe";
  const set = new Set([n(exe)]);
  deps.isFile = (c: string) => set.has(n(c));
  const r = resolveBackendEntry("claude", undefined, deps);
  assert.equal(n(r.command ?? ""), n(exe));
});

// ── qoder-cn：knownPaths 平台分支 + pathCommand ────────────────────────

test("qoder-cn 表项登记 pathCommand=qoderclicn（≠ kind 名）", () => {
  assert.equal(BACKEND_LOOKUP_BY_KIND["qoder-cn"].pathCommand, "qoderclicn");
  assert.equal(BACKEND_LOOKUP_BY_KIND["qoder-cn"].package, undefined);
});

test("qoder-cn win32 ⇒ 选 .exe knownPath，命中即用", () => {
  const home = "C:\\Users\\u";
  const winPath = join(home, ".qoder-cn", "bin", "qoderclicn", "qoderclicn.exe");
  const deps = makeDeps([winPath], {}, { platform: "win32", homedir: () => home, env: {}, npmRoots: [] });
  const r = resolveBackendEntry("qoder-cn", undefined, deps);
  assert.equal(n(r.command ?? ""), n(winPath));
  assert.ok(r.probes.some((p) => p.layer === "known" && p.status === "hit"));
});

test("qoder-cn posix ⇒ 选无扩展名 knownPath（真身形态）", () => {
  const home = "/home/u";
  const posixPath = join(home, ".local", "bin", "qoderclicn");
  const deps = makeDeps([posixPath], {}, { platform: "darwin", homedir: () => home, env: {}, npmRoots: [] });
  const r = resolveBackendEntry("qoder-cn", undefined, deps);
  assert.equal(n(r.command ?? ""), n(posixPath));
  assert.ok(!(r.command ?? "").toLowerCase().endsWith(".exe"), "posix known path 无扩展名");
});

test("qoder-cn 平台过滤：win32 不得选 posix 那条（即便两条都在盘上）", () => {
  const home = "C:\\Users\\u";
  const winPath = join(home, ".qoder-cn", "bin", "qoderclicn", "qoderclicn.exe");
  const posixPath = join(home, ".local", "bin", "qoderclicn");
  const deps = makeDeps([winPath, posixPath], {}, { platform: "win32", homedir: () => home, env: {}, npmRoots: [] });
  const r = resolveBackendEntry("qoder-cn", undefined, deps);
  assert.equal(n(r.command ?? ""), n(winPath));
});

test("qoder-cn knownPaths 都不在 ⇒ 回落 PATH（qoderclicn.exe 真身命中）", () => {
  const home = "C:\\Users\\u";
  const pathExe = "C:\\tools\\qoderclicn.exe";
  const deps = makeDeps([], {}, {
    platform: "win32",
    homedir: () => home,
    env: { PATH: "C:\\tools" },
    npmRoots: [],
  });
  const set = new Set([n(pathExe)]);
  deps.isFile = (c: string) => set.has(n(c));
  const r = resolveBackendEntry("qoder-cn", undefined, deps);
  assert.equal(n(r.command ?? ""), n(pathExe));
  assert.ok(r.probes.some((p) => p.layer === "known" && p.status === "miss"));
  assert.ok(r.probes.some((p) => p.layer === "L3-path" && p.status === "hit"));
});

// ── 未知 kind / require 语义 ───────────────────────────────────────────

test("未知 kind ⇒ 判未命中（command undefined，不抛）", () => {
  const deps = makeDeps([], {}, { npmRoots: [], machineModulesRoot: "/empty", platform: "linux", env: {} });
  const r = resolveBackendEntry("bogus-kind" as AgentKind, undefined, deps);
  assert.equal(r.command, undefined);
  assert.deepEqual(r.probes.map((p) => p.layer), ["L0-explicit"]);
});

test("requireBackendEntry：命中返回字符串；未命中抛 requiredMsg", () => {
  // REQ-v0.8.6-2026-09-21-02 真机补正①：L0 现校验存在性 ⇒ 显式值须在注入 fs 中存在才是「命中」。
  const okDeps = makeDeps(["X:/a.exe"], {}, { npmRoots: [], machineModulesRoot: "/empty", platform: "linux" });
  assert.equal(requireBackendEntry("codex", { backendCmd: "X:/a.exe" }, "MSG", okDeps), "X:/a.exe");
  const badDeps = makeDeps([], {}, { npmRoots: ["/empty"], machineModulesRoot: "/empty", platform: "linux", env: {} });
  assert.throws(() => requireBackendEntry("codex", undefined, "CODEX_MSG", badDeps), /CODEX_MSG/);
});

test("formatBackendProbe：层名 + 状态 + 目标（note 存在则并入）", () => {
  const hit: BackendEntryProbe = { layer: "L2-npm-global", status: "hit", target: "/a/index.js" };
  const noted: BackendEntryProbe = { layer: "L1-local", status: "miss", target: "/b/package.json", note: "no-bin" };
  assert.equal(formatBackendProbe(hit), "L2-npm-global=hit(/a/index.js)");
  assert.equal(formatBackendProbe(noted), "L1-local=miss(/b/package.json no-bin)");
});
