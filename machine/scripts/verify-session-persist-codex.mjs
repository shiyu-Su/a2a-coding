/**
 * Verify that a2a-codex's SessionManager persists its contextId → threadId map
 * to disk and restores it on construction (simulated agent restart).
 *
 * Run: node scripts/verify-session-persist-codex.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../node_modules/a2a-codex/dist/codex/session-manager.js";

const tempDir = mkdtempSync(join(tmpdir(), "a2a-codex-session-persist-"));
let startCalls = 0;
let resumeCalls = 0;
// Simulates threads persisted on the Codex server across an agent restart.
const serverThreads = new Set();

/** Fresh stub Codex client per SessionManager, sharing the (server-side) thread store. */
function makeStubClient() {
    return {
        startThread() {
            const id = `thr_test_${++startCalls}`;
            serverThreads.add(id);
            return { id };
        },
        resumeThread(id) {
            resumeCalls++;
            if (!serverThreads.has(id))
                throw new Error(`thread not found: ${id}`);
            return { id };
        },
    };
}

const config = {
    codex: { workingDirectory: tempDir },
    session: { reuseByContext: true, ttl: 3_600_000 },
};

try {
    // 1. First manager creates a thread for ctx-A, then persists the mapping
    //    (the executor sets session.threadId on thread.started).
    const manager1 = new SessionManager(makeStubClient(), config);
    const session1 = manager1.getOrCreate("ctx-A", () => manager1.client.startThread());
    const threadId1 = session1.thread.id;
    session1.threadId = threadId1;
    manager1.persist();

    const persisted = JSON.parse(readFileSync(join(tempDir, ".a2a", "sessions.json"), "utf8"));
    assert.equal(persisted["ctx-A"].threadId, threadId1, "persisted map must contain ctx-A → threadId1");
    assert.equal(typeof persisted["ctx-A"].lastAccessedAt, "number", "persisted entry must carry lastAccessedAt");

    // 2. Second manager with the same directory (simulated restart) restores and
    //    reuses threadId1 via resumeThread — no new thread created.
    const manager2 = new SessionManager(makeStubClient(), config);
    assert.equal(manager2.sessions.get("ctx-A")?.threadId, threadId1, "restart must restore ctx-A mapping");
    const session2 = manager2.getOrCreate("ctx-A", () => manager2.client.startThread());
    assert.equal(session2.threadId, threadId1, `reuse survived restart: expected ${threadId1}, got ${session2.threadId}`);
    assert.equal(startCalls, 1, "reuse must not create a new thread");
    assert.equal(resumeCalls, 1, "restart must resume the persisted thread exactly once");

    // 3. A different context gets its own independent thread.
    const sessionB = manager2.getOrCreate("ctx-B", () => manager2.client.startThread());
    assert.notEqual(sessionB.thread.id, threadId1, "ctx-B must not reuse ctx-A's thread");
    assert.notEqual(sessionB.threadId, threadId1, "ctx-B threadId must differ from ctx-A");

    // 4. TTL-expired entries are skipped on load.
    const staleDir = mkdtempSync(join(tmpdir(), "a2a-codex-session-stale-"));
    try {
        mkdirSync(join(staleDir, ".a2a"), { recursive: true });
        serverThreads.add("thr_test_fresh");
        writeFileSync(
            join(staleDir, ".a2a", "sessions.json"),
            JSON.stringify({
                "ctx-stale": {
                    threadId: "thr_test_stale",
                    createdAt: Date.now() - config.session.ttl - 1000,
                    lastAccessedAt: Date.now() - config.session.ttl - 1000,
                },
                "ctx-fresh": {
                    threadId: "thr_test_fresh",
                    createdAt: Date.now(),
                    lastAccessedAt: Date.now(),
                },
            }),
            "utf8",
        );
        const manager3 = new SessionManager(makeStubClient(), {
            ...config,
            codex: { workingDirectory: staleDir },
        });
        assert.equal(manager3.sessions.has("ctx-stale"), false, "expired entry must be skipped on load");
        assert.equal(manager3.sessions.has("ctx-fresh"), true, "fresh entry must be loaded");
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
