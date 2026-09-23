/**
 * `machine/acp-bridge/` 会话保留边界参数面单测（REQ-v0.8.9-2026-09-23-01 · 节点 M5）。
 *
 * 判据：
 * - `parseSessionRetentionArg`：合法正整数原样；空串 / 非数字 / 小数 / ≤ 0 ⇒ 抛错
 *   （宽松校验，纪律同 `--session-timeout`；上限护栏归 launcher 加载期）。
 * - `parseBridgeArgs`：`--session-retention-days` / `--session-retention-max` ⇒ 对应 args 键；
 *   未给 ⇒ 键缺席（⇒ SessionMap 落自身缺省 7d / 500）。
 * - `startBridge` 接线实证：临时 workspace 预置含 8 天前条目的映射文件，
 *   带 `sessionRetentionDays: 1` 拉起桥 ⇒ 启动 load 即按 **1d**（而非缺省 7d）收敛（prune 日志 removed/kept）。
 * - 两键与 `sessionTimeoutMs` 相互独立：只给 retention 不影响超时缺省（负向锚）。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  parseBridgeArgs,
  parseSessionRetentionArg,
  startBridge,
  type BridgeArgs,
} from "../acp-bridge/index.js";
import type { AcpChildProcess, AcpSpawn } from "../acp-bridge/acp/types.js";

/** 最小 fake 后端：只应答 `initialize`（本文件不跑 prompt，只看桥启动期 load/prune）。 */
class InitOnlyChild implements AcpChildProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  constructor() {
    let buffer = "";
    this.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as { id?: unknown; method?: string };
        if (message.id !== undefined && message.method === "initialize") {
          this.stdout.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } })}\n`,
          );
        }
      }
    });
  }

  kill(): boolean {
    return true;
  }

  onExit(_listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    return undefined;
  }

  onError(_listener: (error: Error) => void): void {
    return undefined;
  }
}

// ---------- ① parseSessionRetentionArg ----------

test("parseSessionRetentionArg：缺省 undefined；正整数原样（两 flag 文案各自指名）", () => {
  assert.equal(parseSessionRetentionArg(undefined, "--session-retention-days"), undefined);
  assert.equal(parseSessionRetentionArg("14", "--session-retention-days"), 14);
  assert.equal(parseSessionRetentionArg("500", "--session-retention-max"), 500);
});

test("parseSessionRetentionArg：空串 / 非数字 / 小数 / 0 / 负数 ⇒ 抛错（错误文案含 flag 名）", () => {
  for (const raw of ["", "abc", "1.5", "0", "-1"]) {
    assert.throws(
      () => parseSessionRetentionArg(raw, "--session-retention-days"),
      /--session-retention-days/,
      `days raw=${raw}`,
    );
    assert.throws(
      () => parseSessionRetentionArg(raw, "--session-retention-max"),
      /--session-retention-max/,
      `max raw=${raw}`,
    );
  }
});

// ---------- ② parseBridgeArgs 透传 ----------

const COMMON = [
  "--port",
  "4100",
  "--workspace",
  "/ws",
  "--project-id",
  "p1",
  "--backend-cmd",
  "b",
];

test("parseBridgeArgs：两 flag ⇒ args 对应键；未给 ⇒ 键缺席；非法 ⇒ 抛错", () => {
  const withBoth = parseBridgeArgs([
    ...COMMON,
    "--session-retention-days",
    "3",
    "--session-retention-max",
    "100",
  ]);
  assert.equal(withBoth.sessionRetentionDays, 3);
  assert.equal(withBoth.sessionRetentionMax, 100);
  const without = parseBridgeArgs(COMMON);
  assert.equal(without.sessionRetentionDays, undefined);
  assert.equal("sessionRetentionDays" in without, false);
  assert.equal("sessionRetentionMax" in without, false);
  assert.throws(
    () => parseBridgeArgs([...COMMON, "--session-retention-days", "0"]),
    /--session-retention-days/,
  );
  assert.throws(
    () => parseBridgeArgs([...COMMON, "--session-retention-max", "x"]),
    /--session-retention-max/,
  );
});

// ---------- ③ startBridge 接线实证（桥启动期 load → prune 用生效边界） ----------

/** 预置 `<workspace>/.a2a/acp-sessions/p1.json`：键 = contextId，值内 ageDays = 距**当前真实时刻**的天数。 */
function seededWorkspace(seed: Record<string, string>): string {
  const t0Ms = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "a2a-acp-retention-"));
  const sessionsDir = join(dir, ".a2a", "acp-sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const entries: Record<string, unknown> = {};
  for (const [contextId, ageDaysText] of Object.entries(seed)) {
    entries[contextId] = {
      sessionId: `s-${contextId}`,
      updatedAt: new Date(t0Ms - Number(ageDaysText) * 86_400_000).toISOString(),
      turn: 0,
      lastMessageIds: [],
    };
  }
  writeFileSync(join(sessionsDir, "p1.json"), JSON.stringify(entries), "utf8");
  return dir;
}

async function startWith(workspace: string, extra: Partial<BridgeArgs> = {}): Promise<string[]> {
  const args: BridgeArgs = {
    port: 0,
    workspace,
    projectId: "p1",
    backendCmd: "fake-backend",
    risk: "write",
    ...extra,
  };
  const logs: string[] = [];
  const spawn: AcpSpawn = () => new InitOnlyChild();
  const running = await startBridge(args, {
    spawn,
    logger: (m: string): void => {
      logs.push(m);
    },
  });
  await running.client.close();
  return logs;
}

test("startBridge：sessionRetentionDays=1 ⇒ 8 天前的条目启动即被淘汰（日志 ttl=1d removed=1 kept=1）", async () => {
  const dir = seededWorkspace({ stale: "8", fresh: "0" });
  const logs = await startWith(dir, { sessionRetentionDays: 1 });
  const line = logs.find((l) => l.includes("prune"));
  assert.ok(line !== undefined, `应有 prune 日志，实际：${logs.join(" | ")}`);
  assert.match(line ?? "", /ttl=1d/, "生效边界应是显式配置的 1d（缺省 7d 会留下 8 天前条目）");
  assert.match(line ?? "", /removed=1 kept=1/, "内存映射按 1d 收敛（落盘随首次写穿）");
});

test("startBridge：不配两键 ⇒ 缺省 7d 生效（8 天前条目同样被淘汰，但日志报 ttl=7d）", async () => {
  const dir = seededWorkspace({ stale: "8", fresh: "0" });
  const logs = await startWith(dir);
  const line = logs.find((l) => l.includes("prune"));
  assert.ok(line !== undefined);
  assert.match(line ?? "", /ttl=7d max=500/, "未配 ⇒ 缺省边界");
  assert.match(line ?? "", /removed=1 kept=1/);
});

test("startBridge：sessionRetentionDays=30 ⇒ 8 天前的条目存活（负向锚：边界确实被喂进 prune）", async () => {
  const dir = seededWorkspace({ stale: "8", fresh: "0" });
  const logs = await startWith(dir, { sessionRetentionDays: 30 });
  assert.equal(
    logs.find((l) => l.includes("prune")),
    undefined,
    "放宽到 30d ⇒ 启动期不应发生任何淘汰（缺省 7d 会淘汰 8 天前条目）",
  );
});
