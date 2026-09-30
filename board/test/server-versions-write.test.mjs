import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createBoardServer } from "../dist/server.js";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const WRITE_HEADERS = { "x-board-write": "1", accept: "application/json" };

/** 只读面假客户端：getFeatures 供 remove 的「名下无已确认卡」闸（增补十一 E2）；其余方法不应被触达。 */
function fakeClient(opts = {}) {
  const calls = [];
  return {
    calls,
    client: {
      baseUrl: "http://fake",
      async getFeatures() {
        calls.push("getFeatures");
        if (opts.throwOnFeatures) throw new Error("桥不可达（用例注入）");
        return { features: opts.features ?? [], stateCounts: null };
      },
      async getFeature() {
        throw new Error("不该被版本写面触达");
      },
      async getFeatureTrace() {
        throw new Error("不该被版本写面触达");
      },
      async getProjects() {
        throw new Error("不该被版本写面触达");
      },
      async getTasks() {
        throw new Error("不该被版本写面触达");
      },
    },
  };
}

function feature(id, version, overrides = {}) {
  return {
    featureId: id,
    state: "waiting_approval",
    title: id,
    taskCount: 0,
    ownerGroup: "g",
    stage: "需求分析",
    version,
    approval: "未发起",
    createdAt: "c",
    updatedAt: "u",
    ...overrides,
  };
}

function tmpEnv() {
  const dir = mkdtempSync(join(tmpdir(), "board-versions-http-"));
  return { dir, orgsRoot: join(dir, "orgs"), versionsFile: join(dir, "data", "versions.json") };
}

function seedLedger(file, entries) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ version: 1, versions: entries }, null, 2) + "\n",
    "utf8",
  );
}

function rec(version, status) {
  return { version, status, createdAt: "2026-09-27T00:00:00.000Z", updatedAt: "2026-09-27T00:00:00.000Z", note: null };
}

/** 空间档条目（B4）：唯一键 = `(org, version)` ⇒ 种子须带组织；`rec()` 的无 org 条目落未归属空串桶。 */
function recOrg(org, version, status) {
  return { ...rec(version, status), org };
}

async function withVersionServer(
  run,
  { envOptions = {}, serverOverrides = {}, orgs = [], preSeed = null } = {},
) {
  const env = tmpEnv();
  mkdirSync(env.orgsRoot, { recursive: true });
  for (const org of orgs) mkdirSync(join(env.orgsRoot, org), { recursive: true });
  if (preSeed !== null) preSeed(env.versionsFile);
  const { client, calls } = fakeClient(envOptions);
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client,
    now: () => NOW,
    versionsLedgerFile: env.versionsFile,
    docs: { repoRoot: env.dir, orgsDir: env.orgsRoot },
    ...serverOverrides,
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`, env, calls);
  } finally {
    await handle.close();
  }
}

function postVersions(base, fields, headers = WRITE_HEADERS) {
  return fetch(`${base}/versions`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

/** 空间档写口（B4）：`/org/<编码组织名>/versions` —— 归一层剥前缀后命中同一条全局写路径。 */
function postVersionsAt(base, path, fields, headers = WRITE_HEADERS) {
  return fetch(`${base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

function readLedger(file) {
  return JSON.parse(readFileSync(file, "utf8")).versions;
}

// ---------------------------------------------------------------------------
// ① CSRF / 方法门
// ---------------------------------------------------------------------------

test("N1-①（CSRF）：无自定义头且无同源来源 ⇒ 403 write_guard_origin_unknown，零写", async () => {
  await withVersionServer(async (base, env) => {
    const res = await postVersions(base, { action: "create", version: "v0.9.4" }, { accept: "application/json" });
    assert.equal(res.status, 403);
    const json = await res.json();
    assert.equal(json.code, "write_guard_origin_unknown");
    assert.equal(existsSync(env.versionsFile), false, "台账零写（不建文件）");
  });
});

test("N1-②（方法门）：非 GET /versions ⇒ 404（非已退役 GET 页；写面仅认 POST /versions）", async () => {
  await withVersionServer(async (base) => {
    const res = await fetch(`${base}/versions`, { method: "PUT" });
    assert.equal(res.status, 404);
    const text = await res.text();
    assert.match(text, /未知路径/);
  });
});

// ---------------------------------------------------------------------------
// ② action 三值闭集（未知 action fail-closed 拒）
// ---------------------------------------------------------------------------

test("N1-③ action 缺失 / 越界 ⇒ 400 board_version_action_invalid（fail-closed，不猜动作）", async () => {
  await withVersionServer(async (base) => {
    const miss = await postVersions(base, { version: "v0.9.4" });
    assert.equal(miss.status, 400);
    assert.equal((await miss.json()).code, "board_version_action_invalid");
    const bad = await postVersions(base, { action: "drop", version: "v0.9.4" });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, "board_version_action_invalid");
  });
});

// ---------------------------------------------------------------------------
// ③ create：semver 收口 / 同名 409 / PRG
// ---------------------------------------------------------------------------

test("N1-④ create 正向：201 + 台账落 notstart；表单档 = 303 回 /schedule", async () => {
  await withVersionServer(async (base, env) => {
    const res = await postVersions(base, { action: "create", version: "v0.9.4" });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { ok: true, version: "v0.9.4", status: "notstart", ledgerFile: env.versionsFile });
    assert.deepEqual(readLedger(env.versionsFile).map((v) => [v.version, v.status]), [["v0.9.4", "notstart"]]);

    const form = await postVersions(base, { action: "create", version: "v0.9.5" }, { origin: base });
    assert.equal(form.status, 303);
    assert.equal(form.headers.get("location"), "/schedule");
  });
});

test("N1-⑤ create 同名 ⇒ 409 board_version_exists（不重复创建）", async () => {
  await withVersionServer(async (base, env) => {
    seedLedger(env.versionsFile, [rec("v0.9.4", "notstart")]);
    const res = await postVersions(base, { action: "create", version: "v0.9.4" });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, "board_version_exists");
  });
});

test("N1-⑥ create 非 x.y.z ⇒ 400 board_version_form_invalid（复用 parseVersion，只拦新写）", async () => {
  await withVersionServer(async (base, env) => {
    const res = await postVersions(base, { action: "create", version: "1.0" });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "board_version_form_invalid");
    assert.equal(existsSync(env.versionsFile), false, "拒绝即零写");
  });
});

// ---------------------------------------------------------------------------
// ④ remove 闸：released 不可删 / 名下有已确认卡 / 想法卡自动回池 / 桥不可达 fail-closed
// ---------------------------------------------------------------------------

/** 假排期写（增补十一 E2：删版本时的「想法卡自动回池」复用同一条排期写通路）。 */
function fakeSchedule(impl) {
  const seen = [];
  const fn = async (input, options) => {
    seen.push({ input, options });
    if (impl) return impl(input, options);
    return { ok: true, featureId: input.featureId, state: input.to, version: input.version };
  };
  return { fn, seen };
}

test("N1-⑦ remove released ⇒ 409 board_version_remove_released", async () => {
  await withVersionServer(async (base, env) => {
    seedLedger(env.versionsFile, [rec("v0.9.3", "released")]);
    const res = await postVersions(base, { action: "remove", version: "v0.9.3" });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, "board_version_remove_released");
    assert.equal(readLedger(env.versionsFile).length, 1, "台账不动");
  });
});

test("N1-⑧ remove 名下有**已确认卡** ⇒ 409 board_version_remove_confirmed_cards（业务化文案、零回池写）", async () => {
  const { fn, seen } = fakeSchedule();
  await withVersionServer(
    async (base, env) => {
      seedLedger(env.versionsFile, [rec("v0.9.4", "notstart")]);
      const res = await postVersions(base, { action: "remove", version: "v0.9.4" });
      assert.equal(res.status, 409);
      const json = await res.json();
      assert.equal(json.code, "board_version_remove_confirmed_cards");
      assert.match(json.error, /该版本下还有已确认需求（1 条）⇒ 请先移出后再删/, "文案业务化（不透传内部细节）");
      assert.equal(readLedger(env.versionsFile).length, 1, "台账不动");
      assert.deepEqual(seen, [], "被拒即零出网（想法卡也不动）");
    },
    {
      envOptions: {
        features: [
          feature("F1", "v0.9.4", { stage: "改造方案", approval: "已通过" }),
          feature("F2", "v0.9.4"),
        ],
      },
      serverOverrides: { scheduleFeatureImpl: fn },
    },
  );
});

test("N1-⑧b remove 名下**仅想法卡** ⇒ 200 + 卡自动回池（version 清空）+ 台账摘除（口径变更）", async () => {
  const { fn, seen } = fakeSchedule();
  await withVersionServer(
    async (base, env) => {
      seedLedger(env.versionsFile, [rec("v0.9.4", "notstart"), rec("v0.9.5", "notstart")]);
      const res = await postVersions(base, { action: "remove", version: "v0.9.4" });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.removed, true);
      assert.deepEqual(json.backToPool, ["F1", "F3"], "本版名下两张想法卡回池（异版卡不在内）");
      assert.deepEqual(
        seen.map((s) => [s.input.featureId, s.input.version, s.input.to, s.options.group]),
        [["F1", "", "waiting_approval", "g"], ["F3", "", "executing", "g"]],
        "逐张走既有排期写通路：version 清空 = 回需求池，to 回填当前态（不迁状态机）",
      );
      assert.deepEqual(readLedger(env.versionsFile).map((v) => v.version), ["v0.9.5"], "只摘本版条目");
    },
    {
      envOptions: {
        features: [
          feature("F1", "v0.9.4"),
          feature("F2", "v0.9.5"),
          feature("F3", " v0.9.4 ", { state: "executing" }),
        ],
      },
      serverOverrides: { scheduleFeatureImpl: fn },
    },
  );
});

test("N1-⑧c 想法卡回池写失败 ⇒ 502 board_version_remove_pool_back_failed（版本不删，fail-closed）", async () => {
  const { fn } = fakeSchedule(() => ({ ok: false, code: "feature_invalid_stage", error: "桥拒写（用例注入）" }));
  await withVersionServer(
    async (base, env) => {
      seedLedger(env.versionsFile, [rec("v0.9.4", "notstart")]);
      const res = await postVersions(base, { action: "remove", version: "v0.9.4" });
      assert.equal(res.status, 502);
      const json = await res.json();
      assert.equal(json.code, "board_version_remove_pool_back_failed");
      assert.match(json.error, /1 张想法卡未能回需求池/, "回执带失败张数与原因");
      assert.equal(readLedger(env.versionsFile).length, 1, "回池未全部成功 ⇒ 不删台账条目");
    },
    { envOptions: { features: [feature("F1", "v0.9.4")] }, serverOverrides: { scheduleFeatureImpl: fn } },
  );
});

test("N1-⑧d 想法卡无归属组织 ⇒ 计入回池失败（不猜组）⇒ 版本不删", async () => {
  const { fn, seen } = fakeSchedule();
  await withVersionServer(
    async (base, env) => {
      seedLedger(env.versionsFile, [rec("v0.9.4", "notstart")]);
      const res = await postVersions(base, { action: "remove", version: "v0.9.4" });
      assert.equal(res.status, 502);
      assert.equal((await res.json()).code, "board_version_remove_pool_back_failed");
      assert.deepEqual(seen, [], "无组卡不出网");
      assert.equal(readLedger(env.versionsFile).length, 1, "台账不动");
    },
    {
      envOptions: { features: [feature("F1", "v0.9.4", { ownerGroup: "  " })] },
      serverOverrides: { scheduleFeatureImpl: fn },
    },
  );
});

test("N1-⑨ remove 干净（notstart ∧ 名下无卡）⇒ 200 且台账条目摘除", async () => {
  await withVersionServer(
    async (base, env) => {
      seedLedger(env.versionsFile, [rec("v0.9.4", "notstart")]);
      const res = await postVersions(base, { action: "remove", version: "v0.9.4" });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.removed, true);
      assert.deepEqual(json.backToPool, [], "无想法卡 ⇒ 空回池清单");
      assert.deepEqual(readLedger(env.versionsFile), []);
    },
    { envOptions: { features: [feature("F2", "")] } },
  );
});

test("N1-⑩ remove 桥不可达 ⇒ 502 fail-closed（不删）", async () => {
  await withVersionServer(
    async (base, env) => {
      seedLedger(env.versionsFile, [rec("v0.9.4", "notstart")]);
      const res = await postVersions(base, { action: "remove", version: "v0.9.4" });
      assert.equal(res.status, 502);
      assert.equal((await res.json()).code, "bridge_unreachable");
      assert.equal(readLedger(env.versionsFile).length, 1, "读不到卡即不删");
    },
    { envOptions: { throwOnFeatures: true } },
  );
});

// ---------------------------------------------------------------------------
// ⑤ setStatus：不存在 404 / status 闭集 / 正向
// ---------------------------------------------------------------------------

test("N1-⑪ setStatus：不存在 ⇒ 404；status 缺失/非闭集 ⇒ 400；正向 ⇒ 200 + 状态落盘", async () => {
  await withVersionServer(async (base, env) => {
    const miss = await postVersions(base, { action: "setStatus", version: "v9.9.9", status: "active" });
    assert.equal(miss.status, 404);
    assert.equal((await miss.json()).code, "board_version_not_found");

    const noStatus = await postVersions(base, { action: "setStatus", version: "v0.9.4" });
    assert.equal(noStatus.status, 400);
    assert.equal((await noStatus.json()).code, "board_version_form_invalid");

    const badStatus = await postVersions(base, { action: "setStatus", version: "v0.9.4", status: "活跃" });
    assert.equal(badStatus.status, 400);
    assert.equal((await badStatus.json()).code, "board_version_form_invalid");

    seedLedger(env.versionsFile, [rec("v0.9.4", "notstart")]);
    const ok = await postVersions(base, { action: "setStatus", version: "v0.9.4", status: "active" });
    assert.equal(ok.status, 200);
    const json = await ok.json();
    assert.equal(json.status, "active");
    assert.equal(json.changed, true);
    assert.equal(readLedger(env.versionsFile)[0].status, "active");
  });
});

// ---------------------------------------------------------------------------
// v0.9.6 B4 · 空间档（`POST /org/<名>/versions`）：org 只从路径取，写面 / 数卡闸 / 303 三处切片
// （口径 4 / 5 / 30；台账唯一键 = `(org, version)` ⇒ 同版号跨组织各自成立）
// ---------------------------------------------------------------------------

const ORG_A = "组织甲";
const ORG_B = "组织乙";
const SEG_A = encodeURIComponent(ORG_A);
const SEG_B = encodeURIComponent(ORG_B);
const V1 = "v1.0.0";

test("B4-① 空间档 create：条目落 (org, version)；同版号他组织可各建；同组织重复 ⇒ 409 且文案点名组织", async () => {
  await withVersionServer(
    async (base, env) => {
      const a = await postVersionsAt(base, `/org/${SEG_A}/versions`, { action: "create", version: V1 });
      assert.equal(a.status, 201);
      assert.deepEqual(await a.json(), { ok: true, version: V1, status: "notstart", ledgerFile: env.versionsFile });

      const b = await postVersionsAt(base, `/org/${SEG_B}/versions`, { action: "create", version: V1 });
      assert.equal(b.status, 201, "同版号在另一组织可各自登记（唯一键含 org）");

      assert.deepEqual(
        readLedger(env.versionsFile).map((v) => [v.org, v.version, v.status]),
        [[ORG_A, V1, "notstart"], [ORG_B, V1, "notstart"]],
        "两条独立条目，组织维不丢",
      );

      const dup = await postVersionsAt(base, `/org/${SEG_A}/versions`, { action: "create", version: V1 });
      assert.equal(dup.status, 409);
      const json = await dup.json();
      assert.equal(json.code, "board_version_exists");
      assert.match(json.error, new RegExp(`已在组织 ${ORG_A} 的台账中`), "409 文案点名本组织（闸 = 同组织同版号）");
      assert.equal(readLedger(env.versionsFile).length, 2, "被拒即零写");
    },
    { orgs: [ORG_A, ORG_B] },
  );
});

test("B4-①b 空间档 create：表单伪造 org / group 字段不改落点（org 只由服务端路径注入，口径 4）", async () => {
  await withVersionServer(
    async (base, env) => {
      const res = await postVersionsAt(base, `/org/${SEG_A}/versions`, {
        action: "create",
        version: V1,
        org: ORG_B,
        group: ORG_B,
      });
      assert.equal(res.status, 201);
      assert.deepEqual(
        readLedger(env.versionsFile).map((v) => [v.org, v.version]),
        [[ORG_A, V1]],
        "落点 = 路径组织，客户端提交的组织字段被忽略",
      );
    },
    { orgs: [ORG_A, ORG_B] },
  );
});

test("B4-② 空间档 create 表单档：303 回**本空间**排期页（口径 5，不再甩回全局 /schedule）", async () => {
  await withVersionServer(
    async (base, env) => {
      const form = await postVersionsAt(base, `/org/${SEG_A}/versions`, { action: "create", version: V1 }, { origin: base });
      assert.equal(form.status, 303);
      assert.equal(form.headers.get("location"), `/org/${SEG_A}/schedule`);
      assert.equal(readLedger(env.versionsFile)[0].org, ORG_A, "303 档同样落本组织条目");
    },
    { orgs: [ORG_A] },
  );
});

test("B4-③ 空间档 remove：只摘本组织条目（他组织同版号条目不动）", async () => {
  await withVersionServer(
    async (base, env) => {
      seedLedger(env.versionsFile, [recOrg(ORG_A, V1, "notstart"), recOrg(ORG_B, V1, "notstart")]);
      const res = await postVersionsAt(base, `/org/${SEG_A}/versions`, { action: "remove", version: V1 });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).removed, true);
      assert.deepEqual(
        readLedger(env.versionsFile).map((v) => [v.org, v.version]),
        [[ORG_B, V1]],
        "只删 (组织甲, v1.0.0)，(组织乙, v1.0.0) 照旧在册",
      );
    },
    { orgs: [ORG_A, ORG_B], envOptions: { features: [] } },
  );
});

test("B4-④ 空间档 remove 的「名下已确认卡」闸按组织数卡（口径 30：他组织的同版号卡不挡本组织删版）", async () => {
  const { fn, seen } = fakeSchedule();
  await withVersionServer(
    async (base, env) => {
      seedLedger(env.versionsFile, [recOrg(ORG_A, V1, "notstart"), recOrg(ORG_B, V1, "notstart")]);
      const out = await postVersionsAt(base, `/org/${SEG_A}/versions`, { action: "remove", version: V1 });
      assert.equal(out.status, 200, "本组织名下只有想法卡 ⇒ 可删（他组织的已确认卡不计入本闸）");
      assert.deepEqual((await out.json()).backToPool, ["FA"], "仅本组织的想法卡回池");
      assert.deepEqual(
        seen.map((s) => [s.input.featureId, s.input.version, s.options.group]),
        [["FA", "", ORG_A]],
      );

      const blocked = await postVersionsAt(base, `/org/${SEG_B}/versions`, { action: "remove", version: V1 });
      assert.equal(blocked.status, 409);
      const json = await blocked.json();
      assert.equal(json.code, "board_version_remove_confirmed_cards");
      assert.match(json.error, /该版本下还有已确认需求（1 条）/, "本组织那张已确认卡 ⇒ 1 条（他组织想法卡不计数）");

      assert.deepEqual(
        readLedger(env.versionsFile).map((v) => v.org),
        [ORG_B],
      );
    },
    {
      orgs: [ORG_A, ORG_B],
      envOptions: {
        features: [
          feature("FA", V1, { ownerGroup: ORG_A }),
          feature("FB", V1, { ownerGroup: ORG_B, stage: "改造方案", approval: "已通过" }),
        ],
      },
      serverOverrides: { scheduleFeatureImpl: fn },
    },
  );
});

test("B4-⑤ 空间档 setStatus 的发版闸按组织数卡（判据 = 该组织该版本名下全收口，口径 30）", async () => {
  await withVersionServer(
    async (base, env) => {
      seedLedger(env.versionsFile, [recOrg(ORG_A, V1, "active"), recOrg(ORG_B, V1, "active")]);
      const ok = await postVersionsAt(base, `/org/${SEG_A}/versions`, { action: "setStatus", version: V1, status: "released" });
      assert.equal(ok.status, 200, "组织甲名下唯一卡已 completed ⇒ 该组织该版本可标记已发版");
      assert.equal((await ok.json()).status, "released");

      const denied = await postVersionsAt(base, `/org/${SEG_B}/versions`, { action: "setStatus", version: V1, status: "released" });
      assert.equal(denied.status, 409);
      const json = await denied.json();
      assert.equal(json.code, "board_version_transition_release_incomplete");
      assert.match(json.error, /total 1/, "组织乙切片只数自己的 1 张卡（甲的完成不点亮乙的闸）");

      assert.deepEqual(
        readLedger(env.versionsFile).map((v) => [v.org, v.status]),
        [[ORG_A, "released"], [ORG_B, "active"]],
        "setStatus 精确命中 (org, version)，他组织同版号条目不动",
      );
    },
    {
      orgs: [ORG_A, ORG_B],
      envOptions: {
        features: [
          feature("FA", V1, { ownerGroup: ORG_A, state: "completed", stage: "改造方案", approval: "已通过" }),
          feature("FB", V1, { ownerGroup: ORG_B, state: "executing", stage: "改造方案", approval: "已通过" }),
        ],
      },
    },
  );
});

test("B4-⑥ 空间档 remove / setStatus：仅他组织有同版号条目 ⇒ 404（不跨组织命中）", async () => {
  await withVersionServer(
    async (base, env) => {
      seedLedger(env.versionsFile, [recOrg(ORG_A, V1, "notstart")]);
      const rm = await postVersionsAt(base, `/org/${SEG_B}/versions`, { action: "remove", version: V1 });
      assert.equal(rm.status, 404);
      assert.equal((await rm.json()).code, "board_version_not_found");

      const st = await postVersionsAt(base, `/org/${SEG_B}/versions`, { action: "setStatus", version: V1, status: "active" });
      assert.equal(st.status, 404);
      assert.equal((await st.json()).code, "board_version_not_found");

      assert.deepEqual(readLedger(env.versionsFile).map((v) => v.org), [ORG_A], "台账不动");
    },
    { orgs: [ORG_A, ORG_B] },
  );
});

test("B4-⑦ 空间排期页的删除 × 表单同样带空间前缀（缺前缀会让删除落回「不限组织」而误删他组织条目）", async () => {
  await withVersionServer(
    async (base) => {
      const html = await (await fetch(`${base}/org/${SEG_A}/schedule`)).text();
      assert.match(
        html,
        new RegExp(`<form method="post" action="/org/${SEG_A}/versions" class="inline vdel"`),
        "× 提交到本空间路径（归一层剥前缀命中同一条全局写口）",
      );
      assert.doesNotMatch(html, /<form method="post" action="\/versions" class="inline vdel"/, "空间页不渲染全局 action");
    },
    {
      orgs: [ORG_A],
      envOptions: { features: [feature("FA", V1, { ownerGroup: ORG_A })] },
      preSeed: (file) => seedLedger(file, [recOrg(ORG_A, V1, "notstart")]),
    },
  );
});

test("B4-⑧ 全局档不变形（路由留到 B5a 退役）：create 落未归属空串桶 ∧ 删 / 设状态按「不限组织」取首个命中 ∧ 303 回 /schedule", async () => {
  await withVersionServer(
    async (base, env) => {
      const created = await postVersions(base, { action: "create", version: V1 }, { origin: base });
      assert.equal(created.status, 303);
      assert.equal(created.headers.get("location"), "/schedule");
      assert.deepEqual(
        readLedger(env.versionsFile).map((v) => [v.org, v.version]),
        [["", V1]],
        "全局直投 = 未归属空串桶（与 migrateLedgerOrgs 的缺桶同构），不猜组织",
      );

      const removed = await postVersions(base, { action: "remove", version: V1 });
      assert.equal(removed.status, 200, "全局档 remove 不限组织 ⇒ 命中空串桶条目");
      assert.deepEqual(readLedger(env.versionsFile), []);
    },
    { orgs: [ORG_A], envOptions: { features: [] } },
  );
});
