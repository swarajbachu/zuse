import type { McpServerDescriptor } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	MCP_DISPLAY_GROUPS,
	mcpChildrenForParent,
	mcpProviderAvailabilityLabel,
	mcpServersForProvider,
	mcpTopLevelServers,
} from "../../src/lib/mcp-display.ts";

const descriptor = (
	key: string,
	overrides: Partial<McpServerDescriptor> = {},
): McpServerDescriptor => ({
	key,
	name: key,
	source: "codex",
	kind: "configured",
	parentKey: null,
	availableProviders: ["codex"],
	transport: "stdio",
	command: "node",
	args: [],
	url: null,
	envVarNames: [],
	enabledInConfig: true,
	disabledByZuse: false,
	toggleSupported: true,
	authenticationAction: null,
	manageUrl: null,
	...overrides,
});

describe("MCP display grouping", () => {
	it("groups top-level rows without duplicating connector children", () => {
		const rows = [
			descriptor("builtin:zuse", { source: "builtin", kind: "builtin" }),
			descriptor("claude:local", {
				source: "claude-user",
				availableProviders: ["claude"],
			}),
			descriptor("codex-apps:codex_apps", {
				source: "codex-app",
				kind: "app-group",
			}),
			descriptor("codex-app:mail", {
				source: "codex-app",
				kind: "app",
				parentKey: "codex-apps:codex_apps",
			}),
		];
		const topLevel = mcpTopLevelServers(rows);

		expect(topLevel).toHaveLength(3);
		expect(
			MCP_DISPLAY_GROUPS.map((group) => ({
				label: group.label,
				keys: topLevel.filter(group.matches).map((row) => row.key),
			})),
		).toEqual([
			{ label: "Built-in", keys: ["builtin:zuse"] },
			{ label: "Claude", keys: ["claude:local"] },
			{ label: "Codex", keys: [] },
			{ label: "Provider apps", keys: ["codex-apps:codex_apps"] },
		]);
	});

	it("shows connector children only while their aggregate is expanded", () => {
		const child = descriptor("codex-app:mail", {
			kind: "app",
			parentKey: "codex-apps:codex_apps",
		});
		expect(
			mcpChildrenForParent([child], "codex-apps:codex_apps", true),
		).toEqual([child]);
		expect(
			mcpChildrenForParent([child], "codex-apps:codex_apps", false),
		).toEqual([]);
	});

	it("labels provider availability without implying cross-provider access", () => {
		expect(
			mcpProviderAvailabilityLabel(
				descriptor("claude:only", {
					availableProviders: ["claude"],
				}),
			),
		).toBe("Claude");
		expect(
			mcpProviderAvailabilityLabel(
				descriptor("builtin:zuse", {
					availableProviders: ["claude", "codex"],
				}),
			),
		).toBe("Claude, Codex");
	});

	it("shows only entries available to the active provider", () => {
		const rows = [
			descriptor("builtin:zuse", {
				source: "builtin",
				kind: "builtin",
				availableProviders: ["claude", "codex"],
			}),
			descriptor("claude:local", {
				source: "claude-user",
				availableProviders: ["claude"],
			}),
			descriptor("codex:local"),
		];

		expect(mcpServersForProvider(rows, "claude").map((row) => row.key)).toEqual(
			["builtin:zuse", "claude:local"],
		);
	});
});
