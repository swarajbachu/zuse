import type { Tool } from "@zuse/agents/codex-generated/Tool";
import type { AppInfo } from "@zuse/agents/codex-generated/v2/AppInfo";
import type { McpServerStatus as NativeStatus } from "@zuse/agents/codex-generated/v2/McpServerStatus";
import type { PluginDetail } from "@zuse/agents/codex-generated/v2/PluginDetail";
import type { McpServerDescriptor } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	groupCodexAppTools,
	reconcileCodexInventory,
} from "../../src/mcp/codex-inventory.ts";
import {
	type CodexLiveMcpSnapshot,
	reconcileCodexConnectors,
} from "../../src/mcp/codex-status.ts";

const tool = (name: string, meta?: unknown): Tool => ({
	name,
	inputSchema: {},
	_meta: meta as Tool["_meta"],
});

const nativeStatus = (
	name: string,
	options: {
		readonly authStatus?: NativeStatus["authStatus"];
		readonly tools?: Readonly<Record<string, Tool>>;
	} = {},
): NativeStatus => ({
	name,
	tools: options.tools ?? {},
	resources: [],
	resourceTemplates: [],
	authStatus: options.authStatus ?? "unsupported",
});

const configuredDescriptor = (
	name: string,
	overrides: Partial<McpServerDescriptor> = {},
): McpServerDescriptor => ({
	key: `codex:${name}`,
	name,
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

const snapshot = (
	overrides: Partial<CodexLiveMcpSnapshot> = {},
): CodexLiveMcpSnapshot => ({
	statuses: [],
	connectors: [],
	pluginServers: [],
	...overrides,
});

describe("reconcileCodexInventory", () => {
	it("keeps configured identity while adding live-only provider servers", () => {
		const result = reconcileCodexInventory({
			configured: [
				{ descriptor: configuredDescriptor("configured"), requirements: [] },
			],
			live: snapshot({
				statuses: [
					nativeStatus("configured", { tools: { one: tool("one") } }),
					nativeStatus("plugin:design:server", {
						authStatus: "notLoggedIn",
					}),
				],
			}),
			excludedNames: new Set(),
			now: 42,
		});

		expect(result.descriptors.map((row) => row.key)).toEqual([
			"codex:configured",
			"codex-live:plugin:design:server",
		]);
		expect(result.statuses[0]).toMatchObject({
			state: "connected",
			toolCount: 1,
		});
		expect(result.statuses[1]).toMatchObject({
			state: "needs-auth",
			authMethod: "oauth",
		});
	});

	it("preserves disabled and missing configured server states", () => {
		const result = reconcileCodexInventory({
			configured: [
				{
					descriptor: configuredDescriptor("off", {
						enabledInConfig: false,
					}),
					requirements: [],
				},
				{ descriptor: configuredDescriptor("missing"), requirements: [] },
			],
			live: snapshot(),
			excludedNames: new Set(),
			now: 42,
		});

		expect(result.statuses.map((status) => status.state)).toEqual([
			"disabled",
			"error",
		]);
		expect(result.statuses[1]?.error).toContain("did not report");
	});

	it("keeps installed plugin MCPs visible when they fail before status", () => {
		const result = reconcileCodexInventory({
			configured: [],
			live: snapshot({
				pluginServers: [{ name: "plugin-server", pluginName: "Design plugin" }],
			}),
			excludedNames: new Set(),
			now: 42,
		});

		expect(result.descriptors[0]).toMatchObject({
			key: "codex-live:plugin-server",
			kind: "provider",
		});
		expect(result.statuses[0]).toMatchObject({
			state: "error",
			error: "Design plugin did not report this MCP server",
		});
	});

	it("keeps an aggregate app row and derives connected and auth child rows", () => {
		const aggregateTools = {
			mail: tool("mail.search", {
				connector_id: "mail-id",
				connector_name: "Mail",
			}),
			unscoped: tool("internal.health"),
		};
		const result = reconcileCodexInventory({
			configured: [],
			live: snapshot({
				statuses: [nativeStatus("codex_apps", { tools: aggregateTools })],
				connectors: [
					{
						id: "mail-id",
						name: "Mail",
						installUrl: "https://example.test/mail",
						isAccessible: true,
						isEnabled: true,
						needsAuth: false,
					},
					{
						id: "drive-id",
						name: "Drive",
						installUrl: "https://example.test/drive",
						isAccessible: false,
						isEnabled: true,
						needsAuth: true,
					},
				],
			}),
			excludedNames: new Set(),
			now: 42,
		});

		expect(result.descriptors.map((row) => row.kind)).toEqual([
			"app-group",
			"app",
			"app",
		]);
		expect(result.statuses[0]).toMatchObject({ toolCount: 2 });
		expect(result.statuses[1]).toMatchObject({
			name: "Mail",
			state: "connected",
			toolCount: 1,
		});
		expect(result.statuses[2]).toMatchObject({
			name: "Drive",
			state: "needs-auth",
		});
		expect(groupCodexAppTools(aggregateTools)).toHaveLength(1);
	});
});

describe("reconcileCodexConnectors", () => {
	it("excludes the marketplace but retains linked and installed auth-required apps", () => {
		const apps = [
			{
				id: "linked",
				name: "Linked",
				isAccessible: true,
				isEnabled: true,
				installUrl: "https://example.test/linked",
			},
			{
				id: "catalog-only",
				name: "Catalog only",
				isAccessible: false,
				isEnabled: true,
				installUrl: "https://example.test/catalog",
			},
			{
				id: "installed",
				name: "Installed",
				isAccessible: false,
				isEnabled: true,
				installUrl: "https://example.test/installed",
			},
		] as unknown as ReadonlyArray<AppInfo>;
		const plugins = [
			{
				apps: [
					{
						id: "installed",
						name: "Installed",
						description: null,
						installUrl: "https://example.test/installed",
						needsAuth: true,
					},
				],
				mcpServers: [],
			} as unknown as PluginDetail,
		];

		expect(reconcileCodexConnectors(apps, plugins)).toEqual([
			expect.objectContaining({ id: "linked", needsAuth: false }),
			expect.objectContaining({ id: "installed", needsAuth: true }),
		]);
	});
});
