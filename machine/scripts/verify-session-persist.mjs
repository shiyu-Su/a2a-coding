/**
 * Verify that a2a-opencode's SessionManager persists its contextId → sessionId map
 * to disk and restores it on construction (simulated restart).
 *
 * Run: node scripts/verify-session-persist.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../node_modules/a2a-opencode/dist/opencode/session-manager.js";

const tempDir = mkdtempSync(join(tmpdir(), "a2a-session-persist-"));
let createCalls = 0;
// Simulates sessions persisted on the opencode server across an agent restart.
const serverSessions = new Set();

/** Fresh stub client per SessionManager, sharing the (server-side) session store. */
function makeStubClient() {
  return {
    async sessionCreate() {
      const id = `ses_test_${++createCalls}`;
      serverSessions.add(id);
      return { id };
    },
    async sessionGet(sessionId) {
      if (!serverSessions.has(sessionId)) throw new Error(`session not found: ${sessionId}`);
      return { id: sessionId };
    },
  };
}

const sessionCfg = {
  reuseByContext: true,
  ttl: 3_600_000,
  cleanupInterval: 3_600_000,
  titlePrefix: "A2A Session",
};
const features = { autoApprovePermissions: false };

try {
  // 1. First manager creates a session for ctx-A and persists the map.
  const manager1 = new SessionManager(makeStubClient(), sessionCfg, features, tempDir);
  const id1 = await manager1.getOrCreate("ctx-A");
  assert.match(id1, /^ses_test_/, "id1 must be a stub-created session id");

  const persisted = JSON.parse(readFileSync(join(tempDir, ".a2a", "sessions.json"), "utf8"));
  assert.equal(persisted["ctx-A"].sessionId, id1, "persisted map must contain ctx-A → id1");
  assert.equal(typeof persisted["ctx-A"].lastUsed, "number", "persisted entry must carry lastUsed");

  // 2. Second manager with the same directory (simulated restart) reuses id1.
  const manager2 = new SessionManager(makeStubClient(), sessionCfg, features, tempDir);
  const id2 = await manager2.getOrCreate("ctx-A");
  assert.equal(id2, id1, `reuse survived restart: expected ${id1}, got ${id2}`);
  assert.equal(createCalls, 1, "reuse must not create a new session");

  // 3. A different context gets a different session id.
  const idB = await manager2.getOrCreate("ctx-B");
  assert.notEqual(idB, id1, "ctx-B must not reuse ctx-A's session");

  // 4. TTL-expired entries are skipped on load.
  const staleDir = mkdtempSync(join(tmpdir(), "a2a-session-stale-"));
  try {
    mkdirSync(join(staleDir, ".a2a"), { recursive: true });
    writeFileSync(
      join(staleDir, ".a2a", "sessions.json"),
      JSON.stringify({
        "ctx-stale": { sessionId: "ses_test_stale", lastUsed: Date.now() - sessionCfg.ttl - 1000 },
        "ctx-fresh": { sessionId: "ses_test_fresh", lastUsed: Date.now() },
      }),
      "utf8",
    );
    const manager3 = new SessionManager(makeStubClient(), sessionCfg, features, staleDir);
    assert.equal(
      manager3.contextMap.has("ctx-stale"),
      false,
      "expired entry must be skipped on load",
    );
    assert.equal(manager3.contextMap.has("ctx-fresh"), true, "fresh entry must be loaded");
  } finally {
    rmSync(staleDir, { recursive: true, force: true });
  }

  console.log("PASS");
} catch (err) {
  console.error("FAIL:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
