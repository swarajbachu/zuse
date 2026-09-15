import type {
	AgentPluginCatalog,
	AgentPluginCommand,
	AgentPluginDetails,
} from "@zuse/contracts";
import { Schema } from "effect";

/** Native ownership: Codex validates manifests and manages cache, hooks and MCP config. */
export interface PluginClient {
	request(
		method:
			| "plugin/list"
			| "plugin/read"
			| "plugin/install"
			| "plugin/uninstall"
			| "config/value/write"
			| "marketplace/add"
			| "marketplace/remove"
			| "marketplace/upgrade",
		params: unknown,
	): Promise<unknown>;
}
const NativePlugin = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	installed: Schema.Boolean,
	enabled: Schema.Boolean,
	availability: Schema.String,
	installPolicy: Schema.String,
	interface: Schema.NullOr(
		Schema.Struct({
			displayName: Schema.NullOr(Schema.String),
			shortDescription: Schema.NullOr(Schema.String),
			capabilities: Schema.Array(Schema.String),
		}),
	),
});
const NativeCatalog = Schema.Struct({
	marketplaces: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			path: Schema.NullOr(Schema.String),
			plugins: Schema.Array(NativePlugin),
		}),
	),
	marketplaceLoadErrors: Schema.Array(
		Schema.Struct({ message: Schema.String }),
	),
});
const NativeDetails = Schema.Struct({
	plugin: Schema.Struct({
		description: Schema.NullOr(Schema.String),
		skills: Schema.Array(Schema.Struct({ name: Schema.String })),
		hooks: Schema.Array(Schema.Struct({ eventName: Schema.String })),
		mcpServers: Schema.Array(Schema.String),
		apps: Schema.Array(Schema.Struct({ name: Schema.String })),
	}),
});
const list = async (client: PluginClient) =>
	Schema.decodeUnknownSync(NativeCatalog)(
		await client.request("plugin/list", {}),
	);
const locate = async (
	client: PluginClient,
	locator: { marketplace: string; name: string },
) => {
	const catalog = await list(client);
	const market = catalog.marketplaces.find(
		(m) => m.name === locator.marketplace,
	);
	const plugin = market?.plugins.find((p) => p.name === locator.name);
	if (!market || !plugin)
		throw new Error(
			"Plugin is no longer in this marketplace. Refresh and try again.",
		);
	return {
		plugin,
		params: {
			pluginName: plugin.name,
			...(market.path
				? { marketplacePath: market.path }
				: { remoteMarketplaceName: market.name }),
		},
	};
};
export async function listAgentPlugins(
	client: PluginClient,
): Promise<AgentPluginCatalog> {
	const catalog = await list(client);
	return {
		marketplaces: catalog.marketplaces.map((m) => ({
			name: m.name,
			local: m.path !== null,
		})),
		errors: catalog.marketplaceLoadErrors.map((e) => e.message),
		plugins: catalog.marketplaces.flatMap((m) =>
			m.plugins.map((p) => ({
				id: p.id,
				name: p.name,
				marketplace: m.name,
				displayName: p.interface?.displayName || p.name,
				description: p.interface?.shortDescription ?? "",
				installed: p.installed,
				enabled: p.enabled,
				available: p.availability === "AVAILABLE",
				installable: p.installPolicy !== "NOT_AVAILABLE",
				capabilities: p.interface?.capabilities ?? [],
			})),
		),
	};
}
export async function inspectAgentPlugin(
	client: PluginClient,
	locator: { marketplace: string; name: string },
): Promise<AgentPluginDetails> {
	const { params } = await locate(client, locator);
	const { plugin } = Schema.decodeUnknownSync(NativeDetails)(
		await client.request("plugin/read", params),
	);
	return {
		description: plugin.description ?? "",
		skills: plugin.skills.map((s) => s.name),
		hooks: plugin.hooks.map((h) => h.eventName),
		mcpServers: plugin.mcpServers,
		apps: plugin.apps.map((a) => a.name),
	};
}
export async function executeAgentPlugin(
	client: PluginClient,
	command: AgentPluginCommand,
): Promise<{ message: string }> {
	if (command._tag === "add-marketplace") {
		if (command.source.includes("\0"))
			throw new Error("Invalid marketplace source.");
		await client.request("marketplace/add", { source: command.source });
	} else if (
		command._tag === "update-marketplace" ||
		command._tag === "remove-marketplace"
	) {
		const catalog = await list(client);
		if (!catalog.marketplaces.some((m) => m.name === command.marketplace))
			throw new Error("Marketplace is no longer available.");
		await client.request(
			command._tag === "update-marketplace"
				? "marketplace/upgrade"
				: "marketplace/remove",
			{ marketplaceName: command.marketplace },
		);
	} else {
		const { plugin, params } = await locate(client, command.plugin);
		if (command._tag === "install") {
			if (plugin.installed) return { message: "Plugin is already installed." };
			if (
				plugin.availability !== "AVAILABLE" ||
				plugin.installPolicy === "NOT_AVAILABLE"
			)
				throw new Error(
					"This plugin is unavailable or disabled by your administrator.",
				);
			const result = Schema.decodeUnknownSync(
				Schema.Struct({
					appsNeedingAuth: Schema.Array(Schema.Struct({ name: Schema.String })),
				}),
			)(await client.request("plugin/install", params));
			if (result.appsNeedingAuth.length)
				return {
					message: `Installed. Sign in to ${result.appsNeedingAuth.map((a) => a.name).join(", ")} in Codex. Start a new chat to use this plugin.`,
				};
		} else {
			if (!plugin.installed) throw new Error("This plugin is not installed.");
			if (command._tag === "uninstall")
				await client.request("plugin/uninstall", { pluginId: plugin.id });
			else {
				if (command.enabled && plugin.availability !== "AVAILABLE")
					throw new Error("This plugin is disabled by your administrator.");
				await client.request("config/value/write", {
					keyPath: `plugins.${JSON.stringify(plugin.id)}.enabled`,
					value: command.enabled,
					mergeStrategy: "replace",
				});
			}
		}
	}
	return {
		message:
			"Saved. Start a new Codex chat to pick up plugin changes. Existing chats are unchanged.",
	};
}
