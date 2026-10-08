import { expect, test, vi } from "vitest";
import { servePluginMcp } from "../../src/plugin-mcp.ts";

test("branded tenant MCP endpoint discovers and invokes through the bound owner", async () => {
	const tools = vi.fn(async () => [
		{ address: "tools.linear.user.work.search" },
	]);
	const host = {
		request: async () => ({ kind: "ok" as const }),
		tools,
		callback: async () => new Response(),
	};
	const identity = { tenant: "personal:alice", subject: "alice" };
	const request = (method: string, params: unknown) =>
		new Request("https://api.test/v1/plugins/personal%3Aalice/mcp", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		});
	const list = await servePluginMcp(request("tools/list", {}), identity, host);
	expect(list.status).toBe(200);
	expect(await list.text()).toContain("plugins_call");
	await servePluginMcp(
		request("tools/call", { name: "plugins_list", arguments: {} }),
		identity,
		host,
	);
	expect(tools).toHaveBeenCalledWith(identity, { action: "list" });
	const call = await servePluginMcp(
		request("tools/call", {
			name: "plugins_search",
			arguments: { query: "issues" },
		}),
		identity,
		host,
	);
	expect(call.status).toBe(200);
	expect(tools).toHaveBeenCalledWith(identity, {
		action: "search",
		query: "issues",
	});
});
