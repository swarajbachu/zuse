#!/usr/bin/env bun
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { DEVICE_COMMAND_TOOL_TIMEOUT_SECONDS } from "../device-command-tools.ts";

const endpoint = process.env.ZUSE_APP_MCP_URL;
const token = process.env.ZUSE_APP_MCP_TOKEN;

if (endpoint === undefined || token === undefined) {
	process.stderr.write(
		"[zuse-mcp-proxy] missing ZUSE_APP_MCP_URL/ZUSE_APP_MCP_TOKEN\n",
	);
	process.exit(2);
}

const upstream = new Client({ name: "zuse-stdio-proxy", version: "0.0.1" });
const upstreamTransport = new StreamableHTTPClientTransport(new URL(endpoint), {
	requestInit: {
		headers: { Authorization: `Bearer ${token}` },
	},
});
const server = new Server(
	{ name: "zuse", version: "0.0.1" },
	{ capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () =>
	upstream.listTools(),
);
server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
	upstream.callTool(
		{
			name: request.params.name,
			arguments: request.params.arguments,
		},
		undefined,
		{
			signal: extra.signal,
			...(request.params.name === "local_command_execute"
				? { timeout: DEVICE_COMMAND_TOOL_TIMEOUT_SECONDS * 1000 }
				: {}),
		},
	),
);

const start = async (): Promise<void> => {
	await upstream.connect(upstreamTransport);
	await server.connect(new StdioServerTransport());
};

start().catch((cause: unknown) => {
	process.stderr.write(
		`[zuse-mcp-proxy] failed: ${
			cause instanceof Error ? cause.message : String(cause)
		}\n`,
	);
	process.exit(1);
});
