import type {
	PluginConnection,
	PluginDefinition,
	PluginSnapshot,
} from "@zuse/contracts";
import { useMemo } from "react";
import { useAuth } from "../hooks/use-auth.ts";
import { usePluginSnapshot } from "./plugins-client.ts";

/** Plugins the signed-in account can use right now, for `@` mentions. */
export type ConnectedPlugin = Pick<
	PluginDefinition,
	"id" | "name" | "domain"
> & {
	readonly connectionId: string;
	readonly pluginName: string;
};

/** Keep account names consistent in mention menus and settings. */
export const pluginConnectionName = (
	pluginName: string,
	label: string,
): string => (label === pluginName ? pluginName : `${pluginName} / ${label}`);

/** Names must distinguish accounts within the same plugin, including disabled connections. */
export const hasPluginConnectionLabel = (
	connections: readonly Pick<PluginConnection, "pluginId" | "label">[],
	pluginId: string,
	label: string,
): boolean => {
	const normalized = label.trim().toLowerCase();
	return (
		normalized.length > 0 &&
		connections.some(
			(connection) =>
				connection.pluginId === pluginId &&
				connection.label.trim().toLowerCase() === normalized,
		)
	);
};

/** List usable connections individually so mentions can select the exact account. */
export const connectedOf = (
	snapshot: PluginSnapshot | null,
): readonly ConnectedPlugin[] => {
	if (snapshot === null) return [];
	const catalog = new Map(
		snapshot.catalog.map((plugin) => [plugin.id, plugin]),
	);
	return snapshot.connections.flatMap((connection) => {
		const plugin = catalog.get(connection.pluginId);
		if (!plugin || connection.state !== "connected" || !connection.enabled)
			return [];
		return [
			{
				id: plugin.id,
				domain: plugin.domain,
				name: pluginConnectionName(plugin.name, connection.label),
				pluginName: plugin.name,
				connectionId: connection.id,
			},
		];
	});
};

/** The account whose plugins apply, or null when signed out. */
export function usePluginAccount(): string | null {
	const { isSignedIn, user } = useAuth();
	return isSignedIn ? (user?.id ?? null) : null;
}

/**
 * Enabled, connected personal plugins for `@` menus and tool rows; empty while
 * signed out. Reads the shared plugin snapshot cache (agent sessions use
 * personal connections only).
 */
export function useConnectedPlugins(): readonly ConnectedPlugin[] {
	const { snapshot } = usePluginSnapshot(usePluginAccount());
	return useMemo(() => connectedOf(snapshot), [snapshot]);
}

/** Context the agent receives for an `@plugin` mention. */
export const pluginMentionContext = (plugin: {
	readonly id: string;
	readonly name: string;
	readonly connectionId?: string;
}) => ({
	_tag: "context" as const,
	id: plugin.connectionId
		? `plugin:${plugin.id}:${plugin.connectionId}`
		: `plugin:${plugin.id}`,
	label: plugin.name,
	comment: `Use my connected ${plugin.name} plugin for this request. Find its tools with plugins_search (an empty query lists every connected tool; this connection’s tool addresses start with "tools.${plugin.id}.${plugin.connectionId ? `user.${plugin.connectionId}.` : ""}"), read a tool's input with plugins_schema, then run it with plugins_call.${plugin.connectionId ? " Use only this exact connection prefix; if it is unavailable, ask me to reconnect rather than using another account." : ""}`,
});

/** Logos come from the same public registry as the catalog. */
export const pluginIconUrl = (domain: string) =>
	`https://integrations.sh/logo/${encodeURIComponent(domain)}`;

/** Plugin id from a managed tool address (`tools.<plugin>.user.<id>.<tool>`). */
export const pluginToolAddress = (
	address: string,
): { readonly pluginId: string; readonly tool: string } | null => {
	const match = /^tools\.([^.]+)\.user\.[^.]+\.(.+)$/.exec(address);
	return match === null
		? null
		: { pluginId: match[1] ?? "", tool: match[2] ?? "" };
};

/** Display info for a connected plugin; null until known or if disconnected. */
export function useConnectedPlugin(
	pluginId: string | null,
): ConnectedPlugin | null {
	const plugins = useConnectedPlugins();
	const plugin = plugins.find((item) => item.id === pluginId);
	return plugin ? { ...plugin, name: plugin.pluginName } : null;
}
