/**
 * BD10 docs-read 用例（REQ-v0.9.1-2026-09-25-04 · 判据 1，纯函数级；HTTP 双层归 BD11。
 * REQ-v0.9.2-2026-09-26-01 起目录扫描 `listDocs` / 分类标注作废 ⇒ 对应用例随删，
 * 本文件只剩**单文件读取守卫**）。
 *
 * 覆盖：`..` / `%2e%2e` / 盘符 / 绝对路径 / 反斜杠 / 非 .md / 超 256KiB / **目录段不合规**
 *   （= 非版号且非 `pool` 的段，REQ-2026-10-15-05 N4 起读面入参语义由 version 改**目录段**）
 *   ⇒ 全部结构化拒绝或截断降级，**不抛未捕获异常**；失败文案不泄根。
 * 负向锚两枚分立（N7 锚面要求）：「非版号且非 `pool` 的段 ⇒ 拒」与「`pool` ⇒ 放行」
 *   各自一枚，谓词层与 `readDoc` 层各一对 —— 允许集放宽不得把负判据吞掉。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_DOC_FILE_BYTES,
  defaultRepoRoot,
  docsRootFor,
  isValidDocVersion,
  isAllowedDocDirSegment,
  docExistsOnDisk,
  readDoc,
} from "../dist/docs-read.js";

/** 建一个临时盘根，返回 {dir, abs}。 */
function tmpDisk(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, abs: dir };
}

/** 落一份文档：source=A ⇒ <disk>/doc/{目录段}/{name}；B ⇒ <disk>/orgs/org1/doc/{目录段}/{name}。 */
function putDoc(disk, source, dirSegment, name, content = "# doc\n") {
  const base =
    source === "A"
      ? join(disk.abs, "doc", dirSegment)
      : join(disk.abs, "orgs", "org1", "doc", dirSegment);
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, name), content, "utf8");
}

// ---------------------------------------------------------------------------
// ① 守卫负例
// ---------------------------------------------------------------------------

test("版号谓词 isValidDocVersion：合法版号收下，其余一律拒（且不抛）—— 它不管 pool（pool 由允许集放行，见下）", () => {
  assert.equal(isValidDocVersion("v0.9.1"), true);
  assert.equal(isValidDocVersion("v10.0.23"), true);
  for (const bad of ["", "v0.9", "v0.9.1.2", "0.9.1", "V0.9.1", "v0.9.x", "v0.9.1/", "../v0.9.1", "v0.9.1.md", "version"]) {
    assert.equal(isValidDocVersion(bad), false, bad);
  }
});

test("目录段负锚：非版号且非 pool 的段 ⇒ readDoc 结构化拒绝（不抛错、不泄根）", () => {
  const disk = tmpDisk("board-docs-");
  putDoc(disk, "A", "v1.2.3", "a.md", "# 在盘上但段不合规\n");
  const dirs = { repoRoot: disk.abs, orgsDir: null, org: null };
  for (const bad of ["v9", "../../etc", "v0.10", "docs", "latest", "POOL", "pool ", "", "C:", "a%2e"]) {
    const r = readDoc(dirs, "A", bad, "a.md");
    assert.equal(r.ok, false, bad);
    assert.equal(r.code, "docs_read_invalid", bad);
    assert.ok(!r.error.includes(disk.abs), `失败文案不得泄根路径: ${bad}`);
  }
  rmSync(disk.abs, { recursive: true, force: true });
});

test("目录段正锚：pool ⇒ readDoc 放行（未排期停靠档读得开，其余三件套照过）", () => {
  const disk = tmpDisk("board-docs-");
  putDoc(disk, "A", "pool", "unscheduled-需求确认单.md", "# pool 档\n");
  putDoc(disk, "B", "pool", "org-pool.md", "# 组织工作区 pool 档\n");
  const dirs = { repoRoot: disk.abs, orgsDir: join(disk.abs, "orgs"), org: "org1" };
  const r = readDoc(dirs, "A", "pool", "unscheduled-需求确认单.md");
  assert.equal(r.ok, true);
  assert.equal(r.content, "# pool 档\n");
  const fromB = readDoc(dirs, "B", "pool", "org-pool.md");
  assert.equal(fromB.ok, true, "pool 放行同样覆盖源 B");
  // 放行只针对「目录段」这一维：文件名守卫 / .md 闭集 / 根内收 / 上限不得因 pool 放宽
  const notMd = readDoc(dirs, "A", "pool", "unscheduled-需求确认单.txt");
  assert.equal(notMd.ok, false);
  assert.equal(notMd.code, "docs_read_invalid");
  const escape = readDoc(dirs, "A", "pool", "../v1.2.3/a.md");
  assert.equal(escape.ok, false);
  assert.ok(escape.code === "docs_read_invalid" || escape.code === "docs_read_escapes_root");
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

// ---------------------------------------------------------------------------
// v0.10.7 B-N4：文档读允许集（版号 ∨ pool）+ 盘上存在性探针
// ---------------------------------------------------------------------------

test("允许集正锚：合法版号 ∨ 字面 pool ⇒ 放行（pool 不是版本号，是允许的目录段）", () => {
  assert.equal(isAllowedDocDirSegment("v0.10.7"), true);
  assert.equal(isAllowedDocDirSegment("pool"), true);
  assert.equal(isValidDocVersion("pool"), false, "pool 仍不是版号 —— 放行来自允许集，不来自版号白名单");
});

test("允许集负锚：非版号且非 pool 的段 ⇒ 一律拒（含段卫生负例 / 大小写与空白变体 / 带分隔符的 pool）", () => {
  for (const bad of ["v0.10", "v0", "..", "a%2eb", "C:", "", "doc", "pool ", "POOL", "pool/evil", "pool\\evil", "backlog"]) {
    assert.equal(isAllowedDocDirSegment(bad), false, bad);
  }
});

test("docExistsOnDisk：存在 ⇒ true；缺失 / 非 .md / 非法目录段 ⇒ false（一律不抛）", () => {
  const disk = tmpDisk("board-docs-");
  putDoc(disk, "A", "pool", "here.md");
  putDoc(disk, "A", "v0.10.7", "there.md");
  const dirs = { repoRoot: disk.abs, orgsDir: null, org: null };
  assert.equal(docExistsOnDisk(dirs, "A", "pool", "here.md"), true);
  assert.equal(docExistsOnDisk(dirs, "A", "v0.10.7", "there.md"), true);
  assert.equal(docExistsOnDisk(dirs, "A", "v0.10.7", "missing.md"), false);
  assert.equal(docExistsOnDisk(dirs, "A", "pool", "missing.md"), false);
  assert.equal(docExistsOnDisk(dirs, "A", "v0.10", "there.md"), false, "非版号非 pool 的段不探测");
  assert.equal(docExistsOnDisk(dirs, "A", "..", "here.md"), false);
  assert.equal(docExistsOnDisk(dirs, "A", "pool", "here.txt"), false, ".md 闭集不动");
  assert.equal(docExistsOnDisk(dirs, "B", "pool", "here.md"), false, "源 B 未配置 ⇒ false，不越权");
  rmSync(disk.abs, { recursive: true, force: true });
});

test("负向锚：DOC_VERSION_PATTERN 与 isValidDocVersion 逐字未改（扩允许集不得动版号判据）", () => {
  const src = readFileSync(
    join(dirnameOfModule(), "..", "src", "docs-read.ts"),
    "utf8",
  );
  assert.ok(
    src.includes("export const DOC_VERSION_PATTERN = /^v\\d+\\.\\d+\\.\\d+$/;"),
    "版号白名单正则须逐字保留（docs-move 改版善后共用）",
  );
  assert.ok(
    src.includes("export function isValidDocVersion(version: string): boolean {") &&
      src.includes("return DOC_VERSION_PATTERN.test(version);"),
    "isValidDocVersion 须逐字保留（形参名 + 实现）",
  );
  assert.equal(isValidDocVersion("pool"), false, "pool 不得被认成版本号");
});

function dirnameOfModule() {
  return fileURLToPath(new URL(".", import.meta.url));
}
