/**
 * Verify that a2a-claude's SessionManager persists its contextId → sessionId map
 * to disk and restores it on construction (simulated agent restart).
 *
 * Run: node scripts/verify-session-persist-claude.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../node_modules/a2a-claude/dist/claude/session-manager.js";

const tempDir = mkdtempSync(join(tmpdir(), "a2a-claude-session-persist-"));
const config = { claude: { workingDirectory: tempDir }, session: { reuseByContext: true, ttl: 0 } };

try {
    // 1. A first manager records a Claude session id and persists the map.
    const manager1 = new SessionManager(config);
    const session1 = manager1.getOrCreate("ctx-A");
    session1.sessionId = "ses_claude_1";
    manager1.persist();

    const persisted = JSON.parse(readFileSync(join(tempDir, ".a2a", "sessions.json"), "utf8"));
    assert.equal(persisted["ctx-A"].sessionId, "ses_claude_1", "persisted map must contain ctx-A → ses_claude_1");
    assert.equal(typeof persisted["ctx-A"].createdAt, "number", "persisted entry must carry createdAt");

    // 2. A second manager on the same directory (simulated restart) reuses id1.
    const manager2 = new SessionManager(config);
    const reused = manager2.getOrCreate("ctx-A");
    assert.equal(reused.sessionId, "ses_claude_1", `reuse survived restart: expected ses_claude_1, got ${reused.sessionId}`);

    // 3. A different context is independent.
    const sessionB = manager2.getOrCreate("ctx-B");
    sessionB.sessionId = "ses_claude_B";
    manager2.persist();

    const manager3 = new SessionManager(config);
    assert.equal(manager3.getOrCreate("ctx-A").sessionId, "ses_claude_1", "ctx-A must keep its own session id");
    assert.equal(manager3.getOrCreate("ctx-B").sessionId, "ses_claude_B", "ctx-B must keep its own session id");

    // 4. TTL-expired entries are skipped on load; fresh ones are kept.
    const staleDir = mkdtempSync(join(tmpdir(), "a2a-claude-session-stale-"));
    try {
        mkdirSync(join(staleDir, ".a2a"), { recursive: true });
        const ttl = 3_600_000;
        writeFileSync(
            join(staleDir, ".a2a", "sessions.json"),
            JSON.stringify({
                "ctx-stale": {
                    sessionId: "ses_claude_stale",
                    createdAt: Date.now() - ttl - 1000,
                    lastAccessedAt: Date.now() - ttl - 1000,
                },
                "ctx-fresh": {
                    sessionId: "ses_claude_fresh",
                    createdAt: Date.now(),
                    lastAccessedAt: Date.now(),
                },
            }),
            "utf8",
        );
        const manager4 = new SessionManager({ claude: { workingDirectory: staleDir }, session: { reuseByContext: true, ttl } });
        assert.equal(manager4.sessions.has("ctx-stale"), false, "expired entry must be skipped on load");
        assert.equal(manager4.sessions.has("ctx-fresh"), true, "fresh entry must be loaded");
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
