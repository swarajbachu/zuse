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
});
