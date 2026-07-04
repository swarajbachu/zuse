import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { startServerHandle, type ServerOptions } from "./handle.ts";
import { buildTools } from "./tools.ts";

/**
 * Build and start the MCP server. Wired against stdio by default —
 * `zuse-mcp --workspace .` is the canonical invocation. HTTP
 * transport ships as a separate entry (mod-side opt-in) so the
 * default binary stays single-purpose.
 *
 * The handle stays in scope for the life of the process; tools close
 * over it. SIGINT/SIGTERM triggers a clean shutdown.
 */
export const runStdioServer = async (
  opts: ServerOptions,
): Promise<void> => {
  const handle = await startServerHandle(opts);
  const tools = buildTools(handle);
  const byName = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    {
      name: "zuse-mcp",
      version: "0.0.1",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const def = byName.get(req.params.name);
    if (!def) {
      return {
        content: [
          {
            type: "text",
            text: `Unknown tool: ${req.params.name}`,
          },
        ],
        isError: true,
      };
    }
    const parsed = def.validator.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return {
        content: [
          {
            type: "text",
            text: `Invalid arguments for ${def.name}: ${parsed.error.message}`,
          },
        ],
        isError: true,
      };
    }
    try {
      return await def.handler(parsed.data);
    } catch (cause) {
      return {
        content: [
          {
            type: "text",
            text: `Tool ${def.name} failed: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          },
        ],
        isError: true,
      };
    }
  });

  const cleanup = async () => {
    try {
      await handle.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void cleanup());
  process.on("SIGTERM", () => void cleanup());

  const transport = new StdioServerTransport();
  await server.connect(transport);
};
