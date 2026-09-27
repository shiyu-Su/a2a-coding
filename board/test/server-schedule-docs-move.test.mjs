/**
 * REQ-2026-09-26-02 T6 —— 改版自动善后（排期写链内的受限 mv · `src/docs-move.ts`）。
 *
 * 覆盖改造文档 §4 验收判据：
 * - MV-①：新 version ≠ 旧 version ∧ decisions 登记主干（源 A）文档 ⇒ 文件搬到 `doc/{新版}/`
 *   + 源消失 + 第二跳 advance 携带 `decisions`（仅搬成项），第一跳仍三键；
 * - MV-②：幂等 —— 目标已存在 ⇒ 跳 mv（**不覆盖**）仅登记；
 * - MV-③：守卫负例 —— 越树 / 层级越界 / 非法版本段 / 非 .md ⇒ `rejected` 且**零文件动作**；
 *   未登记文件（不在 decisions 里）原地不动；
 * - MV-④：主干未命中（= 组织工作区（源 B）形态）⇒ 不自动搬、`manual` 列出、第二跳不发生；
 * - MV-⑤：清空回池 / 非 semver 目标 ⇒ 整体不搬（文档留原目录，M6 失联警示照旧）；
 * - MV-⑥：善后第二跳失败**不回滚**已成功的排期写（仍 200，异常如实进 `docMoves.failed`）。
 *
 * mv 是服务端文件动作、不经 HTTP 写路由面（故本文件不测 `/static` 白名单，那条在既有面锚里）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBoardServer } from "../dist/server.js";
import {
  docsMoveRegistrations,
  executeDocsMove,
  planDocsMove,
} from "../dist/docs-move.js";

const NOW = Date.parse("2026-09-26T12:00:00Z");
const FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded" };
const WRITE_HEADERS = { "x-board-write": "1" };

/** 一个临时「主仓根」，内含 `doc/{版本}/` 若干文件（相对路径以 `/` 书写）。 */
function makeRepo(files) {
  const root = mkdtempSync(join(tmpdir(), "board-docs-move-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, ...rel.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return root;
}

/** 想法挪版态（闸放行）+ 可控 version / decisions 的只读面假客户端。 */
function fakeClient(featureOver) {
  const feature = {
    featureId: "F1",
    state: "executing",
    title: "需求甲",
    plan: null,
    ownerGroup: "g",
    stage: "需求分析",
    approval: "未发起",
    version: "v0.9.1",
    decisions: null,
    contracts: null,
    createdAt: "c",
    updatedAt: "u",
    ...featureOver,
  };
  return {
    baseUrl: "http://fake",
    async getFeatures() {
      throw new Error("不该被排期写用例触达");
    },
    async getFeature() {
      return { feature, tasks: [], acceptance: null };
    },
    async getFeatureTrace() {
      throw new Error("不该被排期写用例触达");
    },
    async getProjects() {
      throw new Error("不该被排期写用例触达");
    },
    async getTasks() {
      throw new Error("不该被排期写用例触达");
    },
  };
}

/** 记录每次封装实收 input，按 results 逐次返回（不足则一律成功）。 */
function recordingSchedule(results = []) {
  const seen = [];
  const fn = async (input, _options) => {
    seen.push({ input });
    const over = results[seen.length - 1];
    return over ?? { ok: true, featureId: "F1", state: "executing", version: input.version };
  };
  return { fn, seen };
}

async function postSchedule(base, version) {
  const res = await fetch(`${base}/features/F1/schedule`, {
    method: "POST",
    redirect: "manual",
    headers: { ...FORM_HEADERS, ...WRITE_HEADERS, accept: "application/json" },
    body: `version=${encodeURIComponent(version)}`,
  });
  return { status: res.status, body: (await res.json()) };
}

/** 跑一次排期写：注入临时主仓根。 */
async function withDocsServer(
  repoRoot,
  client,
  scheduleFeatureImpl,
  run,
  releasedVersions = [],
) {
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    client,
    now: () => NOW,
    defaultGroup: "g",
    docs: { repoRoot, orgsDir: null },
    releasedVersions,
    scheduleFeatureImpl,
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
  }
}

const DEC_OLD = "doc/v0.9.1/甲-改造文档.md 用户确认改造文档";
const DEC_PLAIN = "2026-09-26 与单元对齐边界";

// ---------------------------------------------------------------------------
// HTTP 面（排期写链内触发）
// ---------------------------------------------------------------------------

test("MV-①：改版 ⇒ 主干登记文档搬到 doc/{新版}/ + 源消失 + 第二跳 advance 携带新路径", async () => {
  const root = makeRepo({ "doc/v0.9.1/甲-改造文档.md": "# 改造文档\n" });
  try {
    const client = fakeClient({ decisions: JSON.stringify([DEC_PLAIN, DEC_OLD]) });
    const { fn, seen } = recordingSchedule();
    await withDocsServer(root, client, fn, async (base) => {
      const { status, body } = await postSchedule(base, "v0.9.2");
      assert.equal(status, 200);
      assert.ok(existsSync(join(root, "doc/v0.9.2/甲-改造文档.md")), "文档已落到新目录");
      assert.equal(readFileSync(join(root, "doc/v0.9.2/甲-改造文档.md"), "utf8"), "# 改造文档\n", "内容原样搬，不改写");
      assert.ok(!existsSync(join(root, "doc/v0.9.1/甲-改造文档.md")), "旧路径不留副本");
      const moves = body.docMoves;
      assert.deepEqual(moves.moved, ["doc/v0.9.2/甲-改造文档.md"]);
      assert.deepEqual(moves.registerOnly, []);
      assert.deepEqual(moves.manual, []);
      assert.deepEqual(moves.failed, []);
      assert.equal(seen.length, 2, "第一跳写 version + 第二跳追加登记");
      assert.deepEqual(Object.keys(seen[0].input).sort(), ["featureId", "to", "version"], "第一跳仍仅三键（不带 decisions）");
      assert.deepEqual(seen[1].input.decisions, ["doc/v0.9.2/甲-改造文档.md"]);
      assert.deepEqual(Object.keys(seen[1].input).sort(), ["decisions", "featureId", "to", "version"], "第二跳仅多 decisions 一键，仍不触 stage/approval");
      assert.equal(seen[1].input.to, "executing", "第二跳同样走「to = 当前态」登记特例");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MV-②：幂等 —— 目标已存在 ⇒ 跳 mv（不覆盖）仅登记新路径", async () => {
  const root = makeRepo({
    "doc/v0.9.1/甲-改造文档.md": "旧版内容\n",
    "doc/v0.9.2/甲-改造文档.md": "新版已有内容\n",
  });
  try {
    const client = fakeClient({ decisions: JSON.stringify([DEC_OLD]) });
    const { fn, seen } = recordingSchedule();
    await withDocsServer(root, client, fn, async (base) => {
      const { status, body } = await postSchedule(base, "v0.9.2");
      assert.equal(status, 200);
      assert.equal(readFileSync(join(root, "doc/v0.9.2/甲-改造文档.md"), "utf8"), "新版已有内容\n", "已存在目标不被覆盖");
      assert.ok(existsSync(join(root, "doc/v0.9.1/甲-改造文档.md")), "未搬 ⇒ 源也不动");
      const moves = body.docMoves;
      assert.deepEqual(moves.moved, []);
      assert.deepEqual(moves.registerOnly, ["doc/v0.9.2/甲-改造文档.md"]);
      assert.deepEqual(seen[1].input.decisions, ["doc/v0.9.2/甲-改造文档.md"], "仅登记，仍进第二跳");
    });
    // 同版重提（现版本已 = 目标）⇒ 零变更写：不触发善后、无第二跳（口径同双条件闸的同版豁免）
    const client2 = fakeClient({ version: "v0.9.2", decisions: JSON.stringify([DEC_OLD]) });
    const rec2 = recordingSchedule();
    await withDocsServer(root, client2, rec2.fn, async (base) => {
      const { status, body } = await postSchedule(base, "v0.9.2");
      assert.equal(status, 200);
      assert.ok(!("docMoves" in body), "同版重提 ⇒ 不做任何文件动作、回执无该键");
      assert.equal(rec2.seen.length, 1, "无第二跳");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MV-③（守卫负例）：越树 / 层级越界 / 非法版本段 / 非 .md ⇒ rejected 且零文件动作；未登记文件原地不动", async () => {
  const root = makeRepo({
    "doc/v0.9.1/甲-改造文档.md": "a\n",
    "doc/v0.9.1/未登记.md": "b\n",
    "secret.md": "c\n",
  });
  try {
    const bad = [
      "doc/../secret.md 越树（上级）",
      "doc/v0.9.1/../../secret.md 越树（多级）",
      "doc/v0.9.1/sub/甲-改造文档.md 层级越界",
      "doc/v9/甲-改造文档.md 版本段不合法",
      "doc/v0.9.1/../../etc/passwd 非 .md",
      "C:/doc/v0.9.1/甲-改造文档.md 绝对路径/盘符",
      "/abs/repo/doc/v0.9.1/甲-改造文档.md 绝对路径（非独立起点）",
      "doc/v0.9.1\\sub\\甲-改造文档.md 反斜杠分隔",
    ];
    const client = fakeClient({ decisions: JSON.stringify([DEC_OLD, ...bad]) });
    const { fn, seen } = recordingSchedule();
    await withDocsServer(root, client, fn, async (base) => {
      const { status, body } = await postSchedule(base, "v0.9.2");
      assert.equal(status, 200, "改版写本身成功；守卫只拦文件动作");
      const moves = body.docMoves;
      assert.deepEqual(moves.moved, ["doc/v0.9.2/甲-改造文档.md"], "合法登记项照搬");
      assert.equal(moves.rejected.length, bad.length, "逐条列入 rejected，不静默吞");
      assert.ok(moves.rejected.includes(bad[0]));
      assert.ok(existsSync(join(root, "secret.md")), "越树目标从未被写/搬");
      assert.ok(existsSync(join(root, "doc/v0.9.1/未登记.md")), "非 decisions 登记路径永不成为动作对象");
      assert.ok(!existsSync(join(root, "doc/v0.9.2/未登记.md")), "未登记文件不会被顺手搬");
      assert.ok(!existsSync(join(root, "etc")), "不给目录越界留痕");
      assert.deepEqual(seen[1].input.decisions, ["doc/v0.9.2/甲-改造文档.md"], "拒掉的不进登记");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MV-④：主干未命中（组织工作区 / 源 B 形态）⇒ 不自动搬、manual 列出、第二跳不发生", async () => {
  const root = makeRepo({ "doc/v0.9.1/.gitkeep": "" });
  try {
    const client = fakeClient({
      decisions: JSON.stringify(["doc/v0.9.1/乙-需求确认单.md 确认单（落在组织工作区）", DEC_PLAIN]),
    });
    const { fn, seen } = recordingSchedule();
    await withDocsServer(root, client, fn, async (base) => {
      const { status, body } = await postSchedule(base, "v0.9.2");
      assert.equal(status, 200);
      const moves = body.docMoves;
      assert.deepEqual(moves.moved, []);
      assert.deepEqual(moves.registerOnly, []);
      assert.equal(moves.manual.length, 1, "未命中项列入手工");
      assert.match(moves.manual[0], /组织工作区（源 B）/, "回执说明为何不自动搬");
      assert.ok(!existsSync(join(root, "doc/v0.9.2")), "不凭未命中路径造新文件");
      assert.equal(seen.length, 1, "无搬成项 ⇒ 不发空 decisions 的第二跳");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MV-⑤：清空回池 / 非 semver 目标版本 ⇒ 整体不搬（文档留原目录）", async () => {
  const root = makeRepo({ "doc/v0.9.1/甲-改造文档.md": "a\n" });
  try {
    for (const target of ["", "backlog-x", "v0.9"]) {
      const client = fakeClient({ decisions: JSON.stringify([DEC_OLD]) });
      const { fn, seen } = recordingSchedule();
      await withDocsServer(root, client, fn, async (base) => {
        const { status, body } = await postSchedule(base, target);
        assert.equal(status, 200, `目标「${target}」的排期写本身不被本模块拦`);
        assert.ok(!("docMoves" in body), `目标「${target}」不合版本白名单 ⇒ 不触发善后、回执无该键`);
        assert.equal(seen.length, 1, "无第二跳");
      });
    }
    assert.ok(existsSync(join(root, "doc/v0.9.1/甲-改造文档.md")), "文档原地未动（M6 失联警示行仍如实显示）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MV-⑥：第二跳登记失败不回滚排期写 —— 仍 200，异常如实进 docMoves.failed", async () => {
  const root = makeRepo({ "doc/v0.9.1/甲-改造文档.md": "a\n" });
  try {
    const client = fakeClient({ decisions: JSON.stringify([DEC_OLD]) });
    const { fn, seen } = recordingSchedule([
      undefined,
      { ok: false, code: "bridge_unreachable", error: "桥没起（假）" },
    ]);
    await withDocsServer(root, client, fn, async (base) => {
      const { status, body } = await postSchedule(base, "v0.9.2");
      assert.equal(status, 200, "第一跳已成功 ⇒ 善后失败不得把整条写改成 5xx");
      assert.equal(body.ok, true);
      const moves = body.docMoves;
      assert.deepEqual(moves.moved, ["doc/v0.9.2/甲-改造文档.md"], "文件确实搬了（不回滚）");
      assert.equal(moves.failed.length, 1);
      assert.match(moves.failed[0], /decisions 追加未成功/);
      assert.match(moves.failed[0], /请宿主手工补登记/);
      assert.equal(seen.length, 2);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 纯函数层（规划 / 执行 / 登记集）—— HTTP 面已覆盖端到端，这里钉住守卫判据与注入口径
// ---------------------------------------------------------------------------

test("MV-P①：planDocsMove 与 executeDocsMove 可注入文件谓词（离线自测面，不依赖真盘）", () => {
  const root = "C:/tmp/repo";
  const plan = planDocsMove(JSON.stringify([DEC_OLD, "doc/v0.9.1/丙.md", DEC_PLAIN]), "v0.9.3", root);
  assert.equal(plan.actions.length, 2);
  assert.equal(plan.targetVersion, "v0.9.3");
  assert.deepEqual(plan.rejected, [], "无 doc/ 引用的一般登记条目与本模块无关");
  assert.deepEqual(plan.manual, []);
  assert.ok(plan.actions[0].fromAbs.includes("甲-改造文档.md"));
  assert.ok(plan.actions[0].toAbs.endsWith(join("v0.9.3", "甲-改造文档.md")), "落点 = 主仓 doc/{新版本}/{文件}");
  // 只有第一条（甲）在「主干树内命中」⇒ 搬它；丙 未命中 ⇒ 落 manual（源 B 形态）
  const result = executeDocsMove(plan, (p) => p === plan.actions[0].fromAbs, () => {});
  assert.deepEqual(result.moved, ["doc/v0.9.3/甲-改造文档.md"]);
  assert.equal(result.manual.length, 1, "主干未命中者落 manual（不猜落点、不碰）");
  assert.deepEqual(docsMoveRegistrations(result), ["doc/v0.9.3/甲-改造文档.md"]);
});

test("MV-P②：同版本登记项无需搬（不产生动作、不进 manual/rejected）", () => {
  const plan = planDocsMove(JSON.stringify(["doc/v0.9.2/甲-改造文档.md"]), "v0.9.2", "C:/tmp/repo");
  assert.deepEqual(plan.actions, []);
  assert.deepEqual(plan.manual, []);
  assert.deepEqual(plan.rejected, []);
});
