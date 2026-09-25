import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  ADAPTERS_ENTRY_REL,
  BRIDGE_ENTRY_REL,
  MACHINE_DIST_ENV,
  HostRuntimeError,
  assertRuntimeArtifacts,
  loadAdaptersModule,
  resolveMachineDistDir,
} from "../dist/host-runtime.js";

// ---------------------------------------------------------------------------
// 路径解析（「路径可配置」+「启动时检查存在性」两条要求的落点）
// ---------------------------------------------------------------------------

const SELF_DIST_DIR = dirname(fileURLToPath(import.meta.url)); // <仓根>/board/dist（由本测试 import 的产物位置）
const SELF_MODULE_URL = new URL("../dist/host-runtime.js", import.meta.url).href;
const SRC_FILE = fileURLToPath(new URL("../src/host-runtime.ts", import.meta.url));

/** 捕获抛出的错误（不满足类型/文案 ⇒ 直接 fail，避免 assert.throws 把断言吞成「没抛」）。 */
function captureThrow(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return assert.fail("应抛错，实际正常返回");
}

function freshDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function touchEntries(dir) {
  mkdirSync(join(dir, "acp-bridge"), { recursive: true });
  mkdirSync(join(dir, "adapters"), { recursive: true });
  writeFileSync(join(dir, "acp-bridge", "index.js"), "// stub\n", "utf8");
  writeFileSync(join(dir, "adapters", "index.js"), "// stub\n", "utf8");
}

test("resolveMachineDistDir: BOARD_MACHINE_DIST 优先于仓根推导（去首尾空白）", () => {
  const target = freshDir("board-env-");
  const out = resolveMachineDistDir({ [MACHINE_DIST_ENV]: `  ${target}  ` }, SELF_MODULE_URL);
  assert.equal(out, target);
  assert.ok(!out.includes("  "), "首尾空白须被清掉");
});

test("resolveMachineDistDir: 未配置 env ⇒ 由模块位置反推 <仓根>/machine/dist", () => {
  const out = resolveMachineDistDir({}, SELF_MODULE_URL);
  assert.equal(out, join(dirname(dirname(SELF_DIST_DIR)), "machine", "dist"));
});

test("resolveMachineDistDir: env 为空串 / 全空白视为未配置（回落缺省，不返回空路径）", () => {
  const fromEmpty = resolveMachineDistDir({ [MACHINE_DIST_ENV]: "   " }, SELF_MODULE_URL);
  assert.equal(fromEmpty, resolveMachineDistDir({}, SELF_MODULE_URL));
});

test("两个运行时产物的相对路径 = acp-bridge/index.js 与 adapters/index.js", () => {
  assert.equal(BRIDGE_ENTRY_REL, join("acp-bridge", "index.js"));
  assert.equal(ADAPTERS_ENTRY_REL, join("adapters", "index.js"));
});

// ---------------------------------------------------------------------------
// 存在性检查（dist 未构建 ⇒ 清晰报错，不静默失败）
// ---------------------------------------------------------------------------

test("assertRuntimeArtifacts: 两个产物都缺 ⇒ 抛 machine_dist_missing，文案逐个列出缺失路径", () => {
  const dir = freshDir("board-dist-empty-");
  const err = captureThrow(() => assertRuntimeArtifacts(dir));
  assert.ok(err instanceof HostRuntimeError);
  assert.equal(err.code, "machine_dist_missing");
  assert.ok(err.message.includes(join(dir, "acp-bridge", "index.js")));
  assert.ok(err.message.includes(join(dir, "adapters", "index.js")));
  assert.match(err.message, /缺失（2 个）/);
});

test("assertRuntimeArtifacts: 只缺一个 ⇒ 计数与路径都如实（不夸大、不掩盖另一项）", () => {
  const dir = freshDir("board-dist-half-");
  mkdirSync(join(dir, "adapters"), { recursive: true });
  writeFileSync(join(dir, "adapters", "index.js"), "export {};\n", "utf8");
  const err = captureThrow(() => assertRuntimeArtifacts(dir));
  assert.equal(err.code, "machine_dist_missing");
  assert.match(err.message, /缺失（1 个）/);
  assert.ok(err.message.includes(join(dir, "acp-bridge", "index.js")));
  assert.ok(!err.message.includes(join(dir, "adapters", "index.js")));
});

test("缺失文案含两条补救路径（npm run build / 改 BOARD_MACHINE_DIST）并回显当前解析目录", () => {
  const dir = freshDir("board-dist-msg-");
  const err = captureThrow(() => assertRuntimeArtifacts(dir));
  assert.match(err.message, /npm run build/);
  assert.ok(err.message.includes(MACHINE_DIST_ENV));
  assert.ok(err.message.includes(dir), "须回显当前解析目录，便于判断是配错还是没构建");
});

test("assertRuntimeArtifacts: 产物齐备 ⇒ 返回两个入口的绝对路径（供板如实显示耦合面）", () => {
  const dir = freshDir("board-dist-ok-");
  touchEntries(dir);
  const out = assertRuntimeArtifacts(dir);
  assert.equal(out.ok, true);
  assert.equal(out.distDir, dir);
  assert.equal(out.bridgeEntry, join(dir, "acp-bridge", "index.js"));
  assert.equal(out.adaptersEntry, join(dir, "adapters", "index.js"));
});

// ---------------------------------------------------------------------------
// 适配器模块加载（真 dist 在位才算；未构建 ⇒ skip，不把「没构建」当测试失败）
// ---------------------------------------------------------------------------

const REAL_DIST = resolveMachineDistDir({}, SELF_MODULE_URL);
const realDistReady = existsSync(join(REAL_DIST, BRIDGE_ENTRY_REL)) && existsSync(join(REAL_DIST, ADAPTERS_ENTRY_REL));

test("loadAdaptersModule: 真 dist 在位 ⇒ getAdapter(kind) 可用；未知 kind 回落 undefined 而非抛", { skip: !realDistReady }, async () => {
  const mod = await loadAdaptersModule(REAL_DIST);
  assert.equal(typeof mod.getAdapter, "function");
  const adapter = mod.getAdapter("claude");
  assert.ok(adapter !== undefined, "claude 适配器应在注册表内");
  assert.equal(adapter.kind, "claude");
  assert.equal(typeof adapter.buildLaunch, "function");
  assert.equal(typeof adapter.permission, "function");
  assert.equal(mod.getAdapter("no-such-kind-xyz"), undefined);
});

test("loadAdaptersModule: dist 缺失 ⇒ 同一份 machine_dist_missing（先检查后加载，不让 import 炸出伪装错误）", async () => {
  let err = null;
  try {
    await loadAdaptersModule(freshDir("board-dist-load-"));
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof HostRuntimeError);
  assert.equal(err.code, "machine_dist_missing");
});

test("loadAdaptersModule: 产物在但无 getAdapter 出口 ⇒ adapters_load_failed（构建产物与板期望不符）", async () => {
  const dir = freshDir("board-dist-nofn-");
  touchEntries(dir);
  writeFileSync(join(dir, "adapters", "index.js"), "export const notWhatBoardWants = 1;\n", "utf8");
  let err = null;
  try {
    await loadAdaptersModule(dir);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof HostRuntimeError);
  assert.equal(err.code, "adapters_load_failed");
  assert.match(err.message, /无 getAdapter 出口/);
});

test("依赖耦合面只在运行时产物：本模块不静态 import machine 源码，改用动态 import", () => {
  const src = readFileSync(SRC_FILE, "utf8");
  assert.ok(!/\.\.\/\.\.\/machine\/src/.test(src), "不得静态引用 machine 源码路径");
  assert.ok(!/^import[^;]*from "[^"]*machine/gm.test(src), "不得静态 import machine 任何东西");
  assert.match(src, /await import\(/, "运行时产物须经动态 import 加载");
});
