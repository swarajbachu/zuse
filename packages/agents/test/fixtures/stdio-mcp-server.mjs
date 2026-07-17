// Minimal stdio MCP server used by user-mcp-probe.test.ts to exercise the
// full connect → listTools → close round-trip against a real child process.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "probe-fixture", version: "1.0.0" });
server.tool("echo", async () => ({
	content: [{ type: "text", text: "ok" }],
}));
server.tool("ping", async () => ({
	content: [{ type: "text", text: "pong" }],
}));
await server.connect(new StdioServerTransport());
