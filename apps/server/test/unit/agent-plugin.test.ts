import { describe, expect, it, vi } from "vitest";
import {
	executeAgentPlugin,
	inspectAgentPlugin,
	listAgentPlugins,
	type PluginClient,
} from "../../src/agent-plugin/manager.ts";

const locator = { marketplace: "team.tools", name: "review" };
const plugin = {
	id: "review@team.tools",
	name: "review",
	installed: false,
	enabled: false,
	availability: "AVAILABLE",
	installPolicy: "AVAILABLE",
	interface: {
		displayName: "Review",
		shortDescription: "Team review workflow",
		capabilities: ["skills", "hooks"],
	},
};
const catalog = (entry = plugin) => ({
	marketplaces: [
		{ name: locator.marketplace, path: "/team/catalog.json", plugins: [entry] },
	],
	marketplaceLoadErrors: [],
});
const client = (snapshot: unknown = catalog()) => {
	const request = vi.fn<PluginClient["request"]>(async (method) => {
		if (method === "plugin/list") return snapshot;
		if (method === "plugin/read")
			return {
				plugin: {
					description: "Reviews",
					skills: [{ name: "review" }],
					hooks: [{ eventName: "SessionStart" }],
					mcpServers: ["tickets"],
					apps: [],
				},
			};
		if (method === "plugin/install") return { appsNeedingAuth: [] };
		return {};
	});
	return { request };
};
describe("native agent plugins", () => {
	it("lists native state and partial marketplace errors without inventing installed state", async () => {
		const c = client({
			...catalog(),
			marketplaceLoadErrors: [{ message: "Offline" }],
		});
		expect(await listAgentPlugins(c)).toMatchObject({
			plugins: [{ id: plugin.id, installed: false, displayName: "Review" }],
			errors: ["Offline"],
		});
		expect(c.request).toHaveBeenCalledTimes(1);
	});
	it("resolves inspection and install paths from the current native catalog", async () => {
		const c = client();
		expect(await inspectAgentPlugin(c, locator)).toEqual({
			description: "Reviews",
			skills: ["review"],
			hooks: ["SessionStart"],
			mcpServers: ["tickets"],
			apps: [],
		});
		await executeAgentPlugin(c, { _tag: "install", plugin: locator });
		expect(c.request).toHaveBeenCalledWith("plugin/install", {
			pluginName: "review",
			marketplacePath: "/team/catalog.json",
		});
	});
	it("supports remote-only marketplaces and reports outstanding authentication", async () => {
		const c = client();
		c.request.mockImplementation(async (method) =>
			method === "plugin/list"
				? {
						marketplaces: [
							{ name: locator.marketplace, path: null, plugins: [plugin] },
						],
						marketplaceLoadErrors: [],
					}
				: { appsNeedingAuth: [{ name: "Tickets" }] },
		);
		expect(
			(await executeAgentPlugin(c, { _tag: "install", plugin: locator }))
				.message,
		).toContain("Tickets");
		expect(c.request).toHaveBeenCalledWith("plugin/install", {
			pluginName: "review",
			remoteMarketplaceName: "team.tools",
		});
	});
	it("rejects stale and admin-disabled entries before mutation", async () => {
		const c = client(catalog({ ...plugin, availability: "DISABLED_BY_ADMIN" }));
		await expect(
			executeAgentPlugin(c, { _tag: "install", plugin: locator }),
		).rejects.toThrow("administrator");
		await expect(
			executeAgentPlugin(c, {
				_tag: "install",
				plugin: { ...locator, name: "gone" },
			}),
		).rejects.toThrow("no longer");
		expect(
			c.request.mock.calls.every(([method]) => method === "plugin/list"),
		).toBe(true);
	});
	it("does not reinstall installed plugins, and toggles exactly the quoted native ID", async () => {
		const c = client(catalog({ ...plugin, installed: true }));
		await executeAgentPlugin(c, { _tag: "install", plugin: locator });
		expect(c.request).not.toHaveBeenCalledWith(
			"plugin/install",
			expect.anything(),
		);
		await executeAgentPlugin(c, {
			_tag: "set-enabled",
			plugin: locator,
			enabled: true,
		});
		expect(c.request).toHaveBeenCalledWith("config/value/write", {
			keyPath: 'plugins."review@team.tools".enabled',
			value: true,
			mergeStrategy: "replace",
		});
		await executeAgentPlugin(c, { _tag: "uninstall", plugin: locator });
		expect(c.request).toHaveBeenCalledWith("plugin/uninstall", {
			pluginId: plugin.id,
		});
	});
	it("delegates marketplace changes and surfaces native failures", async () => {
		const c = client();
		await executeAgentPlugin(c, {
			_tag: "add-marketplace",
			source: "/team/repo",
		});
		await executeAgentPlugin(c, {
			_tag: "update-marketplace",
			marketplace: locator.marketplace,
		});
		await executeAgentPlugin(c, {
			_tag: "remove-marketplace",
			marketplace: locator.marketplace,
		});
		expect(c.request).toHaveBeenCalledWith("marketplace/add", {
			source: "/team/repo",
		});
		expect(c.request).toHaveBeenCalledWith("marketplace/upgrade", {
			marketplaceName: "team.tools",
		});
		expect(c.request).toHaveBeenCalledWith("marketplace/remove", {
			marketplaceName: "team.tools",
		});
		c.request.mockRejectedValue(new Error("Unsupported plugin API"));
		await expect(listAgentPlugins(c)).rejects.toThrow("Unsupported");
	});
	it("fails malformed native responses rather than presenting an empty marketplace", async () => {
		const c = client();
		c.request.mockResolvedValue({});
		await expect(listAgentPlugins(c)).rejects.toThrow();
	});
});
