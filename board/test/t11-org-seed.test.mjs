import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGENTS_TARGET_FILE,
  AGENTS_TEMPLATE_FILE,
  backfillOrgWorkspaces,
  extractSpecStamp,
  orgsToBackfill,
  renderAgentsTemplate,
  resolveOrgSeedOptions,
  seedOrgWorkspace,
  snapshotHeader,
  summarizeSeedResults,
} from "../dist/org-seed.js";
import { createBoardServer } from "../dist/server.js";
import { WRITE_ROUTES } from "../dist/write-guard.js";

// ---------------------------------------------------------------------------
// fixture：模板目录（注入）+ 主仓 flow/spec 源 + 组织目录根
// ---------------------------------------------------------------------------

const TEMPLATE = [
  "# {ORG_NAME} 工作区",
  "kind={HOST_KIND}",
  "stamp={FLOW_SPEC_STAMP}",
  "members={ORG_MEMBER_PROJECTS}",
  "",
].join("\n");

const SPEC_MAIN = "# 需求流程\n\n> **规范版本戳**：v9.9.9（2099-01-01）\n\n正文 A\n";
const SPEC_MAP = "# 引擎映射\n\n> **规范版本戳**：v9.9.9（2099-01-01）\n\n正文 B\n";
const SPEC_TPL = "# 文档模板\n\n> **规范版本戳**：v9.9.9（2099-01-01）\n\n模板正文（含使用期占位 {topic}，逐字节透传）\n";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "board-t11-"));
  const templateRoot = join(root, "templates");
  mkdirSync(templateRoot, { recursive: true });
  writeFileSync(join(templateRoot, AGENTS_TEMPLATE_FILE), TEMPLATE, "utf8");
  const repoRoot = join(root, "repo");
  mkdirSync(join(repoRoot, "flow", "spec"), { recursive: true });
  writeFileSync(join(repoRoot, "flow", "spec", "需求流程.md"), SPEC_MAIN, "utf8");
  writeFileSync(join(repoRoot, "flow", "spec", "引擎映射.md"), SPEC_MAP, "utf8");
  writeFileSync(join(repoRoot, "flow", "spec", "文档模板.md"), SPEC_TPL, "utf8");
  const orgsDir = join(root, "orgs");
  mkdirSync(orgsDir, { recursive: true });
  return { root, templateRoot, repoRoot, orgsDir };
}

function opts(f, extra = {}) {
  return resolveOrgSeedOptions(
    {
      templateRoot: f.templateRoot,
      repoRoot: f.repoRoot,
      boardVersion: "9.9.9",
      hostKind: "opencode",
      ...extra,
    },
    {},
  );
}

function fakeClient() {
  return {
    baseUrl: "http://fake",
    async getFeatures() {
      return { features: [], stateCounts: null };
    },
    async getFeature() {
      throw new Error("不该被本用例触达");
    },
    async getFeatureTrace() {
      throw new Error("不该被本用例触达");
    },
    async getProjects() {
      throw new Error("不该被本用例触达");
    },
    async getTasks() {
      throw new Error("不该被本用例触达");
    },
  };
}

async function withServer(f, run, overrides = {}) {
  const ledgerFile = join(f.root, "data", "orgs.json");
  const handle = await createBoardServer({
    host: "127.0.0.1",
    port: 0,
    now: () => Date.parse("2026-09-28T00:00:00Z"),
    client: fakeClient(),
    docs: { repoRoot: f.repoRoot, orgsDir: f.orgsDir },
    orgsLedgerFile: ledgerFile,
    ...overrides,
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`, { ledgerFile });
  } finally {
    await handle.close();
  }
}

function postOrg(base, org) {
  return fetch(`${base}/orgs`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-board-write": "1", accept: "application/json" },
    body: new URLSearchParams({ org }).toString(),
  });
}

function firstLine(text) {
  return text.split("\n")[0];
}

// ---------------------------------------------------------------------------
// ① 纯函数层
// ---------------------------------------------------------------------------

test("T11-① 纯函数：renderAgentsTemplate 只替换 T11 已知键，未知占位符原样保留", () => {
  const out = renderAgentsTemplate(TEMPLATE, { org: "组A", hostKind: "codex", flowSpecStamp: "v1.0.0（X）" });
  assert.match(out, /# 组A 工作区/);
  assert.match(out, /kind=codex/);
  assert.match(out, /stamp=v1\.0\.0（X）/);
  assert.ok(out.includes("{ORG_MEMBER_PROJECTS}"), "未知占位符（需成员写面数据）原样保留，不臆造");
  const fallback = renderAgentsTemplate("s={FLOW_SPEC_STAMP}", { org: "o", hostKind: "claude", flowSpecStamp: null });
  assert.match(fallback, /未获取/);
});

test("T11-② 纯函数：规范版本戳提取 + 快照头双记三件（来源 / board 版本 / 源版本戳）", () => {
  assert.equal(extractSpecStamp(SPEC_MAIN), "v9.9.9（2099-01-01）");
  assert.equal(extractSpecStamp("没有版本戳的正文"), null);
  const h = snapshotHeader("flow/spec/需求流程.md", "0.9.4", "v9.9.9（2099-01-01）");
  assert.match(h, /来源 flow\/spec\/需求流程\.md/);
  assert.match(h, /board 版本 v0\.9\.4/);
  assert.match(h, /源文件规范版本戳 v9\.9\.9（2099-01-01）/);
});

test("T11-③ 纯函数：回填清单 = 盘∪台账（剔停用 / 去重 / 排序）", () => {
  assert.deepEqual(
    orgsToBackfill({ disk: ["b", "a"], ledger: ["c", "b", "  "], disabled: ["c"] }),
    ["a", "b"],
  );
});

// ---------------------------------------------------------------------------
// ② 单组织种子化（建组织链落盘口径）
// ---------------------------------------------------------------------------

test("T11-④ 建组织链：AGENTS.md + flow/spec 三份快照落盘（fixture 模板注入）", () => {
  const f = fixture();
  const orgDir = join(f.orgsDir, "新组");
  const r = seedOrgWorkspace(orgDir, "新组", opts(f));
  assert.deepEqual(
    [...r.created].sort(),
    ["AGENTS.md", "flow/spec/文档模板.md", "flow/spec/引擎映射.md", "flow/spec/需求流程.md"].sort(),
  );
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(summarizeSeedResults([r]), { created: 4, skipped: 0 });

  const agents = readFileSync(join(orgDir, AGENTS_TARGET_FILE), "utf8");
  assert.match(agents, /# 新组 工作区/);
  assert.match(agents, /kind=opencode/);
  assert.match(agents, /stamp=v9\.9\.9（2099-01-01）/);

  const snap = readFileSync(join(orgDir, "flow", "spec", "需求流程.md"), "utf8");
  assert.ok(snap.startsWith("<!--"), "快照首行 = 版本戳双记注释");
  assert.match(firstLine(snap), /来源 flow\/spec\/需求流程\.md/);
  assert.match(firstLine(snap), /board 版本 v9\.9\.9/);
  assert.match(firstLine(snap), /源文件规范版本戳 v9\.9\.9（2099-01-01）/);
  assert.ok(snap.includes("正文 A"), "源正文逐字保留");

  const tplSnap = readFileSync(join(orgDir, "flow", "spec", "文档模板.md"), "utf8");
  assert.match(firstLine(tplSnap), /来源 flow\/spec\/文档模板\.md/);
  assert.ok(tplSnap.includes("{topic}"), "模板内的使用期占位符逐字节透传（快照不经模板渲染）");
});

test("T11-⑤ 幂等只补缺：已有文件一律不覆盖（组织自改保留），缺失补齐；再跑无新建", () => {
  const f = fixture();
  const orgDir = join(f.orgsDir, "存改组");
  mkdirSync(join(orgDir, "flow", "spec"), { recursive: true });
  writeFileSync(join(orgDir, "AGENTS.md"), "组织自改版", "utf8");
  writeFileSync(join(orgDir, "flow", "spec", "需求流程.md"), "组织自改规范", "utf8");

  const r = seedOrgWorkspace(orgDir, "存改组", opts(f));
  assert.equal(readFileSync(join(orgDir, "AGENTS.md"), "utf8"), "组织自改版");
  assert.equal(readFileSync(join(orgDir, "flow", "spec", "需求流程.md"), "utf8"), "组织自改规范");
  assert.deepEqual([...r.created].sort(), ["flow/spec/引擎映射.md", "flow/spec/文档模板.md"]);
  assert.deepEqual([...r.skipped].sort(), ["AGENTS.md", "flow/spec/需求流程.md"].sort());

  const again = seedOrgWorkspace(orgDir, "存改组", opts(f));
  assert.deepEqual(again.created, [], "第二次幂等：零新建");
});

test("T11-⑥ fail-open：模板缺失 ⇒ 结构化告警且不抛，flow 快照照落盘", () => {
  const f = fixture();
  rmSync(join(f.templateRoot, AGENTS_TEMPLATE_FILE));
  const orgDir = join(f.orgsDir, "无模板组");
  const r = seedOrgWorkspace(orgDir, "无模板组", opts(f));
  assert.equal(existsSync(join(orgDir, "AGENTS.md")), false);
  assert.equal(existsSync(join(orgDir, "flow", "spec", "需求流程.md")), true);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].code, "board_org_seed_template_missing");
});

test("T11-⑦ fail-open：flow/spec 缺失 ⇒ 告警、AGENTS.md 照落盘（{FLOW_SPEC_STAMP} 回退）", () => {
  const f = fixture();
  rmSync(join(f.repoRoot, "flow"), { recursive: true, force: true });
  const orgDir = join(f.orgsDir, "无规范组");
  const r = seedOrgWorkspace(orgDir, "无规范组", opts(f));
  assert.equal(existsSync(join(orgDir, "AGENTS.md")), true);
  assert.equal(r.warnings.filter((w) => w.code === "board_org_seed_spec_missing").length, 3);
  assert.match(readFileSync(join(orgDir, "AGENTS.md"), "utf8"), /未获取：flow\/spec 不可读/);
});

test("T11-⑧ fail-open：目标不可写（组织目录位被文件占用）⇒ board_org_seed_write_failed，不抛", () => {
  const f = fixture();
  writeFileSync(join(f.orgsDir, "占位文件"), "x", "utf8");
  const r = seedOrgWorkspace(join(f.orgsDir, "占位文件"), "占位文件", opts(f));
  assert.deepEqual(r.created, []);
  assert.equal(r.warnings.length, 4, "四份落盘各自失败各自告警");
  assert.ok(r.warnings.every((w) => w.code === "board_org_seed_write_failed"));
});

// ---------------------------------------------------------------------------
// ③ 启动幂等回填
// ---------------------------------------------------------------------------

test("T11-⑨ 回填：盘∪台账、跳过停用、只补缺、逐组织 fail-open", () => {
  const f = fixture();
  mkdirSync(join(f.orgsDir, "盘上一组"), { recursive: true });
  mkdirSync(join(f.orgsDir, "盘上二组"), { recursive: true });
  writeFileSync(join(f.orgsDir, "盘上二组", "AGENTS.md"), "自改", "utf8");
  const r = backfillOrgWorkspaces({
    orgsDir: f.orgsDir,
    disk: ["盘上一组", "盘上二组", "停用组"],
    ledger: ["台账组", "停用组", "盘上一组"],
    disabled: ["停用组"],
    options: opts(f),
  });
  assert.deepEqual(r.orgs, ["台账组", "盘上一组", "盘上二组"].sort());
  assert.ok(existsSync(join(f.orgsDir, "台账组", "AGENTS.md")), "台账独有组织（盘上无目录）也补建");
  assert.equal(readFileSync(join(f.orgsDir, "盘上二组", "AGENTS.md"), "utf8"), "自改", "不覆盖已有");
  assert.equal(existsSync(join(f.orgsDir, "停用组", "AGENTS.md")), false, "停用组织跳过");
});

test("T11-⑨b 根不代建：orgsDir 根不存在 ⇒ 回填整体跳过（绝不把根建出来）", () => {
  const f = fixture();
  const missingRoot = join(f.root, "no-such-root");
  const r = backfillOrgWorkspaces({
    orgsDir: missingRoot,
    disk: [],
    ledger: ["台账组"],
    disabled: [],
    options: opts(f),
  });
  assert.deepEqual(r.orgs, []);
  assert.equal(existsSync(missingRoot), false, "根不得被种子化代建（BD15/BD14 硬纪律）");
});

// ---------------------------------------------------------------------------
// ④ HTTP 装配：建组织链 + listen 前回填 + 负向（省略即不种子化）+ 白名单不动
// ---------------------------------------------------------------------------

test("T11-⑩ HTTP：POST /orgs 建组织 ⇒ AGENTS.md + flow 快照当场出现；回显形状不变", async () => {
  const f = fixture();
  await withServer(
    f,
    async (base, env) => {
      const res = await postOrg(base, "接口组");
      assert.equal(res.status, 201);
      assert.deepEqual(await res.json(), { ok: true, org: "接口组", ledgerFile: env.ledgerFile });
      assert.ok(existsSync(join(f.orgsDir, "接口组", "AGENTS.md")));
      assert.ok(existsSync(join(f.orgsDir, "接口组", "flow", "spec", "需求流程.md")));
      assert.ok(existsSync(join(f.orgsDir, "接口组", "flow", "spec", "文档模板.md")), "三份规范快照含文档模板");
    },
    { orgSeed: { templateRoot: f.templateRoot, repoRoot: f.repoRoot, boardVersion: "9.9.9", hostKind: "opencode" } },
  );
});

test("T11-⑪ HTTP：启动回填 —— listen 前为存量组织补 AGENTS.md（无需任何写请求）", async () => {
  const f = fixture();
  mkdirSync(join(f.orgsDir, "存量组"), { recursive: true });
  await withServer(
    f,
    async () => {
      assert.ok(existsSync(join(f.orgsDir, "存量组", "AGENTS.md")), "listen 前已回填");
      assert.ok(existsSync(join(f.orgsDir, "存量组", "flow", "spec", "引擎映射.md")));
      assert.ok(existsSync(join(f.orgsDir, "存量组", "flow", "spec", "文档模板.md")), "回填同样补文档模板快照");
    },
    { orgSeed: { templateRoot: f.templateRoot, repoRoot: f.repoRoot, boardVersion: "9.9.9", hostKind: "opencode" } },
  );
});

test("T11-⑫ 负向：orgSeed 省略 / null ⇒ 完全不种子化（既有行为逐字节不变）", async () => {
  const f = fixture();
  mkdirSync(join(f.orgsDir, "未启用组"), { recursive: true });
  await withServer(f, async (base) => {
    assert.equal(existsSync(join(f.orgsDir, "未启用组", "AGENTS.md")), false, "启动不回填");
    assert.equal((await postOrg(base, "新建未启用组")).status, 201);
    assert.equal(existsSync(join(f.orgsDir, "新建未启用组", "AGENTS.md")), false, "建组织链不落盘");
  });
  await withServer(
    f,
    async () => {
      assert.equal(existsSync(join(f.orgsDir, "存量组2", "AGENTS.md")), false);
    },
    { orgSeed: null },
  );
});

test("T11-⑬ 无独立写路由：写面白名单仍 11 条，无任何种子化路径", () => {
  assert.equal(WRITE_ROUTES.length, 11);
  assert.ok(!WRITE_ROUTES.some((r) => /seed|agents/i.test(r)));
});
