/**
 * `machine/acp-bridge/` MCP payload 判别键校验单测（REQ-v0.9.0-2026-09-24-01 · 节点 M2c）。
 *
 * 来源 = M2b 真机探针的派生事实：四 kind 经 ACP 通路全部调通，但 `session/new` 的 `mcpServers`
 * 实参必须是 ACP **tagged-union** —— 缺 `type` 判别键的元素会被后端拒 `-32602 Invalid params`
 * （`type: expected "http" / "sse" / "acp"`）。M2a 的 `parseMcpServersArg` 不校验 `type` ⇒ 该
 * payload 能过启动期 fail-fast、直到运行期才炸。本节点把它前移：
 * - ① **合法 `type` 通过**（`http` / `sse` / `acp` 三值 + 各自必填键）；
 * - ② **缺 `type` ⇒ 抛**（**核心用例** —— M2b 实测它以前能过启动期）；
 * - ③ **非法 `type` 值 ⇒ 抛**；
 * - ④ **最小一致性检查**：`http`/`sse` ⇒ 需非空 `url`；`acp` ⇒ 需非空 `command`；
 * - ⑤ **启动期即拒**（经 `parseBridgeArgs` 的 flag 面，非仅 parse 函数）。
 *
 * 行为变更边界：唯一变化 = 非法 payload 从「运行期炸」变「启动期拒」；合法路径行为零变化
 * （透传锚见 `acp-bridge-m2a-mcp-flag.test.ts`）。
 *
 * 运行：`npm test`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBridgeArgs, parseMcpServersArg } from "../acp-bridge/index.js";

/** M2b 实测的**合法**形态（qoder-cn `session/new` 接受）。 */
const LEGAL_HTTP = '{"type":"http","name":"a2a","url":"http://127.0.0.1:8787/a2a-coding/mcp","headers":[]}';
/** M2b 实测的**非法**形态（缺 `type` ⇒ 后端 `-32602`）。 */
const ILLEGAL_NO_TYPE = '{"name":"a2a","url":"http://127.0.0.1:8787/a2a-coding/mcp","headers":[]}';

const COMMON = ["--port", "4100", "--workspace", "/ws", "--project-id", "p1", "--backend-cmd", "b"];

test("M2c ①：三种合法 type（http / sse / acp）各带其必填键 ⇒ 通过且原样透传", () => {
  const servers = [
    { name: "h", type: "http", url: "http://x/mcp", headers: [{ name: "k", value: "v" }] },
    { name: "s", type: "sse", url: "http://x/sse" },
    { name: "a", type: "acp", command: "/usr/bin/foo", args: ["--stdio-only"], env: [] },
  ];
  assert.deepEqual(parseMcpServersArg(JSON.stringify(servers)), servers, "校验只挡形态，不改写 / 不补全 / 不删键");
});

test("M2c ②（核心）：缺 type 判别键 ⇒ 启动期抛（M2b 实测该 payload 能过 M2a 校验、运行期才炸）", () => {
  assert.throws(() => parseMcpServersArg(`[${ILLEGAL_NO_TYPE}]`), /项 a2a 的 type 必须是 http \/ sse \/ acp/);
  assert.throws(() => parseMcpServersArg('[{"name":"a","url":"http://x"}]'), /type 必须是/);
  assert.throws(() => parseMcpServersArg('[{"name":"a","type":null,"url":"http://x"}]'), /type 必须是/, "null 不是判别键");
  assert.throws(() => parseMcpServersArg('[{"name":"a","type":"","url":"http://x"}]'), /type 必须是/, "空串不是判别键");
});

test("M2c ③：type 非闭集值 ⇒ 抛（含大小写与 stdio 等相邻方言名）", () => {
  for (const bad of ["stdio", "HTTP", "streamable-http", "ws"]) {
    assert.throws(
      () => parseMcpServersArg(`[{"name":"a","type":"${bad}","url":"http://x"}]`),
      /type 必须是 http \/ sse \/ acp/,
      `type=${bad} 不在 ACP 判别键闭集内`,
    );
  }
});

test("M2c ④：type 决定的必填键缺失 / 为空 ⇒ 抛；键存在但为空串同样抛", () => {
  assert.throws(() => parseMcpServersArg('[{"name":"a","type":"http"}]'), /type=http 需要非空字符串 url/);
  assert.throws(() => parseMcpServersArg('[{"name":"a","type":"sse","url":""}]'), /type=sse 需要非空字符串 url/);
  assert.throws(() => parseMcpServersArg('[{"name":"a","type":"acp"}]'), /type=acp 需要非空字符串 command/);
  assert.throws(() => parseMcpServersArg('[{"name":"a","type":"acp","command":[]}]'), /type=acp 需要非空字符串 command/);
  // 交叉形态：有 url 但 type=acp ⇒ 仍需 command（不再接受"两键至少其一"的宽松判定）
  assert.throws(
    () => parseMcpServersArg('[{"name":"a","type":"acp","url":"http://x"}]'),
    /type=acp 需要非空字符串 command/,
  );
});

test("M2c ⑤：非法 payload 在启动期（parseBridgeArgs）即拒；合法 payload 仍原样落 args.mcpServers", () => {
  assert.throws(
    () => parseBridgeArgs([...COMMON, "--mcp-servers-json", `[${ILLEGAL_NO_TYPE}]`]),
    /--mcp-servers-json 项 a2a 的 type/,
    "缺 type 的 payload 不得进入运行期",
  );
  const args = parseBridgeArgs([...COMMON, "--mcp-servers-json", `[${LEGAL_HTTP}]`]);
  assert.deepEqual(args.mcpServers, [JSON.parse(LEGAL_HTTP)]);
});
