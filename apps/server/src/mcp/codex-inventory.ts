import type { Tool } from "@zuse/agents/codex-generated/Tool";
import type {
	McpRequirement,
	McpServerDescriptor,
	McpServerStatus,
} from "@zuse/contracts";
import { Predicate } from "effect";

import type { CodexLiveMcpSnapshot } from "./codex-status.ts";

export interface ConfiguredCodexInventoryEntry {
	readonly descriptor: McpServerDescriptor;
	readonly requirements: ReadonlyArray<McpRequirement>;
}

export interface ReconciledCodexInventory {
	readonly descriptors: ReadonlyArray<McpServerDescriptor>;
	readonly statuses: ReadonlyArray<McpServerStatus>;
}

const APPS_GROUP_KEY = "codex-apps:codex_apps";

const providerDescriptor = (
	name: string,
	authenticationAction: McpServerDescriptor["authenticationAction"],
): McpServerDescriptor => ({
	key: `codex-live:${name}`,
	name,
	source: "codex",
	kind: "provider",
	parentKey: null,
	availableProviders: ["codex"],
	transport: null,
	command: null,
	args: [],
	url: null,
	envVarNames: [],
	enabledInConfig: true,
	disabledByZuse: false,
	toggleSupported: false,
	authenticationAction,
	manageUrl: null,
});

const appGroupDescriptor = (): McpServerDescriptor => ({
	key: APPS_GROUP_KEY,
	name: "Apps & connectors",
	source: "codex-app",
	kind: "app-group",
	parentKey: null,
	availableProviders: ["codex"],
	transport: null,
	command: null,
	args: [],
	url: null,
	envVarNames: [],
	enabledInConfig: true,
	disabledByZuse: false,
	toggleSupported: false,
	authenticationAction: null,
	manageUrl: null,
});

interface ConnectorTools {
	readonly id: string;
	readonly name: string;
	readonly toolNames: ReadonlyArray<string>;
}

const recordString = (value: unknown, key: string): string | null => {
	if (!Predicate.hasProperty(value, key)) return null;
	const field = value[key];
	return Predicate.isString(field) ? field : null;
};

/** Group aggregate app-server tools by the stable connector metadata. */
export const groupCodexAppTools = (
	tools: Readonly<Record<string, Tool | undefined>>,
): ReadonlyArray<ConnectorTools> => {
	const grouped = new Map<string, { name: string; toolNames: string[] }>();
	for (const [fallbackName, tool] of Object.entries(tools)) {
		if (tool === undefined) continue;
		const id = recordString(tool._meta, "connector_id");
		if (id === null) continue;
		const name = recordString(tool._meta, "connector_name") ?? id;
		const current = grouped.get(id) ?? { name, toolNames: [] };
		current.toolNames.push(tool.name || fallbackName);
		grouped.set(id, current);
	}
	return [...grouped.entries()].map(([id, value]) => ({ id, ...value }));
};

const statusFromLive = (options: {
	readonly descriptor: McpServerDescriptor;
	readonly authStatus: "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth";
	readonly tools: Readonly<Record<string, Tool | undefined>>;
	readonly requirements: ReadonlyArray<McpRequirement>;
	readonly now: number;
}): McpServerStatus => {
	const needsAuth = options.authStatus === "notLoggedIn";
	const toolNames = Object.values(options.tools).flatMap((tool) =>
		tool === undefined ? [] : [tool.name],
	);
	return {
		key: options.descriptor.key,
		name: options.descriptor.name,
		source: options.descriptor.source,
		state: needsAuth ? "needs-auth" : "connected",
		toolCount: needsAuth ? null : toolNames.length,
		toolNames,
		error: null,
		authMethod: needsAuth ? "oauth" : null,
		requirements: needsAuth
			? [
					...options.requirements,
					{ kind: "auth", detail: "sign-in required", satisfied: false },
				]
			: [...options.requirements],
		checkedAt: options.now,
	};
};

export const reconcileCodexInventory = (options: {
	readonly configured: ReadonlyArray<ConfiguredCodexInventoryEntry>;
	readonly live: CodexLiveMcpSnapshot;
	readonly excludedNames: ReadonlySet<string>;
	readonly now: number;
}): ReconciledCodexInventory => {
	const descriptors: McpServerDescriptor[] = [];
	const statuses: McpServerStatus[] = [];
	const configuredNames = new Set(
		options.configured.map((entry) => entry.descriptor.name),
	);
	const liveByName = new Map(
		options.live.statuses.map((status) => [status.name, status]),
	);

	for (const entry of options.configured) {
		descriptors.push(entry.descriptor);
		if (entry.descriptor.disabledByZuse || !entry.descriptor.enabledInConfig) {
			statuses.push({
				key: entry.descriptor.key,
				name: entry.descriptor.name,
				source: entry.descriptor.source,
				state: "disabled",
				toolCount: null,
				toolNames: [],
				error: null,
				authMethod: null,
				requirements: [...entry.requirements],
				checkedAt: options.now,
			});
			continue;
		}
		const live = liveByName.get(entry.descriptor.name);
		if (live === undefined) {
			statuses.push({
				key: entry.descriptor.key,
				name: entry.descriptor.name,
				source: entry.descriptor.source,
				state: "error",
				toolCount: null,
				toolNames: [],
				error: "Codex did not report this server (it may have failed to start)",
				authMethod: null,
				requirements: [...entry.requirements],
				checkedAt: options.now,
			});
			continue;
		}
		statuses.push(
			statusFromLive({
				descriptor: entry.descriptor,
				authStatus: live.authStatus,
				tools: live.tools,
				requirements: entry.requirements,
				now: options.now,
			}),
		);
	}

	const aggregate = liveByName.get("codex_apps");
	for (const live of options.live.statuses) {
		if (
			configuredNames.has(live.name) ||
			options.excludedNames.has(live.name) ||
			live.name === "codex_apps"
		) {
			continue;
		}
		const descriptor = providerDescriptor(
			live.name,
			live.authStatus === "notLoggedIn" ? "native-oauth" : null,
		);
		descriptors.push(descriptor);
		statuses.push(
			statusFromLive({
				descriptor,
				authStatus: live.authStatus,
				tools: live.tools,
				requirements: [],
				now: options.now,
			}),
		);
	}
	for (const pluginServer of options.live.pluginServers) {
		if (
			configuredNames.has(pluginServer.name) ||
			liveByName.has(pluginServer.name) ||
			options.excludedNames.has(pluginServer.name)
		) {
			continue;
		}
		const descriptor = providerDescriptor(pluginServer.name, null);
		descriptors.push(descriptor);
		statuses.push({
			key: descriptor.key,
			name: descriptor.name,
			source: descriptor.source,
			state: "error",
			toolCount: null,
			toolNames: [],
			error: `${pluginServer.pluginName} did not report this MCP server`,
			authMethod: null,
			requirements: [],
			checkedAt: options.now,
		});
	}

	const groupedTools = new Map(
		groupCodexAppTools(aggregate?.tools ?? {}).map((group) => [
			group.id,
			group,
		]),
	);
	const connectorIds = new Set([
		...options.live.connectors.map((connector) => connector.id),
		...groupedTools.keys(),
	]);
	if (aggregate !== undefined || connectorIds.size > 0) {
		const groupDescriptor = appGroupDescriptor();
		descriptors.push(groupDescriptor);
		statuses.push(
			aggregate === undefined
				? {
						key: groupDescriptor.key,
						name: groupDescriptor.name,
						source: groupDescriptor.source,
						state: "connected",
						toolCount: 0,
						toolNames: [],
						error: null,
						authMethod: null,
						requirements: [],
						checkedAt: options.now,
					}
				: statusFromLive({
						descriptor: groupDescriptor,
						authStatus: aggregate.authStatus,
						tools: aggregate.tools,
						requirements: [],
						now: options.now,
					}),
		);
	}

	for (const id of connectorIds) {
		const connector = options.live.connectors.find((item) => item.id === id);
		const tools = groupedTools.get(id);
		const descriptor: McpServerDescriptor = {
			key: `codex-app:${id}`,
			name: connector?.name ?? tools?.name ?? id,
			source: "codex-app",
			kind: "app",
			parentKey: APPS_GROUP_KEY,
			availableProviders: ["codex"],
			transport: null,
			command: null,
			args: [],
			url: null,
			envVarNames: [],
			enabledInConfig: connector?.isEnabled ?? true,
			disabledByZuse: false,
			toggleSupported: connector !== undefined,
			authenticationAction:
				connector?.needsAuth === true && connector.installUrl !== null
					? "open-url"
					: null,
			manageUrl: connector?.installUrl ?? null,
		};
		descriptors.push(descriptor);
		const needsAuth = connector?.needsAuth === true;
		const enabled = connector?.isEnabled ?? true;
		statuses.push({
			key: descriptor.key,
			name: descriptor.name,
			source: descriptor.source,
			state: !enabled ? "disabled" : needsAuth ? "needs-auth" : "connected",
			toolCount: enabled && !needsAuth ? (tools?.toolNames.length ?? 0) : null,
			toolNames: [...(tools?.toolNames ?? [])],
			error: null,
			authMethod: needsAuth ? "oauth" : null,
			requirements: needsAuth
				? [{ kind: "auth", detail: "sign-in required", satisfied: false }]
				: [],
			checkedAt: options.now,
		});
	}

	return { descriptors, statuses };
};
