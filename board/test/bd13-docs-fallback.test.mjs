/**
 * BD13 补源 B 用例（v0.9.1 需求 3 · BD12 收口偏差 ②）：
 * 详情页「阶段产出」区的打开链接不带 `src`（缺省源 A）⇒ 组织工作区登记的文档 404。
 * 修法取 b 案（服务端回落）：`src` 缺省且源 A `not_found` ⇒ 自动查源 B，回落逐源过守卫；
 * 实际来源经响应头 `X-Docs-Source` + html 页头标注透出（两源同名 ⇒ 源 A 优先，不歧义）。
 *
 * 覆盖：
 * ① 正例：源 B 文档经无 src 链接可打开（text/plain 档 + html 档来源标注）；
 * ② 同名歧义：两源同名 ⇒ 缺省命中源 A（内容与标注都是 A）；
 * ③ 显式 src 不回落（`src=A` 未命中 ⇒ 404，行为与 BD11 一致）；
 * ④ 负例不回归：bd11 越界名清单跑一遍 ⇒ 4xx、不泄根（回落通路不开守卫口子）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBoardServer } from "../dist/server.js";

const NOW = Date.parse("2026-09-24T12:00:00Z");

function tmpDisk() {
  return mkdtempSync(join(tmpdir(), "board-bd13fb-"));
}

function put(disk, source, version, name, content = "# doc\n") {
  const base = source === "A" ? join(disk, "doc", version) : join(disk, "orgs", "org1", "doc", version);
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, name), content, "utf8");
  return join(base, name);
}

function fakeClient(featureOver = {}) {
  const feature = {
    featureId: "F1",
    state: "executing",
    title: "补源 B",
    plan: null,
    ownerGroup: "org1",
    stage: "改造方案",
    version: "v1.2.3",
    approval: "已通过",
    decisions: null,
    contracts: null,
    createdAt: "c",
    updatedAt: "u",
    ...featureOver,
  };
  return {
    client: {
      baseUrl: "http://fake",
      async getFeatures() {
        return { features: [], stateCounts: {} };
      },
      async getFeature(featureId) {
        return { feature: { ...feature, featureId }, tasks: [] };
      },
      async getFeatureTrace(featureId) {
        return { featureId, featureState: feature.state, nodes: [] };
      },
      async getProjects() {
        return { source: null, note: null, observedAt: null, machines: [], runners: [] };
      },
      async getTasks(projectId) {
        return { projectId, reachable: true, notice: null, tasks: [] };
      },
    },
  };
}

async function withServer(run, { featureOver, docs } = {}) {
  const { client } = fakeClient(featureOver);
  const handle = await createBoardServer({ host: "127.0.0.1", port: 0, client, now: () => NOW, docs });
  try {
    await run(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
  }
}

async function fetchText(base, path, headers) {
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

// ---------------------------------------------------------------------------
// ① 正例：无 src 链接命中源 B
// ---------------------------------------------------------------------------

test("无 src 缺省读 ⇒ 源 A 未命中自动回落源 B（text/plain 档 + X-Docs-Source: B）", async () => {
  const disk = tmpDisk();
  try {
    put(disk, "B", "v1.2.3", "补源B-需求确认单.md", "# B 侧正文\n");
    await withServer(
      async (base) => {
        const res = await fetchText(base, `/features/F1/docs?file=${encodeURIComponent("补源B-需求确认单.md")}`);
        assert.equal(res.status, 200);
        assert.equal(res.text, "# B 侧正文\n");
        assert.equal(res.headers.get("x-docs-source"), "B");
      },
      { docs: { repoRoot: disk, orgsDir: join(disk, "orgs") } },
    );
  } finally {
    rmSync(disk, { recursive: true, force: true });
  }
});

test("回落命中源 B 的 html 档 ⇒ 页头标注「组织工作区」", async () => {
  const disk = tmpDisk();
  try {
    put(disk, "B", "v1.2.3", "b.md", "# B\n");
    await withServer(
      async (base) => {
        const res = await fetchText(base, "/features/F1/docs?file=b.md", {
          accept: "text/html,application/xhtml+xml",
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("x-docs-source"), "B");
        assert.match(res.text, /来源：组织工作区/);
      },
      { docs: { repoRoot: disk, orgsDir: join(disk, "orgs") } },
    );
  } finally {
    rmSync(disk, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ② 同名歧义：源 A 优先
// ---------------------------------------------------------------------------

test("两源同名 ⇒ 无 src 缺省命中源 A（内容与来源标注均为 A，不歧义）", async () => {
  const disk = tmpDisk();
  try {
    put(disk, "A", "v1.2.3", "same.md", "# A 侧\n");
    put(disk, "B", "v1.2.3", "same.md", "# B 侧\n");
    await withServer(
      async (base) => {
        const res = await fetchText(base, "/features/F1/docs?file=same.md");
        assert.equal(res.status, 200);
        assert.equal(res.text, "# A 侧\n");
        assert.equal(res.headers.get("x-docs-source"), "A");
        const html = await fetchText(base, "/features/F1/docs?file=same.md", { accept: "text/html" });
        assert.match(html.text, /来源：主仓/);
      },
      { docs: { repoRoot: disk, orgsDir: join(disk, "orgs") } },
    );
  } finally {
    rmSync(disk, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ③ 显式 src 不回落（BD11 现状不回归）
// ---------------------------------------------------------------------------

test("显式 src=A 未命中 ⇒ 404 不回落源 B；显式 src=B 直读源 B 标注 B", async () => {
  const disk = tmpDisk();
  try {
    put(disk, "B", "v1.2.3", "only-b.md", "# B\n");
    await withServer(
      async (base) => {
        const a = await fetchText(base, "/features/F1/docs?file=only-b.md&src=A");
        assert.equal(a.status, 404);
        assert.equal(a.headers.get("x-docs-source"), "A");
        const b = await fetchText(base, "/features/F1/docs?file=only-b.md&src=B");
        assert.equal(b.status, 200);
        assert.equal(b.headers.get("x-docs-source"), "B");
      },
      { docs: { repoRoot: disk, orgsDir: join(disk, "orgs") } },
    );
  } finally {
    rmSync(disk, { recursive: true, force: true });
  }
});

test("orgsDir 未配置（源 B 无根）⇒ 缺省读只查源 A，缺失仍 404 不抛穿", async () => {
  const disk = tmpDisk();
  try {
    await withServer(
      async (base) => {
        const res = await fetchText(base, "/features/F1/docs?file=nope.md");
        assert.equal(res.status, 404);
      },
      { docs: { repoRoot: disk, orgsDir: null } },
    );
  } finally {
    rmSync(disk, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ④ 越界负例不回归（bd11 同清单，跑在双源齐备的盘上）
// ---------------------------------------------------------------------------

test("负例不回归：.. / 绝对路径 / 非 .md / 缺失 ⇒ 4xx 且两源均不泄根", async () => {
  const disk = tmpDisk();
  try {
    put(disk, "A", "v1.2.3", "ok.md");
    put(disk, "B", "v1.2.3", "ok.md");
    await withServer(
      async (base) => {
        for (const file of ["..", "../ok.md", "%2e%2e/ok.md", "/etc/passwd.md", "a\\b.md", "x.txt", "nope.md"]) {
          const res = await fetchText(base, `/features/F1/docs?file=${encodeURIComponent(file)}`);
          assert.ok(res.status === 400 || res.status === 404, `${file} ⇒ ${res.status}`);
          assert.equal(res.headers.get("cache-control"), "no-store");
          assert.ok(!res.text.includes(disk), `响应不得泄根路径：${file} → ${res.text}`);
        }
      },
      { docs: { repoRoot: disk, orgsDir: join(disk, "orgs") } },
    );
  } finally {
    rmSync(disk, { recursive: true, force: true });
  }
});
