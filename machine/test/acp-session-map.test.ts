/**
 * `machine/acp-bridge/session-map.ts` 定向单测（REQ-v0.8.0-2026-09-19-01 · 节点 B5）。
 *
 * 判据：映射读写 / 原子性（先 .tmp- 临时文件再 rename）/ 启动加载往返 / 损坏文件容错
 * （非法 JSON、顶层非对象、坏条目）；含真实临时目录往返（默认 node fs）。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionMap, createNodeSessionMapFs, type SessionMapFs } from "../acp-bridge/session-map.js";

/** 内存文件系统（记录操作序，供原子性断言）。 */
class InMemoryFs implements SessionMapFs {
  readonly files = new Map<string, string>();
  readonly ops: Array<{ op: "write" | "rename" | "mkdirp"; paths: string[] }> = [];

  readText(path: string): string | null {
    const value = this.files.get(path);
    return value === undefined ? null : value;
  }

  writeText(path: string, data: string): void {
    this.files.set(path, data);
    this.ops.push({ op: "write", paths: [path] });
  }

  rename(from: string, to: string): void {
    const value = this.files.get(from);
    if (value !== undefined) {
      this.files.set(to, value);
      this.files.delete(from);
    }
    this.ops.push({ op: "rename", paths: [from, to] });
  }

  mkdirp(dir: string): void {
    this.ops.push({ op: "mkdirp", paths: [dir] });
  }
}

const FIXED = (): Date => new Date("2026-01-01T00:00:00.000Z");

test("会话映射：set/get/delete 读写与 size", () => {
  const fs = new InMemoryFs();
  const map = new SessionMap({ projectId: "p1", baseDir: "/m", fs, now: FIXED });
  assert.equal(map.get("ctx1"), null);
  map.set("ctx1", "sess1");
  assert.equal(map.get("ctx1"), "sess1");
  assert.equal(map.size(), 1);
  map.delete("ctx1");
  assert.equal(map.get("ctx1"), null);
  assert.equal(map.size(), 0);
});

test("会话映射：原子落盘（先写 .tmp- 临时文件，再 rename 到目标）", () => {
  const fs = new InMemoryFs();
  const map = new SessionMap({ projectId: "p1", baseDir: "/m", fs, now: FIXED });
  map.set("ctx1", "sess1");

  const ops = fs.ops.filter((o) => o.op === "write" || o.op === "rename");
  assert.equal(ops.length, 2);
  assert.equal(ops[0]?.op, "write");
  assert.equal(ops[1]?.op, "rename");
  const writePath = ops[0]?.paths[0] ?? "";
  assert.ok(writePath.startsWith(`${map.path()}.tmp-`), `意外临时路径：${writePath}`);
  assert.equal(ops[1]?.paths[1], map.path());
  assert.ok(fs.files.has(map.path()), "最终文件应存在");
  assert.ok(!fs.files.has(writePath), "临时文件应已 rename 消失");
});

test("会话映射：持久化往返（重启后加载）", () => {
  const fs = new InMemoryFs();
  const first = new SessionMap({ projectId: "p1", baseDir: "/m", fs, now: FIXED });
  first.set("ctx1", "sess1");
  first.set("ctx2", "sess2");

  const second = new SessionMap({ projectId: "p1", baseDir: "/m", fs, now: FIXED });
  assert.equal(second.get("ctx1"), "sess1");
  assert.equal(second.get("ctx2"), "sess2");
  assert.equal(second.size(), 2);
});

test("会话映射：损坏文件容错（非法 JSON / 顶层非对象 / 坏条目 → 不抛）", () => {
  const fs = new InMemoryFs();
  const probe = new SessionMap({ projectId: "p1", baseDir: "/m", fs, now: FIXED });

  fs.files.set(probe.path(), "{not json");
  assert.equal(new SessionMap({ projectId: "p1", baseDir: "/m", fs, now: FIXED }).size(), 0);

  fs.files.set(probe.path(), "[1,2,3]");
  assert.equal(new SessionMap({ projectId: "p1", baseDir: "/m", fs, now: FIXED }).size(), 0);

  fs.files.set(
    probe.path(),
    JSON.stringify({ good: { sessionId: "s", updatedAt: "t" }, bad: { nope: 1 } }),
  );
  const partial = new SessionMap({ projectId: "p1", baseDir: "/m", fs, now: FIXED });
  assert.equal(partial.size(), 1);
  assert.equal(partial.get("good"), "s");
  assert.equal(partial.get("bad"), null);
});

test("会话映射：真实临时目录往返（默认 node fs）", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-acp-sess-"));
  try {
    const fs = createNodeSessionMapFs();
    const map = new SessionMap({ projectId: "proj-x", baseDir: dir, fs, now: FIXED });
    map.set("ctx", "sess");
    assert.ok(existsSync(map.path()));
    const raw = JSON.parse(readFileSync(map.path(), "utf8")) as Record<string, { sessionId: string }>;
    assert.equal(raw["ctx"]?.sessionId, "sess");

    const reloaded = new SessionMap({ projectId: "proj-x", baseDir: dir, fs, now: FIXED });
    assert.equal(reloaded.get("ctx"), "sess");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
