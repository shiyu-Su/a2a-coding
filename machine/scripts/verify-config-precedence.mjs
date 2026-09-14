/**
 * Verify config precedence for the claude adapter at runtime:
 * DEFAULT_AGENT_CONFIG < adapter.baseConfig() < project.agentConfig < riskConfig.
 *
 * Run after `npm run build`: node scripts/verify-config-precedence.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "../dist/adapters/claude.js";
import { writeAgentConfig } from "../dist/launcher/agent-config.js";

const adapter = new ClaudeAdapter();
const tempDir = mkdtempSync(join(tmpdir(), "a2a-config-precedence-"));
const project = { projectId: "precedence", workspace: tempDir, agentKind: "claude", a2aPort: 0 };

try {
  // 1. Default: baseConfig injects settingSources ["user"] on top of events off.
  let path = writeAgentConfig(project, tempDir, adapter.baseConfig());
  let config = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(
    config.claude.settingSources,
    ["user"],
    "default must enable the user settings source",
  );
  assert.equal(config.events.enabled, false, "events stay off by default");

  // 2. Project agentConfig overrides baseConfig per-field: ["user"] -> [] (isolation).
  path = writeAgentConfig(
    { ...project, agentConfig: { claude: { settingSources: [] } } },
    tempDir,
    adapter.baseConfig(),
  );
  config = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(
    config.claude.settingSources,
    [],
    "project agentConfig must override settingSources",
  );
  assert.equal(config.events.enabled, false, "unrelated keys survive the per-field override");

  // 3. Risk patch is merged last: the full tier forces dangerouslyAllowBypassPermissions
  //    even when agentConfig tries to flip it off.
  path = writeAgentConfig(
    { ...project, agentConfig: { claude: { dangerouslyAllowBypassPermissions: false } } },
    tempDir,
    adapter.baseConfig(),
    adapter.permission("full").config,
  );
  config = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(
    config.claude.dangerouslyAllowBypassPermissions,
    true,
    "risk config must win over agentConfig",
  );

  console.log("verify-config-precedence: all assertions passed");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
