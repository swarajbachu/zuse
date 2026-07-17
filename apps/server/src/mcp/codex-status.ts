import type { AppInfo } from "@zuse/agents/codex-generated/v2/AppInfo";
import type { AppsListResponse } from "@zuse/agents/codex-generated/v2/AppsListResponse";
import type { ListMcpServerStatusResponse } from "@zuse/agents/codex-generated/v2/ListMcpServerStatusResponse";
import type { McpServerOauthLoginResponse } from "@zuse/agents/codex-generated/v2/McpServerOauthLoginResponse";
import type { McpServerStatus as CodexMcpServerStatus } from "@zuse/agents/codex-generated/v2/McpServerStatus";
import type { PluginDetail } from "@zuse/agents/codex-generated/v2/PluginDetail";
import type { PluginListResponse } from "@zuse/agents/codex-generated/v2/PluginListResponse";
import type { PluginReadResponse } from "@zuse/agents/codex-generated/v2/PluginReadResponse";
import { CodexAppServerClient } from "@zuse/agents/drivers/codex-app-server-client";
import { Effect } from "effect";

export interface CodexConnectorSnapshot {
	readonly id: string;
	readonly name: string;
	readonly installUrl: string | null;
	readonly isAccessible: boolean;
	readonly isEnabled: boolean;
	readonly needsAuth: boolean;
}

export interface CodexPluginMcpSnapshot {
	readonly name: string;
	readonly pluginName: string;
}

export interface CodexLiveMcpSnapshot {
	readonly statuses: ReadonlyArray<CodexMcpServerStatus>;
	readonly connectors: ReadonlyArray<CodexConnectorSnapshot>;
	readonly pluginServers: ReadonlyArray<CodexPluginMcpSnapshot>;
}

/**
 * Short-lived `codex app-server` used when no Codex session is running:
 * status listing, the enabled toggle, and the native OAuth login all go
 * through the provider itself so config semantics, live inventory, and token
 * storage remain native to that provider.
 */
const withCodexApp = <A>(
	codexPath: string | null,
	run: (app: CodexAppServerClient) => Promise<A>,
	options?: {
		readonly onNotification?: (notification: {
			method: string;
			params?: unknown;
		}) => void;
	},
): Effect.Effect<A, Error> =>
	Effect.tryPromise({
		try: async () => {
			const app = await CodexAppServerClient.start({
				codexPath,
				startupTimeoutMs: 20_000,
				onNotification: (notification) =>
					options?.onNotification?.(
						notification as { method: string; params?: unknown },
					),
				// Nothing interactive runs in these one-shot calls; deny-by-noop
				// keeps a stray server request from wedging the child.
				onServerRequest: (_request, respond) => respond({}),
			});
			try {
				return await run(app);
			} finally {
				app.close();
			}
		},
		catch: (cause) =>
			cause instanceof Error ? cause : new Error(String(cause)),
	});

const listMcpStatuses = async (
	app: CodexAppServerClient,
): Promise<ReadonlyArray<CodexMcpServerStatus>> => {
	const out: CodexMcpServerStatus[] = [];
	let cursor: string | null = null;
	do {
		const page: ListMcpServerStatusResponse =
			await app.request<ListMcpServerStatusResponse>("mcpServerStatus/list", {
				detail: "toolsAndAuthOnly",
				cursor,
			});
		out.push(...page.data);
		cursor = page.nextCursor;
	} while (cursor !== null);
	return out;
};

const readInstalledPluginDetails = async (
	app: CodexAppServerClient,
	cwd: string | null,
): Promise<ReadonlyArray<PluginDetail>> => {
	let response: PluginListResponse;
	try {
		response = await app.request<PluginListResponse>("plugin/list", {
			cwds: cwd === null ? null : [cwd],
		});
	} catch {
		return [];
	}
	const installed = response.marketplaces.flatMap((marketplace) =>
		marketplace.plugins
			.filter((plugin) => plugin.installed && plugin.enabled)
			.map((plugin) => ({ marketplace, plugin })),
	);
	const details = await Promise.all(
		installed.map(async ({ marketplace, plugin }) => {
			try {
				const response = await app.request<PluginReadResponse>("plugin/read", {
					marketplacePath: marketplace.path,
					remoteMarketplaceName:
						marketplace.path === null ? marketplace.name : null,
					pluginName: plugin.name,
				});
				return response.plugin;
			} catch {
				// A remote catalog can disappear between list/read. The MCP status
				// response still discovers its running servers, so omit only the
				// optional ownership/app metadata.
				return null;
			}
		}),
	);
	return details.filter((detail): detail is PluginDetail => detail !== null);
};

export const reconcileCodexConnectors = (
	apps: ReadonlyArray<AppInfo>,
	plugins: ReadonlyArray<PluginDetail>,
): ReadonlyArray<CodexConnectorSnapshot> => {
	const installed = new Map(
		plugins.flatMap((plugin) =>
			plugin.apps.map((app) => [app.id, app] as const),
		),
	);
	const connectors = new Map<string, CodexConnectorSnapshot>();
	for (const app of apps) {
		const pluginApp = installed.get(app.id);
		if (!app.isAccessible && pluginApp === undefined) continue;
		connectors.set(app.id, {
			id: app.id,
			name: app.name,
			installUrl: app.installUrl ?? pluginApp?.installUrl ?? null,
			isAccessible: app.isAccessible,
			isEnabled: app.isEnabled,
			needsAuth: !app.isAccessible,
		});
	}
	for (const app of installed.values()) {
		if (connectors.has(app.id)) continue;
		connectors.set(app.id, {
			id: app.id,
			name: app.name,
			installUrl: app.installUrl,
			isAccessible: !app.needsAuth,
			isEnabled: true,
			needsAuth: app.needsAuth,
		});
	}
	return [...connectors.values()];
};

/**
 * Reads every provider-owned MCP source through one app-server process. The
 * app catalog request is intentionally limited to its prioritized first page:
 * linked apps are returned first, while installed-but-unlinked apps are added
 * from plugin metadata. This avoids treating the full marketplace as an MCP
 * inventory.
 */
export const readCodexLiveMcpSnapshot = (
	codexPath: string | null,
	cwd: string | null,
): Effect.Effect<CodexLiveMcpSnapshot, Error> =>
	withCodexApp(codexPath, async (app) => {
		const [statuses, apps, plugins] = await Promise.all([
			listMcpStatuses(app),
			app
				.request<AppsListResponse>("app/list", {
					limit: 200,
					forceRefetch: false,
				})
				.then(
					(page) => page.data,
					() => [],
				),
			readInstalledPluginDetails(app, cwd),
		]);
		return {
			statuses,
			connectors: reconcileCodexConnectors(apps, plugins),
			pluginServers: plugins.flatMap((plugin) =>
				plugin.mcpServers.map((name) => ({
					name,
					pluginName: plugin.summary.name,
				})),
			),
		};
	});

export const listCodexMcpStatus = (
	codexPath: string | null,
): Effect.Effect<ReadonlyArray<CodexMcpServerStatus>, Error> =>
	readCodexLiveMcpSnapshot(codexPath, null).pipe(
		Effect.map((snapshot) => snapshot.statuses),
	);

/**
 * Writes the native `enabled` flag. This intentionally persists into the
 * user's `~/.codex/config.toml` — toggling a codex-source server in Zuse
 * toggles it for Codex everywhere, which is the documented semantics of a
 * native-config passthrough.
 */
export const setCodexMcpEnabled = (
	codexPath: string | null,
	serverName: string,
	enabled: boolean,
): Effect.Effect<void, Error> =>
	withCodexApp(codexPath, async (app) => {
		await app.request("config/value/write", {
			keyPath: `mcp_servers.${JSON.stringify(serverName)}.enabled`,
			value: enabled,
			mergeStrategy: "replace",
		});
		await app.request("config/mcpServer/reload", undefined);
	});

export const setCodexAppEnabled = (
	codexPath: string | null,
	appId: string,
	enabled: boolean,
): Effect.Effect<void, Error> =>
	withCodexApp(codexPath, async (app) => {
		await app.request("config/value/write", {
			keyPath: `apps.${JSON.stringify(appId)}.enabled`,
			value: enabled,
			mergeStrategy: "replace",
		});
	});

export interface CodexOauthLoginProgress {
	readonly onAuthorizationUrl: (url: string) => void;
}

/**
 * Codex-native OAuth login. Codex runs discovery/registration/PKCE and its
 * own loopback listener; we surface the authorization URL (the renderer
 * opens the browser) and resolve when `mcpServer/oauthLogin/completed`
 * arrives for this server.
 */
export const codexMcpOauthLogin = (
	codexPath: string | null,
	serverName: string,
	progress: CodexOauthLoginProgress,
): Effect.Effect<{ success: boolean; error: string | null }, Error> => {
	let completed: { success: boolean; error: string | null } | null = null;
	let notifyCompleted: (() => void) | null = null;
	return withCodexApp(
		codexPath,
		async (app) => {
			const done = new Promise<void>((resolve) => {
				notifyCompleted = resolve;
				if (completed !== null) resolve();
			});
			const login = await app.request<McpServerOauthLoginResponse>(
				"mcpServer/oauth/login",
				{ name: serverName, timeoutSecs: 300 },
			);
			progress.onAuthorizationUrl(login.authorizationUrl);
			await done;
			return completed ?? { success: false, error: "login did not complete" };
		},
		{
			onNotification: (notification) => {
				if (notification.method !== "mcpServer/oauthLogin/completed") return;
				const params = notification.params as {
					name?: string;
					success?: boolean;
					error?: string;
				};
				if (params.name !== serverName) return;
				completed = {
					success: params.success === true,
					error: params.error ?? null,
				};
				notifyCompleted?.();
			},
		},
	);
};
