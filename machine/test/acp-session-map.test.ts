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
import {
  DEFAULT_SESSION_RETENTION_DAYS,
  DEFAULT_SESSION_RETENTION_MAX,
  SessionMap,
  createNodeSessionMapFs,
  type SessionMapFs,
} from "../acp-bridge/session-map.js";

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

// ---------- REQ-v0.8.9-2026-09-23-01 · M1：保留边界（TTL / LRU）+ 状态字段 + 合并式写入 ----------

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const DAY_MS = 86_400_000;

/** 可拨时钟（一条测试内推进时间，驱动 TTL / LRU）。 */
function clock(start = T0): { now: () => Date; advance: (ms: number) => void } {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

function writeLegacy(fs: InMemoryFs, path: string, data: unknown): void {
  fs.files.set(path, JSON.stringify(data));
}

test("M1 状态字段：set 初值 turn=0 / lastMessageIds=[] / 未注入；markPrompted 同刻写 prompted+injectedAt", () => {
  const map = new SessionMap({ projectId: "p1", baseDir: "/m", fs: new InMemoryFs(), now: FIXED });
  map.set("ctx", "s1");
  assert.equal(map.getEntry("ctx")?.turn, 0);
  assert.deepEqual(map.getEntry("ctx")?.lastMessageIds, []);
  assert.equal(map.getEntry("ctx")?.injectedAt, undefined);
  assert.equal(map.isPrompted("ctx"), false);

  map.markPrompted("ctx");
  assert.equal(map.isPrompted("ctx"), true);
  assert.equal(map.getEntry("ctx")?.injectedAt, "2026-01-01T00:00:00.000Z");
});

test("M1 bumpTurn：逐轮 +1 并落盘（无该键 ⇒ 0，不动映射）", () => {
  const fs = new InMemoryFs();
  const map = new SessionMap({ projectId: "p1", baseDir: "/m", fs, now: FIXED });
  assert.equal(map.bumpTurn("missing"), 0);
  map.set("ctx", "s1");
  assert.equal(map.bumpTurn("ctx"), 1);
  assert.equal(map.bumpTurn("ctx"), 2);
  const reloaded = new SessionMap({ projectId: "p1", baseDir: "/m", fs, now: FIXED });
  assert.equal(reloaded.getEntry("ctx")?.turn, 2, "turn 须跨重启保留");
});

test("M1 lastMessageIds：有界 ≤32（溢出丢最旧）· 与队尾重复不追加", () => {
  const map = new SessionMap({ projectId: "p1", baseDir: "/m", fs: new InMemoryFs(), now: FIXED });
  map.set("ctx", "s1");
  for (let i = 0; i < 40; i += 1) map.recordMessageId("ctx", `m${String(i)}`);
  const ids = map.getEntry("ctx")?.lastMessageIds ?? [];
  assert.equal(ids.length, 32);
  assert.equal(ids[0], "m8", "溢出应丢最旧");
  assert.equal(ids[31], "m39");

  map.recordMessageId("ctx", "m39");
  assert.equal((map.getEntry("ctx")?.lastMessageIds ?? []).length, 32, "队尾重复不得撑破上界");
});

test("M1 set 合并式写入：换 sessionId 不清 turn / lastMessageIds / prompted / injectedAt", () => {
  const fs = new InMemoryFs();
  const map = new SessionMap({ projectId: "p1", baseDir: "/m", fs, now: FIXED });
  map.set("ctx", "s1");
  map.bumpTurn("ctx");
  map.bumpTurn("ctx");
  map.recordMessageId("ctx", "m1");
  map.markPrompted("ctx");

  map.set("ctx", "s2"); // 同 ctx 再落一个新 sessionId（覆盖式写入会把下面四项清零）
  assert.equal(map.get("ctx"), "s2");
  assert.equal(map.getEntry("ctx")?.turn, 2);
  assert.deepEqual(map.getEntry("ctx")?.lastMessageIds, ["m1"]);
  assert.equal(map.isPrompted("ctx"), true);
  assert.equal(map.getEntry("ctx")?.injectedAt, "2026-01-01T00:00:00.000Z");

  const reloaded = new SessionMap({ projectId: "p1", baseDir: "/m", fs, now: FIXED });
  assert.equal(reloaded.getEntry("ctx")?.turn, 2, "合并结果须随落盘保留");
});

test("M1 旧格式文件兼容：缺 turn / lastMessageIds / injectedAt ⇒ 缺省；类型不符 ⇒ 回落缺省且不抛", () => {
  const fs = new InMemoryFs();
  const probe = new SessionMap({ projectId: "p1", baseDir: "/m", fs, now: FIXED });

  writeLegacy(fs, probe.path(), { ctx: { sessionId: "s", updatedAt: "2026-01-01T00:00:00.000Z", prompted: true } });
  const v1 = new SessionMap({ projectId: "p1", baseDir: "/m", fs, now: FIXED }).getEntry("ctx");
  assert.equal(v1?.turn, 0);
  assert.deepEqual(v1?.lastMessageIds, []);
  assert.equal(v1?.injectedAt, undefined);
  assert.equal(v1?.prompted, true);

  writeLegacy(fs, probe.path(), {
    ctx: {
      sessionId: "s",
      updatedAt: "2026-01-01T00:00:00.000Z",
      turn: "3",
      lastMessageIds: [1, "m2", null, "m3"],
      injectedAt: 42,
    },
  });
  const v2 = new SessionMap({ projectId: "p1", baseDir: "/m", fs, now: FIXED }).getEntry("ctx");
  assert.equal(v2?.turn, 0, "非数字 turn ⇒ 缺省");
  assert.deepEqual(v2?.lastMessageIds, ["m2", "m3"], "非字符串 id ⇒ 过滤");
  assert.equal(v2?.injectedAt, undefined);
});

test("M1 prune：启动 load 即淘汰超 7 天条目 + 一行日志（removed / kept / 阈值）", () => {
  const fs = new InMemoryFs();
  const probe = new SessionMap({ projectId: "p1", baseDir: "/m", fs, now: FIXED });
  writeLegacy(fs, probe.path(), {
    fresh: { sessionId: "f", updatedAt: "2026-01-01T00:00:00.000Z", turn: 0, lastMessageIds: [] },
    stale: { sessionId: "s", updatedAt: "2025-12-01T00:00:00.000Z", turn: 3, lastMessageIds: ["m"] },
  });

  const logs: string[] = [];
  const reloaded = new SessionMap({ projectId: "p1", baseDir: "/m", fs, now: FIXED, logger: (m) => logs.push(m) });
  assert.equal(reloaded.size(), 1);
  assert.equal(reloaded.get("stale"), null, "超 TTL ⇒ 启动即淘汰");
  assert.equal(reloaded.get("fresh"), "f");
  const line = logs.find((l) => l.includes("prune"));
  assert.ok(line !== undefined, `应有 prune 日志，实际：${logs.join(" | ")}`);
  assert.match(line ?? "", /removed=1/);
  assert.match(line ?? "", /kept=1/);
  assert.match(line ?? "", /ttl=7d/);
  assert.match(line ?? "", /max=500/);
});

test("M1 prune：写穿摊还 —— 时钟推进 8 天后任何一次写入顺带清掉过期项", () => {
  const { now, advance } = clock();
  const map = new SessionMap({ projectId: "p1", baseDir: "/m", fs: new InMemoryFs(), now });
  map.set("old", "s-old");
  advance(8 * DAY_MS);
  map.set("new", "s-new"); // 本次 persist 摊还 prune
  assert.equal(map.get("old"), null);
  assert.equal(map.get("new"), "s-new");
  assert.equal(map.size(), 1);
});

test("M1 prune：LRU —— 超过每项目 500 条时最旧先出", () => {
  const { now, advance } = clock();
  const map = new SessionMap({ projectId: "p1", baseDir: "/m", fs: new InMemoryFs(), now });
  for (let i = 0; i < 501; i += 1) {
    map.set(`ctx-${String(i)}`, `s${String(i)}`);
    advance(1000);
  }
  assert.equal(map.size(), 500);
  assert.equal(map.get("ctx-0"), null, "最旧一条应被淘汰");
  assert.equal(map.get("ctx-1"), "s1");
  assert.equal(map.get("ctx-500"), "s500");
});

test("M1 prune：LRU 按 updatedAt 计 —— bumpTurn 刷新的条目不因早期创建被淘汰", () => {
  const { now, advance } = clock();
  const map = new SessionMap({ projectId: "p1", baseDir: "/m", fs: new InMemoryFs(), now });
  map.set("hot", "s-hot"); // 最早创建
  for (let i = 0; i < 499; i += 1) {
    map.set(`ctx-${String(i)}`, `s${String(i)}`); // ctx-0 与 hot 同刻创建 ⇒ 竞争最旧席位
    advance(1000);
  }
  map.bumpTurn("hot"); // 刷新到最新时刻
  advance(1000);
  map.set("ctx-499-x", "s-x"); // 第 501 条 ⇒ 触发一次淘汰
  assert.equal(map.size(), 500);
  assert.equal(map.get("hot"), "s-hot", "LRU 看 updatedAt：被刷新的最早条目应留下");
  assert.equal(map.get("ctx-0"), null, "留下不下的应是最旧 updatedAt 的 ctx-0");
});

// ---------- REQ-v0.8.9-2026-09-23-01 · M5：保留边界可配（retentionDays / retentionMax）----------

test("M5 缺省常量 = 7 天 / 500 条（与 M1 硬编码时代逐字一致）", () => {
  assert.equal(DEFAULT_SESSION_RETENTION_DAYS, 7);
  assert.equal(DEFAULT_SESSION_RETENTION_MAX, 500);
});

test("M5 不配 ⇒ 缺省边界生效（8 天旧条目被 7d TTL 淘汰）", () => {
  const { now, advance } = clock();
  const map = new SessionMap({ projectId: "p1", baseDir: "/m", fs: new InMemoryFs(), now });
  map.set("old", "s-old");
  advance(8 * DAY_MS);
  map.set("new", "s-new"); // persist 摊还 prune（缺省 7d）
  assert.equal(map.get("old"), null);
  assert.equal(map.size(), 1);
});

test("M5 显式 retentionDays=1 ⇒ 2 天前的条目启动即淘汰，日志报 ttl=1d", () => {
  const fs = new InMemoryFs();
  const probe = new SessionMap({ projectId: "p1", baseDir: "/m", fs, now: FIXED });
  writeLegacy(fs, probe.path(), {
    d2: { sessionId: "a", updatedAt: "2025-12-30T00:00:00.000Z", turn: 0, lastMessageIds: [] },
    d0: { sessionId: "b", updatedAt: "2026-01-01T00:00:00.000Z", turn: 0, lastMessageIds: [] },
  });
  const logs: string[] = [];
  const reloaded = new SessionMap({
    projectId: "p1",
    baseDir: "/m",
    fs,
    now: FIXED,
    retentionDays: 1,
    logger: (m) => logs.push(m),
  });
  assert.equal(reloaded.get("d2"), null, "保留 1 天 ⇒ 2 天前的条目不配活过启动");
  assert.equal(reloaded.get("d0"), "b");
  assert.match(logs.find((l) => l.includes("prune")) ?? "", /ttl=1d/, "日志阈值应报生效值而非缺省 7d");
});

test("M5 显式 retentionMax=2 ⇒ LRU 只留最新 2 条", () => {
  const { now, advance } = clock();
  const map = new SessionMap({
    projectId: "p1",
    baseDir: "/m",
    fs: new InMemoryFs(),
    now,
    retentionMax: 2,
  });
  map.set("c0", "s0");
  advance(1000);
  map.set("c1", "s1");
  advance(1000);
  map.set("c2", "s2");
  assert.equal(map.size(), 2);
  assert.equal(map.get("c0"), null, "最旧先出");
  assert.equal(map.get("c1"), "s1");
  assert.equal(map.get("c2"), "s2");
});

test("M5 非法边界值（0 / 负数 / 小数 / NaN）⇒ 回落缺省，不抛", () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    const { now, advance } = clock();
    const map = new SessionMap({
      projectId: "p1",
      baseDir: "/m",
      fs: new InMemoryFs(),
      now,
      retentionDays: bad,
      retentionMax: bad,
    });
    map.set("old", "s-old");
    advance(8 * DAY_MS);
    map.set("new", "s-new");
    assert.equal(map.get("old"), null, `非法值 ${String(bad)} 应回落缺省 7d 而非放大/禁用边界`);
    assert.equal(map.size(), 1);
  }
});
