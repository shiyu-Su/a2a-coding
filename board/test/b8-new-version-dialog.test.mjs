/**
 * v0.9.4 增补八 B1（REQ-2026-09-28-02 · 父改造文档 §9.3）——「＋ 新版本」由原生 `prompt()`
 * 改为与「＋ 新增需求」**同款弹窗**：
 *
 * ① `views.renderNewVersionDialog(org)` = 第三枚 dialog 骨架（`dialog.fd` + 「关闭」钮 + `.fd-body`
 *    内 SSR 表单：隐藏字段 `action=create` + `version` 输入 + `data-ov="1"`）；
 * ② **v0.9.6 B4 改版（REQ-2026-09-28-07 口径 4 / 9 / 24）**：骨架与页头按钮的宿主由全局 `/schedule`
 *    **迁到组织空间排期页** `/org/<名>/`（台账唯一键 = `(org, version)` ⇒ 全局页无组织上下文，
 *    表单零 org 字段、org 只从路径取）；组织门户不渲染；
 * ③ 闭集八元不扩：骨架零 `<script>`、弹窗交互仍在 `NEW_REQUIREMENT_DIALOG_SCRIPT` 体内（wire 委托）；
 * ④ 服务端写口零改动：表单档提交仍落既有闸与台账（空间档经归一层剥前缀命中同一条 `POST /versions`）。
 *
 * 增补十一 E1（§9.6）起：看板尾虚列拖拽 `prompt()` 路径已撤除（负向锚在
 * `w6-new-version-entry.test.mjs` W6-①/②/⑤）⇒ 本弹窗是创建版本的唯一入口。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  groupFeaturesByVersion,
  renderNewVersionDialog,
  renderSchedule,
  selectRequirementPool,
} from "../dist/web/views.js";
import { DRAG_SCHEDULE_SCRIPT, NEW_REQUIREMENT_DIALOG_SCRIPT } from "../dist/web/layout.js";
import { createBoardServer } from "../dist/server.js";

function feature(featureId, version, overrides = {}) {
  return {
    featureId,
    state: "executing",
    title: `需求 ${featureId}`,
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

// ---------------------------------------------------------------------------
// ① 骨架结构（对齐 #new-req-dialog：dialog.fd + 第一枚关闭钮 + fd-body 表单）
// ---------------------------------------------------------------------------

test("B8-①（B4 改版）renderNewVersionDialog(org)：dialog.fd 骨架 · 关闭钮 = 第一枚 button · 表单 = POST /org/<名>/versions + 隐藏 action=create + version 输入", () => {
  const html = renderNewVersionDialog("alpha");
  assert.match(html, /^<dialog class="fd" id="new-version-dialog">/, "同款 dialog.fd 骨架（错误卡叠加规则生效）");
  assert.match(
    html,
    /^<dialog class="fd" id="new-version-dialog">\n<button type="button" id="new-version-close">关闭<\/button>/,
    "第一枚 button = 关闭钮（wire() 的 closeBtn 判据）",
  );
  assert.match(html, /<div class="fd-body">/, "表单区 = .fd-body（与 new-req-dialog 同构）");
  assert.match(html, /<form method="post" action="\/org\/alpha\/versions"[^>]*data-ov="1">/, "SSR 原生可提交 + data-ov 浮层档（B4：action 带空间前缀）");
  assert.match(html, /<input type="hidden" name="action" value="create">/, "隐藏字段 action=create（写口零改动）");
  assert.doesNotMatch(html, /name="org"|name="group"/, "表单零组织字段（口径 4：org 只从服务端路径取）");
  assert.match(html, /归属组织 = <b>alpha<\/b>/, "组织只读展示（同 BD8 提需求免选形态）");
  assert.match(html, /<label>版本号 \*<input name="version" required placeholder="如 v0\.10\.0/, "版本号输入框含占位提示");
  assert.match(html, /<button type="submit">创建版本<\/button>/, "提交钮");
  assert.doesNotMatch(html, /<script/, "骨架零脚本（闭集八元不扩）");
});

test("B8-①b（B4）组织名含特殊字符 ⇒ action 的 URL 段经 encodeURIComponent 转义", () => {
  const html = renderNewVersionDialog("a b/c");
  assert.match(html, /action="\/org\/a%20b%2Fc\/versions"/, "URL 段编码口径同 orgSpaceLink（与提需求表单同源）");
  assert.match(html, /归属组织 = <b>a b\/c<\/b>/, "正文展示走 escapeHtml（不嵌未转义原文）");
});

// ---------------------------------------------------------------------------
// ② 页面注入面（B4 改版）：空间排期页有按钮 + 骨架 · 全局排期页与门户皆无
// ---------------------------------------------------------------------------

function fakeClient(features) {
  return {
    baseUrl: "http://fake",
    async getFeatures() {
      return { features, stateCounts: null };
    },
  };
}

async function withServer(client, run) {
  const handle = await createBoardServer({ host: "127.0.0.1", port: 0, client });
  try {
    await run(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
  }
}

test("B8-②（B4 改版 · B5a 整页退役）GET /schedule ⇒ 303：建版本入口随页消失（按钮 + 骨架都不在）；弹窗脚本仍单点注入（本面不扩脚本枚（第七枚只随 manage 页））", async () => {
  await withServer(fakeClient([feature("F1", "v0.9.3")]), async (base) => {
    const res = await fetch(`${base}/schedule`, { redirect: "manual" });
    assert.equal(res.status, 303, "全局看板页退役");
    const html = await res.text();
    assert.doesNotMatch(html, /id="new-version-open"/, "退役路径不再有「＋ 新版本」按钮（无组织上下文可挂 ⇒ 不留死按钮）");
    assert.doesNotMatch(html, /id="new-version-dialog"/, "退役路径不渲染骨架（渲染门反转，口径 9）");
    assert.doesNotMatch(html, /id="new-req-open"|<script>/, "退役路径不出提需求入口，也不注入任何脚本");
    const board = await (await fetch(`${base}/org/alpha/schedule`)).text();
    assert.match(board, /id="new-req-open"/, "「＋ 新增需求」入口不受影响（宿主 = 空间排期页）");
    assert.ok(board.includes(NEW_REQUIREMENT_DIALOG_SCRIPT), "交互仍在第六枚常量体内（wire 委托）");
  });
});

test("B8-②b 组织门户 GET /：不渲染新版本骨架（建版本单入口 = 空间排期页；闭集仍八元）", async () => {
  await withServer(fakeClient([feature("F1", "v0.9.3")]), async (base) => {
    const html = await (await fetch(`${base}/`)).text();
    assert.doesNotMatch(html, /id="new-version-dialog"/, "门户无骨架");
    assert.doesNotMatch(html, /id="new-version-open"/, "门户无按钮（增补七 a 口径不变）");
    assert.equal((html.match(/<script>/g) ?? []).length, 2, "门户可执行内联脚本仍两枚");
  });
});

test("B8-②c（B4 改版）空间排期页 GET /org/alpha/：按钮 + 骨架 + 前缀 action 三件齐；提需求弹窗不受扰", async () => {
  await withServer(fakeClient([feature("F1", "v0.9.3")]), async (base) => {
    const html = await (await fetch(`${base}/org/alpha/`)).text();
    assert.match(html, /<dialog class="fd" id="new-req-dialog">/, "空间页提需求弹窗不受影响");
    assert.match(
      html,
      /<button type="button" id="new-version-open" class="header-actions" hidden>＋ 新版本<\/button>/,
      "空间页头「＋ 新版本」按钮（与旧全局那枚同款：服务端 hidden ⇒ 无 JS 不显死按钮）",
    );
    assert.ok(
      html.indexOf('id="new-req-open"') < html.indexOf('id="new-version-open"'),
      "紧随「＋ 新增需求」其后（同旧全局页头次序）",
    );
    assert.match(html, /<dialog class="fd" id="new-version-dialog">/, "空间页渲染新版本骨架");
    assert.match(html, /action="\/org\/alpha\/versions"/, "骨架表单落空间路径（归一层剥前缀命中同一条全局写口）");
    assert.ok(html.includes(NEW_REQUIREMENT_DIALOG_SCRIPT), "弹窗脚本单点注入不变");
  });
});

// ---------------------------------------------------------------------------
// ③ 闭集与拖拽侧撤除
// ---------------------------------------------------------------------------

test("B8-③（E1 改版）虚列拖拽 prompt() 路径已撤除；内联脚本字面量闭集仍八元", () => {
  assert.doesNotMatch(
    DRAG_SCHEDULE_SCRIPT,
    /window\.prompt|prompt\(/,
    "看板尾虚列 drop → prompt 输入已整段删除",
  );
  assert.doesNotMatch(DRAG_SCHEDULE_SCRIPT, /data-newversion/, "哨兵属性在拖拽侧不再出现");
  const s = NEW_REQUIREMENT_DIALOG_SCRIPT;
  assert.doesNotMatch(s, /window\.prompt/, "按钮侧 prompt 已退役");
  assert.equal((s.match(/<script>/g) ?? []).length, 1, "常量自身仍单枚");
});

// ---------------------------------------------------------------------------
// ④ v0.10.0 B2：写面改道 ⇒ 表单档 POST /versions(create) 发引擎意图（不再本地落台账）
// ---------------------------------------------------------------------------

test("B8-④（v0.10.0 B2 改道）表单档提交（action=create + version，urlencoded）⇒ 303 + 引擎收到建版意图", async () => {
  const { mkdtempSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "board-b8-"));
  const versionsFile = join(dir, "data", "versions.json");
  const calls = [];
  // 假引擎版本写客户端（B2）：记录意图、返回成功档。
  const engine = {
    kind: "versions",
    client: {
      async create(input) {
        calls.push({ kind: "create", input });
        return { ok: true, httpStatus: 201, version: input.version, status: "notstart" };
      },
      async remove(input) {
        calls.push({ kind: "remove", input });
        return { ok: true, httpStatus: 200, version: input.version, status: null };
      },
      async setStatus(input) {
        calls.push({ kind: "setStatus", input });
        return { ok: true, httpStatus: 200, version: input.version, status: input.status };
      },
    },
  };
  const srv = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client: fakeClient([]),
    versionsLedgerFile: versionsFile,
    versionsWriteImpl: engine.client,
  });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const res = await fetch(`${base}/versions`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/html",
        origin: base,
      },
      body: new URLSearchParams({ action: "create", version: "v0.10.0" }).toString(),
    });
    assert.equal(res.status, 303, "成功 = 服务端 303（fetch 跟随后 ok ⇒ wire() 关弹窗刷新）");
    assert.deepEqual(calls, [{ kind: "create", input: { ownerGroup: null, version: "v0.10.0" } }], "建版意图发引擎（全局档 ownerGroup=null）");
    assert.equal(existsSync(versionsFile), false, "板不再写本地台账（B2：事实源在引擎）");
  } finally {
    await srv.close();
  }
});
