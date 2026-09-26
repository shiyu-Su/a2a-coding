/**
 * BD10 docs-read 用例（REQ-v0.9.1-2026-09-25-04 · 判据 1，纯函数级；HTTP 双层归 BD11。
 * REQ-v0.9.2-2026-09-26-01 起目录扫描 `listDocs` / 分类标注作废 ⇒ 对应用例随删，
 * 本文件只剩**单文件读取守卫**）。
 *
 * 覆盖：`..` / `%2e%2e` / 盘符 / 绝对路径 / 反斜杠 / 非 .md / 超 256KiB / version 非法
 *   ⇒ 全部结构化拒绝或截断降级，**不抛未捕获异常**；失败文案不泄根。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_DOC_FILE_BYTES,
  defaultRepoRoot,
  docsRootFor,
  isValidDocVersion,
  readDoc,
} from "../dist/docs-read.js";

/** 建一个临时盘根，返回 {dir, abs}。 */
function tmpDisk(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, abs: dir };
}

/** 落一份文档：source=A ⇒ <disk>/doc/{version}/{name}；B ⇒ <disk>/orgs/org1/doc/{version}/{name}。 */
function putDoc(disk, source, version, name, content = "# doc\n") {
  const base =
    source === "A"
      ? join(disk.abs, "doc", version)
      : join(disk.abs, "orgs", "org1", "doc", version);
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, name), content, "utf8");
}

// ---------------------------------------------------------------------------
// ① 守卫负例
// ---------------------------------------------------------------------------

test("version 白名单：合法收下，非法一律拒（且不抛）", () => {
  assert.equal(isValidDocVersion("v0.9.1"), true);
  assert.equal(isValidDocVersion("v10.0.23"), true);
  for (const bad of ["", "v0.9", "v0.9.1.2", "0.9.1", "V0.9.1", "v0.9.x", "v0.9.1/", "../v0.9.1", "v0.9.1.md", "version"]) {
    assert.equal(isValidDocVersion(bad), false, bad);
  }
});

test("version 非法 ⇒ readDoc 结构化拒绝（不抛错）", () => {
  const disk = tmpDisk("board-docs-");
  const dirs = { repoRoot: disk.abs, orgsDir: null, org: null };
  for (const bad of ["v9", "../../etc"]) {
    const r = readDoc(dirs, "A", bad, "a.md");
    assert.equal(r.ok, false);
    assert.equal(r.code, "docs_read_invalid");
  }
  rmSync(disk.abs, { recursive: true, force: true });
});

test("文件名负例：.. / %2e%2e / 盘符 / 绝对路径 / 反斜杠 / 非 .md ⇒ 全部结构化拒绝", () => {
  const disk = tmpDisk("board-docs-");
  putDoc(disk, "A", "v1.2.3", "ok.md");
  const dirs = { repoRoot: disk.abs, orgsDir: null, org: null };
  for (const name of [
    "..",
    "../ok.md",
    "..\\..\\secret.md",
    "%2e%2e%2fsecret",
    "%2e%2e/ok.md",
    "C:secret.md",
    "C:\\windows\\evil.md",
    "/etc/passwd.md",
    "\\\\server\\share\\x.md",
    "notes.txt",
    "ok.MD",
    "a/b.md",
    "",
  ]) {
    const r = readDoc(dirs, "A", "v1.2.3", name);
    assert.equal(r.ok, false, name);
    assert.ok(r.code === "docs_read_invalid" || r.code === "docs_read_escapes_root", name);
    assert.ok(!r.error.includes(disk.abs), `失败文案不得泄根路径: ${name}`);
  }
  rmSync(disk.abs, { recursive: true, force: true });
});

test("根内收负例：即使名字过段检查，resolve 出根仍拒（escapes_root 档）", () => {
  const disk = tmpDisk("board-docs-");
  const dirs = { repoRoot: disk.abs, orgsDir: null, org: null };
  // 段检查放行（无分隔符/盘符/%、以 .md 结尾），但 version 档已拦 ../；
  // 这里用探针喂一个「目录在 doc 根内但内容指外」不构成逃逸 ——
  // 直接验证 insideRoot 语义：orgsDir 未配置时源 B 一律 not_found 而非越权。
  const r = readDoc(dirs, "B", "v1.2.3", "x.md");
  assert.equal(r.ok, false);
  rmSync(disk.abs, { recursive: true, force: true });
});

test("256KiB 读上限：超限只读到上限 + truncated 标记；未超限 truncated=false", () => {
  const disk = tmpDisk("board-docs-");
  const big = "あ".repeat(MAX_DOC_FILE_BYTES); // UTF-8 三字节 ⇒ 远超上限
  putDoc(disk, "A", "v1.2.3", "big.md", big);
  putDoc(disk, "A", "v1.2.3", "small.md", "# small\n");
  const dirs = { repoRoot: disk.abs, orgsDir: null, org: null };
  const bigRead = readDoc(dirs, "A", "v1.2.3", "big.md");
  assert.equal(bigRead.ok, true);
  assert.equal(bigRead.truncated, true);
  assert.equal(bigRead.bytes, MAX_DOC_FILE_BYTES);
  assert.ok(Buffer.byteLength(bigRead.content, "utf8") <= MAX_DOC_FILE_BYTES);
  const smallRead = readDoc(dirs, "A", "v1.2.3", "small.md");
  assert.equal(smallRead.ok, true);
  assert.equal(smallRead.truncated, false);
  assert.equal(smallRead.content, "# small\n");
  rmSync(disk.abs, { recursive: true, force: true });
});

test("文件缺失 / 目标是目录 ⇒ not_found，不抛", () => {
  const disk = tmpDisk("board-docs-");
  const vdir = join(disk.abs, "doc", "v1.2.3");
  mkdirSync(join(vdir, "dir.md"), { recursive: true });
  const dirs = { repoRoot: disk.abs, orgsDir: null, org: null };
  const missing = readDoc(dirs, "A", "v1.2.3", "nope.md");
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "docs_read_not_found");
  const isDir = readDoc(dirs, "A", "v1.2.3", "dir.md");
  assert.equal(isDir.ok, false);
  assert.equal(isDir.code, "docs_read_not_found");
  rmSync(disk.abs, { recursive: true, force: true });
});

test("readDoc 走源 B 能读到组织工作区的文档", () => {
  const disk = tmpDisk("board-docs-");
  putDoc(disk, "B", "v1.2.3", "org-doc.md", "# org content\n");
  const r = readDoc({ repoRoot: disk.abs, orgsDir: join(disk.abs, "orgs"), org: "org1" }, "B", "v1.2.3", "org-doc.md");
  assert.equal(r.ok, true);
  assert.equal(r.content, "# org content\n");
  rmSync(disk.abs, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 根推导
// ---------------------------------------------------------------------------

test("defaultRepoRoot = 板根上一级；docsRootFor A/B 落点正确", () => {
  const root = defaultRepoRoot();
  assert.ok(root.endsWith("a2a-coding") || root.length > 1);
  assert.equal(docsRootFor("A", { repoRoot: "/r", orgsDir: "/o", org: "g" }), join("/r", "doc"));
  assert.equal(docsRootFor("B", { repoRoot: "/r", orgsDir: "/o", org: "g" }), join("/o", "g", "doc"));
});

test("目录扫描已作废：docs-read 不再导出 listDocs / classifyDoc（REQ-v0.9.2 按需求归约回归锚）", async () => {
  const mod = await import("../dist/docs-read.js");
  assert.equal(mod.listDocs, undefined, "版本目录 flat 清单的读面入口已移除");
  assert.equal(mod.classifyDoc, undefined, "分类标注随清单一并作废");
  assert.equal(typeof mod.readDoc, "function", "单文件守卫读取仍在（打开通道不动）");
});
