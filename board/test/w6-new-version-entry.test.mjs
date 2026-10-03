/**
 * v0.9.4 W6（REQ-2026-09-27-05 §2.6 · 入口交互单件）—— **增补十一 E1（§9.6）改版**：
 * 新增版本只保留一种方式 = 排期看板页头「＋ 新版本」按钮 + 弹窗；看板尾拖拽虚列已撤。
 *
 * ① 页头「＋ 新版本」按钮（服务端 hidden，脚本显形）⇒ 点击打开同款弹窗 `#new-version-dialog`
 *    （表单 `action=create`）→ 台账落 notstart 条目 ⇒ 看板出现空列（原 `prompt()` 输入已退役；
 *    锚见 `b8-new-version-dialog.test.mjs`）
 *    （**增补七 a §9.1-a**：入口原在组织门户 `/`，迁入排期页 ⇒ 门户不再渲染该按钮；
 *    **v0.9.6 B4**：入口再迁入**组织空间排期页** `/org/<名>/`，表单 action 带空间前缀
 *    ⇒ 全局 `/schedule` 不再渲染该按钮与弹窗骨架 —— 路由 `POST /versions` 仍留作纯 HTTP 兜底，
 *    页壳随 B5a 退役）；
 * ② **（E1 撤除）** 看板尾虚列壳（哨兵属性 `data-newversion`）与其 drop → `window.prompt()` 分支
 *    不再渲染 / 不再存在 ⇒ 本文件以**负向锚**钉「虚列与哨兵不再出现」。
 *
 * 闭集纪律：交互**全在既有脚本常量体内**（`NEW_REQUIREMENT_DIALOG_SCRIPT` /
 * `DRAG_SCHEDULE_SCRIPT`）—— 内联脚本闭集保持**六元**、CSP 不动（全站闭集钉见
 * `n3-regression-anchors.test.mjs` N3-⑦/⑧；本文件补「不踩其它常量标记」的归属唯一锚）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  groupFeaturesByVersion,
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
// ① （E1 撤除）虚列壳不再渲染 —— 负向锚
// ---------------------------------------------------------------------------

test("W6-①（E1 改版）renderSchedule 不再挂虚列壳：哨兵 data-newversion / newver 类 / 虚列头三处皆不出现；池列仍在（件3 起 = 首列）", () => {
  const html = renderSchedule(
    groupFeaturesByVersion([feature("F1", "v0.9.3")]),
    selectRequirementPool([feature("F2", null)]),
  );
  assert.doesNotMatch(html, /data-newversion/, "哨兵属性不再渲染（服务端 + 脚本两侧同撤）");
  assert.doesNotMatch(html, /kcol newver/, "虚列壳 class 已撤");
  assert.doesNotMatch(html, /<h3>＋ 新版本/, "虚列头已撤（页头按钮那枚不算，见 W6-④）");
  assert.doesNotMatch(html, /拖卡到此/, "拖卡建版本口径文案已撤");
  // 池列仍以 data-version="" 标记；件3 起它是看板**首列**（最左）
  assert.match(html, /<div class="kcol" data-version="">/, "池列 data-version 空串不变（清空排期落点）");
  const board = html.slice(html.indexOf('<div class="kanban" id="schedule-board">'), html.indexOf("<dialog"));
  assert.ok(
    board.indexOf('<div class="kcol"') === board.indexOf('<div class="kcol" data-version=""'),
    "池列是看板首列（件3：需求池最左，其右为版本列）",
  );
});

test("W6-①b（E1 改版）空看板同样不出虚列壳（列只剩需求池）", () => {
  const html = renderSchedule([], []);
  assert.doesNotMatch(html, /data-newversion/);
  assert.equal((html.match(/<div class="kcol"/g) ?? []).length, 1, "空看板列数 = 1（仅需求池）");
});

// ---------------------------------------------------------------------------
// ② （E1 撤除）拖拽脚本：哨兵列识别与 prompt 建版本分支已删 —— 负向锚 + 既有拖拽行为保留
// ---------------------------------------------------------------------------

test("W6-②（E1 改版）DRAG_SCHEDULE_SCRIPT：colOf 只认 data-version · drop-建版本分支与 prompt 已删 · 改排期通路与零新端点保留", () => {
  const s = DRAG_SCHEDULE_SCRIPT;
  // 负向：哨兵属性与 prompt 建版本路径整段撤除
  assert.doesNotMatch(s, /data-newversion/, "colOf / drop 分支不再出现哨兵属性");
  assert.doesNotMatch(s, /window\.prompt|prompt\(/, "prompt 输入新版本号路径已删（按钮弹窗为唯一入口）");
  assert.doesNotMatch(s, /submitDrag\(id, fresh\)|typed|var fresh/, "输入归一 + 复用分支的中间变量已随分支撤除");
  // colOf 只按 data-version 判定（属性存在判定，不依赖 class）
  assert.match(s, /el\.getAttribute\("data-version"\) !== null\)/, "colOf 落点判定 = data-version 属性存在");
  // 保留面：改排期通路逐条不变
  assert.match(s, /var target = col\.getAttribute\("data-version"\);/, "目标版本自列属性读取");
  assert.match(s, /if \(\(card\.getAttribute\("data-version"\) \|\| ""\) === \(target \|\| ""\)\) return;/, "同版早退保留");
  assert.match(s, /submitDrag\(id, target === null \? "" : target\);/, "池列（空串）= 清空排期落点保留");
  // 零新端点：fetch 目标仍唯一 = /features/:id/schedule，不新增 /versions
  assert.equal((s.match(/fetch\(/g) ?? []).length, 1, "拖拽脚本 fetch 单点");
  assert.match(s, /fetch\("\/features\/" \+ encodeURIComponent\(featureId\) \+ "\/schedule"/, "fetch 目标 = 既有排期写路由");
  assert.doesNotMatch(s, /fetch\("\/versions"/, "拖拽脚本不新增版本写端点（零新端点）");
  // 归属唯一：不踩其它常量标记
  assert.doesNotMatch(s, /getElementById\("(feat-dialog|new-req-dialog|new-version-dialog|err-ov)"\)/, "不踩其它常量单点标记");
});

// ---------------------------------------------------------------------------
// ③ 排期页按钮脚本：wireNewVersion 委托 wire()（增补八 §9.3 弹窗化；原 prompt() 路径已退役）
// ---------------------------------------------------------------------------

test("W6-③（增补八 §9.3 改版）NEW_REQUIREMENT_DIALOG_SCRIPT：wireNewVersion = wire(#new-version-dialog, #new-version-open) · 零 prompt · 成功关弹窗刷新", () => {
  const s = NEW_REQUIREMENT_DIALOG_SCRIPT;
  assert.match(s, /function wireNewVersion\(btn\) \{/, "单函数接入新版本按钮");
  assert.match(s, /wireNewVersion\(document\.getElementById\("new-version-open"\)\);/, "挂在 #new-version-open 上（非排期页无此 id ⇒ 空转）");
  assert.match(s, /if \(btn === null\) return;/, "无按钮页 ⇒ 早退");
  // 增补八：弹窗化 —— 按钮点击经 wire() showModal 打开 #new-version-dialog（与新增需求同款）
  assert.match(
    s,
    /var dlg = document\.getElementById\("new-version-dialog"\);/,
    "取第三枚 dialog 骨架",
  );
  assert.match(s, /wire\(dlg, btn, null\);/, "复用 wire()（不新枚、不复制 fetch 通路）");
  // 原生 prompt() 通路已退役（按钮侧）：本常量内零 prompt、零 body 叠卡
  assert.doesNotMatch(s, /window\.prompt/, "按钮侧不再用原生 prompt()");
  assert.doesNotMatch(s, /location\.assign\("\/schedule"\)/, "成功改走 wire() 的关弹窗刷新（不再显式跳 /schedule）");
  // 提交通路与既有 dialog 一致：属性读 action + 同源 fetch + urlencoded
  assert.match(s, /var action = form\.getAttribute\("action"\) \|\| "";/, "action 走属性读取（同名字段遮蔽）");
  assert.match(s, /new URLSearchParams\(new FormData\(form\)\)/, "载荷 urlencoded（action=create 经隐藏字段携带）");
  // 归属唯一：不踩其它常量标记
  assert.doesNotMatch(s, /getElementById\("(feat-dialog|schedule-board|err-ov)"\)/, "不踩其它常量单点标记");
});

// ---------------------------------------------------------------------------
// ④ HTTP 面：排期看板页头按钮 + 门户撤除 + 看板哨兵列 + 闭集不扩
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

test("W6-④（B4 改版）GET /org/alpha/：空间页头带「＋ 新版本」按钮（服务端 hidden、紧随「＋ 新增需求」其后）；脚本闭集不扩", async () => {
  await withServer(fakeClient([feature("F1", "v0.9.3")]), async (base) => {
    const html = await (await fetch(`${base}/org/alpha/`)).text();
    assert.match(
      html,
      /<button type="button" id="new-version-open" class="header-actions" hidden>＋ 新版本<\/button>/,
      "空间排期页页头「＋ 新版本」按钮（服务端 hidden）",
    );
    assert.ok(
      html.indexOf('id="new-req-open"') < html.indexOf('id="new-version-open"'),
      "排在「＋ 新增需求」旁（其后）",
    );
    assert.ok(html.includes(NEW_REQUIREMENT_DIALOG_SCRIPT), "新版本交互仍在弹窗常量内（第六枚内扩写）");
    // 闭集不扩：入口迁空间页**不新增任何脚本枚**。B5a 起全局排期页退役 ⇒ 「与全局页同计数」的对照物失效，
    // 等价式改钉**绝对枚数 5**（提交守卫 + err-ov 关闭 + 详情浮层 + 新增需求/版本弹窗 + 拖拽 = 看板注入面，
    // 与 schedule-page N2-④ 同一口径；bare `<script>` 计数与是否 vendored mermaid 资产无关）。
    assert.equal((html.match(/<script>/g) ?? []).length, 5, "空间排期页可执行内联脚本 = 五枚（未扩第七枚）");
    for (const m of html.matchAll(/<script[^>]*src="([^"]*)"/g)) {
      assert.match(m[1], /^\/static\//, "外源脚本面不变（仅既有同源 mermaid 资产，CSP 不动）");
    }
  });
});

test("W6-④b（增补七 a）GET /：门户页头**不再**渲染「＋ 新版本」按钮（全站只留排期页一处入口）；门户脚本仍两枚", async () => {
  await withServer(fakeClient([feature("F1", "v0.9.3")]), async (base) => {
    const html = await (await fetch(`${base}/`)).text();
    assert.doesNotMatch(html, /id="new-version-open"/, "门户撤除新版本入口");
    assert.match(html, /id="new-org-open"/, "门户「＋ 建项目组」入口不受影响");
    // 闭集不扩：门户仍 = 提交守卫 + 泛化弹窗脚本两枚
    assert.equal((html.match(/<script>/g) ?? []).length, 2, "门户可执行内联脚本 = 两枚（未新增第七枚）");
    assert.doesNotMatch(html, /<script[^>]*src=/, "无外源脚本（CSP 不动）");
  });
});

test("W6-⑤（E1 改版 + B4 迁入口 · B5a 整页退役）`GET /schedule` ⇒ 303 空体（虚列壳 / 建版本入口 / 看板脚本随页一并消失）；看板尾列形态锚归空间排期页", async () => {
  await withServer(fakeClient([feature("F1", "v0.9.3"), feature("F2", null)]), async (base) => {
    const res = await fetch(`${base}/schedule`, { redirect: "manual" });
    assert.equal(res.status, 303, "B5a：全局看板页退役");
    const html = await res.text();
    assert.doesNotMatch(html, /data-newversion|kcol newver|<h3>需求池/, "退役路径不渲染任何看板正文");
    // B4：建版本入口归空间页 ⇒ 退役的全局页既无按钮也无骨架（写口路由仍在，留作纯 HTTP 兜底）
    assert.doesNotMatch(html, /id="new-version-open"|id="new-version-dialog"/, "退役路径不出建版本按钮与骨架");
    assert.doesNotMatch(html, /<script>/, "退役路径不注入看板脚本（闭集六元不因此扩）");
    const board = await (await fetch(`${base}/org/alpha/schedule`)).text();
    assert.match(board, /<h3>需求池/, "需求池列仍是看板尾列（宿主 = 空间排期页）");
    assert.doesNotMatch(board, /data-newversion|kcol newver/, "虚列壳哨兵不随宿主迁移而复生");
    assert.ok(board.includes(DRAG_SCHEDULE_SCRIPT), "拖拽脚本仍为单点常量注入（改排期用途不变）");
    assert.ok(board.includes(NEW_REQUIREMENT_DIALOG_SCRIPT), "弹窗脚本仍单点注入");
  });
});

test("W6-⑤b（B4 · B5a 改版）GET /org/alpha/：唯一入口三件齐（按钮 + 骨架 + 前缀 action）；骨架内零组织字段", async () => {
  await withServer(fakeClient([feature("F1", "v0.9.3")]), async (base) => {
    const html = await (await fetch(`${base}/org/alpha/`)).text();
    assert.match(html, /id="new-version-open"/, "空间页头「＋ 新版本」按钮 = 全站唯一创建入口");
    assert.match(html, /<dialog class="fd" id="new-version-dialog">/, "弹窗骨架在空间页");
    assert.match(html, /action="\/org\/alpha\/versions"/, "表单 action 带空间前缀（org 由路径决定）");
    assert.doesNotMatch(html, /<input[^>]*name="org"/, "表单不带 org 字段（口径 4）");
    // 脚本闭集不扩：同 W6-④ 的绝对枚数五枚锚（B5a 起全局页退役，无对照物）
    assert.equal((html.match(/<script>/g) ?? []).length, 5, "空间页可执行内联脚本 = 五枚（未新增第七枚）");
    assert.doesNotMatch(html, /<script type="text\/template"/, "不为入口迁移引入任何新的脚本载体");
  });
});
