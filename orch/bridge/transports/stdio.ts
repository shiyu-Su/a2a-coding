/**
 * stdio 接入面（默认；REQ-v0.4.1-2026-09-15-02 §2.2）。
 *
 * 形态：**单实例**（进程内一个 MCP server + `StdioServerTransport`），与既有 `main()`
 * 的 stdio 路径行为一致 —— 生命周期随宿主（stdin 管道），不持有进程。
 *
 * 与 http 接入面的差异（§2.3）：http 是 **stateless「每请求新建 server + transport」**，
 * 故 server 一律由 `createServer(core)` 工厂供给（工厂与工具注册在 `register-tools.ts`，
 * 该模块 import 无副作用；本模块不含领域 / 工具逻辑）。
 *
 * 日志：本模块不写 stdout —— stdout 是 stdio MCP 的 JSON-RPC 协议通道（§1.3 第 7 条）。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { BridgeCore } from "../index.js";
import { createServer } from "../register-tools.js";

/**
 * 装配并连接 stdio 接入面。
 * 返回 server 供停机路径 `close()`（`index.ts` 的 `shutdown()`）。
 */
export async function startStdioTransport(core: BridgeCore): Promise<McpServer> {
  const server = createServer(core);
  await server.connect(new StdioServerTransport());
  return server;
}
