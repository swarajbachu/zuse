import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { PLUGIN_MCP_TOOLS, PluginToolRequest } from "@zuse/contracts";
import { Schema } from "effect";
import { readLimitedJsonBody } from "./http.ts";
import type { PluginHost, PluginIdentity } from "./plugin-host.ts";

export async function servePluginMcp(
	request: Request,
	identity: PluginIdentity,
	host: typeof PluginHost.Service,
) {
	const server = new Server(
		{ name: "Zuse", version: "1.0.0" },
		{ capabilities: { tools: {} } },
	);
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: PLUGIN_MCP_TOOLS,
	}));
	server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
		const action = (
			{
				plugins_list: "list",
				plugins_search: "search",
				plugins_schema: "schema",
				plugins_call: "call",
			} as Record<string, string>
		)[params.name];
		try {
			const input = Schema.decodeUnknownSync(PluginToolRequest)({
				...params.arguments,
				action,
			});
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(await host.tools(identity, input)),
					},
				],
			};
		} catch {
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: "Plugin request failed. Check your connection in Zuse.",
					},
				],
			};
		}
	});
	await server.connect(transport);
	try {
		return await transport.handleRequest(request, {
			parsedBody:
				request.method === "POST"
					? await readLimitedJsonBody(request, 128_000)
					: undefined,
		});
	} finally {
		await server.close();
	}
}
