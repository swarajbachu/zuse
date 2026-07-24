import { ensureBrowserPermission } from "@zuse/agents/drivers/browser-mcp-tools";
import { describe, expect, it } from "vitest";

describe("browser MCP plan permissions", () => {
	it("allows read-only browser tools without requesting permission", async () => {
		let requestCount = 0;
		await ensureBrowserPermission(
			"browser_snapshot",
			{},
			{
				send: async () => ({ id: "browser-test", ok: true }),
				getPermissionMode: () => "plan",
				getRuntimeMode: () => "full-access",
				requestPermission: async () => {
					requestCount += 1;
					return { _tag: "AllowOnce" };
				},
			},
		);
		expect(requestCount).toBe(0);
	});

	it("denies mutating browser tools without requesting permission", async () => {
		let requestCount = 0;
		await expect(
			ensureBrowserPermission(
				"browser_click",
				{},
				{
					send: async () => ({ id: "browser-test", ok: true }),
					getPermissionMode: () => "plan",
					getRuntimeMode: () => "full-access",
					requestPermission: async () => {
						requestCount += 1;
						return { _tag: "AllowOnce" };
					},
				},
			),
		).rejects.toThrow(/blocked/i);
		expect(requestCount).toBe(0);
	});

	it("treats status, compound waits, and inspection as read-only", async () => {
		let requestCount = 0;
		for (const tool of [
			"browser_status",
			"browser_wait_for",
			"browser_inspect",
		]) {
			await ensureBrowserPermission(
				tool,
				{},
				{
					send: async () => ({ id: "browser-test", ok: true }),
					getPermissionMode: () => "default",
					getRuntimeMode: () => "full-access",
					requestPermission: async () => {
						requestCount += 1;
						return { _tag: "AllowOnce" };
					},
				},
			);
		}
		expect(requestCount).toBe(0);
	});

	it("always prompts before page evaluation", async () => {
		let forced = false;
		await ensureBrowserPermission(
			"browser_evaluate",
			{ expression: "document.title" },
			{
				send: async () => ({ id: "browser-test", ok: true }),
				getPermissionMode: () => "default",
				getRuntimeMode: () => "full-access",
				requestPermission: async (_kind, options) => {
					forced = options.forcePrompt;
					return { _tag: "AllowOnce" };
				},
			},
		);
		expect(forced).toBe(true);
	});
});
