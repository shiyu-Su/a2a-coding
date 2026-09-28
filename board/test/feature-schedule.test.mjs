import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildScheduleAdvanceArgs,
  buildToolsCallRequest,
  parseToolCallEnvelope,
  scheduleFeature,
  buildMcpEndpoint,
  FEATURE_ADVANCE_TOOL,
  FeatureScheduleConfigError,
} from "../dist/feature-schedule.js";

function okEnvelope(payload) {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false },
  };
}

// ---------------------------------------------------------------------------
// 断言①：出参键集合 ⊆ {featureId,to,version}，绝不携带 stage/approval
// ---------------------------------------------------------------------------

test("buildScheduleAdvanceArgs: 出参键集合恰好 = {featureId,to,version}", () => {
  const args = buildScheduleAdvanceArgs({ featureId: "F1", to: "executing", version: "v0.9.2" });
  assert.deepEqual(Object.keys(args).sort(), ["featureId", "to", "version"]);
  assert.ok(!("stage" in args), "排期写不得携带 stage");
  assert.ok(!("approval" in args), "排期写不得携带 approval");
});

test("buildScheduleAdvanceArgs: to 恒等传入的当前态（不加工、不回落）", () => {
  for (const to of ["waiting_approval", "executing", "integrating", "testing", "reviewing", "completed"]) {
    assert.equal(buildScheduleAdvanceArgs({ featureId: "F1", to, version: "v0.9.2" }).to, to);
  }
});

// v0.9.4 N4 semver 收口（改造文档 §2.5）：排期写口三态 —— 合法放行 / 非法拒 / 清空 \"\" 放行（取消排期）。
test("buildScheduleAdvanceArgs（N4 · 三态）: 合法 x.y.z 放行；清空 \"\" = 取消排期放行；非 x.y.z 抛 FeatureScheduleConfigError", () => {
  assert.equal(buildScheduleAdvanceArgs({ featureId: "F1", to: "executing", version: "v0.9.4" }).version, "v0.9.4");
  assert.equal(buildScheduleAdvanceArgs({ featureId: "F1", to: "executing", version: "  v0.10.0  " }).version, "v0.10.0");
  // 清空 = 取消排期的合法值 ⇒ 放行（键仍在）
  assert.equal(buildScheduleAdvanceArgs({ featureId: "F1", to: "executing", version: "" }).version, "");
  // 非法（含验收点名 v0.9.1-probe 类）⇒ 先于网络拒
  for (const bad of ["v0.9.1-probe", "1.0", "v1", "v0.9", "^0.9.4", "latest", "0.9.4.1"]) {
    assert.throws(
      () => buildScheduleAdvanceArgs({ featureId: "F1", to: "executing", version: bad }),
      FeatureScheduleConfigError,
      `expected ${JSON.stringify(bad)} rejected`,
    );
  }
});

// ---------------------------------------------------------------------------
// 断言②：清空排期 ⇒ version === "" 且键存在
// ---------------------------------------------------------------------------

test("buildScheduleAdvanceArgs: 清空 ⇒ version === \"\" 且 version 键存在", () => {
  const args = buildScheduleAdvanceArgs({ featureId: "F1", to: "executing", version: "" });
  assert.equal(args.version, "");
  assert.ok("version" in args, "清空是显式发空串，不是省略键");
});

test("buildScheduleAdvanceArgs: version 键缺失 = 编程错误抛出（类型层封死的运行期兜底）", () => {
  assert.throws(
    () => buildScheduleAdvanceArgs({ featureId: "F1", to: "executing" }),
    FeatureScheduleConfigError,
  );
});

test("buildScheduleAdvanceArgs: 空 featureId / 空 to 抛出", () => {
  assert.throws(() => buildScheduleAdvanceArgs({ featureId: "  ", to: "executing", version: "v0.9.2" }), FeatureScheduleConfigError);
  assert.throws(() => buildScheduleAdvanceArgs({ featureId: "F1", to: "  ", version: "v0.9.2" }), FeatureScheduleConfigError);
});

// ---------------------------------------------------------------------------
// 断言③：端到端出网参数锁定（工具名 = advance、arguments 仅三键、无 stage/approval）
// ---------------------------------------------------------------------------

test("scheduleFeature: 出网 body 的 name = a2a_feature_advance 且 arguments 只有三键", async () => {
  let body = null;
  const fetchImpl = async (_url, init) => {
    body = JSON.parse(String(init.body));
    return new Response(JSON.stringify(okEnvelope({ ok: true, featureId: "F1", state: "executing", version: "v0.9.2" })), { status: 200 });
  };
  const out = await scheduleFeature({ featureId: "F1", to: "executing", version: "v0.9.2" }, { group: "g", fetchImpl });
  assert.equal(out.ok, true);
  assert.equal(body.params.name, FEATURE_ADVANCE_TOOL);
  assert.deepEqual(Object.keys(body.params.arguments).sort(), ["featureId", "to", "version"]);
  assert.equal(body.params.arguments.to, "executing");
});

test("scheduleFeature: 清空排期出网 version === \"\"", async () => {
  let body = null;
  const fetchImpl = async (_url, init) => {
    body = JSON.parse(String(init.body));
    return new Response(JSON.stringify(okEnvelope({ ok: true, featureId: "F1", state: "executing", version: "" })), { status: 200 });
  };
  const out = await scheduleFeature({ featureId: "F1", to: "executing", version: "" }, { group: "g", fetchImpl });
  assert.equal(out.ok, true);
  assert.equal(out.version, "");
  assert.equal(body.params.arguments.version, "");
  assert.ok("version" in body.params.arguments);
});

test("scheduleFeature: 桥拒（如态漂移）结构化透传、不吞", async () => {
  const out = await scheduleFeature(
    { featureId: "F1", to: "executing", version: "v0.9.2" },
    { group: "g", fetchImpl: async () => new Response(JSON.stringify(okEnvelope({ ok: false, code: "feature_illegal_transition", error: "to 非当前态" })), { status: 200 }) },
  );
  assert.equal(out.ok, false);
  assert.equal(out.code, "feature_illegal_transition");
});

test("scheduleFeature: 空组名先于网络抛错", () => {
  assert.throws(() => buildMcpEndpoint("http://127.0.0.1:8787", "  "), FeatureScheduleConfigError);
});

test("parseToolCallEnvelope: 成功归一 state/version；缺 featureId 落 response_invalid", () => {
  const ok = parseToolCallEnvelope(okEnvelope({ ok: true, featureId: "F1", state: "executing", version: "v1" }));
  assert.equal(ok.ok, true);
  assert.equal(ok.version, "v1");
  const bad = parseToolCallEnvelope(okEnvelope({ ok: true, state: "executing" }));
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "response_invalid");
});

test("buildToolsCallRequest: params.name 固定为 advance 工具名", () => {
  const req = buildToolsCallRequest({ featureId: "F1", to: "executing", version: "v1" }, 7);
  assert.equal(req.method, "tools/call");
  assert.equal(req.id, 7);
  assert.equal(req.params.name, FEATURE_ADVANCE_TOOL);
});
