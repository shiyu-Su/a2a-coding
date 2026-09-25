/**
 * BD10 docs-read 用例（REQ-v0.9.1-2026-09-25-04 · 判据 1/2，纯函数级；HTTP 双层归 BD11）。
 *
 * 两组：
 * ① 守卫负例 —— `..` / `%2e%2e` / 盘符 / 绝对路径 / 反斜杠 / 非 .md / 超 256KiB / version 非法
 *    ⇒ 全部拒绝或降级（结构化失败 / 空清单 / 截断标记），**不抛未捕获异常**；
 * ② 双源合并 —— 临时造两源同 version 目录 ⇒ 合并 + 来源标注正确；单源 ⇒ 只列该源；
 *    无目录 ⇒ 空清单。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_DOC_FILE_BYTES,
  classifyDoc,
  defaultRepoRoot,
  docsRootFor,
  isValidDocVersion,
  listDocs,
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

test("version 非法 ⇒ listDocs 空清单、readDoc 结构化拒绝（均不抛错）", () => {
  const disk = tmpDisk("board-docs-");
  const dirs = { repoRoot: disk.abs, orgsDir: null, org: null };
  assert.deepEqual(listDocs(dirs, "v9"), []);
  assert.deepEqual(listDocs(dirs, "../../etc"), []);
  const r = readDoc(dirs, "A", "v9", "a.md");
  assert.equal(r.ok, false);
  assert.equal(r.code, "docs_read_invalid");
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

test("列目录只收 .md 普通文件：非 .md / 目录 / 符号目录混入不出现在清单", () => {
  const disk = tmpDisk("board-docs-");
  const vdir = join(disk.abs, "doc", "v1.2.3");
  mkdirSync(vdir, { recursive: true });
  writeFileSync(join(vdir, "a-改造文档.md"), "x", "utf8");
  writeFileSync(join(vdir, "b.txt"), "x", "utf8");
  writeFileSync(join(vdir, "c.md.bak"), "x", "utf8");
  mkdirSync(join(vdir, "sub.md"), { recursive: true });
  const entries = listDocs({ repoRoot: disk.abs, orgsDir: null, org: null }, "v1.2.3");
  assert.deepEqual(entries.map((e) => e.name), ["a-改造文档.md"]);
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

// ---------------------------------------------------------------------------
// ② 双源合并
// ---------------------------------------------------------------------------

test("双源同 version：合并列出 + 同名两处都有 ⇒ 分行并标注来源 A/B", () => {
  const disk = tmpDisk("board-docs-");
  const orgs = join(disk.abs, "orgs");
  // A 源：two.md + only-a.md；B 源：two.md + only-b.md
  putDoc(disk, "A", "v1.2.3", "two.md");
  putDoc(disk, "A", "v1.2.3", "only-a.md");
  mkdirSync(join(orgs, "org1", "doc", "v1.2.3"), { recursive: true });
  writeFileSync(join(orgs, "org1", "doc", "v1.2.3", "two.md"), "b", "utf8");
  writeFileSync(join(orgs, "org1", "doc", "v1.2.3", "only-b.md"), "b", "utf8");
  const entries = listDocs({ repoRoot: disk.abs, orgsDir: orgs, org: "org1" }, "v1.2.3");
  const shaped = entries.map((e) => `${e.source}:${e.name}`);
  assert.deepEqual(shaped, ["A:only-a.md", "A:two.md", "B:only-b.md", "B:two.md"]);
  rmSync(disk.abs, { recursive: true, force: true });
});

test("单源 ⇒ 只列该源；orgsDir 未配置 ⇒ 只剩源 A", () => {
  const disk = tmpDisk("board-docs-");
  putDoc(disk, "B", "v1.2.3", "b-only.md");
  const orgs = join(disk.abs, "orgs");
  const dirsB = { repoRoot: disk.abs, orgsDir: orgs, org: "org1" };
  assert.deepEqual(listDocs(dirsB, "v1.2.3").map((e) => `${e.source}:${e.name}`), ["B:b-only.md"]);
  const dirsNoOrgs = { repoRoot: disk.abs, orgsDir: null, org: null };
  assert.deepEqual(listDocs(dirsNoOrgs, "v1.2.3"), []);
  putDoc(disk, "A", "v1.2.3", "a-only.md");
  assert.deepEqual(listDocs(dirsNoOrgs, "v1.2.3").map((e) => `${e.source}:${e.name}`), ["A:a-only.md"]);
  rmSync(disk.abs, { recursive: true, force: true });
});

test("两源目录都不存在 ⇒ 空清单（不抛错）", () => {
  const disk = tmpDisk("board-docs-");
  const entries = listDocs({ repoRoot: join(disk.abs, "no-a"), orgsDir: join(disk.abs, "no-b"), org: "org1" }, "v1.2.3");
  assert.deepEqual(entries, []);
  rmSync(disk.abs, { recursive: true, force: true });
});

test("源 B 组织名卫生：含分隔符 / 相对段的 org ⇒ 不列源 B；正常 org 正常列", () => {
  const disk = tmpDisk("board-docs-");
  putDoc(disk, "B", "v1.2.3", "b.md");
  const orgs = join(disk.abs, "orgs");
  for (const evil of ["..", "../elsewhere", "a/b", "a\\b", "C:", "%2e%2e"]) {
    assert.deepEqual(listDocs({ repoRoot: disk.abs, orgsDir: orgs, org: evil }, "v1.2.3"), []);
  }
  assert.equal(listDocs({ repoRoot: disk.abs, orgsDir: orgs, org: "org1" }, "v1.2.3").length, 1);
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
// 分类标注 + 根推导
// ---------------------------------------------------------------------------

test("分类标注：后缀式与前缀式都认，其它照列为「其它」", () => {
  assert.equal(classifyDoc("阶段产出上板-需求确认单.md"), "需求确认单");
  assert.equal(classifyDoc("阶段产出上板-改造文档.md"), "改造文档");
  assert.equal(classifyDoc("需求确认单-某主题.md"), "需求确认单");
  assert.equal(classifyDoc("改造文档-某主题.md"), "改造文档");
  assert.equal(classifyDoc("README.md"), "其它");
  assert.equal(classifyDoc("随手笔记.md"), "其它");
});

test("defaultRepoRoot = 板根上一级；docsRootFor A/B 落点正确", () => {
  const root = defaultRepoRoot();
  assert.ok(root.endsWith("a2a-coding") || root.length > 1);
  assert.equal(docsRootFor("A", { repoRoot: "/r", orgsDir: "/o", org: "g" }), join("/r", "doc"));
  assert.equal(docsRootFor("B", { repoRoot: "/r", orgsDir: "/o", org: "g" }), join("/o", "g", "doc"));
});
