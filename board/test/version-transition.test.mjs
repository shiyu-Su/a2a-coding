/**
 * REQ-2026-09-27-05 §2.3 W3 —— 状态转换执法（单件）：迁移矩阵五条边（人工写面）。
 *
 * 判据（改造文档 §2.3 / 需求确认单 v5）：
 * - 手动写面闸（五条边）：`notstart → active`（正例）· `active → notstart`（有已确认卡 ⇒ 拒）·
 *   `active → released`（判据 `total > 0 ∧ completed + cancelled === total ∧ completed > 0`，
 *   **完成集合 = completed + cancelled**（cancelled 轨已终止、无遗留待办 ⇒ 计入），`failed` 不计入
 *   ⇒ 含 failed 反例必须拒；**全 cancelled（无任何交付）同样必须拒**）·
 *   `released → active`（重开）· `notstart → released`（状态机拒）；
 * - **自动转换（`notstart → active`）已迁引擎（v0.10.0 · C-1 / O2b）** —— 板侧不再有任何自动写路径，
 *   本文件不再覆盖自动转换（原节流 / 幂等 / 复合键、GET 渲染前自动转换用例整段退役）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { IDEA_CARD_STAGE, decideVersionTransition, isConfirmedCard } from "../dist/version-transition.js";
import { createBoardServer } from "../dist/server.js";

const NOW = "2026-09-27T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const WRITE_HEADERS = { "x-board-write": "1", accept: "application/json" };

// ---------------------------------------------------------------------------
// 纯判定：迁移矩阵（五条边 + 自环 + 未列边）
// ---------------------------------------------------------------------------

/** 构造迁移事实（缺省 = 无已确认卡、空版；计数面 = raw 四桶）。 */
function facts(over = {}) {
  return { version: "v0.9.4", hasConfirmedCard: false, total: 0, completed: 0, cancelled: 0, failed: 0, ...over };
}

test("W3-① 已确认卡判据 = stage ≠ 需求分析（含 null 老桥缺列 ⇒ 已确认，fail-closed）", () => {
  assert.equal(isConfirmedCard(IDEA_CARD_STAGE), false);
  assert.equal(isConfirmedCard("改造方案"), true);
  assert.equal(isConfirmedCard(null), true);
  assert.equal(isConfirmedCard(undefined), true);
});

test("W3-② notstart → active 正例（自动 / 手动同边）；自环恒放行且 noop", () => {
  assert.deepEqual(decideVersionTransition("notstart", "active", facts()), { ok: true, noop: false });
  for (const s of ["notstart", "active", "released"]) {
    assert.deepEqual(decideVersionTransition(s, s, facts()), { ok: true, noop: true }, `自环 ${s}`);
  }
});

test("W3-③ active → notstart：无已确认卡（仅想法卡 / 无卡）⇒ 放行；有已确认卡 ⇒ 拒", () => {
  assert.deepEqual(
    decideVersionTransition("active", "notstart", facts({ hasConfirmedCard: false })),
    { ok: true, noop: false },
  );
  const r = decideVersionTransition("active", "notstart", facts({ hasConfirmedCard: true }));
  assert.equal(r.ok, false);
  assert.equal(r.code, "board_version_transition_confirmed_cards");
});

test("W3-④ active → released 正锚：`total > 0 ∧ completed + cancelled === total ∧ completed > 0` 才放行", () => {
  // 纯函数正锚：全 completed
  assert.equal(decideVersionTransition("active", "released", facts({ total: 2, completed: 2 })).ok, true);
  // 正锚（完成集合含 cancelled 轨）：1 completed + 1 cancelled ⇒ 放行
  assert.equal(
    decideVersionTransition("active", "released", facts({ total: 2, completed: 1, cancelled: 1 })).ok,
    true,
    "completed + cancelled === total ∧ completed > 0 ⇒ 放行",
  );
  assert.equal(
    decideVersionTransition("active", "released", facts({ total: 0, completed: 0 })).ok,
    false,
    "空版（total=0）不放行",
  );
  // 非终态在途（total=3 只收尾 2）⇒ 拒
  const r = decideVersionTransition("active", "released", facts({ total: 3, completed: 2 }));
  assert.equal(r.ok, false);
  assert.equal(r.code, "board_version_transition_release_incomplete");
});

test("W3-④b active → released 负锚：全 cancelled（无任何交付）⇒ 拒（用户裁决 A）", () => {
  const r = decideVersionTransition("active", "released", facts({ total: 2, completed: 0, cancelled: 2 }));
  assert.equal(r.ok, false, "completed + cancelled === total 但 completed = 0 ⇒ 该版零交付，不得标记 released");
  assert.equal(r.code, "board_version_transition_release_incomplete");
});

test("W3-④c active → released 负锚：非终态在途（executing）⇒ 拒", () => {
  const r = decideVersionTransition("active", "released", facts({ total: 3, completed: 2, cancelled: 0 }));
  assert.equal(r.ok, false, "名下仍有一张未到终态 ⇒ 未收口");
  assert.equal(r.code, "board_version_transition_release_incomplete");
});

test("W3-⑤ active → released 负锚：failed 不计入完成集合（含 failed ⇒ 拒，须先经 cancel 归档）", () => {
  // 名下 3 张 = 1 completed + 1 failed + 1 cancelled ⇒ 完成集合 2 ≠ total 3 ⇒ 必须拒。
  const r = decideVersionTransition("active", "released", facts({ total: 3, completed: 1, cancelled: 1, failed: 1 }));
  assert.equal(r.ok, false);
  assert.equal(r.code, "board_version_transition_release_incomplete");
});

test("W3-⑥ released → active 重开放行；notstart → released 与 released → notstart ⇒ forbidden", () => {
  assert.deepEqual(decideVersionTransition("released", "active", facts()), { ok: true, noop: false });
  for (const [from, to] of [
    ["notstart", "released"],
    ["released", "notstart"],
  ]) {
    const r = decideVersionTransition(from, to, facts());
    assert.equal(r.ok, false, `${from} → ${to} 必须拒`);
    assert.equal(r.code, "board_version_transition_forbidden");
  }
});

// ---------------------------------------------------------------------------
// HTTP 接线：手动写面闸（经引擎）
// ---------------------------------------------------------------------------

function tmpEnv() {
  const dir = mkdtempSync(join(tmpdir(), "board-w3-"));
  return { dir, versionsFile: join(dir, "data", "versions.json") };
}

function seedLedger(file, entries) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, versions: entries }, null, 2) + "\n", "utf8");
}

/** 台账条目夹具：`org` 缺省 = `alpha`。 */
function rec(version, status, org = "alpha") {
  return { org, version, status, createdAt: NOW, updatedAt: NOW, note: null };
}

function readLedger(file) {
  return JSON.parse(readFileSync(file, "utf8")).versions;
}

/** v0.10.0 B2：假引擎版本写客户端（记录意图，缺省成功档）——写面改道后覆盖 setStatus 直投。 */
function fakeEngine(impl = {}) {
  const calls = [];
  const make = (kind) => async (input) => {
    calls.push({ kind, input });
    const r = impl[kind];
    if (typeof r === "function") return r(input);
    if (r !== undefined) return r;
    return {
      ok: true,
      httpStatus: kind === "create" ? 201 : 200,
      version: input.version,
      status: kind === "remove" ? null : (input.status ?? "notstart"),
    };
  };
  return { calls, client: { create: make("create"), remove: make("remove"), setStatus: make("setStatus") } };
}

async function withServer(run, { features = [], seed = [], engineImpl = {} } = {}) {
  const env = tmpEnv();
  if (seed.length > 0) seedLedger(env.versionsFile, seed);
  const engine = fakeEngine(engineImpl);
  const client = {
    baseUrl: "http://fake",
    async getFeatures() {
      return { features, stateCounts: null };
    },
    async getFeature() {
      throw new Error("不该被版本面触达");
    },
    async getFeatureTrace() {
      throw new Error("不该被版本面触达");
    },
    async getProjects() {
      throw new Error("不该被版本面触达");
    },
    async getTasks() {
      throw new Error("不该被版本面触达");
    },
  };
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client,
    now: () => NOW_MS,
    versionsLedgerFile: env.versionsFile,
    versionsWriteImpl: engine.client,
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`, env, engine);
  } finally {
    await handle.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
}

function postVersions(base, fields) {
  return fetch(`${base}/versions`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...WRITE_HEADERS },
    body: new URLSearchParams(fields).toString(),
  });
}

test("W3-⑩（v0.10.0 B2 改道）HTTP setStatus 经引擎：引擎放行 ⇒ 200；unknown ⇒ 404 原样码；本地台账零写", async () => {
  await withServer(
    async (base, env, engine) => {
      const res = await postVersions(base, { action: "setStatus", version: "v0.9.4", status: "notstart" });
      assert.equal(res.status, 200, "引擎放行 ⇒ 板 200（引擎 setStatus 只锁 released 终态）");
      assert.equal((await res.json()).status, "notstart", "回显引擎 record.status");
      assert.deepEqual(engine.calls, [
        { kind: "setStatus", input: { ownerGroup: null, version: "v0.9.4", status: "notstart" } },
      ]);
      assert.equal(readLedger(env.versionsFile)[0].status, "active", "本地台账零写（投影只读）");
    },
    { seed: [rec("v0.9.4", "active")] },
  );
  await withServer(
    async (base) => {
      const res = await postVersions(base, { action: "setStatus", version: "v9.9.9", status: "active" });
      assert.equal(res.status, 404);
      assert.equal((await res.json()).code, "orch_version_unknown", "引擎码原样");
    },
    { engineImpl: { setStatus: { ok: false, httpStatus: 404, code: "orch_version_unknown", message: "unknown" } } },
  );
});

test("W3-⑪（v0.10.0 B2 改道）HTTP setStatus active → released 经引擎（发版闸归引擎，板原样展示）", async () => {
  await withServer(
    async (base, env, engine) => {
      const res = await postVersions(base, { action: "setStatus", version: "v0.9.4", status: "released" });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).status, "released");
      assert.deepEqual(engine.calls, [
        { kind: "setStatus", input: { ownerGroup: null, version: "v0.9.4", status: "released" } },
      ]);
      assert.equal(readLedger(env.versionsFile)[0].status, "active", "本地台账零写");
    },
    { seed: [rec("v0.9.4", "active")] },
  );
  await withServer(
    async (base) => {
      const res = await postVersions(base, { action: "setStatus", version: "v0.9.4", status: "released" });
      assert.equal(res.status, 409);
      assert.equal((await res.json()).code, "orch_version_not_converged", "引擎发版闸码原样");
    },
    {
      seed: [rec("v0.9.4", "active")],
      engineImpl: { setStatus: { ok: false, httpStatus: 409, code: "orch_version_not_converged", message: "gate" } },
    },
  );
});

test("W3-⑪b（v0.10.0 B2 改道）HTTP active → released 负锚：零交付 / 非终态在途均由引擎拒", async () => {
  await withServer(
    async (base) => {
      const res = await postVersions(base, { action: "setStatus", version: "v0.9.4", status: "released" });
      assert.equal(res.status, 409, "completed = 0 ⇒ 引擎发版闸拒");
      assert.equal((await res.json()).code, "orch_version_not_converged");
    },
    {
      seed: [rec("v0.9.4", "active")],
      engineImpl: { setStatus: { ok: false, httpStatus: 409, code: "orch_version_not_converged", message: "zero-delivery" } },
    },
  );
  await withServer(
    async (base) => {
      const res = await postVersions(base, { action: "setStatus", version: "v0.9.4", status: "released" });
      assert.equal(res.status, 409, "名下仍有 executing 在途 ⇒ 引擎未收口拒");
      assert.equal((await res.json()).code, "orch_version_not_converged");
    },
    {
      seed: [rec("v0.9.4", "active")],
      engineImpl: { setStatus: { ok: false, httpStatus: 409, code: "orch_version_not_converged", message: "inflight" } },
    },
  );
});

test("W3-⑫（v0.10.0 B2 改道）HTTP released 终态：改态被引擎拒（orch_version_released_locked 原样）", async () => {
  await withServer(
    async (base) => {
      const res = await postVersions(base, { action: "setStatus", version: "v0.9.4", status: "notstart" });
      assert.equal(res.status, 409);
      assert.equal((await res.json()).code, "orch_version_released_locked");
    },
    {
      seed: [rec("v0.9.4", "released")],
      engineImpl: { setStatus: { ok: false, httpStatus: 409, code: "orch_version_released_locked", message: "locked" } },
    },
  );
  await withServer(
    async (base) => {
      const res = await postVersions(base, { action: "setStatus", version: "v0.9.4", status: "active" });
      assert.equal(res.status, 409, "released 不可回退（引擎终态锁）");
      assert.equal((await res.json()).code, "orch_version_released_locked");
    },
    {
      seed: [rec("v0.9.4", "released")],
      engineImpl: { setStatus: { ok: false, httpStatus: 409, code: "orch_version_released_locked", message: "locked" } },
    },
  );
});

test("W3-⑬（v0.10.0 B2 改道）HTTP released → active：引擎拒（终态不可回退），板原样展示、本地零写", async () => {
  await withServer(
    async (base, env, engine) => {
      const res = await postVersions(base, { action: "setStatus", version: "v0.9.4", status: "active" });
      assert.equal(res.status, 409);
      assert.equal((await res.json()).code, "orch_version_released_locked");
      assert.deepEqual(engine.calls, [
        { kind: "setStatus", input: { ownerGroup: null, version: "v0.9.4", status: "active" } },
      ]);
      assert.equal(readLedger(env.versionsFile)[0].status, "released", "本地台账零写（原 released 不变）");
    },
    {
      seed: [rec("v0.9.4", "released")],
      engineImpl: { setStatus: { ok: false, httpStatus: 409, code: "orch_version_released_locked", message: "locked" } },
    },
  );
});
