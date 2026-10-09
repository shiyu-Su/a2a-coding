/**
 * v0.10.0 B2 · 版本写面**改道引擎**（改造文档 §2.1(2) / §2.3(2)/(3)）—— 单件。
 *
 * 判据（要点内嵌）：
 * - **三写面均经引擎**：建 / 删 / 设状态各发一次 `ctx.write.versions.{create,remove,setStatus}`；
 * - **板不判闸**：不复核 semver 形状 / 重复 / released / 名下卡 / 迁移矩阵 —— 错误码一律来自引擎；
 * - **错误码原样展示**：`orch_*` 走显示映射表、未知码原样透出、**不得 fail-closed**；
 * - **板侧无事实源写**：`.data/versions.json` 不再被本写面写入（含成功档，不建文件）；
 * - **引擎不可达 ⇒ 硬失败**（`502 bridge_unreachable`），**无本地下沉兜底写**。
 *
 * 表单解析（CSRF / action 三值闭集 / status 闭集 / 组织作用域）**原样**，只把「本地台账写」
 * 换成「引擎意图」。引擎以注入的假客户端离线自证（不起真桥、不触 MCP）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBoardServer } from "../dist/server.js";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const WRITE_HEADERS = { "x-board-write": "1", accept: "application/json" };

/**
 * 只读面假客户端。`getFeatures` 供**组织空间前缀归一层**解析 universe（`/org/<名>/…` 存在性），
 * 返回空清单即可（组织存在性另有磁盘目录源）；其余只读方法**不应被版本写面触达**。
 */
function fakeClient() {
  const boom = (name) => async () => {
    throw new Error(`不该被版本写面触达：${name}`);
  };
  return {
    client: {
      baseUrl: "http://fake",
      async getFeatures() {
        return { features: [], stateCounts: null };
      },
      getFeature: boom("getFeature"),
      getFeatureTrace: boom("getFeatureTrace"),
      getProjects: boom("getProjects"),
      getTasks: boom("getTasks"),
    },
  };
}

/**
 * 假引擎版本写客户端。`impl[kind]` 可为函数（逐调用裁决）或静态结果对象；缺省 ⇒ 成功档。
 * 记录逐次 `{kind, input}` 供断言「意图是否发出、载荷是否正确」。
 */
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

function tmpEnv() {
  const dir = mkdtempSync(join(tmpdir(), "board-versions-http-"));
  return { dir, orgsRoot: join(dir, "orgs"), versionsFile: join(dir, "data", "versions.json") };
}

async function withVersionServer(run, { engineImpl = {}, serverOverrides = {}, orgs = [] } = {}) {
  const env = tmpEnv();
  mkdirSync(env.orgsRoot, { recursive: true });
  for (const org of orgs) mkdirSync(join(env.orgsRoot, org), { recursive: true });
  const { client } = fakeClient();
  const engine = fakeEngine(engineImpl);
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client,
    now: () => NOW,
    versionsLedgerFile: env.versionsFile,
    versionsWriteImpl: engine.client,
    docs: { repoRoot: env.dir, orgsDir: env.orgsRoot },
    ...serverOverrides,
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`, env, engine);
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

/** 空间档写口：`/org/<编码组织名>/versions`（归一层剥前缀后命中同一条全局写路径）。 */
function postVersionsAt(base, path, fields, headers = WRITE_HEADERS) {
  return fetch(`${base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

// ---------------------------------------------------------------------------
// ① CSRF / 方法门 / 表单闭集（板侧解析原样，零出网）
// ---------------------------------------------------------------------------

test("B2-①（CSRF）：无自定义头且无同源来源 ⇒ 403 write_guard_origin_unknown，零出网", async () => {
  await withVersionServer(async (base, env, engine) => {
    const res = await postVersions(base, { action: "create", version: "v0.9.4" }, { accept: "application/json" });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "write_guard_origin_unknown");
    assert.deepEqual(engine.calls, [], "未认证请求不触达引擎");
    assert.equal(existsSync(env.versionsFile), false, "本地台账零写（不建文件）");
  });
});

test("B2-②（方法门）：非 GET /versions ⇒ 404", async () => {
  await withVersionServer(async (base) => {
    const res = await fetch(`${base}/versions`, { method: "PUT" });
    assert.equal(res.status, 404);
    assert.match(await res.text(), /未知路径/);
  });
});

test("B2-③ action 缺失 / 越界 ⇒ 400 board_version_action_invalid（fail-closed，不猜动作、零出网）", async () => {
  await withVersionServer(async (base, _env, engine) => {
    const miss = await postVersions(base, { version: "v0.9.4" });
    assert.equal(miss.status, 400);
    assert.equal((await miss.json()).code, "board_version_action_invalid");
    const bad = await postVersions(base, { action: "drop", version: "v0.9.4" });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, "board_version_action_invalid");
    assert.deepEqual(engine.calls, [], "表单闭集不过即零出网");
  });
});

// ---------------------------------------------------------------------------
// ② 建版：经引擎；重复 / 非法按引擎码展示；无本地写
// ---------------------------------------------------------------------------

test("B2-④ create 正向：引擎 201 ⇒ 板 201 + 引擎回显；表单档 303 回 /schedule；本地零写", async () => {
  await withVersionServer(async (base, env, engine) => {
    const res = await postVersions(base, { action: "create", version: "v0.9.4" });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { ok: true, version: "v0.9.4", status: "notstart" });
    assert.deepEqual(engine.calls, [{ kind: "create", input: { ownerGroup: null, version: "v0.9.4" } }], "全局档 ⇒ ownerGroup=null 发引擎");
    assert.equal(existsSync(env.versionsFile), false, "本地台账零写（不建文件）");

    const form = await postVersions(base, { action: "create", version: "v0.9.5" }, { origin: base });
    assert.equal(form.status, 303);
    assert.equal(form.headers.get("location"), "/schedule");
  });
});

test("B2-⑤ create 重复：引擎 409 orch_version_exists ⇒ 板 409 原样码 + 业务化文案", async () => {
  await withVersionServer(
    async (base, _env, engine) => {
      const res = await postVersions(base, { action: "create", version: "v0.9.4" });
      assert.equal(res.status, 409);
      const json = await res.json();
      assert.equal(json.code, "orch_version_exists", "引擎码原样（非板本地 board_version_exists）");
      assert.match(json.error, /已存在/, "走显示映射表给业务化文案");
      assert.equal(engine.calls.length, 1);
    },
    { engineImpl: { create: { ok: false, httpStatus: 409, code: "orch_version_exists", message: "引擎原文" } } },
  );
});

test("B2-⑥ create 非法形状：引擎 400 orch_version_invalid_shape ⇒ 板 400（板不再预判 semver）", async () => {
  await withVersionServer(
    async (base, _env, engine) => {
      const res = await postVersions(base, { action: "create", version: "1.0" });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.code, "orch_version_invalid_shape");
      assert.match(json.error, /x\.y\.z/);
      assert.deepEqual(engine.calls[0]?.input, { ownerGroup: null, version: "1.0" }, "非法形状也发引擎裁决");
    },
    { engineImpl: { create: { ok: false, httpStatus: 400, code: "orch_version_invalid_shape", message: "shape" } } },
  );
});

// ---------------------------------------------------------------------------
// ③ 删版：经引擎；名下未收口按引擎 409 展示；无回池写
// ---------------------------------------------------------------------------

test("B2-⑦ remove 名下未收口：引擎 409 orch_version_open_cards ⇒ 板 409 原样码 + 文案；不回池", async () => {
  await withVersionServer(
    async (base, _env, engine) => {
      const res = await postVersions(base, { action: "remove", version: "v0.9.4" });
      assert.equal(res.status, 409);
      const json = await res.json();
      assert.equal(json.code, "orch_version_open_cards");
      assert.match(json.error, /未收口/);
      assert.deepEqual(engine.calls, [{ kind: "remove", input: { ownerGroup: null, version: "v0.9.4" } }]);
    },
    { engineImpl: { remove: { ok: false, httpStatus: 409, code: "orch_version_open_cards", message: "open" } } },
  );
});

test("B2-⑧ remove 正向：引擎成功 ⇒ 板 200 + 摘除回执；本地零写（不回池任何卡）", async () => {
  await withVersionServer(async (base, env, engine) => {
    const res = await postVersions(base, { action: "remove", version: "v0.9.4" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, version: "v0.9.4", removed: true });
    assert.deepEqual(engine.calls, [{ kind: "remove", input: { ownerGroup: null, version: "v0.9.4" } }], "只发删意图，无排期写回池");
    assert.equal(existsSync(env.versionsFile), false, "本地台账零写");
  });
});

test("B2-⑨ 引擎不可达（删版）⇒ 502 bridge_unreachable 硬失败，无本地下沉写", async () => {
  await withVersionServer(
    async (base, env) => {
      const res = await postVersions(base, { action: "remove", version: "v0.9.4" });
      assert.equal(res.status, 502);
      assert.equal((await res.json()).code, "bridge_unreachable");
      assert.equal(existsSync(env.versionsFile), false, "不可达 ⇒ 不写本地（无兜底）");
    },
    { engineImpl: { remove: { ok: false, httpStatus: 502, code: "bridge_unreachable", message: "连接被拒" } } },
  );
});

// ---------------------------------------------------------------------------
// ④ 设状态：经引擎；表单闭集仍在；引擎码原样展示
// ---------------------------------------------------------------------------

test("B2-⑩ setStatus 表单闭集：status 缺失 / 非闭集 ⇒ 400 board_version_form_invalid（零出网）", async () => {
  await withVersionServer(async (base, _env, engine) => {
    const noStatus = await postVersions(base, { action: "setStatus", version: "v0.9.4" });
    assert.equal(noStatus.status, 400);
    assert.equal((await noStatus.json()).code, "board_version_form_invalid");
    const badStatus = await postVersions(base, { action: "setStatus", version: "v0.9.4", status: "活跃" });
    assert.equal(badStatus.status, 400);
    assert.equal((await badStatus.json()).code, "board_version_form_invalid");
    assert.deepEqual(engine.calls, [], "闭集不过零出网");
  });
});

test("B2-⑪ setStatus 正向：引擎成功 ⇒ 板 200 + 引擎回显状态", async () => {
  await withVersionServer(async (base, _env, engine) => {
    const res = await postVersions(base, { action: "setStatus", version: "v0.9.4", status: "active" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, version: "v0.9.4", status: "active" });
    assert.deepEqual(engine.calls, [{ kind: "setStatus", input: { ownerGroup: null, version: "v0.9.4", status: "active" } }]);
  });
});

test("B2-⑫ setStatus 引擎 404 orch_version_unknown ⇒ 板 404 原样码", async () => {
  await withVersionServer(
    async (base) => {
      const res = await postVersions(base, { action: "setStatus", version: "v9.9.9", status: "active" });
      assert.equal(res.status, 404);
      assert.equal((await res.json()).code, "orch_version_unknown");
    },
    { engineImpl: { setStatus: { ok: false, httpStatus: 404, code: "orch_version_unknown", message: "unknown" } } },
  );
});

test("B2-⑬ 未知引擎码 ⇒ **原样展示**（不 fail-closed、不吞成通用错误）", async () => {
  await withVersionServer(
    async (base) => {
      const res = await postVersions(base, { action: "remove", version: "v0.9.4" });
      assert.equal(res.status, 500, "HTTP 状态用引擎回执");
      const json = await res.json();
      assert.equal(json.code, "orch_future_code", "未知码原样透出");
      assert.equal(json.error, "引擎新码原文", "未知码文案原样（未映射、未吞）");
    },
    { engineImpl: { remove: { ok: false, httpStatus: 500, code: "orch_future_code", message: "引擎新码原文" } } },
  );
});

// ---------------------------------------------------------------------------
// ⑤ 组织作用域：org 只从路径取；全局档 ownerGroup=null
// ---------------------------------------------------------------------------

const ORG_A = "组织甲";
const SEG_A = encodeURIComponent(ORG_A);

test("B2-⑭ 空间档 create：ownerGroup = 路径组织；303 回本空间排期页", async () => {
  await withVersionServer(
    async (base, env, engine) => {
      const created = await postVersionsAt(base, `/org/${SEG_A}/versions`, { action: "create", version: "v1.0.0" });
      assert.equal(created.status, 201);
      assert.deepEqual(engine.calls, [{ kind: "create", input: { ownerGroup: ORG_A, version: "v1.0.0" } }], "org 只由路径注入");

      const form = await postVersionsAt(base, `/org/${SEG_A}/versions`, { action: "create", version: "v1.0.1" }, { origin: base });
      assert.equal(form.status, 303);
      assert.equal(form.headers.get("location"), `/org/${SEG_A}/schedule`);
      void env;
    },
    { orgs: [ORG_A] },
  );
});

test("B2-⑮ 空间档 create：表单伪造 org 字段不改落点（ownerGroup 恒 = 路径组织）", async () => {
  await withVersionServer(
    async (base, _env, engine) => {
      const res = await postVersionsAt(base, `/org/${SEG_A}/versions`, {
        action: "create",
        version: "v1.0.0",
        org: "别处组织",
        group: "别处组织",
      });
      assert.equal(res.status, 201);
      assert.deepEqual(engine.calls, [{ kind: "create", input: { ownerGroup: ORG_A, version: "v1.0.0" } }], "客户端提交的组织字段被忽略");
    },
    { orgs: [ORG_A] },
  );
});

test("B2-⑯ 空间档删 / 设状态：ownerGroup = 路径组织", async () => {
  await withVersionServer(
    async (base, _env, engine) => {
      await postVersionsAt(base, `/org/${SEG_A}/versions`, { action: "remove", version: "v1.0.0" });
      await postVersionsAt(base, `/org/${SEG_A}/versions`, { action: "setStatus", version: "v1.0.0", status: "active" });
      assert.deepEqual(engine.calls, [
        { kind: "remove", input: { ownerGroup: ORG_A, version: "v1.0.0" } },
        { kind: "setStatus", input: { ownerGroup: ORG_A, version: "v1.0.0", status: "active" } },
      ]);
    },
    { orgs: [ORG_A] },
  );
});
