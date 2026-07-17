import { BROWSER_MCP_TOOLS } from "@zuse/agents/drivers/browser-mcp-tools";
import {
	ORCHESTRATION_MCP_SERVER_NAME,
	ORCHESTRATION_MCP_TOOLS,
} from "@zuse/agents/drivers/orchestration-tools";
import { probeMcpServer } from "@zuse/agents/user-mcp/probe";
import type { ResolvedMcpServer } from "@zuse/agents/user-mcp/types";
import {
	type FolderId,
	type McpAuthenticateEvent,
	McpConfigError,
	type McpRequirement,
	type McpServerDescriptor,
	type McpServerStatus,
	type ProviderId,
} from "@zuse/contracts";
import { type Cause, Effect, Layer, Queue, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { SqlClient } from "effect/unstable/sql";

import { ConfigStoreService } from "../../config-store/services/config-store-service.ts";
import { resolveCliPath } from "../../provider/availability.ts";
import { CredentialsService } from "../../provider/services/credentials-service.ts";
import { RepositorySettingsService } from "../../repository-settings/services/repository-settings-service.ts";
import {
	type ClaudeManagedInventory,
	claudeMcpLogin,
	readClaudeLiveMcpSnapshot,
	readClaudeManagedMcpEntries,
	reconcileClaudeManagedInventory,
} from "../claude-status.ts";
import {
	type ReconciledCodexInventory,
	reconcileCodexInventory,
} from "../codex-inventory.ts";
import {
	codexMcpOauthLogin,
	readCodexLiveMcpSnapshot,
	setCodexAppEnabled,
	setCodexMcpEnabled,
} from "../codex-status.ts";
import { getValidMcpAccessToken, runMcpOauthFlow } from "../mcp-oauth.ts";
import {
	expandEnvRefs,
	type NativeMcpServer,
	readNativeServers,
} from "../native-config.ts";
import { type McpScope, McpService } from "../services/mcp-service.ts";

const BUILTIN_ZUSE = "zuse";
/** Codex config.toml entries the Codex driver writes for Zuse's gateway. */
const RESERVED_CODEX_NAMES = [BUILTIN_ZUSE, ORCHESTRATION_MCP_SERVER_NAME];

const keyFor = (server: NativeMcpServer): string =>
	server.source === "codex" ? `codex:${server.name}` : `claude:${server.name}`;

const toDescriptor = (
	server: NativeMcpServer,
	disabledKeys: ReadonlySet<string>,
): McpServerDescriptor => ({
	key: keyFor(server),
	name: server.name,
	source: server.source,
	kind: "configured",
	parentKey: null,
	availableProviders: [server.source === "codex" ? "codex" : "claude"],
	transport: server.transport,
	command: server.command,
	args: server.args,
	url: server.url,
	envVarNames: server.envVarNames,
	enabledInConfig: server.enabledInConfig,
	disabledByZuse: disabledKeys.has(keyFor(server)),
	toggleSupported: true,
	authenticationAction: server.transport === "stdio" ? null : "native-oauth",
	manageUrl: null,
});

const builtinDescriptor = (name: string): McpServerDescriptor => ({
	key: `builtin:${name}`,
	name,
	source: "builtin",
	kind: "builtin",
	parentKey: null,
	availableProviders: [
		"claude",
		"codex",
		"grok",
		"gemini",
		"cursor",
		"opencode",
	],
	transport: "http",
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

const builtinStatus = (
	name: string,
	toolNames: ReadonlyArray<string>,
): McpServerStatus => ({
	key: `builtin:${name}`,
	name,
	source: "builtin",
	state: "connected",
	toolCount: toolNames.length,
	toolNames,
	error: null,
	authMethod: null,
	requirements: [],
	checkedAt: 0,
});

const BUILTIN_DESCRIPTORS: ReadonlyArray<McpServerDescriptor> = [
	builtinDescriptor(BUILTIN_ZUSE),
	builtinDescriptor(ORCHESTRATION_MCP_SERVER_NAME),
];

const BUILTIN_STATUSES: ReadonlyArray<McpServerStatus> = [
	builtinStatus(BUILTIN_ZUSE, [
		"ask_user_question",
		...BROWSER_MCP_TOOLS.map((tool) => tool.name),
	]),
	builtinStatus(
		ORCHESTRATION_MCP_SERVER_NAME,
		ORCHESTRATION_MCP_TOOLS.map((tool) => tool.name),
	),
];

const placeholderStatus = (
	descriptor: McpServerDescriptor,
	state: "connecting" | "disabled",
): McpServerStatus => ({
	key: descriptor.key,
	name: descriptor.name,
	source: descriptor.source,
	state,
	toolCount: null,
	toolNames: [],
	error: null,
	authMethod: null,
	requirements: [],
	checkedAt: 0,
});

const envRequirements = (server: NativeMcpServer): McpRequirement[] => {
	const requirements: McpRequirement[] = [];
	for (const name of server.envVarNames) {
		requirements.push({
			kind: "env",
			detail: `environment variable ${name}`,
			satisfied:
				server.env[name] !== undefined || process.env[name] !== undefined,
		});
	}
	if (server.bearerTokenEnvVar !== null) {
		requirements.push({
			kind: "env",
			detail: `environment variable ${server.bearerTokenEnvVar}`,
			satisfied: process.env[server.bearerTokenEnvVar] !== undefined,
		});
	}
	return requirements;
};

const expandRecord = (
	record: Readonly<Record<string, string>>,
	localEnv: Readonly<Record<string, string>>,
): Record<string, string> =>
	Object.fromEntries(
		Object.entries(record).map(([k, v]) => [k, expandEnvRefs(v, localEnv)]),
	);

/** Env-expand a native entry and inject a held OAuth token, if any. */
const resolveServer = (
	server: NativeMcpServer,
	accessToken: string | null,
): ResolvedMcpServer => {
	const expand = (text: string): string => expandEnvRefs(text, server.env);
	if (server.transport === "stdio") {
		return {
			name: server.name,
			transport: "stdio",
			command: expand(server.command ?? ""),
			args: server.args.map(expand),
			env: expandRecord(server.env, server.env),
		};
	}
	const headers = expandRecord(server.headers, server.env);
	if (accessToken !== null && headers.Authorization === undefined) {
		headers.Authorization = `Bearer ${accessToken}`;
	}
	return {
		name: server.name,
		transport: server.transport,
		url: expand(server.url ?? ""),
		headers,
	};
};

export const McpServiceLive = Layer.effect(
	McpService,
	Effect.gen(function* () {
		const configStore = yield* ConfigStoreService;
		const repositorySettings = yield* RepositorySettingsService;
		const credentials = yield* CredentialsService;
		const sql = yield* SqlClient.SqlClient;
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

		// Provider inventories and statuses stay cached until an explicit refresh
		// or a mutation invalidates them. Normal popover polling is read-only.
		const statusCache = new Map<string, McpServerStatus>();
		const claudeInventoryCache = new Map<string, ClaudeManagedInventory>();
		const codexInventoryCache = new Map<string, ReconciledCodexInventory>();
		const inventoryCacheKey = (cwd: string | null): string => cwd ?? "<global>";

		const codexPath = (): Effect.Effect<string | null> =>
			resolveCliPath("codex").pipe(
				Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
			);
		const claudePath = (): Effect.Effect<string | null> =>
			resolveCliPath("claude").pipe(
				Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
			);

		const projectPath = (projectId: FolderId): Effect.Effect<string | null> =>
			Effect.gen(function* () {
				const rows = yield* sql<{ readonly path: string }>`
					SELECT path FROM projects WHERE id = ${projectId} LIMIT 1
				`.pipe(Effect.orDie);
				return rows[0]?.path ?? null;
			});

		const oauthStore = (key: string) => ({
			load: () =>
				Effect.runPromise(
					credentials
						.getMcpOauth(key)
						.pipe(Effect.catch(() => Effect.succeed(null))),
				),
			save: (bundleJson: string) =>
				Effect.runPromise(
					credentials
						.setMcpOauth(key, bundleJson)
						.pipe(Effect.catch(() => Effect.void)),
				),
		});

		interface Inventory {
			readonly cwd: string | null;
			readonly native: ReadonlyArray<NativeMcpServer>;
			readonly disabledKeys: ReadonlySet<string>;
			readonly descriptors: ReadonlyArray<McpServerDescriptor>;
			readonly includeClaudeLive: boolean;
			readonly claudeManaged: ClaudeManagedInventory;
			readonly includeCodexLive: boolean;
		}

		const sourcesMatch = (
			server: NativeMcpServer,
			provider: ProviderId | undefined,
		): boolean =>
			provider === undefined ||
			(provider === "codex"
				? server.source === "codex"
				: provider === "claude"
					? server.source !== "codex"
					: false);

		const inventoryFor = (scope: McpScope): Effect.Effect<Inventory> =>
			Effect.gen(function* () {
				const cwd =
					scope.projectId === undefined
						? null
						: yield* projectPath(scope.projectId);
				const settings = yield* configStore.getSettings().pipe(Effect.orDie);
				const repoDisabled =
					scope.projectId === undefined
						? []
						: (yield* repositorySettings
								.get(scope.projectId)
								.pipe(Effect.orDie)).mcpDisabledServers;
				const disabledKeys = new Set([
					...settings.mcpDisabledServers,
					...repoDisabled,
				]);
				const native = yield* Effect.sync(() =>
					readNativeServers({
						cwd,
						excludeCodexNames: RESERVED_CODEX_NAMES,
					}),
				).pipe(
					Effect.map((servers) =>
						servers.filter((server) => sourcesMatch(server, scope.provider)),
					),
				);
				const configuredDescriptors = native.map((server) =>
					toDescriptor(server, disabledKeys),
				);
				const configuredKeys = new Set(
					configuredDescriptors.map((descriptor) => descriptor.key),
				);
				const includeClaudeLive =
					scope.provider === undefined || scope.provider === "claude";
				const configuredClaude = configuredDescriptors.filter((descriptor) =>
					descriptor.source.startsWith("claude-"),
				);
				const claudeManaged = includeClaudeLive
					? (claudeInventoryCache.get(inventoryCacheKey(cwd)) ??
						reconcileClaudeManagedInventory({
							configured: configuredClaude,
							entries: readClaudeManagedMcpEntries(),
						}))
					: { descriptors: [], statuses: [] };
				const includeCodexLive =
					scope.provider === undefined || scope.provider === "codex";
				const liveDescriptors = includeCodexLive
					? (
							codexInventoryCache.get(inventoryCacheKey(cwd))?.descriptors ?? []
						).filter((descriptor) => !configuredKeys.has(descriptor.key))
					: [];
				return {
					cwd,
					native,
					disabledKeys,
					descriptors: [
						...BUILTIN_DESCRIPTORS,
						...configuredDescriptors,
						...claudeManaged.descriptors.filter(
							(descriptor) => !configuredKeys.has(descriptor.key),
						),
						...liveDescriptors,
					],
					includeClaudeLive,
					claudeManaged,
					includeCodexLive,
				};
			});

		const claudeProbeStatus = (
			server: NativeMcpServer,
		): Effect.Effect<McpServerStatus> =>
			Effect.gen(function* () {
				const key = keyFor(server);
				const token =
					server.transport === "stdio" || server.url === null
						? null
						: yield* getValidMcpAccessToken({
								serverUrl: expandEnvRefs(server.url, server.env),
								store: oauthStore(key),
							});
				const probe = yield* probeMcpServer(resolveServer(server, token));
				const requirements = envRequirements(server);
				if (probe.state === "needs-auth") {
					requirements.push({
						kind: "auth",
						detail:
							probe.authMethod === "token"
								? "access token required"
								: "sign-in required",
						satisfied: false,
					});
				}
				if (probe.error?.startsWith("command not found") === true) {
					requirements.push({
						kind: "command",
						detail: server.command ?? "",
						satisfied: false,
					});
				}
				return {
					key,
					name: server.name,
					source: server.source,
					state: probe.state,
					toolCount:
						probe.state === "connected" ? probe.toolNames.length : null,
					toolNames: probe.toolNames,
					error: probe.error,
					authMethod: probe.authMethod,
					requirements,
					checkedAt: Date.now(),
				};
			});

		const codexInventoryStatuses = (
			servers: ReadonlyArray<NativeMcpServer>,
			inventory: Inventory,
		): Effect.Effect<ReconciledCodexInventory> =>
			Effect.gen(function* () {
				const path = yield* codexPath();
				const live = yield* readCodexLiveMcpSnapshot(path, inventory.cwd).pipe(
					Effect.catch((cause) => Effect.succeed(cause)),
				);
				const now = Date.now();
				const configured = servers.map((server) => ({
					descriptor: toDescriptor(server, inventory.disabledKeys),
					requirements: envRequirements(server),
				}));
				if (live instanceof Error) {
					return {
						descriptors: configured.map((entry) => entry.descriptor),
						statuses: configured.map(
							(entry): McpServerStatus => ({
								key: entry.descriptor.key,
								name: entry.descriptor.name,
								source: entry.descriptor.source,
								state:
									entry.descriptor.disabledByZuse ||
									!entry.descriptor.enabledInConfig
										? "disabled"
										: "error",
								toolCount: null,
								toolNames: [],
								error:
									entry.descriptor.disabledByZuse ||
									!entry.descriptor.enabledInConfig
										? null
										: `could not query Codex: ${live.message}`,
								authMethod: null,
								requirements: [...entry.requirements],
								checkedAt: now,
							}),
						),
					};
				}
				return reconcileCodexInventory({
					configured,
					live,
					excludedNames: new Set(RESERVED_CODEX_NAMES),
					now,
				});
			});

		const refreshStatuses = (
			inventory: Inventory,
		): Effect.Effect<McpServerStatus[]> =>
			Effect.gen(function* () {
				const activeClaude: NativeMcpServer[] = [];
				const results: McpServerStatus[] = [];
				for (const server of inventory.native.filter(
					(server) => server.source !== "codex",
				)) {
					const key = keyFor(server);
					if (inventory.disabledKeys.has(key) || !server.enabledInConfig) {
						const descriptor = toDescriptor(server, inventory.disabledKeys);
						results.push(placeholderStatus(descriptor, "disabled"));
					} else {
						activeClaude.push(server);
					}
				}
				const claudeStatuses = yield* Effect.forEach(
					activeClaude,
					claudeProbeStatus,
					{ concurrency: 4 },
				);
				const configuredClaude = inventory.descriptors.filter(
					(descriptor) =>
						descriptor.kind === "configured" &&
						descriptor.source.startsWith("claude-"),
				);
				const claudeManaged = inventory.includeClaudeLive
					? yield* Effect.gen(function* () {
							const path = yield* claudePath();
							const entries = yield* readClaudeLiveMcpSnapshot(
								path,
								inventory.cwd,
							).pipe(
								Effect.catch(() =>
									Effect.sync(() => {
										const now = Date.now();
										return readClaudeManagedMcpEntries().map((entry) => ({
											...entry,
											checkedAt: now,
										}));
									}),
								),
							);
							return reconcileClaudeManagedInventory({
								configured: configuredClaude,
								entries,
							});
						})
					: { descriptors: [], statuses: [] };
				if (inventory.includeClaudeLive) {
					claudeInventoryCache.set(
						inventoryCacheKey(inventory.cwd),
						claudeManaged,
					);
				}
				const codexServers = inventory.native.filter(
					(server) => server.source === "codex",
				);
				const codexInventory = inventory.includeCodexLive
					? yield* codexInventoryStatuses(codexServers, inventory)
					: { descriptors: [], statuses: [] };
				if (inventory.includeCodexLive) {
					codexInventoryCache.set(
						inventoryCacheKey(inventory.cwd),
						codexInventory,
					);
				}
				results.push(
					...claudeStatuses,
					...claudeManaged.statuses,
					...codexInventory.statuses,
				);
				const deduplicated = [
					...new Map(results.map((status) => [status.key, status])).values(),
				];
				for (const status of deduplicated) statusCache.set(status.key, status);
				return deduplicated;
			});

		const statusesFromCache = (inventory: Inventory): McpServerStatus[] =>
			inventory.descriptors.map((descriptor) => {
				if (descriptor.source === "builtin") {
					return (
						BUILTIN_STATUSES.find((status) => status.key === descriptor.key) ??
						placeholderStatus(descriptor, "connecting")
					);
				}
				if (descriptor.disabledByZuse || !descriptor.enabledInConfig) {
					return placeholderStatus(descriptor, "disabled");
				}
				const cached = statusCache.get(descriptor.key);
				const managed = inventory.claudeManaged.statuses.find(
					(status) => status.key === descriptor.key,
				);
				return cached !== undefined && cached.state !== "disabled"
					? cached
					: (managed ?? placeholderStatus(descriptor, "connecting"));
			});

		const list: McpService["Service"]["list"] = (scope) =>
			Effect.gen(function* () {
				let inventory = yield* inventoryFor(scope);
				const needsInitialDiscovery =
					(inventory.includeClaudeLive &&
						!claudeInventoryCache.has(inventoryCacheKey(inventory.cwd))) ||
					(inventory.includeCodexLive &&
						!codexInventoryCache.has(inventoryCacheKey(inventory.cwd)));
				if (needsInitialDiscovery) {
					yield* refreshStatuses(inventory);
					inventory = yield* inventoryFor(scope);
				}
				return {
					servers: inventory.descriptors,
					statuses: statusesFromCache(inventory),
				};
			});

		const refresh: McpService["Service"]["refresh"] = (scope) =>
			Effect.gen(function* () {
				const inventory = yield* inventoryFor(scope);
				yield* refreshStatuses(inventory);
				const latest = yield* inventoryFor(scope);
				return {
					servers: latest.descriptors,
					statuses: statusesFromCache(latest),
				};
			});

		const setEnabled: McpService["Service"]["setEnabled"] = (
			key,
			enabled,
			projectId,
		) =>
			Effect.gen(function* () {
				if (key.startsWith("builtin:")) {
					return yield* Effect.fail(
						new McpConfigError({
							key,
							reason: "built-in servers cannot be toggled",
						}),
					);
				}
				if (key.startsWith("codex-app:")) {
					const path = yield* codexPath();
					yield* setCodexAppEnabled(
						path,
						key.slice("codex-app:".length),
						enabled,
					).pipe(
						Effect.mapError(
							(cause) => new McpConfigError({ key, reason: cause.message }),
						),
					);
					codexInventoryCache.clear();
					statusCache.delete(key);
					return;
				}
				if (key.startsWith("codex-live:") || key.startsWith("codex-apps:")) {
					return yield* Effect.fail(
						new McpConfigError({
							key,
							reason: "this provider-managed entry cannot be toggled directly",
						}),
					);
				}
				if (key.startsWith("codex:")) {
					// Codex owns its config — write the native `enabled` flag (this
					// affects Codex everywhere, including outside Zuse; per-repo
					// scoping is a claude-source-only concept).
					const path = yield* codexPath();
					yield* setCodexMcpEnabled(
						path,
						key.slice("codex:".length),
						enabled,
					).pipe(
						Effect.mapError(
							(cause) => new McpConfigError({ key, reason: cause.message }),
						),
					);
					codexInventoryCache.clear();
					statusCache.delete(key);
					return;
				}
				const toggle = (current: ReadonlyArray<string>): string[] =>
					enabled
						? current.filter((k) => k !== key)
						: current.includes(key)
							? [...current]
							: [...current, key];
				if (projectId === undefined) {
					const settings = yield* configStore.getSettings().pipe(Effect.orDie);
					yield* configStore
						.updateSettings({
							mcpDisabledServers: toggle(settings.mcpDisabledServers),
						})
						.pipe(Effect.orDie);
				} else {
					const settings = yield* repositorySettings
						.get(projectId)
						.pipe(Effect.orDie);
					yield* repositorySettings
						.update(projectId, {
							mcpDisabledServers: toggle(settings.mcpDisabledServers),
						})
						.pipe(Effect.orDie);
				}
			});

		const authenticate: McpService["Service"]["authenticate"] = (
			key,
			projectId,
		) =>
			Stream.unwrap(
				Effect.gen(function* () {
					const events = yield* Queue.make<McpAuthenticateEvent, Cause.Done>();
					const emit = (event: McpAuthenticateEvent): void => {
						Queue.offerUnsafe(events, event);
					};
					const finish = (event: McpAuthenticateEvent): void => {
						emit(event);
						Queue.endUnsafe(events);
					};
					const inventory = yield* inventoryFor({ projectId });
					const descriptor = inventory.descriptors.find(
						(candidate) => candidate.key === key,
					);
					if (key.startsWith("codex-app:")) {
						if (
							descriptor?.authenticationAction !== "open-url" ||
							descriptor.manageUrl === null
						) {
							return yield* Effect.fail(
								new McpConfigError({
									key,
									reason: "this connector has no available sign-in URL",
								}),
							);
						}
						emit({ _tag: "browser-opened", url: descriptor.manageUrl });
						codexInventoryCache.clear();
						statusCache.delete(key);
						finish({ _tag: "completed" });
						return Stream.fromQueue(events);
					}
					if (key.startsWith("claude-live:")) {
						const serverName = key.slice("claude-live:".length);
						const flow = Effect.gen(function* () {
							const path = yield* claudePath();
							const outcome = yield* claudeMcpLogin(
								path,
								inventory.cwd,
								serverName,
								{
									onAuthorizationUrl: (url) => {
										emit({ _tag: "browser-opened", url });
									},
								},
							).pipe(
								Effect.catch((cause) =>
									Effect.succeed({ success: false, error: cause.message }),
								),
							);
							claudeInventoryCache.delete(inventoryCacheKey(inventory.cwd));
							statusCache.delete(key);
							finish(
								outcome.success
									? { _tag: "completed" }
									: {
											_tag: "failed",
											error: outcome.error ?? "sign-in did not complete",
										},
							);
						});
						yield* Effect.forkDetach(flow);
						return Stream.fromQueue(events);
					}
					const server = inventory.native.find(
						(candidate) => keyFor(candidate) === key,
					);
					const liveCodexName = key.startsWith("codex-live:")
						? key.slice("codex-live:".length)
						: null;
					if (server === undefined && liveCodexName === null) {
						return yield* Effect.fail(
							new McpConfigError({ key, reason: "unknown MCP server" }),
						);
					}
					const flow: Effect.Effect<void> = Effect.gen(function* () {
						if (server?.source === "codex" || liveCodexName !== null) {
							const path = yield* codexPath();
							const serverName = liveCodexName ?? server?.name ?? "";
							const outcome = yield* codexMcpOauthLogin(path, serverName, {
								onAuthorizationUrl: (url) =>
									emit({ _tag: "browser-opened", url }),
							}).pipe(
								Effect.catch((cause) =>
									Effect.succeed({
										success: false,
										error: cause.message,
									}),
								),
							);
							finish(
								outcome.success
									? { _tag: "completed" }
									: {
											_tag: "failed",
											error: outcome.error ?? "sign-in did not complete",
										},
							);
						} else if (
							server === undefined ||
							server.transport === "stdio" ||
							server.url === null
						) {
							finish({
								_tag: "failed",
								error:
									"stdio servers authenticate through their own env/config",
							});
						} else {
							const outcome = yield* runMcpOauthFlow({
								serverUrl: expandEnvRefs(server.url, server.env),
								store: oauthStore(key),
								onAuthorizationUrl: (url) => {
									emit({ _tag: "browser-opened", url });
								},
							}).pipe(
								Effect.as<Error | null>(null),
								Effect.catch((cause) => Effect.succeed(cause)),
							);
							finish(
								outcome === null
									? { _tag: "completed" }
									: { _tag: "failed", error: outcome.message },
							);
						}
						if (liveCodexName !== null || server?.source === "codex") {
							codexInventoryCache.clear();
						}
						statusCache.delete(key);
					});
					yield* Effect.forkDetach(flow);
					return Stream.fromQueue(events);
				}),
			);

		const resolveForClaudeSession: McpService["Service"]["resolveForClaudeSession"] =
			(cwd) =>
				Effect.gen(function* () {
					const settings = yield* configStore.getSettings();
					const native = readNativeServers({
						cwd,
						excludeCodexNames: RESERVED_CODEX_NAMES,
					}).filter(
						(server) =>
							server.source !== "codex" &&
							server.enabledInConfig &&
							!settings.mcpDisabledServers.includes(keyFor(server)),
					);
					// Per-repository disables also apply when the cwd maps to a known
					// project (worktrees resolve to the project's repo settings file
					// living in the checkout itself — read via the repo service when
					// a projectId is known; sessions pass cwd only, so match by path).
					const rows = yield* sql<{ readonly id: string }>`
						SELECT id FROM projects WHERE path = ${cwd} LIMIT 1
					`.pipe(Effect.catch(() => Effect.succeed([])));
					const projectId = rows[0]?.id as FolderId | undefined;
					const repoDisabled =
						projectId === undefined
							? new Set<string>()
							: new Set(
									(yield* repositorySettings
										.get(projectId)
										.pipe(
											Effect.catch(() =>
												Effect.succeed({ mcpDisabledServers: [] }),
											),
										)).mcpDisabledServers,
								);
					const resolved: ResolvedMcpServer[] = [];
					for (const server of native) {
						if (repoDisabled.has(keyFor(server))) continue;
						const token =
							server.transport === "stdio" || server.url === null
								? null
								: yield* getValidMcpAccessToken({
										serverUrl: expandEnvRefs(server.url, server.env),
										store: oauthStore(keyFor(server)),
									});
						resolved.push(resolveServer(server, token));
					}
					return resolved;
				}).pipe(Effect.catch(() => Effect.succeed([])));

		return {
			list,
			refresh,
			setEnabled,
			authenticate,
			resolveForClaudeSession,
		} as const;
	}),
);
