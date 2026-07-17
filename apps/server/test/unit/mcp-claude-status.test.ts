import { fileURLToPath } from "node:url";
import type { McpServerDescriptor } from "@zuse/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
	claudeMcpLogin,
	parseClaudeMcpList,
	reconcileClaudeManagedInventory,
} from "../../src/mcp/claude-status.ts";

describe("Claude native MCP status", () => {
	it("forwards the native authorization URL before login completes", async () => {
		const executable = fileURLToPath(
			new URL("../fixtures/fake-claude-mcp-login.sh", import.meta.url),
		);
		const urls: string[] = [];

		const outcome = await Effect.runPromise(
			claudeMcpLogin(executable, process.cwd(), "plugin:figma:figma", {
				onAuthorizationUrl: (url) => urls.push(url),
			}),
		);

		expect(outcome.success).toBe(true);
		expect(urls).toEqual(["https://auth.example.test/authorize?server=figma"]);
	});

	it("parses configured, plugin, and hosted app rows", () => {
		const rows = parseClaudeMcpList(
			[
				"Checking MCP server health…",
				"claude.ai Calendar: https://calendar.example/mcp - ✔ Connected",
				"plugin:design:canvas: https://canvas.example/mcp (HTTP) - ! Needs authentication",
				"local: bun run-server --flag - ✘ Failed to connect",
			].join("\n"),
			123,
		);

		expect(rows).toEqual([
			expect.objectContaining({
				name: "claude.ai Calendar",
				source: "claude-app",
				transport: "http",
				state: "connected",
				checkedAt: 123,
			}),
			expect.objectContaining({
				name: "plugin:design:canvas",
				source: "claude-plugin",
				state: "needs-auth",
			}),
			expect.objectContaining({
				name: "local",
				source: "claude-user",
				transport: "stdio",
				state: "error",
			}),
		]);
	});

	it("ignores diagnostics and unrelated output", () => {
		expect(
			parseClaudeMcpList(
				"MCP config diagnostics ⚠\nFor help configuring MCP servers, see: https://example.test",
				123,
			),
		).toEqual([]);
	});

	it("keeps configured identities and creates read-only managed rows", () => {
		const configured: McpServerDescriptor = {
			key: "claude:local",
			name: "local",
			source: "claude-user",
			kind: "configured",
			parentKey: null,
			availableProviders: ["claude"],
			transport: "stdio",
			command: "bun",
			args: [],
			url: null,
			envVarNames: [],
			enabledInConfig: true,
			disabledByZuse: false,
			toggleSupported: true,
			authenticationAction: null,
			manageUrl: null,
		};
		const entries = parseClaudeMcpList(
			[
				"local: bun server - ✔ Connected",
				"plugin:design:canvas: https://canvas.example/mcp (HTTP) - ! Needs authentication",
			].join("\n"),
			123,
		);
		const inventory = reconcileClaudeManagedInventory({
			configured: [configured],
			entries,
		});

		expect(inventory.descriptors).toEqual([
			expect.objectContaining({
				key: "claude-live:plugin:design:canvas",
				source: "claude-plugin",
				kind: "provider",
				toggleSupported: false,
				authenticationAction: "native-oauth",
			}),
		]);
		expect(inventory.statuses.map((status) => status.key)).toEqual([
			"claude:local",
			"claude-live:plugin:design:canvas",
		]);
	});
});
