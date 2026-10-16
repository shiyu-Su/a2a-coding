/**
 * v0.10.0 **O2c**（REQ-v0.10.0-2026-09-24-01 · 改造文档 §2.1(2)）——
 * 设状态端点 + 引擎内部 `notstart → active` 自动转换 + 三护栏。
 *
 * 锁定的行为面：
 * 1. **PATCH 设状态**（`/api/versions/{version}/status`）：`notstart ↔ active` ⇒ 200；`released`
 *    转 {@link markVersionReleased}（发版闸 + 快照同事务）；未知版号 ⇒ 404；非法 status ⇒ 400；
 *    非 PATCH ⇒ 405；follower ⇒ 503；回执带三护栏参数（节流窗口）；
 * 2. **`released` 终态不可回退**：已是 `released` 再改态 ⇒ 409 `orch_version_released_locked`；
 * 3. **发版闸复用 O4**：未收口 ⇒ 409 `orch_version_not_converged`（不是临时聚合计数）；
 * 4. **自动转换**：`approve` 放行 / 首个节点派发触发 `notstart → active`，落 `version.activated`
 *    事件；写口**幂等**（重复触发零写入、零事件）；
 * 5. **三护栏**：幂等（写口层）/ 不阻断（触发绝不抛）/ 节流（同键窗口内至多一次）。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前（默认存储惰性打开）

import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  close,
  createFeature,
  ERR_VERSION_RELEASED_LOCKED,
  ERR_VERSION_UNKNOWN,
  EVENT_VERSION_ACTIVATED,
  EVENT_VERSION_STATUS_CHANGED,
  listEvents,
  updateFeatureState,
  versionLedgerActivate,
  versionLedgerCreate,
  versionLedgerStatus,
} from "../session/store.js";
import { handleFeatureAdvance, handleFeatureApprove, handleFeatureCreate } from "../bridge/feature-tools.js";
import { startHttpTransport } from "../bridge/transports/http.js";
import type { HttpTransportHandle } from "../bridge/transports/http.js";
import {
  ERR_VERSIONS_BAD_REQUEST,
  ERR_VERSIONS_METHOD_NOT_ALLOWED,
  ERR_VERSIONS_NOT_OWNER,
  VERSIONS_COLLECTION_PATH,
  createVersionsEndpoints,
  type VersionsEndpointOptions,
} from "../bridge/versions-endpoints.js";
import {
  VERSION_ACTIVATION_THROTTLE_MS,
  VersionActivator,
} from "../bridge/versions-activation.js";
import type { BridgeCore } from "../bridge/index.js";
import type { FeatureState } from "../types.js";

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

const transports: HttpTransportHandle[] = [];

after(async () => {
  for (const transport of transports) await transport.close();
  close();
});

function resetToMemory(): void {
  process.env["SESSION_DB"] = ":memory:";
  close();
}

function unused(name: string): never {
  throw new Error(`unused BridgeCore method: ${name}`);
}

function fakeCore(): BridgeCore {
  return {
    projects: async () => unused("projects"),
    tasks: async () => unused("tasks"),
    call: async () => unused("call"),
    registerFeatureNode: () => unused("registerFeatureNode"),
    taskStatus: async () => unused("taskStatus"),
    cancel: async () => unused("cancel"),
    events: () => unused("events"),
    wait: async () => unused("wait"),
    featureCreate: () => unused("featureCreate"),
    featureStatus: () => unused("featureStatus"),
    featureAdvance: () => unused("featureAdvance"),
    featureApprove: () => unused("featureApprove"),
    featureCancel: () => unused("featureCancel"),
    featureTrace: () => unused("featureTrace"),
    configWriteGroup: async () => unused("configWriteGroup"),
    kickScheduler: () => unused("kickScheduler"),
  };
}

async function startHarness(overrides: Partial<VersionsEndpointOptions> = {}): Promise<number> {
  const handle = createVersionsEndpoints({ role: () => "owner", ...overrides });
  const transport = await startHttpTransport({
    core: fakeCore(),
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
    isReady: () => true,
    role: () => "owner",
    version: "test",
    onShutdown: () => {
      /* 测试不触发停机 */
    },
    versions: handle,
  });
  transports.push(transport);
  return transport.port;
}

interface HttpResult {
  status: number;
  body: Record<string, unknown> | null;
  text: string;
}

async function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<HttpResult> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* 204 无体 / 非 JSON */
  }
  return { status: res.status, body: parsed, text };
}

function assertFailureEnvelope(res: HttpResult, code: string): void {
  assert.equal(res.body?.["ok"], false, `信封 ok 应为 false（实际 ${res.text}）`);
  const error = res.body?.["error"] as { code?: string; message?: string } | undefined;
  assert.equal(error?.code, code, `错误码应为 ${code}（实际 ${error?.code}）`);
  assert.equal(typeof error?.message, "string", "信封缺 error.message");
}

function statusPath(version: string): string {
  return `${VERSIONS_COLLECTION_PATH}/${version}/status`;
}

function eventsOfKind(kind: string): number {
  return listEvents({ limit: 1000 }).filter((e) => e.kind === kind).length;
}

/** 造一张该版号名下的卡（默认匿名档），可指定终态。 */
function seedCard(
  featureId: string,
  ownerGroup: string | null,
  version: string,
  state?: FeatureState,
): void {
  createFeature({ featureId, title: `卡 ${featureId}`, ownerGroup, version });
  if (state !== undefined) updateFeatureState(featureId, state);
}

// ---------------------------------------------------------------------------
// 1：PATCH notstart ↔ active（人工写口）
// ---------------------------------------------------------------------------

test("O2c PATCH：active / notstart 互改 ⇒ 200；回执带三护栏参数（节流窗口）", async () => {
  resetToMemory();
  const port = await startHarness();

  const created = await request(port, "POST", VERSIONS_COLLECTION_PATH, {
    ownerGroup: "g1",
    version: "9.9.9",
  });
  assert.equal(created.status, 201);

  const toActive = await request(port, "PATCH", statusPath("9.9.9"), {
    ownerGroup: "g1",
    status: "active",
  });
  assert.equal(toActive.status, 200, `设 active 应 200（实际 ${toActive.status} ${toActive.text}）`);
  assert.equal(toActive.body?.["ok"], true);
  assert.equal(toActive.body?.["status"], "active");
  const guardrails = toActive.body?.["guardrails"] as Record<string, unknown> | undefined;
  assert.equal(guardrails?.["idempotent"], true);
  assert.equal(guardrails?.["nonBlocking"], true);
  assert.equal(guardrails?.["throttleMs"], VERSION_ACTIVATION_THROTTLE_MS);

  const toNotstart = await request(port, "PATCH", statusPath("9.9.9"), {
    ownerGroup: "g1",
    status: "notstart",
  });
  assert.equal(toNotstart.status, 200);
  assert.equal(toNotstart.body?.["status"], "notstart");

  // 人工改态落 version.status_changed 事件（两次真变各一条；同值幂等不落）
  assert.equal(eventsOfKind(EVENT_VERSION_STATUS_CHANGED), 2);
  const idem = await request(port, "PATCH", statusPath("9.9.9"), {
    ownerGroup: "g1",
    status: "notstart",
  });
  assert.equal(idem.status, 200);
  assert.equal(eventsOfKind(EVENT_VERSION_STATUS_CHANGED), 2, "同值重写幂等 ⇒ 不落第二条事件");
});

test("O2c PATCH 入参 / 路由判据：非法 status 400 · 未知版号 404 · 非 PATCH 405 · follower 503", async () => {
  resetToMemory();
  const port = await startHarness();

  assertFailureEnvelope(
    await request(port, "PATCH", statusPath("1.0.0"), { status: "weird" }),
    ERR_VERSIONS_BAD_REQUEST,
  );
  assertFailureEnvelope(
    await request(port, "PATCH", statusPath("1.0.0"), {}),
    ERR_VERSIONS_BAD_REQUEST,
  );
  assertFailureEnvelope(
    await request(port, "PATCH", statusPath("1.0.0"), { status: "active" }),
    ERR_VERSION_UNKNOWN,
  );
  assertFailureEnvelope(
    await request(port, "GET", statusPath("1.0.0")),
    ERR_VERSIONS_METHOD_NOT_ALLOWED,
  );

  const followerPort = await startHarness({ role: () => "follower" });
  assertFailureEnvelope(
    await request(followerPort, "PATCH", statusPath("1.0.0"), { status: "active" }),
    ERR_VERSIONS_NOT_OWNER,
  );
});

// ---------------------------------------------------------------------------
// 2：PATCH released（发版闸 O4 复用 + 终态不可回退）
// ---------------------------------------------------------------------------

test("O2c PATCH released：收口过闸 ⇒ 200 + status released + 快照；未收口 ⇒ 409 orch_version_not_converged", async () => {
  resetToMemory();
  const port = await startHarness();

  // 未收口：名下卡还在飞 ⇒ 挡闸（复用 O4 evaluateReleaseGate，非临时聚合）
  await request(port, "POST", VERSIONS_COLLECTION_PATH, { ownerGroup: "g1", version: "1.0.0" });
  seedCard("f-open", "g1", "1.0.0");
  const blocked = await request(port, "PATCH", statusPath("1.0.0"), {
    ownerGroup: "g1",
    status: "released",
  });
  assert.equal(blocked.status, 409, `未收口应 409（实际 ${blocked.status} ${blocked.text}）`);
  assertFailureEnvelope(blocked, "orch_version_not_converged");

  // 收口：同版号下另一张 completed 卡 ⇒ 过闸
  await request(port, "POST", VERSIONS_COLLECTION_PATH, { ownerGroup: "g1", version: "2.0.0" });
  seedCard("f-done", "g1", "2.0.0", "completed");
  const released = await request(port, "PATCH", statusPath("2.0.0"), {
    ownerGroup: "g1",
    status: "released",
    projects: [{ repoId: "r1", ref: "v2.0.0" }],
  });
  assert.equal(released.status, 200, `过闸应 200（实际 ${released.status} ${released.text}）`);
  assert.equal(released.body?.["status"], "released");
  assert.equal(released.body?.["statusMigrated"], true);
  assert.equal(released.body?.["snapshotWritten"], true);
});

test("O2c released 终态不可回退：已 released ⇒ 改 active / notstart 一律 409 orch_version_released_locked", async () => {
  resetToMemory();
  const port = await startHarness();
  await request(port, "POST", VERSIONS_COLLECTION_PATH, { ownerGroup: "g1", version: "3.0.0" });
  seedCard("f-r", "g1", "3.0.0", "completed");
  const released = await request(port, "PATCH", statusPath("3.0.0"), {
    ownerGroup: "g1",
    status: "released",
  });
  assert.equal(released.status, 200);

  for (const target of ["active", "notstart"]) {
    const back = await request(port, "PATCH", statusPath("3.0.0"), {
      ownerGroup: "g1",
      status: target,
    });
    assert.equal(back.status, 409, `released → ${target} 应 409（实际 ${back.status}）`);
    assertFailureEnvelope(back, ERR_VERSION_RELEASED_LOCKED);
  }
});

// ---------------------------------------------------------------------------
// 3：自动转换（写口幂等 + 事件）
// ---------------------------------------------------------------------------

test("O2c 自动转换：versionLedgerActivate 幂等 → 一次 notstart→active + 一条 version.activated 事件", () => {
  resetToMemory();
  const version = "0.10.0";
  const created = versionLedgerCreate({ ownerGroup: null, version });
  assert.equal(created.ok, true);

  const first = versionLedgerActivate(null, version);
  assert.equal(first.activated, true);
  assert.equal(first.status, "active");
  assert.equal(versionLedgerStatus(null, version).status, "active");
  assert.equal(eventsOfKind(EVENT_VERSION_ACTIVATED), 1);

  const second = versionLedgerActivate(null, version);
  assert.equal(second.activated, false);
  assert.equal(eventsOfKind(EVENT_VERSION_ACTIVATED), 1, "重复触发不得再落事件");

  // 行不存在 ⇒ 不建行、不落事件
  const missing = versionLedgerActivate(null, "8.8.8");
  assert.equal(missing.activated, false);
  assert.equal(missing.status, null);
  assert.equal(eventsOfKind(EVENT_VERSION_ACTIVATED), 1);
});

test("O2c 自动转换触发点 approve：waiting_approval 过审 ⇒ 版号 notstart→active + 事件", () => {
  resetToMemory();
  const version = "2.2.2";
  assert.equal(versionLedgerCreate({ ownerGroup: null, version }).ok, true);

  const created = handleFeatureCreate({ title: "首卡", version });
  assert.equal(created.ok, true, `建卡应成功（实际 ${JSON.stringify(created)}）`);
  if (!created.ok) return;
  assert.equal(versionLedgerStatus(null, version).status, "notstart", "approve 前仍 notstart");

  // v0.10.5 O6 过门序列：create 不收 stage/approval（初值恒「需求分析 / 未发起」）⇒
  // approve 前须经 advance 登记抬门（version 已在 create 写定，门① version 守卫直接满足；
  // 增补 bbc7ea28 O3 第二前提 ⇒ 抬 stage 同单登记《需求确认单》档名）
  const staged = handleFeatureAdvance({
    featureId: created.featureId,
    to: "waiting_approval",
    stage: "改造方案",
    decisions: '["doc/v0.10.0/夹具-需求确认单.md","doc/v0.10.0/夹具-改造文档.md"]',
  });
  assert.equal(staged.ok, true, `登记 stage 应成功（实际 ${JSON.stringify(staged)}）`);
  const gated = handleFeatureAdvance({ featureId: created.featureId, to: "waiting_approval", approval: "待审批" });
  assert.equal(gated.ok, true, `登记 approval 应成功（实际 ${JSON.stringify(gated)}）`);

  const approved = handleFeatureApprove({ featureId: created.featureId });
  assert.equal(approved.ok, true, `approve 应成功（实际 ${JSON.stringify(approved)}）`);
  assert.equal(versionLedgerStatus(null, version).status, "active");
  assert.equal(eventsOfKind(EVENT_VERSION_ACTIVATED), 1);
});

// ---------------------------------------------------------------------------
// 4：三护栏（节流 / 不阻断）
// ---------------------------------------------------------------------------

test("O2c 护栏·节流：同键窗口内至多一次；窗口过后放行", () => {
  let calls = 0;
  let nowMs = 1_000_000;
  const activator = new VersionActivator({
    port: {
      activate: () => {
        calls += 1;
        return { activated: false, status: null, ledgerReady: true };
      },
    },
    throttleMs: 5_000,
    now: () => nowMs,
  });

  assert.equal(activator.activate("g1", "1.0.0", "dispatch").throttled, false);
  const second = activator.activate("g1", "1.0.0", "dispatch");
  assert.equal(second.throttled, true, "窗口内第二次应节流");
  assert.equal(calls, 1, "节流跳过者不得触达写口");

  nowMs += 5_001;
  assert.equal(activator.activate("g1", "1.0.0", "dispatch").throttled, false);
  assert.equal(calls, 2, "窗口过后放行");

  // 不同键互不影响
  assert.equal(activator.activate("g2", "1.0.0", "dispatch").throttled, false);
  assert.equal(calls, 3);
});

test("O2c 护栏·不阻断：写口抛错时触发不抛出，返回 activated=false", () => {
  const activator = new VersionActivator({
    port: {
      activate: () => {
        throw new Error("boom");
      },
    },
    throttleMs: 0,
  });
  // 写口抛错 ⇒ 护栏吞掉并返回（若抛则本行整体失败 ⇒ 即「不阻断」反证）
  const outcome = activator.activate("g1", "1.0.0", "dispatch");
  assert.equal(outcome.activated, false);
  assert.equal(outcome.throttled, false);
});

test("O2c 护栏·命中即解除节流：激活成功后重复触发走写口（非节流跳过）", () => {
  let calls = 0;
  const activator = new VersionActivator({
    port: {
      activate: () => {
        calls += 1;
        return calls === 1
          ? { activated: true, status: "active", ledgerReady: true }
          : { activated: false, status: "active", ledgerReady: true };
      },
    },
    throttleMs: 60_000,
  });
  assert.equal(activator.activate("g1", "1.0.0", "dispatch").activated, true);
  const again = activator.activate("g1", "1.0.0", "dispatch");
  assert.equal(again.throttled, false, "命中后解除节流 ⇒ 第二次仍触达写口（幂等 no-op）");
  assert.equal(calls, 2);
});
