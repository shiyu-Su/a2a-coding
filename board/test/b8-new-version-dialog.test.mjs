/**
 * v0.9.4 增补八 B1（REQ-2026-09-28-02 · 父改造文档 §9.3）——「＋ 新版本」由原生 `prompt()`
 * 改为与「＋ 新增需求」**同款弹窗**：
 *
 * ① `views.renderNewVersionDialog()` = 第三枚 dialog 骨架（`dialog.fd` + 「关闭」钮 + `.fd-body`
 *    内 SSR 表单：`POST /versions` 隐藏字段 `action=create` + `version` 输入 + `data-ov="1"`）；
 * ② 排期页（全局 `/schedule`）注入骨架，与页头 `#new-version-open` 按钮配对；组织门户与
 *    空间排期页（无按钮 ⇒ 无骨架）不受影响；
 * ③ 闭集六元不扩：骨架零 `<script>`、弹窗交互仍在 `NEW_REQUIREMENT_DIALOG_SCRIPT` 体内（wire 委托）；
 * ④ 服务端写口零改动：表单档 `POST /versions`（action=create + version）仍落既有闸与台账。
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

test("B8-① renderNewVersionDialog：dialog.fd 骨架 · 关闭钮 = 第一枚 button · 表单 = POST /versions + 隐藏 action=create + version 输入", () => {
  const html = renderNewVersionDialog();
  assert.match(html, /^<dialog class="fd" id="new-version-dialog">/, "同款 dialog.fd 骨架（错误卡叠加规则生效）");
  assert.match(
    html,
    /^<dialog class="fd" id="new-version-dialog">\n<button type="button" id="new-version-close">关闭<\/button>/,
    "第一枚 button = 关闭钮（wire() 的 closeBtn 判据）",
  );
  assert.match(html, /<div class="fd-body">/, "表单区 = .fd-body（与 new-req-dialog 同构）");
  assert.match(html, /<form method="post" action="\/versions"[^>]*data-ov="1">/, "SSR 原生可提交 + data-ov 浮层档");
  assert.match(html, /<input type="hidden" name="action" value="create">/, "隐藏字段 action=create（写口零改动）");
  assert.match(html, /<label>版本号 \*<input name="version" required placeholder="如 v0\.10\.0/, "版本号输入框含占位提示");
  assert.match(html, /<button type="submit">创建版本<\/button>/, "提交钮");
  assert.doesNotMatch(html, /<script/, "骨架零脚本（闭集六元不扩）");
});

// ---------------------------------------------------------------------------
// ② 页面注入面：全局排期页有骨架 · 门户 / 空间页无（无按钮 ⇒ 不渲染）
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

test("B8-② GET /schedule：按钮 + 骨架 + 脚本三件齐（配对 #new-version-open）；仍单枚弹窗常量（未新增第七枚）", async () => {
  await withServer(fakeClient([feature("F1", "v0.9.3")]), async (base) => {
    const html = await (await fetch(`${base}/schedule`)).text();
    assert.match(
      html,
      /<button type="button" id="new-version-open" class="header-actions" hidden>＋ 新版本<\/button>/,
      "页头按钮原样（服务端 hidden）",
    );
    assert.match(html, /<dialog class="fd" id="new-version-dialog">/, "弹窗骨架在看板页");
    assert.ok(html.includes(NEW_REQUIREMENT_DIALOG_SCRIPT), "交互仍在第六枚常量体内（wire 委托）");
    assert.ok(
      html.indexOf('id="new-req-dialog"') < html.indexOf('id="new-version-dialog"'),
      "骨架挂在新建需求骨架之后（正文单点渲染链尾）",
    );
  });
});

test("B8-②b 组织门户 GET /：不渲染新版本骨架（全站唯一入口在排期页；闭集仍六元）", async () => {
  await withServer(fakeClient([feature("F1", "v0.9.3")]), async (base) => {
    const html = await (await fetch(`${base}/`)).text();
    assert.doesNotMatch(html, /id="new-version-dialog"/, "门户无骨架");
    assert.doesNotMatch(html, /id="new-version-open"/, "门户无按钮（增补七 a 口径不变）");
    assert.equal((html.match(/<script>/g) ?? []).length, 2, "门户可执行内联脚本仍两枚");
  });
});

test("B8-②c 空间排期页 GET /org/alpha/：无按钮 ⇒ 不渲染骨架（脚本仍注入但空转）", async () => {
  await withServer(fakeClient([feature("F1", "v0.9.3")]), async (base) => {
    const html = await (await fetch(`${base}/org/alpha/`)).text();
    assert.match(html, /<dialog class="fd" id="new-req-dialog">/, "空间页提需求弹窗不受影响");
    assert.doesNotMatch(html, /id="new-version-dialog"/, "空间页不渲染新版本骨架");
    assert.ok(html.includes(NEW_REQUIREMENT_DIALOG_SCRIPT), "弹窗脚本单点注入不变");
  });
});

// ---------------------------------------------------------------------------
// ③ 闭集与拖拽侧撤除
// ---------------------------------------------------------------------------

test("B8-③（E1 改版）虚列拖拽 prompt() 路径已撤除；内联脚本字面量闭集仍六元", () => {
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
// ④ 服务端写口零改动：表单档 POST /versions(create) 与隐藏字段载荷逐字兼容
// ---------------------------------------------------------------------------

test("B8-④ 表单档提交（action=create + version，urlencoded）⇒ 303 + 台账落 notstart 条目", async () => {
  // 台账注入临时文件（A3 收口口径：不触碰开发机真实 .data/versions.json）
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "board-b8-"));
  const srv = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client: fakeClient([]),
    versionsLedgerFile: join(dir, "data", "versions.json"),
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
    const ledger = JSON.parse(readFileSync(join(dir, "data", "versions.json"), "utf8"));
    assert.equal(ledger.versions[0].version, "v0.10.0");
    assert.equal(ledger.versions[0].status, "notstart", "初态 notstart（写口与闸零改动）");
  } finally {
    await srv.close();
  }
});
