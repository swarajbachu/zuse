#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
	ORCHESTRATION_MCP_SERVER_NAME,
	ORCHESTRATION_MCP_TOOLS,
	type OrchestrationMcpToolResult,
} from "../orchestration-tools.ts";

const bridgeUrl = process.env.ZUSE_ORCHESTRATION_MCP_URL;
const token = process.env.ZUSE_ORCHESTRATION_MCP_TOKEN;

if (bridgeUrl === undefined || token === undefined) {
	process.stderr.write(
		"[zuse-orchestration-mcp] missing ZUSE_ORCHESTRATION_MCP_URL/ZUSE_ORCHESTRATION_MCP_TOKEN\n",
	);
	process.exit(2);
}

const callParent = async (
	name: string,
	args: unknown,
): Promise<OrchestrationMcpToolResult> => {
	const res = await fetch(`${bridgeUrl}/tool`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ name, arguments: args ?? {} }),
	});
	if (!res.ok) {
		return {
			content: [
				{
					type: "text",
					text: `Orchestration bridge failed: HTTP ${res.status}`,
				},
			],
			isError: true,
		};
	}
	return (await res.json()) as OrchestrationMcpToolResult;
};

const server = new Server(
	{ name: ORCHESTRATION_MCP_SERVER_NAME, version: "0.0.1" },
	{ capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: ORCHESTRATION_MCP_TOOLS.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema,
	})),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
	const name = req.params.name;
	if (!ORCHESTRATION_MCP_TOOLS.some((tool) => tool.name === name)) {
		return {
			content: [{ type: "text", text: `Unknown tool: ${name}` }],
			isError: true,
		};
	}
	try {
		return await callParent(name, req.params.arguments ?? {});
	} catch (cause) {
		return {
			content: [
				{
					type: "text",
					text: `Orchestration tool ${name} failed: ${
						cause instanceof Error ? cause.message : String(cause)
					}`,
				},
			],
			isError: true,
		};
	}
});

const transport = new StdioServerTransport();
server.connect(transport).catch((cause: unknown) => {
	process.stderr.write(
		`[zuse-orchestration-mcp] failed to connect stdio transport: ${
			cause instanceof Error ? cause.message : String(cause)
		}\n`,
	);
	process.exit(1);
});
