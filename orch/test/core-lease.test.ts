/**
 * `orch/runtime/core-lease.ts` 单元测试（REQ-v0.4.1-2026-09-15-02，`node:test`，无新依赖）。
 *
 * 覆盖：
 * - 首次抢锁 → `owner`，锁内容 `{ pid, mode, startedAt }` 正确；
 * - 活锁存在（本进程 pid）→ 第二个 core 得 `follower`；
 * - **owner 退出（陈旧锁）→ 新进程可接管**（真实用已退出子进程的 pid 造锁）；
 * - 损坏 / 空锁文件 → 判为陈旧，清掉后接管；
 * - `releaseCoreLease` 删锁、幂等、且**不删他进程的活锁**；
 * - `dataDir` 不存在时自动创建。
 *
 * 隔离：每个用例用独立临时目录（`os.tmpdir()` 下），互不影响。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  acquireCoreLease,
  coreLockPath,
  isProcessAlive,
  LEASE_PROBE_TIMEOUT_MS,
  probeHttpHealth,
  readCoreLease,
  reclaimWedgeCoreLease,
  releaseCoreLease,
  type HolderServiceVerdict,
} from "../runtime/core-lease.js";

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `a2a-core-lease-${name}-`));
}

/**
 * 造一把「owner 已退出」的锁：让子进程以**自己的 pid** 写锁后立即退出，
 * 返回其 pid（此刻已 ESRCH）。这是「owner 退出后新进程接管」的真实前态。
 */
function writeLockFromExitedProcess(lockPath: string): number {
  const script = [
    "const fs=require('node:fs');",
    "const path=require('node:path');",
    "const p=process.argv[1];",
    "fs.mkdirSync(path.dirname(p),{recursive:true});",
    "fs.writeFileSync(p, JSON.stringify({pid:process.pid,mode:'http',startedAt:new Date().toISOString()}));",
  ].join("");
  const result = spawnSync(process.execPath, ["-e", script, lockPath], { stdio: "ignore" });
  if (result.pid === undefined || result.pid <= 0) {
    throw new Error(`无法造陈旧锁：spawn 失败（status=${String(result.status)}）`);
  }
  return result.pid;
}

test("首次抢锁 → owner，锁内容含 pid / mode / startedAt", () => {
  const dir = tempDir("first");
  try {
    const result = acquireCoreLease(dir, "http");
    assert.equal(result.role, "owner");
    const lockPath = coreLockPath(dir);
    assert.ok(existsSync(lockPath), "core.lock 应存在");
    const info = readCoreLease(dir);
    assert.notEqual(info, null);
    assert.equal(info?.pid, process.pid);
    assert.equal(info?.mode, "http");
    assert.equal(typeof info?.startedAt, "string");
    assert.ok((info?.startedAt ?? "").length > 0);
    assert.equal(releaseCoreLease(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("活锁存在 → 第二个 core 得 follower（不覆盖锁）", () => {
  const dir = tempDir("follower");
  try {
    const first = acquireCoreLease(dir, "http");
    assert.equal(first.role, "owner");
    const second = acquireCoreLease(dir, "http");
    assert.equal(second.role, "follower");
    assert.equal(second.role === "follower" ? second.holder?.pid : null, process.pid);
    // 锁仍属第一持有者
    assert.equal(readCoreLease(dir)?.pid, process.pid);
    assert.equal(releaseCoreLease(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("owner 退出（陈旧锁）→ 新进程可接管（role=owner 且锁被重写）", () => {
  const dir = tempDir("stale");
  try {
    const lockPath = coreLockPath(dir);
    const deadPid = writeLockFromExitedProcess(lockPath);
    const stale = readCoreLease(dir);
    assert.equal(stale?.pid, deadPid);
    assert.equal(isProcessAlive(deadPid), false, "已退出的子进程 pid 应判为死");

    const result = acquireCoreLease(dir, "http");
    assert.equal(result.role, "owner", "陈旧锁应被清理并接管");
    assert.equal(readCoreLease(dir)?.pid, process.pid);
    assert.equal(readCoreLease(dir)?.mode, "http");
    assert.equal(releaseCoreLease(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("损坏 / 空锁文件 → 判为陈旧并接管", () => {
  const dir = tempDir("corrupt");
  try {
    const lockPath = coreLockPath(dir);
    writeFileSync(lockPath, "not-json", "utf8");
    assert.equal(readCoreLease(dir), null);
    assert.equal(acquireCoreLease(dir, "http").role, "owner");

    writeFileSync(lockPath, "", "utf8");
    releaseCoreLease(dir);
    assert.equal(acquireCoreLease(dir, "http").role, "owner");
    assert.equal(releaseCoreLease(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("releaseCoreLease：幂等，且不删他进程的活锁", () => {
  const dir = tempDir("release");
  try {
    // 未持锁 → false（幂等）
    assert.equal(releaseCoreLease(dir), false);

    // 他进程的锁（用本进程的父 pid 之外的任意 pid 表示）→ 拒绝删除
    const lockPath = coreLockPath(dir);
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid + 1, mode: "http", startedAt: "2026-01-01T00:00:00Z" }),
      "utf8",
    );
    assert.equal(releaseCoreLease(dir), false, "他进程的锁不得被删");
    assert.ok(existsSync(lockPath), "他进程的锁应保留");
    rmSync(lockPath, { force: true }); // 清掉测试夹具，验证"自己的锁"路径

    // 自己的锁 → 删除且幂等
    const result = acquireCoreLease(dir, "http");
    assert.equal(result.role, "owner");
    assert.equal(releaseCoreLease(dir), true);
    assert.equal(releaseCoreLease(dir), false);
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dataDir 不存在时自动创建后再建锁", () => {
  const base = tempDir("mkdir");
  const dir = join(base, "nested", "data");
  try {
    assert.equal(existsSync(dirname(coreLockPath(dir))), false);
    const result = acquireCoreLease(dir, "http");
    assert.equal(result.role, "owner");
    assert.ok(existsSync(dir), "dataDir 应被创建");
    assert.equal(releaseCoreLease(dir), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// v0.7.2 REQ-01 ③（K3）：僵死租约回收 —— 「pid 存活但不在服务」探针四态
//   ① 死 pid 交既有路径；② 确认不在服务 ⇒ 删锁接管；③ unknown（含抛错/超时）⇒ 保守不接管；
//   ④ 判定期间锁易主 ⇒ 不删不接管。
// ---------------------------------------------------------------------------

test("K3 ②：pid 活 + 探针确认不在服务 ⇒ 删锁并接管（免人工删 core.lock）", async () => {
  const dir = tempDir("k3-not-serving");
  try {
    assert.equal(acquireCoreLease(dir, "http").role, "owner");
    assert.equal(readCoreLease(dir)?.pid, process.pid);

    const reclaimed = await reclaimWedgeCoreLease(dir, () => "not-serving");
    assert.equal(reclaimed, true, "确认不在服务 ⇒ 应回收僵死锁");
    assert.equal(existsSync(coreLockPath(dir)), false, "锁文件应被删除");
    assert.equal(acquireCoreLease(dir, "http").role, "owner", "回收后本进程可竞争到 owner");
    assert.equal(releaseCoreLease(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K3 ③：探针确认在服务（serving）⇒ 不动活锁", async () => {
  const dir = tempDir("k3-serving");
  try {
    assert.equal(acquireCoreLease(dir, "http").role, "owner");
    assert.equal(await reclaimWedgeCoreLease(dir, () => "serving"), false, "活锁不得被删");
    assert.equal(readCoreLease(dir)?.pid, process.pid);
    assert.equal(releaseCoreLease(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K3 ③（保守分支）：探针 unknown ⇒ 维持现状、不接管", async () => {
  const dir = tempDir("k3-unknown");
  try {
    assert.equal(acquireCoreLease(dir, "http").role, "owner");
    assert.equal(await reclaimWedgeCoreLease(dir, () => "unknown"), false, "判定不明 ⇒ 保守不接管");
    assert.equal(readCoreLease(dir)?.pid, process.pid);
    assert.equal(releaseCoreLease(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K3 ③（保守分支）：探针抛错 ⇒ 保守视为活、不接管", async () => {
  const dir = tempDir("k3-throw");
  try {
    assert.equal(acquireCoreLease(dir, "http").role, "owner");
    const reclaimed = await reclaimWedgeCoreLease(dir, () => {
      throw new Error("probe down");
    });
    assert.equal(reclaimed, false, "探针异常 ⇒ 不得误删活锁");
    assert.equal(readCoreLease(dir)?.pid, process.pid);
    assert.equal(releaseCoreLease(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K3 ③（保守分支）：探针 hang ⇒ 独立短超时兜底 ⇒ 不接管（且不挂住本用例）", async () => {
  const dir = tempDir("k3-hang");
  try {
    assert.equal(acquireCoreLease(dir, "http").role, "owner");
    const hanging: HolderServiceVerdict | Promise<HolderServiceVerdict> = new Promise<
      HolderServiceVerdict
    >(() => {
      /* 永不 settle：模拟探针自身挂住 */
    });
    const reclaimed = await reclaimWedgeCoreLease(dir, () => hanging, { probeTimeoutMs: 50 });
    assert.equal(reclaimed, false, "探针超时 ⇒ 保守不接管");
    assert.equal(readCoreLease(dir)?.pid, process.pid, "活锁应保留");
    assert.equal(releaseCoreLease(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K3 ④（保守分支）：判定期间锁易主（pid 变化）⇒ 不删不接管", async () => {
  const dir = tempDir("k3-race");
  try {
    assert.equal(acquireCoreLease(dir, "http").role, "owner");
    const lockPath = coreLockPath(dir);
    const otherPid = process.pid + 1;

    const reclaimed = await reclaimWedgeCoreLease(dir, () => {
      // 模拟竞态：判定期间锁被另一进程重写为新 pid
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: otherPid, mode: "http", startedAt: new Date().toISOString() }),
        "utf8",
      );
      return "not-serving";
    });
    assert.equal(reclaimed, false, "锁已易主 ⇒ 不得删除新持锁者的锁");
    assert.equal(readCoreLease(dir)?.pid, otherPid, "新持锁者的锁应保留");
    rmSync(lockPath, { force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K3 ①：holder pid 已死 ⇒ 不处理（交 acquireCoreLease 既有陈旧清理）", async () => {
  const dir = tempDir("k3-dead");
  try {
    const deadPid = writeLockFromExitedProcess(coreLockPath(dir));
    assert.equal(isProcessAlive(deadPid), false, "已退出子进程 pid 应判死");
    assert.equal(
      await reclaimWedgeCoreLease(dir, () => "not-serving"),
      false,
      "死 pid 不由本函数处理",
    );
    assert.equal(readCoreLease(dir)?.pid, deadPid, "锁仍在（随后由 acquire 清理）");

    assert.equal(acquireCoreLease(dir, "http").role, "owner");
    assert.equal(releaseCoreLease(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K3 ①：无锁 / 损坏锁 ⇒ 不处理", async () => {
  const dir = tempDir("k3-none");
  try {
    assert.equal(await reclaimWedgeCoreLease(dir, () => "not-serving"), false, "无锁 ⇒ false");
    writeFileSync(coreLockPath(dir), "not-json", "utf8");
    assert.equal(
      await reclaimWedgeCoreLease(dir, () => "not-serving"),
      false,
      "锁不可解析 ⇒ false",
    );
    rmSync(coreLockPath(dir), { force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// K3 探针实现：HTTP GET /health + 独立短超时（严格自清理，不留句柄）
// ---------------------------------------------------------------------------

/** 起一个固定应答的临时 HTTP server（端口由系统分配） */
function startHealthServer(
  body: string,
  status = 200,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createHttpServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({ server, port });
    });
  });
}

/** 关闭临时 server 并强制断开残余连接（保证用例不留句柄、`node --test` 自然退出） */
async function closeHealthServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("K3 探针：/health 可答（桥形状）⇒ serving", async () => {
  const { server, port } = await startHealthServer(
    JSON.stringify({ status: "ok", role: "owner", version: "test" }),
  );
  try {
    assert.equal(
      await probeHttpHealth({ host: "127.0.0.1", port }, LEASE_PROBE_TIMEOUT_MS),
      "serving",
    );
  } finally {
    await closeHealthServer(server);
  }
});

test("K3 探针：非桥响应（不可解析）⇒ unknown（保守）", async () => {
  const { server, port } = await startHealthServer("hello");
  try {
    assert.equal(await probeHttpHealth({ host: "127.0.0.1", port }, 1_000), "unknown");
  } finally {
    await closeHealthServer(server);
  }
});

test("K3 探针：端点无人监听（ECONNREFUSED）⇒ not-serving", async () => {
  const { server, port } = await startHealthServer("{}");
  await closeHealthServer(server); // 确证该端口已无监听
  assert.equal(await probeHttpHealth({ host: "127.0.0.1", port }, 1_000), "not-serving");
});

test("K3 探针：accept 但不应答（模拟 wedge listener）⇒ 独立短超时 ⇒ unknown（且不挂住）", async () => {
  const server = createHttpServer(() => {
    /* 故意不 end：模拟已 wedge 的 listener */
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    assert.equal(await probeHttpHealth({ host: "127.0.0.1", port }, 100), "unknown");
  } finally {
    await closeHealthServer(server);
  }
});
