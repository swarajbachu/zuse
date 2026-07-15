#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { LINEAR_MCP_SERVER_NAME, LINEAR_MCP_TOOLS } from "../linear-tools.ts";

const bridgeUrl = process.env.ZUSE_LINEAR_MCP_URL;
const token = process.env.ZUSE_LINEAR_MCP_TOKEN;
if (bridgeUrl === undefined || token === undefined) process.exit(2);

const server = new Server(
	{ name: LINEAR_MCP_SERVER_NAME, version: "0.0.1" },
	{ capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: LINEAR_MCP_TOOLS.map((tool) => ({ ...tool })),
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
	try {
		const response = await fetch(`${bridgeUrl}/tool`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: request.params.name,
				arguments: request.params.arguments ?? {},
			}),
		});
		return (await response.json()) as {
			content: Array<{ type: "text"; text: string }>;
			isError?: boolean;
		};
	} catch (cause) {
		return {
			content: [
				{
					type: "text" as const,
					text: cause instanceof Error ? cause.message : String(cause),
				},
			],
			isError: true,
		};
	}
});
server.connect(new StdioServerTransport()).catch((cause: unknown) => {
	process.stderr.write(
		`[zuse-linear-mcp] failed to connect stdio transport: ${
			cause instanceof Error ? cause.message : String(cause)
		}\n`,
	);
	process.exit(1);
});
