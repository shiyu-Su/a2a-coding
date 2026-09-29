/**
 * REQ-2026-09-27-05 §2.3 W3 —— 状态转换执法（单件）：迁移矩阵五条边 + 自动转换三护栏。
 *
 * 判据（改造文档 §2.3 / 需求确认单 v5）：
 * - 手动写面闸（五条边）：`notstart → active`（正例）· `active → notstart`（有已确认卡 ⇒ 拒）·
 *   `active → released`（判据 `total > 0 ∧ completed + cancelled === total ∧ completed > 0`，
 *   **完成集合 = completed + cancelled**（cancelled 轨已终止、无遗留待办 ⇒ 计入），`failed` 不计入
 *   ⇒ 含 failed 反例必须拒；**全 cancelled（无任何交付）同样必须拒**）·
 *   `released → active`（重开）· `notstart → released`（状态机拒）；
 * - 自动转换唯一一处 = 渲染前惰性比对「台账 notstart 条目 × 名下存在 stage ≠ 需求分析 的卡」，
 *   三护栏：幂等 / 写失败不阻断渲染（回落派生态） / 进程内节流（≥30s）；
 * - 自动写留 `note='auto:first-card-confirmed'`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  AUTO_NOTE,
  AUTO_THROTTLE_MS,
  IDEA_CARD_STAGE,
  applyAutoVersionTransitions,
  decideVersionTransition,
  deriveAutoActiveVersions,
  isConfirmedCard,
} from "../dist/version-transition.js";
import {
  createVersion,
  emptyVersionsLedger,
  findVersionRecord,
  setVersionStatus,
} from "../dist/versions-ledger.js";
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
// 自动转换引擎（注入假 store）：判据 + 三护栏
// ---------------------------------------------------------------------------

/** 假存储：可注入 `fail`（抛错）以验证护栏②；记录全部写入尝试。 */
function fakeStore(ledger, opts = {}) {
  let current = ledger;
  const writes = [];
  return {
    writes,
    get ledger() {
      return current;
    },
    setStatus(version, status, now, note) {
      writes.push({ version, status, now, note });
      if (opts.fail) throw new Error("disk boom（用例注入）");
      current = setVersionStatus(current, version, status, now, note).ledger;
      return { ledger: current };
    },
  };
}

function twoVersionLedger() {
  let l = createVersion(emptyVersionsLedger(), "v0.9.4", NOW).ledger;
  return createVersion(l, "v0.9.5", NOW).ledger;
}

test("W3-⑦ 自动转换判据：仅「notstart ∧ 名下已确认卡」命中；想法卡不触发；幂等（护栏①：一跳后不再写）", () => {
  const ledger = twoVersionLedger();
  const cards = [
    { version: "v0.9.4", stage: "改造方案" }, // 已确认
    { version: "v0.9.5", stage: IDEA_CARD_STAGE }, // 想法卡 ⇒ 不触发
  ];
  assert.deepEqual(deriveAutoActiveVersions(ledger, cards), ["v0.9.4"], "仅已确认卡命中；想法卡不触发");

  const store = fakeStore(ledger);
  const throttle = new Map();
  const first = applyAutoVersionTransitions({ ledger, cards, store, throttle, nowMs: NOW_MS });
  assert.deepEqual(first.written, ["v0.9.4"]);
  assert.deepEqual(first.failed, []);
  assert.deepEqual(first.throttled, []);
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0].note, AUTO_NOTE, "自动写留 note");
  assert.equal(findVersionRecord(first.ledger, "v0.9.4").status, "active");
  assert.equal(findVersionRecord(first.ledger, "v0.9.4").note, AUTO_NOTE);
  assert.equal(findVersionRecord(first.ledger, "v0.9.5").status, "notstart", "想法卡版本停在 notstart");

  // 护栏① 幂等：以回落台账再跑一次 ⇒ 已 active，候选为空 ⇒ 零写。
  const second = applyAutoVersionTransitions({
    ledger: first.ledger,
    cards,
    store,
    throttle,
    nowMs: NOW_MS,
  });
  assert.deepEqual(second.written, []);
  assert.equal(store.writes.length, 1, "命中一跳不再写");
});

test("W3-⑧ 护栏③ 进程内节流：同条目 ≥30s 至多尝试一次", () => {
  const ledger = createVersion(emptyVersionsLedger(), "v0.9.4", NOW).ledger;
  const cards = [{ version: "v0.9.4", stage: "改造方案" }];
  const store = fakeStore(ledger, { fail: true }); // 写失败 ⇒ 条目仍 notstart ⇒ 下次仍命中候选
  const throttle = new Map();

  const a = applyAutoVersionTransitions({ ledger, cards, store, throttle, nowMs: NOW_MS });
  assert.deepEqual(a.failed, ["v0.9.4"]);
  assert.equal(store.writes.length, 1);

  const b = applyAutoVersionTransitions({ ledger, cards, store, throttle, nowMs: NOW_MS + 10_000 });
  assert.deepEqual(b.throttled, ["v0.9.4"]);
  assert.equal(store.writes.length, 1, "30s 内不再尝试");

  const c = applyAutoVersionTransitions({
    ledger,
    cards,
    store,
    throttle,
    nowMs: NOW_MS + AUTO_THROTTLE_MS,
  });
  assert.deepEqual(c.failed, ["v0.9.4"]);
  assert.equal(store.writes.length, 2, "越过窗口后再尝试");
});

test("W3-⑨ 护栏② 写失败不阻断：failed 回报 + 回落台账剔除失败条目（不误导为「未开始」）、入参无副作用", () => {
  const ledger = createVersion(emptyVersionsLedger(), "v0.9.4", NOW).ledger;
  const cards = [{ version: "v0.9.4", stage: "改造方案" }];
  const store = fakeStore(ledger, { fail: true });
  const out = applyAutoVersionTransitions({ ledger, cards, store, throttle: new Map(), nowMs: NOW_MS });
  assert.deepEqual(out.failed, ["v0.9.4"]);
  assert.deepEqual(out.written, []);
  assert.equal(findVersionRecord(out.ledger, "v0.9.4"), null, "失败条目剔除 ⇒ 徽标回落派生态");
  assert.equal(findVersionRecord(ledger, "v0.9.4").status, "notstart", "入参台账不得被改动");
});

// ---------------------------------------------------------------------------
// HTTP 接线：手动写面闸 + GET 自动转换
// ---------------------------------------------------------------------------

function feature(id, version, overrides = {}) {
  return {
    featureId: id,
    state: "executing",
    title: `需求 ${id}`,
    requirement: null,
    taskCount: 1,
    ownerGroup: "alpha",
    stage: "改造方案",
    version,
    approval: "已通过",
    createdAt: "c",
    updatedAt: "u",
    stateCounts: null,
    ...overrides,
  };
}

function tmpEnv() {
  const dir = mkdtempSync(join(tmpdir(), "board-w3-"));
  return { dir, versionsFile: join(dir, "data", "versions.json") };
}

function seedLedger(file, entries) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, versions: entries }, null, 2) + "\n", "utf8");
}

function rec(version, status) {
  return { version, status, createdAt: NOW, updatedAt: NOW, note: null };
}

function readLedger(file) {
  return JSON.parse(readFileSync(file, "utf8")).versions;
}

async function withServer(run, { features = [], seed = [] } = {}) {
  const env = tmpEnv();
  if (seed.length > 0) seedLedger(env.versionsFile, seed);
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
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`, env);
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

test("W3-⑩ HTTP active → notstart：有已确认卡 ⇒ 409；仅想法卡 ⇒ 200 退回", async () => {
  await withServer(
    async (base, env) => {
      const res = await postVersions(base, { action: "setStatus", version: "v0.9.4", status: "notstart" });
      assert.equal(res.status, 409);
      assert.equal((await res.json()).code, "board_version_transition_confirmed_cards");
      assert.equal(readLedger(env.versionsFile)[0].status, "active", "拒绝即零写");
    },
    { seed: [rec("v0.9.4", "active")], features: [feature("F1", "v0.9.4")] },
  );
  await withServer(
    async (base, env) => {
      const res = await postVersions(base, { action: "setStatus", version: "v0.9.4", status: "notstart" });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).status, "notstart");
      assert.equal(readLedger(env.versionsFile)[0].status, "notstart");
    },
    { seed: [rec("v0.9.4", "active")], features: [feature("F1", "v0.9.4", { stage: IDEA_CARD_STAGE })] },
  );
});

test("W3-⑪ HTTP active → released：全 completed ⇒ 200；完成集合缩影（16 completed + 3 cancelled）⇒ 200；含 failed ⇒ 409", async () => {
  await withServer(
    async (base, env) => {
      const res = await postVersions(base, { action: "setStatus", version: "v0.9.4", status: "released" });
      assert.equal(res.status, 200);
      assert.equal(readLedger(env.versionsFile)[0].status, "released");
    },
    {
      seed: [rec("v0.9.4", "active")],
      features: [feature("F1", "v0.9.4", { state: "completed" }), feature("F2", "v0.9.4", { state: "completed" })],
    },
  );
  // 正向缩影（v0.9.4 名下 16 completed + 3 cancelled = 19 全收尾）⇒ 放行
  await withServer(
    async (base, env) => {
      const res = await postVersions(base, { action: "setStatus", version: "v0.9.4", status: "released" });
      assert.equal(res.status, 200, "completed + cancelled === total ∧ completed > 0 ⇒ 放行");
      assert.equal(readLedger(env.versionsFile)[0].status, "released");
    },
    {
      seed: [rec("v0.9.4", "active")],
      features: [
        ...Array.from({ length: 16 }, (_, i) => feature(`C${i}`, "v0.9.4", { state: "completed" })),
        ...Array.from({ length: 3 }, (_, i) => feature(`X${i}`, "v0.9.4", { state: "cancelled" })),
      ],
    },
  );
  await withServer(
    async (base, env) => {
      const res = await postVersions(base, { action: "setStatus", version: "v0.9.4", status: "released" });
      assert.equal(res.status, 409);
      assert.equal((await res.json()).code, "board_version_transition_release_incomplete");
      assert.equal(readLedger(env.versionsFile)[0].status, "active", "拒绝即零写");
    },
    {
      seed: [rec("v0.9.4", "active")],
      features: [
        feature("F1", "v0.9.4", { state: "completed" }),
        feature("F2", "v0.9.4", { state: "failed" }),
        feature("F3", "v0.9.4", { state: "cancelled" }),
      ],
    },
  );
});

test("W3-⑪b HTTP active → released 负锚：全 cancelled ⇒ 409（零交付版不得发版）；非终态在途 ⇒ 409", async () => {
  await withServer(
    async (base, env) => {
      const res = await postVersions(base, { action: "setStatus", version: "v0.9.4", status: "released" });
      assert.equal(res.status, 409, "completed = 0 ⇒ 拒（用户裁决 A）");
      assert.equal((await res.json()).code, "board_version_transition_release_incomplete");
      assert.equal(readLedger(env.versionsFile)[0].status, "active", "拒绝即零写");
    },
    {
      seed: [rec("v0.9.4", "active")],
      features: [
        feature("F1", "v0.9.4", { state: "cancelled" }),
        feature("F2", "v0.9.4", { state: "cancelled" }),
      ],
    },
  );
  await withServer(
    async (base) => {
      const res = await postVersions(base, { action: "setStatus", version: "v0.9.4", status: "released" });
      assert.equal(res.status, 409, "名下仍有 executing 在途 ⇒ 未收口");
      assert.equal((await res.json()).code, "board_version_transition_release_incomplete");
    },
    {
      seed: [rec("v0.9.4", "active")],
      features: [
        feature("F1", "v0.9.4", { state: "completed" }),
        feature("F2", "v0.9.4", { state: "completed" }),
        feature("F3", "v0.9.4", { state: "executing" }),
      ],
    },
  );
});

test("W3-⑫ HTTP notstart → released / released → notstart ⇒ 409 forbidden（状态机拒绝）", async () => {
  await withServer(
    async (base) => {
      const res = await postVersions(base, { action: "setStatus", version: "v0.9.4", status: "released" });
      assert.equal(res.status, 409);
      assert.equal((await res.json()).code, "board_version_transition_forbidden");
    },
    { seed: [rec("v0.9.4", "notstart")] },
  );
  await withServer(
    async (base) => {
      const res = await postVersions(base, { action: "setStatus", version: "v0.9.4", status: "notstart" });
      assert.equal(res.status, 409);
      assert.equal((await res.json()).code, "board_version_transition_forbidden");
    },
    { seed: [rec("v0.9.4", "released")] },
  );
});

test("W3-⑬ HTTP released → active 重开放行（200）", async () => {
  await withServer(
    async (base, env) => {
      const res = await postVersions(base, { action: "setStatus", version: "v0.9.4", status: "active" });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).status, "active");
      assert.equal(readLedger(env.versionsFile)[0].status, "active");
    },
    { seed: [rec("v0.9.4", "released")] },
  );
});

test("W3-⑭ HTTP GET /schedule 自动转换：notstart + 已确认卡 ⇒ 落盘 active + note；再 GET 幂等不再写", async () => {
  await withServer(
    async (base, env) => {
      const res = await fetch(`${base}/schedule`);
      assert.equal(res.status, 200);
      const html = await res.text();
      const first = readLedger(env.versionsFile)[0];
      assert.equal(first.status, "active", "首卡已确认 ⇒ 渲染前自动转 active");
      assert.equal(first.note, AUTO_NOTE);
      assert.match(html, /<h3>v0\.9\.4 <span class="kbadge vbadge wip"[^>]*>进行中<\/span>/, "徽标 = 台账 active");

      const snapshot = readFileSync(env.versionsFile, "utf8");
      await (await fetch(`${base}/schedule`)).text();
      assert.equal(readFileSync(env.versionsFile, "utf8"), snapshot, "幂等：已 active ⇒ 不再写");
    },
    { seed: [rec("v0.9.4", "notstart")], features: [feature("F1", "v0.9.4")] },
  );
  // 想法卡不触发：GET 后仍 notstart
  await withServer(
    async (base, env) => {
      await (await fetch(`${base}/schedule`)).text();
      assert.equal(readLedger(env.versionsFile)[0].status, "notstart", "仅想法卡 ⇒ 不触发自动转换");
    },
    { seed: [rec("v0.9.4", "notstart")], features: [feature("F1", "v0.9.4", { stage: IDEA_CARD_STAGE })] },
  );
});
