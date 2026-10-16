/**
 * v0.10.3 N3 剥壳单测组（REQ-2026-10-11-02《板详情页重构》· 改造文档 §2-5）。
 *
 * **本文件与 `src/graph-view.ts` 的 `taskDigest` / `TASK_HEAD_SHELL` 同生同灭**：派发侧结构化根治
 * （池卡 `770de678`）落地后，派发消息不再带「需求壳」⇒ 整组删除，断言不迁移、不改造。
 * 分组的理由 = 剥壳是**临时垫片**，判据必须集中到一处才能一次摘干净。
 *
 * 判据面（对应工单 3)）：
 * - ① 命中固定首行 ⇒ 取节点标签（分隔符**逐字**：全角 `【`U+3010 / `】`U+3011 / `·`U+00B7）；
 * - ② 不匹配 ⇒ 原样回落该行（一字不改、绝不吞、绝不返回空串；**不放松为「取【】内所有」**）；
 * - ③ 首行为空白 ⇒ 顺延下一条非空行（避免「回落首行」正好落回空串把内容吞掉）；
 * - ④ **先剥后转义**（构造含 `<` 与 `》`类结构的 prompt 证次序：出现双重转义 = 次序倒了）；
 * - ⑤ 剥出结果仍走 `taskSummaryLines` 的 40 字预算（本节点不动该口径）；
 * - ⑥ 端到端 6 任务样本 ⇒ 执行明细单表「要点」列的实际单元格。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { taskDigest, taskSummaryLines } from "../dist/graph-view.js";
import { renderFeatureDetail } from "../dist/web/views.js";

const NOW = Date.parse("2026-10-11T00:00:00Z");

/** 工单验收样本的固定首行形态（`flow/spec/文档模板.md` §3 派发消息模板首行逐字）。 */
const SHELL_HIT = "【需求 REQ-2026-10-11-02 · Step 2 节点 执行明细单表与剥壳】正文：任务表与三面表并为一张 12 列单表。";

// --- 端到端夹具（走产品渲染路径，不手搓 HTML） ------------------------------------------

const detail = (tasks) => ({
  feature: {
    featureId: "F1",
    state: "executing",
    title: "板详情页重构",
    plan: null,
    ownerGroup: "g",
    stage: "改造方案",
    version: "v0.10.3",
    approval: "已通过",
    createdAt: "c",
    updatedAt: "u",
  },
  tasks,
});

function mkTask(i, prompt, over = {}) {
  const id = `task-${String(i).padStart(2, "0")}`;
  return {
    taskId: id,
    projectId: "board",
    state: "completed",
    lane: "write",
    queueState: "settled",
    failureKind: null,
    retryCount: null,
    dependencies: [],
    queuedAt: `2026-10-11T00:0${i}:00Z`,
    claimedAt: `2026-10-11T00:0${i}:30Z`,
    startedAt: `2026-10-11T00:1${i}:00Z`,
    finishedAt: `2026-10-11T00:2${i}:00Z`,
    taskType: "unit_agent",
    prompt,
    ...over,
  };
}

const renderDetail = (tasks) => renderFeatureDetail(detail(tasks), null, "trace 关闭", NOW);

/** 取该 taskId 所在 `<tr>` 的各 `<td…>`（切片口径同 web.test 既有锚）。 */
function rowCells(html, taskId) {
  const at = html.indexOf(`<td class="mono" title="${taskId}">`);
  assert.ok(at >= 0, `单表中须有 ${taskId} 行`);
  const tr = html.slice(html.lastIndexOf("<tr>", at), html.indexOf("</tr>", at));
  return tr.slice("<tr>".length).split("</td>").slice(0, -1);
}

/** 去掉单元格的前导标签（`<td>` 或 `<td title="…">`），只比可见文字。 */
const cellText = (cell) => cell.replace(/^<td[^>]*>/, "");

test("剥壳-① 命中固定首行 ⇒ 取节点标签（分隔符逐字，Step 后段位数为变项）", () => {
  assert.equal(taskDigest(SHELL_HIT), "执行明细单表与剥壳");
  for (const step of ["0", "1", "2", "3"]) {
    assert.equal(taskDigest(`【需求 R-1 · Step ${step} 节点 标签】正文`), "标签", `Step ${step} 同样命中（位数为变项）`);
  }
  assert.equal(taskDigest("【需求 R-1 · Step 2 节点   标签  】正文"), "标签", "节点与标签间空白可变、标签两侧空白剥除");
  assert.equal(taskDigest("【需求 REQ-2026-10-11-02 · Step 2 节点 执行明细单表与剥壳】"), "执行明细单表与剥壳", "壳后无正文同样命中");
});

test("剥壳-② 不匹配 ⇒ 原样回落该行（绝不吞、绝不返回空串；不放松为「取【】内所有」）", () => {
  assert.equal(taskDigest("随手写的一行正文"), "随手写的一行正文");
  assert.equal(taskDigest("【随手写的一行】"), "【随手写的一行】", "不是「壳词开头」⇒ 整行原样（含【】本身）");
  assert.equal(
    taskDigest("【其它 需求 R-1 · Step 2 节点 标签】正文"),
    "【其它 需求 R-1 · Step 2 节点 标签】正文",
    "首词必须是「需求」⇒ 板不得自创其它分隔符",
  );
  assert.equal(
    taskDigest("【需求 R-1 · Step 2 段落 标签】正文"),
    "【需求 R-1 · Step 2 段落 标签】正文",
    "「节点」一词不得放宽为任意词",
  );
  assert.equal(
    taskDigest("【需求 R-1 - Step 2 节点 标签】正文"),
    "【需求 R-1 - Step 2 节点 标签】正文",
    "间隔符是 U+00B7 中点，半角连字符不认",
  );
  assert.equal(taskDigest("第一行\n【需求 R-1 · Step 2 节点 标签】第二行"), "第一行", "只剥首行 ⇒ 第二行的壳不参与");
});

test("剥壳-③ 首行为空白 ⇒ 顺延下一条非空行；空标签不返回空串；缺值 ⇒ null", () => {
  assert.equal(taskDigest("\n\n  \n【需求 R-1 · Step 2 节点 标签】正文"), "标签", "空白首行不吞掉内容");
  assert.equal(taskDigest("\n\n随手一行"), "随手一行");
  assert.equal(
    taskDigest("【需求 R-1 · Step 2 节点 】正文"),
    "【需求 R-1 · Step 2 节点 】正文",
    "壳命中但标签为空 ⇒ 回落整行（判据「绝不返回空串」）",
  );
  for (const v of [null, undefined, "", "   \n  \n"]) {
    assert.equal(taskDigest(v), null, `${JSON.stringify(v)} ⇒ null（调用方回退 —）`);
  }
});

test("剥壳-④ 先剥后转义：函数返回未转义原文，转义只在拼装处发生一次", () => {
  const prompt = "【需求 REQ-1 · Step 2 节点 <b>甲</b>】正文含 】 与 <img src=x onerror=alert(1)>";
  assert.equal(taskDigest(prompt), "<b>甲</b>", "剥壳在**原始串**上进行 ⇒ 返回未转义文本");

  const html = renderDetail([mkTask(1, prompt)]);
  const cells = rowCells(html, "task-01");
  assert.equal(cellText(cells[5]), "&lt;b&gt;甲&lt;/b&gt;", "剥出的标签经拼装处转义一次");
  assert.equal(html.includes("&amp;lt;"), false, "出现双重转义 ⇒ 转义先于剥壳（次序倒了）");
  assert.equal(/<img src=x/.test(html), false, "用户可控文本不得出结构");
  assert.ok(
    cells[5].includes("title=\"【需求 REQ-1 · Step 2 节点 &lt;b&gt;甲&lt;/b&gt;】正文含 】 与 &lt;img src=x onerror=alert(1)&gt;\""),
    "title 携带**未剥壳**的 prompt 全文（剥壳只作用于可见文字，不吞事实）",
  );
});

test("剥壳-⑤ 剥出的长标签仍走 taskSummaryLines 的 40 字预算（本节点不改该口径）", () => {
  const long = "标".repeat(50);
  assert.equal(taskDigest(`【需求 R-1 · Step 2 节点 ${long}】正文`), long, "剥壳本身不截断");
  const lines = taskSummaryLines(taskDigest(`【需求 R-1 · Step 2 节点 ${long}】正文`));
  assert.equal(lines.length, 2, "≤2 行");
  assert.equal(lines[0].length, 20, "单行宽度 = 既有 20 字");
  assert.ok(lines[1].endsWith("…"), "超预算以省略号截断");
  assert.equal(lines.join("").length, 40, "总量预算 = 既有 40 字");
});

// --- ⑥ 端到端：6 任务样本走产品渲染路径 -----------------------------------------------

test("剥壳-⑥ 端到端 6 任务样本 ⇒ 「要点」列 = 剥壳标签 / 回落截断", () => {
  const tasks = [
    mkTask(1, SHELL_HIT),
    mkTask(2, `随手写的一行正文${"说明文字".repeat(15)}`),
    mkTask(3, "【需求 R-2 · Step 2 节点 只读核实】三时刻列裁掉"),
    mkTask(4, "【需求 R-3 · Step 3 节点 用户测试】增补不重走工序"),
    mkTask(5, "【需求 R-4 · Step 2 节点 依赖图】"),
    mkTask(6, "  \n【需求 R-5 · Step 2 节点 样式回落】空首行"),
  ];
  const html = renderDetail(tasks);

  assert.equal((html.slice(html.indexOf("<thead>"), html.indexOf("</thead>")).match(/<th>/g) ?? []).length, 11);
  assert.equal(cellText(rowCells(html, "task-01")[5]), "执行明细单表与剥壳", "命中壳 ⇒ 要点 = 节点标签（工单验收判据）");
  assert.equal(cellText(rowCells(html, "task-03")[5]), "只读核实");
  assert.equal(cellText(rowCells(html, "task-04")[5]), "用户测试", "Step 后段位数为变项 ⇒ Step 3 同样命中");
  assert.equal(cellText(rowCells(html, "task-05")[5]), "依赖图");
  assert.equal(cellText(rowCells(html, "task-06")[5]), "样式回落", "空白首行顺延后仍命中");

  const loose = cellText(rowCells(html, "task-02")[5]);
  assert.ok(loose.startsWith("随手写的一行正文"), "不匹配 ⇒ 回落该行");
  assert.ok(loose.endsWith("…"), "回落内容仍按既有预算截断");
  assert.equal(loose.replace(/<br\/>/g, "").length, 40, "预算 40 字（含省略号，`<br/>` 只是换行载体不计字）");

  assert.equal(rowCells(html, "task-01")[0], "<td>1", "首列编号 = taskOrdinalMap 序（createdAt 升序；本夹具不带 createdAt ⇒ 由 taskId 兜稳支成同一序）");
  assert.equal(rowCells(html, "task-06")[0], "<td>6");
});

test("剥壳-⑦ 无 prompt（老桥）⇒ 要点格 = —，不回落成空串也不臆造", () => {
  const html = renderDetail([mkTask(1, undefined)]);
  assert.equal(rowCells(html, "task-01")[5], "<td>—");
});
