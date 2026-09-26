import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isWriteRoute,
  checkWriteAuth,
  parseRequirementForm,
  parseScheduleForm,
  GROUP_REQUIRED_CODE,
  WRITE_GUARD_HEADER,
  WRITE_GUARD_HEADER_VALUE,
  REQUIREMENTS_WRITE_PATH,
  MAX_REQUIREMENT_BODY_BYTES,
  ScheduleFormProgrammingError,
} from "../dist/write-guard.js";

const HOST = "127.0.0.1:3400";

test("isWriteRoute：只放开 POST /requirements 一条路径", () => {
  assert.equal(isWriteRoute("POST", REQUIREMENTS_WRITE_PATH), true);
  for (const [method, path] of [
    ["GET", "/requirements"],
    ["PUT", "/requirements"],
    ["PATCH", "/requirements"],
    ["DELETE", "/requirements"],
    ["POST", "/"],
    ["POST", "/tasks"],
    ["POST", "/features/F1"],
    ["POST", "/requirements/"],
    ["POST", "/requirements/x"],
    [undefined, "/requirements"],
  ]) {
    assert.equal(isWriteRoute(method, path), false, `${method} ${path} 不得放行`);
  }
});

test(`守卫头名为 ${WRITE_GUARD_HEADER}（README 同步），值取 ${WRITE_GUARD_HEADER_VALUE}`, () => {
  assert.equal(WRITE_GUARD_HEADER, "x-board-write");
  assert.equal(WRITE_GUARD_HEADER_VALUE, "1");
});

test("checkWriteAuth：自定义守卫头档放行（跨站也放行是设计：API 调用方显式声明）", () => {
  const out = checkWriteAuth({ method: "POST", proto: "http", headers: { host: HOST, [WRITE_GUARD_HEADER]: "1" } });
  assert.deepEqual(out, { ok: true, via: "header" });
});

test("checkWriteAuth（负向）：无守卫头 + 跨站 Origin ⇒ 拒；错误码区分'来源不可知'与'明确跨站'", () => {
  const crossSite = checkWriteAuth({
    method: "POST",
    proto: "http",
    headers: { host: HOST, origin: "http://evil.example" },
  });
  assert.equal(crossSite.ok, false);
  assert.equal(crossSite.code, "write_guard_origin");

  const noProof = checkWriteAuth({ method: "POST", proto: "http", headers: { host: HOST } });
  assert.equal(noProof.ok, false);
  assert.equal(noProof.code, "write_guard_origin_unknown", "无任何来源证据 = 来源不可知，不是跨站");
  assert.match(noProof.error, /无法确认请求来源/);
  assert.match(noProof.error, /表单/);
  assert.match(noProof.error, /x-board-write: 1/, "文案须给出 API 调用方可照做的头");
  assert.match(noProof.error, /白名单/, "文案须给出'浏览器屏蔽 Origin/Referer'时的补救");

  const wrongValue = checkWriteAuth({
    method: "POST",
    proto: "http",
    headers: { host: HOST, [WRITE_GUARD_HEADER]: "yes-please", origin: "http://evil.example" },
  });
  assert.equal(wrongValue.ok, false);
  assert.equal(wrongValue.code, "write_guard_origin", "头值不精确匹配 ⇒ 视为未携带");
});

test("checkWriteAuth：同源判定对端口缺省写法与大小写不敏感", () => {
  const cases = [
    { origin: "http://127.0.0.1:3400" },
    { origin: "HTTP://127.0.0.1:3400/" },
    { referer: `http://${HOST}/features/F1` },
  ];
  for (const c of cases) {
    const out = checkWriteAuth({ method: "POST", proto: "http", headers: { host: HOST, ...c } });
    assert.equal(out.ok, true, `${JSON.stringify(c)} 应判同源`);
  }
  // 字面 `null` 且无 Referer ⇒ 来源不可知 ⇒ 拒（BD16：不是跨站，见下条用例）
  const opaque = checkWriteAuth({ method: "POST", proto: "http", headers: { host: HOST, origin: "null" } });
  assert.equal(opaque.ok, false);
  assert.equal(opaque.code, "write_guard_origin_unknown");
  // 缺省端口（Host 不带端口）与 Origin 带 :80 等价
  const implicitPort = checkWriteAuth({
    method: "POST",
    proto: "http",
    headers: { host: "example.test", origin: "http://example.test:80" },
  });
  assert.equal(implicitPort.ok, true);
  // IPv6 loopback
  const v6 = checkWriteAuth({
    method: "POST",
    proto: "http",
    headers: { host: "[::1]:3400", origin: "http://[::1]:3400" },
  });
  assert.equal(v6.ok, true);
  // Referer 前缀相似的主机不得算同源
  const prefixTrap = checkWriteAuth({
    method: "POST",
    proto: "http",
    headers: { host: HOST, referer: "http://127.0.0.1:3400.evil.example/x" },
  });
  assert.equal(prefixTrap.ok, false);
});

test("checkWriteAuth：无 Host 头时不得放行 Origin 档", () => {
  const out = checkWriteAuth({ method: "POST", proto: "http", headers: { origin: "http://127.0.0.1:3400" } });
  assert.equal(out.ok, false);
});

// ---------------------------------------------------------------------------
// BD16：`Origin`「来源不可知」三值（缺失 / 空串 / 字面 null）⇒ 退 Referer，不得当跨站拒
// ---------------------------------------------------------------------------

const SAME_REFERER = `http://${HOST}/features/F1`;

test("BD16-① Origin 缺失 + 同源 Referer ⇒ 放行（via=referer）", () => {
  const out = checkWriteAuth({
    method: "POST",
    proto: "http",
    headers: { host: HOST, referer: SAME_REFERER },
  });
  assert.deepEqual(out, { ok: true, via: "referer" });
});

test("BD16-② Origin 字面 null + 同源 Referer ⇒ 放行（真机报障：隐私扩展 / sandboxed iframe）", () => {
  for (const origin of ["null", " null ", "NULL"]) {
    const out = checkWriteAuth({ method: "POST", proto: "http", headers: { host: HOST, origin, referer: SAME_REFERER } });
    assert.deepEqual(out, { ok: true, via: "referer" }, `Origin = ${JSON.stringify(origin)} 属来源不可知，必须退 Referer`);
  }
});

test("BD16-③ Origin 空串 / 纯空白 + 同源 Referer ⇒ 放行", () => {
  for (const origin of ["", "   "]) {
    const out = checkWriteAuth({ method: "POST", proto: "http", headers: { host: HOST, origin, referer: SAME_REFERER } });
    assert.deepEqual(out, { ok: true, via: "referer" }, `Origin = ${JSON.stringify(origin)} 属来源不可知，必须退 Referer`);
  }
});

test("BD16-④（回归锚 · 不放宽）有名 Origin 且不同源 ⇒ 仍拒 write_guard_origin，即使 Referer 同源", () => {
  for (const origin of ["http://evil.example", "https://127.0.0.1:3400", "http://127.0.0.1:3401", "not-a-url"]) {
    const out = checkWriteAuth({ method: "POST", proto: "http", headers: { host: HOST, origin, referer: SAME_REFERER } });
    assert.equal(out.ok, false, `Origin = ${origin} 必须拒`);
    assert.equal(out.code, "write_guard_origin", "明确跨站不得被并入'来源不可知'");
    assert.match(out.error, /不同源/);
  }
});

test("BD16-⑤（负向）Origin 与 Referer 皆不可用 ⇒ 拒 write_guard_origin_unknown + 可操作文案", () => {
  const cases = [
    { host: HOST },
    { host: HOST, origin: "null" },
    { host: HOST, origin: "" },
    { host: HOST, origin: "null", referer: "http://evil.example/x" },
    { host: HOST, referer: "null" },
  ];
  for (const headers of cases) {
    const out = checkWriteAuth({ method: "POST", proto: "http", headers });
    assert.equal(out.ok, false, JSON.stringify(headers));
    assert.equal(out.code, "write_guard_origin_unknown", JSON.stringify(headers));
    assert.match(out.error, /无法确认请求来源/);
    assert.match(out.error, /表单/);
    assert.match(out.error, /x-board-write: 1/);
    assert.match(out.error, /白名单/);
  }
});

test("BD16-⑥（回归）既有 X-Board-Write 头档不受 Origin 不可知 / 跨站改动影响", () => {
  for (const extra of [{}, { origin: "null" }, { origin: "http://evil.example" }, { referer: "http://evil.example/" }]) {
    const out = checkWriteAuth({
      method: "POST",
      proto: "http",
      headers: { host: HOST, [WRITE_GUARD_HEADER]: WRITE_GUARD_HEADER_VALUE, ...extra },
    });
    assert.deepEqual(out, { ok: true, via: "header" }, JSON.stringify(extra));
  }
});

test("parseRequirementForm：title 必填去空白；version 去必填（M6，留空 = 未排期），requirement 空串归一为未提供", () => {
  const ok = parseRequirementForm("title=%20甲%20&version=%20v0.9.0%20&requirement=%20", undefined, "g");
  assert.deepEqual(ok, { ok: true, title: "甲", version: "v0.9.0", group: "g" });
  const withReq = parseRequirementForm("title=甲&version=v1&requirement=%E5%8E%9F%E6%96%87", undefined, "g");
  assert.equal(withReq.ok && withReq.requirement, "原文");
  // M6：version 缺失 / 空 / 纯空白 ⇒ 合法（未排期），归一为空串
  for (const raw of ["title=甲", "title=甲&version=", "title=甲&version=%20%20"]) {
    assert.deepEqual(parseRequirementForm(raw, undefined, "g"), { ok: true, title: "甲", version: "", group: "g" }, raw);
  }
});

test("parseRequirementForm（负向）：M6 起必填仅 title ⇒ 空 title 400 结构化，空 version 不拒", () => {
  for (const [raw, expectMissing] of [
    ["title=&version=v1", "title"],
    ["version=v1", "title"],
    ["title=%20%20&version=v1", "title"],
    ["title=%20%20", "title"],
  ]) {
    const out = parseRequirementForm(raw, undefined, "g");
    assert.equal(out.ok, false, `${raw} 必须被拒`);
    assert.equal(out.status, 400);
    assert.equal(out.code, "requirement_form_invalid");
    assert.match(out.error, new RegExp(`必填字段为空：${expectMissing}`));
  }
});

// ---------------------------------------------------------------------------
// BD11：组织名进表单 —— 生效序「表单 > 板级默认」，两者皆空才拒（拒点在请求期，非启动期）
// ---------------------------------------------------------------------------

test("BD11 parseRequirementForm ①：表单 group 去空白后成为生效组身份（覆盖板级默认）", () => {
  const out = parseRequirementForm("group=%20flow-team%20&title=甲&version=v1", undefined, "board-default");
  assert.deepEqual(out, { ok: true, title: "甲", version: "v1", group: "flow-team" });
});

test("BD11 parseRequirementForm ③：表单 group 留空 / 纯空白 ⇒ 回落板级默认组织", () => {
  for (const raw of ["title=甲&version=v1", "title=甲&version=v1&group=", "title=甲&version=v1&group=%20%20"]) {
    const out = parseRequirementForm(raw, undefined, "board-default");
    assert.equal(out.ok, true, raw);
    assert.equal(out.group, "board-default");
  }
});

test("BD11 parseRequirementForm ②（负向）：表单空 ∧ 无板级默认 ⇒ 400 board_group_required，不猜不回落", () => {
  for (const def of [undefined, null, "   ", ""]) {
    const out = parseRequirementForm("title=甲&version=v1", undefined, def);
    assert.equal(out.ok, false, `默认组织 = ${String(def)} 时组织名缺失必须被拒`);
    assert.equal(out.status, 400, "请求期 400（不再是配置期 503）");
    assert.equal(out.code, GROUP_REQUIRED_CODE);
    assert.match(out.error, /不猜、不回落/);
    assert.match(out.error, /config\.json 的 group/, "文案须给出可照做的默认组织配置键（BD12″ 起配置只从文件读）");
    assert.match(out.error, /首次填写/, "文案须说明「首次使用该组织名 = 创建该组织」");
  }
});

test("BD11 parseRequirementForm：title/version 的缺失仍优先报（同一次只报一档，不吞必填）", () => {
  const out = parseRequirementForm("title=&version=v1");
  assert.equal(out.ok, false);
  assert.equal(out.code, "requirement_form_invalid", "必填字段先判，组织名后判");
});

test("parseRequirementForm：超限体 ⇒ 413（content-length 或实际字节数任一越界）", () => {
  const big = "title=" + "甲".repeat(200_000);
  const byLength = parseRequirementForm("title=甲&version=v1", MAX_REQUIREMENT_BODY_BYTES + 1);
  assert.equal(byLength.ok, false);
  assert.equal(byLength.status, 413);
  assert.equal(byLength.code, "payload_too_large");
  const byBytes = parseRequirementForm(big);
  assert.equal(byBytes.ok, false);
  assert.equal(byBytes.status, 413);
  assert.ok(MAX_REQUIREMENT_BODY_BYTES > 0);
});

// ---------------------------------------------------------------------------
// v0.9.2 M3：排期写路由 + 表单解析（POST /features/{id}/schedule）
// ---------------------------------------------------------------------------

test("M3 isWriteRoute：schedule 只放开 POST 单段 id；近似路径不放行", () => {
  assert.equal(isWriteRoute("POST", "/features/F1/schedule"), true);
  for (const [method, path] of [
    ["GET", "/features/F1/schedule"],
    ["PUT", "/features/F1/schedule"],
    ["POST", "/features/F1/schedule/"],
    ["POST", "/features//schedule"],
    ["POST", "/features/F1/x/schedule"],
    ["POST", "/schedule"],
  ]) {
    assert.equal(isWriteRoute(method, path), false, `${method} ${path} 不得放行`);
  }
});

test("M3 parseScheduleForm：显式 version 去空白；空串 = 删除排期（合法值，不拒）", () => {
  assert.deepEqual(parseScheduleForm("version=%20%20v0.9.2%20"), { ok: true, version: "v0.9.2" });
  assert.deepEqual(parseScheduleForm("version="), { ok: true, version: "" });
  assert.deepEqual(parseScheduleForm("version=%20%20"), { ok: true, version: "" }, "纯空白 trim 后同为清空语义");
});

test("M3 parseScheduleForm（负向）：version 键缺失 = 编程错误抛出，不做缺键语义", () => {
  assert.throws(() => parseScheduleForm("title=无关"), ScheduleFormProgrammingError);
  assert.throws(() => parseScheduleForm(""), ScheduleFormProgrammingError);
});

test("M3 parseScheduleForm：超限体 ⇒ 413（口径同 parseRequirementForm）", () => {
  const byLength = parseScheduleForm("version=v1", MAX_REQUIREMENT_BODY_BYTES + 1);
  assert.equal(byLength.ok, false);
  assert.equal(byLength.status, 413);
  assert.equal(byLength.code, "payload_too_large");
  const byBytes = parseScheduleForm("version=" + "甲".repeat(200_000));
  assert.equal(byBytes.ok, false);
  assert.equal(byBytes.status, 413);
});
