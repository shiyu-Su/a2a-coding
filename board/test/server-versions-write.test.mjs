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
  return { dir, versionsFile: join(dir, "data", "versions.json") };
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

async function withVersionServer(run, { envOptions = {}, serverOverrides = {} } = {}) {
  const env = tmpEnv();
  const { client, calls } = fakeClient(envOptions);
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client,
    now: () => NOW,
    versionsLedgerFile: env.versionsFile,
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
