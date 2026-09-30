/**
 * v0.9.5 C7 · T7 用例（离线）：**挂起口 + suspended 台账 + C9 约束两项**。
 *
 * 事实源：改造文档 `doc/v0.9.5/推进流程精简-改造文档.md` §2-C7 / §2-C9（v5）。
 * 覆盖：
 * - ① 白名单十→十一 + 路由归一（`POST /features/{id}/suspend`，近似路径 / 非 POST 不放行）；
 * - ② `parseSuspendForm`（严格仿 `parseMemberForm`：超限 413、校验不过结构化 400、判别联合）——
 *      turnId 必填、pending 可重复键逐项非空、空清单 = 纯 DAG 监视、wakeCond 有界可选；
 * - ③ turnId 归属：`providedTurnId === latestTurnOf(featureId).turnId`（最新轮通过 / 旧轮 400 / 非板发 400），
 *      **不设时间窗**；
 * - ④ suspended 台账：内存为事实源、`.data` 仅供崩溃取证、**启动清空重写**、坏文件 fail-closed、
 *     停链时同条目清；
 * - ⑤ C9：`buildTurnPrompt` 指针句 + 模板挂起口纪律 / 触发来源分野段。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SUSPEND_WRITE_PATH_TEMPLATE,
  SUSPEND_FORM_INVALID_CODE,
  SUSPEND_TURN_MISMATCH_CODE,
  WRITE_ROUTES,
  isWriteRoute,
  parseSuspendForm,
  parseWriteRoute,
} from "../dist/write-guard.js";
import {
  SUSPEND_LEDGER_VERSION,
  SuspendLedgerStore,
  addFiredKey,
  defaultSuspendLedgerFile,
  emptySuspendLedger,
  parseSuspendLedger,
  parseSuspendedEntry,
  removeSuspendedEntry,
  serializeSuspendLedger,
  upsertSuspendedEntry,
} from "../dist/suspend-ledger.js";
import { buildTurnPrompt } from "../dist/host-face.js";
import { createBoardServer } from "../dist/server.js";

const NOW = Date.parse("2026-09-28T12:00:00Z");

// ---------------------------------------------------------------------------
// ① 白名单十→十一 + 路由归一
// ---------------------------------------------------------------------------

test("T7-① WRITE_ROUTES 白名单十一条（含 POST /features/{id}/suspend），既有十条一条不少", () => {
  assert.equal(SUSPEND_WRITE_PATH_TEMPLATE, "/features/{id}/suspend");
  assert.equal(WRITE_ROUTES.length, 11, JSON.stringify(WRITE_ROUTES));
  assert.ok(WRITE_ROUTES.includes("POST /features/{id}/suspend"), "挂起口在清单内");
  for (const route of [
    "POST /requirements",
    "POST /features/{id}/turn",
    "POST /host/{org}/stop",
    "POST /features/{id}/confirm",
    "POST /features/{id}/answer",
    "POST /features/{id}/stop-chain",
    "POST /features/{id}/schedule",
    "POST /orgs",
    "POST /orgs/{org}/members",
    "POST /versions",
  ]) {
    assert.ok(WRITE_ROUTES.includes(route), `既有写路由 ${route} 不得丢`);
  }
});

test("T7-② parseWriteRoute：suspend 归一为 {kind:'suspend',featureId}；后缀互不抢；近似路径 / 非 POST 不放行", () => {
  assert.deepEqual(parseWriteRoute("POST", "/features/F1/suspend"), { kind: "suspend", featureId: "F1" });
  // 后缀互不抢：stop-chain 仍归一为 stop_chain（`/suspend` 与 `/stop-chain` 不同串）
  assert.deepEqual(parseWriteRoute("POST", "/features/F1/stop-chain"), { kind: "stop_chain", featureId: "F1" });
  assert.deepEqual(parseWriteRoute("POST", "/features/F1/turn"), { kind: "turn", featureId: "F1" });
  for (const [method, path] of [
    ["GET", "/features/F1/suspend"],
    ["PUT", "/features/F1/suspend"],
    ["POST", "/features/F1/suspend/"],
    ["POST", "/features//suspend"],
    ["POST", "/features/F1/x/suspend"],
    ["POST", "/suspend"],
    ["POST", "/features/suspend"],
    [undefined, "/features/F1/suspend"],
  ]) {
    assert.equal(isWriteRoute(method, path), false, `${method} ${path} 不得放行`);
    assert.equal(parseWriteRoute(method, path), null, `${method} ${path} 归一须为 null`);
  }
});

// ---------------------------------------------------------------------------
// ② parseSuspendForm（纯函数）
// ---------------------------------------------------------------------------

test("T7-③ parseSuspendForm：turnId 必填 + pending 重复键逐项非空去重保序 + wakeCond trim/空⇒null", () => {
  const raw = new URLSearchParams();
  raw.append("turnId", " turn-1 ");
  raw.append("pending", " t-1 ");
  raw.append("pending", "t-2");
  raw.append("pending", "t-1");
  raw.append("wakeCond", " 到 X 态 ");
  const r = parseSuspendForm(raw.toString());
  assert.equal(r.ok, true);
  assert.equal(r.turnId, "turn-1");
  assert.deepEqual(r.pending, ["t-1", "t-2"], "逐项 trim + 去重保序");
  assert.equal(r.wakeCond, "到 X 态");
});

test("T7-④ parseSuspendForm：空 pending = 纯 DAG 监视（合法）· 缺 turnId ⇒ 400 · pending 含空白项 ⇒ 400", () => {
  const pure = parseSuspendForm(new URLSearchParams({ turnId: "turn-1" }).toString());
  assert.equal(pure.ok, true);
  assert.deepEqual(pure.pending, [], "空清单 = 纯 DAG 监视，合法语义");
  assert.equal(pure.wakeCond, null);

  const noTurn = parseSuspendForm(new URLSearchParams({ pending: "t-1" }).toString());
  assert.equal(noTurn.ok, false);
  assert.equal(noTurn.status, 400);
  assert.equal(noTurn.code, SUSPEND_FORM_INVALID_CODE);

  const blankItem = parseSuspendForm(new URLSearchParams({ turnId: "turn-1", pending: "  " }).toString());
  assert.equal(blankItem.ok, false);
  assert.equal(blankItem.status, 400);
  assert.equal(blankItem.code, SUSPEND_FORM_INVALID_CODE);
});

test("T7-⑤ parseSuspendForm：wakeCond 超 400 字节 ⇒ 400（字段级，不是 body 级）· body 超 256KiB ⇒ 413", () => {
  const longCond = parseSuspendForm(
    new URLSearchParams({ turnId: "turn-1", wakeCond: "甲".repeat(200) }).toString(),
  );
  assert.equal(longCond.ok, false);
  assert.equal(longCond.status, 400);
  assert.equal(longCond.code, SUSPEND_FORM_INVALID_CODE);

  const big = parseSuspendForm("", 300_000);
  assert.equal(big.ok, false);
  assert.equal(big.status, 413);
  assert.equal(big.code, "payload_too_large");
});

// ---------------------------------------------------------------------------
// ③ 台账纯函数 + 文件层（内存事实源 / 启动清空 / 坏文件 fail-closed）
// ---------------------------------------------------------------------------

const ENTRY = {
  featureId: "F1",
  turnId: "turn-1",
  contextId: "ctx-1",
  pending: ["t-1"],
  wakeCond: null,
  firedKeys: [],
  createdAt: "2026-09-28T12:00:00Z",
};

test("T7-⑥ 台账纯函数：坏形状 ⇒ 空；条目缺 featureId/turnId/contextId ⇒ 丢；round-trip；upsert/remove/addFiredKey", () => {
  for (const bad of [null, undefined, 42, "x", [], {}]) {
    assert.deepEqual(parseSuspendLedger(bad), emptySuspendLedger(), JSON.stringify(bad));
  }
  assert.equal(parseSuspendedEntry({ featureId: "F1", turnId: "t", contextId: "c" }).pending.length, 0);
  assert.equal(parseSuspendedEntry({ turnId: "t", contextId: "c" }), null, "featureId 缺失 ⇒ 丢");
  assert.equal(parseSuspendedEntry({ featureId: "F1", contextId: "c" }), null, "turnId 缺失 ⇒ 丢");
  assert.equal(parseSuspendedEntry({ featureId: "F1", turnId: "t" }), null, "contextId 缺失 ⇒ 丢");

  const text = serializeSuspendLedger({ version: SUSPEND_LEDGER_VERSION, entries: [ENTRY] });
  assert.ok(text.endsWith("\n"));
  assert.deepEqual(parseSuspendLedger(JSON.parse(text)).entries, [ENTRY]);

  const base = emptySuspendLedger();
  const add = upsertSuspendedEntry(base, ENTRY);
  assert.equal(add.replaced, false);
  assert.deepEqual(base.entries, [], "纯函数不改动入参");
  const replace = upsertSuspendedEntry(add.ledger, { ...ENTRY, pending: ["t-2"] });
  assert.equal(replace.replaced, true);
  assert.equal(replace.ledger.entries.length, 1, "同 featureId = 覆盖不叠条目");

  assert.equal(removeSuspendedEntry(add.ledger, "F1").removed, true);
  assert.equal(removeSuspendedEntry(add.ledger, "F2").removed, false);

  const fired = addFiredKey(add.ledger, "F1", "k1");
  assert.equal(fired.changed, true);
  assert.deepEqual(fired.ledger.entries[0].firedKeys, ["k1"]);
  assert.equal(addFiredKey(fired.ledger, "F1", "k1").changed, false, "同键幂等");
  assert.equal(addFiredKey(fired.ledger, "F1", "  ").changed, false, "空键不记");
});

test("T7-⑦ 台账 store：arm/get/list/clear/recordFired；启动清空重写（新实例抹掉旧快照）；坏文件 fail-closed", () => {
  assert.ok(defaultSuspendLedgerFile("/tmp/board-x").endsWith(join(".data", "suspended.json")));
  const dir = mkdtempSync(join(tmpdir(), "board-t7-"));
  const file = join(dir, ".data", "suspended.json");
  try {
    const store = new SuspendLedgerStore(file);
    assert.ok(existsSync(file), "构造即写空快照（启动清空重写）");
    assert.deepEqual(store.load().ledger, emptySuspendLedger());

    const e = store.arm({ featureId: "F1", turnId: "turn-1", contextId: "ctx-1", pending: ["t-1"] }, "2026-09-28T12:00:00Z");
    assert.equal(e.createdAt, "2026-09-28T12:00:00Z");
    assert.equal(store.exists("F1"), true);
    assert.deepEqual(store.list().map((x) => x.featureId), ["F1"]);
    assert.deepEqual(parseSuspendLedger(JSON.parse(readFileSync(file, "utf8"))).entries, [e], "快照落盘");

    assert.equal(store.recordFired("F1", "k1"), true);
    assert.deepEqual(store.get("F1").firedKeys, ["k1"]);
    assert.equal(store.recordFired("F1", "k1"), false);

    // 重挂起 ⇒ 覆盖（firedKeys 归零）
    const again = store.arm({ featureId: "F1", turnId: "turn-2", contextId: "ctx-1", pending: [] }, "2026-09-28T13:00:00Z");
    assert.equal(store.list().length, 1);
    assert.deepEqual(again.firedKeys, []);
    assert.deepEqual(again.pending, []);
    assert.equal(again.wakeCond, null);

    assert.equal(store.clear("F1"), true);
    assert.equal(store.clear("F1"), false, "幂等");
    assert.equal(store.get("F1"), null);

    // 启动清空重写：把旧条目写回文件，再 new 一个 store ⇒ 内存与快照都被抹平
    store.arm({ featureId: "F2", turnId: "turn-9", contextId: "ctx-9", pending: [] });
    assert.equal(existsSync(file), true);
    const reopened = new SuspendLedgerStore(file);
    assert.deepEqual(reopened.list(), [], "重启即无链（内存 + 快照均清）");
    assert.deepEqual(parseSuspendLedger(JSON.parse(readFileSync(file, "utf8"))).entries, []);

    // 坏文件 fail-closed：load 回落空台账 + corrupt=true（不信任半截数据）
    const forensic = new SuspendLedgerStore(file);
    writeFileSync(file, "{ 这不是 JSON", "utf8");
    const bad = forensic.load();
    assert.equal(bad.corrupt, true);
    assert.deepEqual(bad.ledger, emptySuspendLedger());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ④ HTTP 路由面：turnId 归属（最新轮通过 / 旧轮 400 / 非板发 400）+ 停链清条目
// ---------------------------------------------------------------------------

function minimalClient() {
  return {
    baseUrl: "http://fake",
    async getFeatures() {
      return { features: [], stateCounts: null };
    },
    async getFeature() {
      throw new Error("挂起口不读引擎态");
    },
    async getFeatureTrace() {
      throw new Error("不该被触达");
    },
    async getProjects() {
      throw new Error("不该被触达");
    },
    async getTasks() {
      throw new Error("不该被触达");
    },
  };
}

function turnRecord(over = {}) {
  return {
    turnId: "turn-latest",
    requirementId: "F1",
    org: "g",
    contextId: "ctx-latest",
    taskId: null,
    state: "succeeded",
    summary: null,
    question: null,
    error: null,
    bridgeNote: null,
    queuedAt: "q",
    startedAt: "s",
    finishedAt: "f",
    updatedAt: "u",
    ...over,
  };
}

function fakeFace({ latest = turnRecord(), stopImpl } = {}) {
  const calls = { latest: [], stop: [] };
  return {
    calls,
    face: {
      latestTurnOf(featureId) {
        calls.latest.push(featureId);
        return latest;
      },
      async stopChain(featureId) {
        calls.stop.push(featureId);
        if (stopImpl !== undefined) return stopImpl(featureId);
        return {
          ok: true,
          featureId,
          chainStopped: true,
          cancelledTurnId: null,
          cancelDisplay: null,
          error: null,
          display: "已停链",
        };
      },
    },
  };
}

async function withServer(run, { face = fakeFace().face } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "board-t7-http-"));
  const file = join(dir, ".data", "suspended.json");
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client: minimalClient(),
    now: () => NOW,
    defaultGroup: "g",
    suspendLedgerFile: file,
    hostFace: face,
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`, file);
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const H = { "x-board-write": "1", accept: "application/json", "content-type": "application/x-www-form-urlencoded" };
function post(base, path, headers, body) {
  return fetch(`${base}${path}`, { method: "POST", redirect: "manual", headers, body });
}

test("T7-⑧ HTTP：最新轮 turnId ⇒ 200 + 登记台账（contextId 取该轮；快照落盘）· 旧轮/无板发轮 ⇒ 400 归属不符", async () => {
  const { face, calls } = fakeFace();
  await withServer(
    async (base, file) => {
      const body = new URLSearchParams();
      body.append("turnId", "turn-latest");
      body.append("pending", "t-1");
      const res = await post(base, "/features/F1/suspend", H, body.toString());
      assert.equal(res.status, 200);
      const payload = await res.json();
      assert.equal(payload.ok, true);
      assert.equal(payload.turnId, "turn-latest");
      assert.equal(payload.contextId, "ctx-latest", "contextId 取该板发轮记录");
      assert.deepEqual(payload.pending, ["t-1"]);
      assert.deepEqual(calls.latest, ["F1"]);
      assert.deepEqual(parseSuspendLedger(JSON.parse(readFileSync(file, "utf8"))).entries, [
        {
          featureId: "F1",
          turnId: "turn-latest",
          contextId: "ctx-latest",
          pending: ["t-1"],
          wakeCond: null,
          firedKeys: [],
          createdAt: new Date(NOW).toISOString(),
        },
      ]);
    },
    { face },
  );

  // 旧轮 turnId（不是最新）⇒ 400 归属不符，零登记
  const old = fakeFace({ latest: turnRecord({ turnId: "turn-new" }) });
  await withServer(
    async (base, file) => {
      const res = await post(base, "/features/F1/suspend", H, new URLSearchParams({ turnId: "turn-old" }).toString());
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, SUSPEND_TURN_MISMATCH_CODE);
      assert.deepEqual(parseSuspendLedger(JSON.parse(readFileSync(file, "utf8"))).entries, [], "归属不符不得登记");
    },
    { face: old.face },
  );

  // 非板发 / 无板发轮（latestTurnOf ⇒ null）⇒ 400
  const none = fakeFace({ latest: null });
  await withServer(
    async (base) => {
      const res = await post(base, "/features/F1/suspend", H, new URLSearchParams({ turnId: "turn-x" }).toString());
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, SUSPEND_TURN_MISMATCH_CODE);
    },
    { face: none.face },
  );
});

test("T7-⑨ HTTP 负向：缺守卫头 ⇒ 403 · 表单校验失败 ⇒ 400 · 宿主面未装配 ⇒ 503 · GET 同径 ⇒ 404", async () => {
  const { face, calls } = fakeFace();
  await withServer(async (base) => {
    const noProof = await post(base, "/features/F1/suspend", { accept: "application/json" }, "turnId=turn-latest");
    assert.equal(noProof.status, 403);
    assert.equal(calls.latest.length, 0, "CSRF 先于一切，不触宿主面");

    const noTurn = await post(base, "/features/F1/suspend", H, "pending=t-1");
    assert.equal(noTurn.status, 400);
    assert.equal((await noTurn.json()).code, SUSPEND_FORM_INVALID_CODE);
    assert.equal(calls.latest.length, 0, "表单校验失败不触宿主面");
  }, { face });

  await withServer(async (base) => {
    const res = await post(base, "/features/F1/suspend", H, "turnId=turn-latest");
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, "host_face_disabled");
  }, { face: null });

  await withServer(async (base) => {
    const res = await fetch(`${base}/features/F1/suspend`);
    assert.equal(res.status, 404);
  });
});

test("T7-⑩ HTTP：停链 ⇒ 同条目清（suspendCleared=true，快照抹平；与停链标志同生死）", async () => {
  const { face } = fakeFace();
  await withServer(
    async (base, file) => {
      const armed = await post(
        base,
        "/features/F1/suspend",
        H,
        new URLSearchParams({ turnId: "turn-latest", pending: "t-1" }).toString(),
      );
      assert.equal(armed.status, 200);
      assert.equal(parseSuspendLedger(JSON.parse(readFileSync(file, "utf8"))).entries.length, 1, "先登记一条");

      const stopped = await post(base, "/features/F1/stop-chain", H, "");
      assert.equal(stopped.status, 200);
      const payload = await stopped.json();
      assert.equal(payload.suspendCleared, true, "停链回执带清条目结果");
      assert.deepEqual(parseSuspendLedger(JSON.parse(readFileSync(file, "utf8"))).entries, [], "停链 ⇒ 同条目清");
    },
    { face },
  );
});

// ---------------------------------------------------------------------------
// ⑤ C9：提示词指针 + 模板内容
// ---------------------------------------------------------------------------

test("T7-⑪ C9：buildTurnPrompt 增挂起口指针句（不出现任何 MCP 工具全名）", () => {
  const p = buildTurnPrompt({ featureId: "F1", org: "g" });
  assert.match(p, /本轮若下发子任务/);
  assert.match(p, /挂起口/);
  assert.match(p, /AGENTS\.md/);
  for (const forbidden of ["a2a_call", "a2a_feature_approve", "a2a_feature_advance", "a2a_feature_cancel"]) {
    assert.equal(p.includes(forbidden), false, `提示词不得出现工具全名 ${forbidden}`);
  }
});

test("T7-⑫ C9：模板含挂起口纪律段（地址/schema/先调口再退出）与触发来源分野段", async () => {
  const { readFileSync: read } = await import("node:fs");
  const tpl = read(join(process.cwd(), "templates", "org", "AGENTS.template.md"), "utf8");
  assert.match(tpl, /127\.0\.0\.1:3400\/features\/\{id\}\/suspend/, "挂起口地址");
  assert.match(tpl, /x-board-write: 1/, "鉴权头");
  for (const key of ["turnId", "pending", "wakeCond"]) {
    assert.ok(tpl.includes(key), `schema 字段 ${key} 应在模板内`);
  }
  assert.match(tpl, /先调(板侧)?挂起口再退出/, "「下发子任务先调口再退出」全文");
  assert.match(tpl, /触发来源分野/, "分野段");
  assert.match(tpl, /watch-task\.mjs/, "客户端触发用 watch 脚本自等");
});

test("T7-⑬ B1（v0.9.6 模板接入）：模板 §3 指针指向 `flow/spec/文档模板.md` 且不再指向 planlog 台账", async () => {
  const { readFileSync: read } = await import("node:fs");
  const tpl = read(join(process.cwd(), "templates", "org", "AGENTS.template.md"), "utf8");
  assert.match(tpl, /Step 0、Step 1 产出物先读 `flow\/spec\/文档模板\.md` 对应节、按模板骨架成文/, "指针措辞（先读对应节、按骨架成文）");
  assert.equal(tpl.includes("`planlog.md` 的「当前步骤」已更新"), false, "推进条件② 已改述为「需求池标记以引擎为准」");
});
