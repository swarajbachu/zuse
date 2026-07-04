#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  BROWSER_MCP_TOOLS,
  type BrowserMcpToolResult,
} from "./browser-mcp-bridge.ts";

const bridgeUrl = process.env.ZUSE_BROWSER_MCP_URL;
const token = process.env.ZUSE_BROWSER_MCP_TOKEN;

if (bridgeUrl === undefined || token === undefined) {
  process.stderr.write(
    "[zuse-browser-mcp] missing ZUSE_BROWSER_MCP_URL/ZUSE_BROWSER_MCP_TOKEN\n",
  );
  process.exit(2);
}

const callParent = async (
  name: string,
  args: unknown,
): Promise<BrowserMcpToolResult> => {
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
          text: `Browser bridge failed: HTTP ${res.status}`,
        },
      ],
      isError: true,
    };
  }
  return (await res.json()) as BrowserMcpToolResult;
};

const server = new Server(
  { name: "zuse", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: BROWSER_MCP_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  if (!BROWSER_MCP_TOOLS.some((tool) => tool.name === name)) {
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
          text: `Browser tool ${name} failed: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        },
      ],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
