/**
 * Public surface of @zuse/mcp-server. The CLI lives in `bin.ts`;
 * this module is what external consumers import if they want to embed
 * the MCP server inside their own runtime (rare — most use the binary).
 */
export { runStdioServer } from "./server.ts";
export {
  startServerHandle,
  type ServerHandle,
  type ServerOptions,
} from "./handle.ts";
export { buildTools, type McpToolDef } from "./tools.ts";
