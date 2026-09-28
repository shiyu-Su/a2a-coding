import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBoardServer } from "../dist/server.js";

const NOW = Date.parse("2026-09-27T12:00:00Z");

/** 只读面假客户端：getFeatures 供重名闸的 ownerGroup 源；其它方法不应被本用例触达。 */
function fakeClient(opts = {}) {
  const calls = [];
  return {
    calls,
    client: {
      baseUrl: "http://fake",
      async getFeatures() {
        calls.push("getFeatures");
        if (opts.throwOnFeatures) throw new Error("桥不可达（用例注入）");
        return {
          features: [
            { featureId: "F1", state: "waiting_approval", title: "甲", taskCount: 1, ownerGroup: "需求所属组", stage: "需求分析", version: "", approval: "未发起", createdAt: "c", updatedAt: "u" },
            { featureId: "F2", state: "waiting_approval", title: "乙", taskCount: 1, ownerGroup: null, stage: "需求分析", version: "", approval: "未发起", createdAt: "c", updatedAt: "u" },
          ],
          stateCounts: null,
        };
      },
      async getFeature() { throw new Error("不该被建组织写面触达"); },
      async getFeatureTrace() { throw new Error("不该被建组织写面触达"); },
      async getProjects() { throw new Error("不该被建组织写面触达"); },
      async getTasks() { throw new Error("不该被建组织写面触达"); },
    },
  };
}

/** 每个用例一套 tmp 盘：orgsRoot（磁盘枚举源）+ ledger 文件落点。 */
function tmpEnv(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "board-orgs-http-"));
  const orgsRoot = join(dir, "orgs");
  if (opts.createRoot !== false) mkdirSync(orgsRoot, { recursive: true });
  if (opts.diskOrgs) for (const o of opts.diskOrgs) mkdirSync(join(orgsRoot, o), { recursive: true });
  if (opts.diskFiles) for (const f of opts.diskFiles) writeFileSync(join(orgsRoot, f), "占位", "utf8");
  if (opts.rootIsFile) {
    rmSync(orgsRoot, { recursive: true, force: true });
    writeFileSync(orgsRoot, "不是目录", "utf8");
  }
  return { dir, orgsRoot, ledgerFile: join(dir, "data", "orgs.json") };
}

async function withOrgServer(envOptions, run, serverOverrides = {}) {
  const env = tmpEnv(envOptions);
  const { client, calls } = fakeClient(envOptions.clientOpts);
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client,
    now: () => NOW,
    docs: { repoRoot: env.dir, orgsDir: env.orgsRoot },
    orgsLedgerFile: env.ledgerFile,
    ...serverOverrides,
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`, env, calls);
  } finally {
    await handle.close();
  }
}

function postOrg(base, org, headers = {}) {
  return fetch(`${base}/orgs`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ org }).toString(),
  });
}

function postOrgAction(base, org, action) {
  return fetch(`${base}/orgs`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...WRITE_HEADERS },
    body: new URLSearchParams({ org, action }).toString(),
  });
}

const WRITE_HEADERS = { "x-board-write": "1", accept: "application/json" };

function readLedgerOrgs(ledgerFile) {
  return JSON.parse(readFileSync(ledgerFile, "utf8")).orgs;
}

// ---------------------------------------------------------------------------
// ① 成功闭环：校验 → 台账原子写 → 201 JSON / 303 PRG
// ---------------------------------------------------------------------------

test("BD1-①（正向）：建组织 201 —— 台账落 .data/orgs.json（disabledAt=null 纯新建）；JSON 回显 org", async () => {
  await withOrgServer({}, async (base, env) => {
    const res = await postOrg(base, "新组织", WRITE_HEADERS);
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.deepEqual(json, { ok: true, org: "新组织", ledgerFile: env.ledgerFile });
    assert.deepEqual(readLedgerOrgs(env.ledgerFile), [{ org: "新组织", disabledAt: null }]);
  });
});

test("BD1-①b（正向）：表单档成功 = 303 回 /orgs（PRG，刷新不重复建）", async () => {
  await withOrgServer({}, async (base, env) => {
    const res = await postOrg(base, "flow-team", { origin: base });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/orgs");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(readLedgerOrgs(env.ledgerFile), [{ org: "flow-team", disabledAt: null }]);
  });
});

// ---------------------------------------------------------------------------
// ①′ 建组织即建目录（v0.9.4 §9-a 死锁修复：目录不再等首次起桥才出现）
// ---------------------------------------------------------------------------

test("BD1-①c（正向 · §9-a）：建组织成功 ⇒ `<orgsDir>/<组织>` 当场出现（单级、非起桥副产物）", async () => {
  await withOrgServer({}, async (base, env) => {
    const res = await postOrg(base, "testtest", WRITE_HEADERS);
    assert.equal(res.status, 201);
    assert.equal(existsSync(join(env.orgsRoot, "testtest")), true, "建组织后目录必须立即可见（死锁修复主断言）");
    assert.ok(statSync(join(env.orgsRoot, "testtest")).isDirectory());
  });
});

test("BD1-①d（幂等 · §9-a）：停用后同名重建 = 复活 ⇒ 目录已在不报错，台账回到在用", async () => {
  await withOrgServer({}, async (base, env) => {
    assert.equal((await postOrg(base, "复活组", WRITE_HEADERS)).status, 201);
    const dir = join(env.orgsRoot, "复活组");
    writeFileSync(join(dir, "keep.txt"), "目录里的既有产出", "utf8");
    assert.equal((await postOrgAction(base, "复活组", "disable")).status, 200);
    const revive = await postOrg(base, "复活组", WRITE_HEADERS);
    assert.equal(revive.status, 201);
    assert.equal(readFileSync(join(dir, "keep.txt"), "utf8"), "目录里的既有产出", "幂等：既不清空也不覆盖既有目录");
    assert.deepEqual(readLedgerOrgs(env.ledgerFile), [{ org: "复活组", disabledAt: null }]);
  });
});

test("BD1-①e（负向 · §9-a）：目录位被文件占用 ⇒ 503 board_org_dir_create_failed（不静默假装就绪），台账条目如实仍在", async () => {
  await withOrgServer({ diskFiles: ["占位文件"] }, async (base, env) => {
    const res = await postOrg(base, "占位文件", WRITE_HEADERS);
    assert.equal(res.status, 503);
    const json = await res.json();
    assert.equal(json.code, "board_org_dir_create_failed");
    assert.match(json.error, /已写入板台账，但组织目录建不出来/);
    assert.match(json.error, /同名重建/);
    assert.deepEqual(readLedgerOrgs(env.ledgerFile), [{ org: "占位文件", disabledAt: null }], "台账与目录两面各自如实，不假装一致");
  });
});

test("BD1-①f（边界 · §9-a）：建组织只建一级 ⇒ 组织根**不代建**（根缺失仍走③闸 503，不留半截目录）", async () => {
  await withOrgServer({ createRoot: false }, async (base, env) => {
    const res = await postOrg(base, "新组织", WRITE_HEADERS);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, "board_orgs_dir_missing");
    assert.equal(existsSync(env.orgsRoot), false, "根不存在 ⇒ 不得经建组织路径把根建出来");
  });
});

// ---------------------------------------------------------------------------
// ② CSRF 同规格（先于一切），且负例闭集经真 HTTP 一致
// ---------------------------------------------------------------------------

test("BD1-②（负向）：跨站 Origin ⇒ 403 CSRF，先于入参校验与台账写（非法名也不暴露 400）", async () => {
  await withOrgServer({}, async (base, env) => {
    const res = await postOrg(base, "a b", { origin: "http://evil.example:80" });
    assert.equal(res.status, 403);
    assert.equal(existsSync(env.ledgerFile), false, "被 CSRF 拒的请求不得触达台账");
  });
});

test("BD1-③（负例闭集 · 真 HTTP）：空格/#/?/%/../跨目录 ⇒ 400 board_org_name_invalid，零写入", async () => {
  await withOrgServer({}, async (base, env) => {
    for (const org of ["a b", "a#b", "a?b", "a%b", "..", "../etc", "a/../../b", ".", "a..b"]) {
      const res = await postOrg(base, org, WRITE_HEADERS);
      assert.equal(res.status, 400, `${JSON.stringify(org)} 必须 400`);
      const json = await res.json();
      assert.equal(json.code, "board_org_name_invalid", JSON.stringify(org));
      assert.equal(json.ok, false);
    }
    assert.equal(existsSync(env.ledgerFile), false, "校验失败不得创建台账文件");
  });
});

// ---------------------------------------------------------------------------
// ④ 三源重名闸（盘枚举 ∪ 板台账 ∪ 需求 ownerGroup）⇒ 409 board_org_exists
// ---------------------------------------------------------------------------

test("BD1-④（重名闸）：盘目录 / 台账 / 需求归属 三源逐一命中 ⇒ 409 + 文案点名来源；文件不动", async () => {
  await withOrgServer({ diskOrgs: ["磁盘已有"] }, async (base, env) => {
    const byDisk = await postOrg(base, "磁盘已有", WRITE_HEADERS);
    assert.equal(byDisk.status, 409);
    const diskJson = await byDisk.json();
    assert.equal(diskJson.code, "board_org_exists");
    assert.match(diskJson.error, /磁盘已有/);
    assert.match(diskJson.error, /磁盘已有 已存在（命中源：组织目录根下的一级目录/, "盘源优先点名（固定序）");

    const byFeature = await postOrg(base, "需求所属组", WRITE_HEADERS);
    assert.equal(byFeature.status, 409);
    assert.match((await byFeature.json()).error, /既有需求的归属组织/);

    const fresh = await postOrg(base, "首次建", WRITE_HEADERS);
    assert.equal(fresh.status, 201);
    const afterFresh = await postOrg(base, "首次建", WRITE_HEADERS);
    assert.equal(afterFresh.status, 409);
    assert.match(
      (await afterFresh.json()).error,
      /组织目录根下的一级目录/,
      "§9-a 起建组织即建目录 ⇒ 同名再建先命中盘源（台账源被盘源遮蔽，固定序不改）",
    );

    // 台账源单独命中：只剩「台账有、盘没有」的形态（①e 建目录失败态、§9-a 前的存量台账）⇒ 直接播种台账。
    writeFileSync(env.ledgerFile, JSON.stringify({ version: 1, orgs: [{ org: "仅台账有", disabledAt: null }] }, null, 2) + "\n", "utf8");
    const byLedger = await postOrg(base, "仅台账有", WRITE_HEADERS);
    assert.equal(byLedger.status, 409);
    assert.match((await byLedger.json()).error, /板组织台账/);
    assert.deepEqual(readLedgerOrgs(env.ledgerFile), [{ org: "仅台账有", disabledAt: null }], "重名拒后台账逐字节不动");
  });
});

// ---------------------------------------------------------------------------
// ⑤ orgsDir 根存在性前置闸（根不代建）；校验先于根闸（400 不被 503 改判）
// ---------------------------------------------------------------------------

test("BD1-⑤（负向）：orgsDir 未配置 ⇒ 503 board_orgs_dir_not_configured；配了但根不存在 ⇒ 503 board_orgs_dir_missing；均零写入", async () => {
  await withOrgServer({ createRoot: false }, async (base, env) => {
    const res = await postOrg(base, "新组织", WRITE_HEADERS);
    assert.equal(res.status, 503);
    const json = await res.json();
    assert.equal(json.code, "board_orgs_dir_missing");
    assert.match(json.error, /板不会代建/);
    assert.equal(existsSync(env.ledgerFile), false);
  });
  const env2 = tmpEnv({});
  const { client } = fakeClient();
  const handle = await createBoardServer({
    host: "127.0.0.1", port: 0, client, now: () => NOW,
    docs: { repoRoot: env2.dir, orgsDir: null },
    orgsLedgerFile: env2.ledgerFile,
  });
  try {
    const res = await postOrg(`http://127.0.0.1:${handle.port}`, "新组织", WRITE_HEADERS);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, "board_orgs_dir_not_configured");
    assert.equal(existsSync(env2.ledgerFile), false, "未配置 ⇒ 不写台账（更不代建根）");
  } finally {
    await handle.close();
  }
});

test("BD1-⑤b（负向）：orgsDir 配了但路径上是文件 ⇒ 503 board_orgs_dir_missing（not_dir 档）", async () => {
  await withOrgServer({ rootIsFile: true }, async (base, env) => {
    const res = await postOrg(base, "新组织", WRITE_HEADERS);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, "board_orgs_dir_missing");
    assert.equal(existsSync(env.ledgerFile), false);
  });
});

// ---------------------------------------------------------------------------
// ⑥ fail-closed：重名闸读不到需求归属 ⇒ 502，宁可不建
// ---------------------------------------------------------------------------

test("BD1-⑥（负向 · fail-closed）：getFeatures 抛错 ⇒ 502 bridge_unreachable，零写入", async () => {
  await withOrgServer({ clientOpts: { throwOnFeatures: true } }, async (base, env) => {
    const res = await postOrg(base, "新组织", WRITE_HEADERS);
    assert.equal(res.status, 502);
    const json = await res.json();
    assert.equal(json.code, "bridge_unreachable");
    assert.match(json.error, /fail-closed/);
    assert.equal(existsSync(env.ledgerFile), false);
  });
});

// ---------------------------------------------------------------------------
// ⑦ 方法门：/orgs 的 GET 仍是只读页；其它方法 405 文案已含 POST /orgs
// ---------------------------------------------------------------------------

test("BD1-⑦（方法门锚）：PUT /orgs ⇒ 405 且文案列全写路径（BD4 起八条，含 POST /orgs）", async () => {
  await withOrgServer({}, async (base) => {
    const res = await fetch(`${base}/orgs`, { method: "PUT" });
    assert.equal(res.status, 405);
    const text = await res.text();
    assert.match(text, /仅支持 GET/);
    assert.match(text, /POST \/orgs/, "405 文案单点 = WRITE_ROUTES，须随白名单同步");
    for (const p of ["POST /requirements", "POST /features/{id}/turn", "POST /host/{org}/stop", "POST /features/{id}/confirm", "POST /features/{id}/answer", "POST /features/{id}/schedule"]) {
      assert.ok(text.includes(p), `405 文案须含 ${p}`);
    }
  });
});
