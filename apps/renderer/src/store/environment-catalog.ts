import {
	type Chat,
	type EnvironmentDescriptor,
	type Folder,
	type GitOriginInfo,
	type RelayConnectGrant,
	type RelayEnvironmentRecord,
	type RemoteEnvironmentProfile,
	type Session,
	type SshEnvironmentTarget,
	type TailnetEnvironmentConnection,
	type TailnetEnvironmentProfile,
	WIRE_PROTOCOL_VERSION,
} from "@zuse/contracts";
import { Effect, Fiber, Stream } from "effect";

import { createCatalogRetryController } from "../lib/catalog-retry.ts";
import { formatError } from "../lib/format-error.ts";
import { createInitializationGate } from "../lib/initialization-gate.ts";
import {
	getRpcClient,
	LOCAL_ENVIRONMENT_KEY,
	registerLocalEnvironment,
	registerRelayEnvironment,
	registerWebSocketEnvironment,
	removeRendererEnvironment,
	setActiveEnvironment,
	subscribeRendererRpcConnection,
} from "../lib/rpc-client.ts";
import { createAtomStore as create } from "../state/atom-store.ts";
import { useWorkspaceStore } from "./workspace.ts";

export type CatalogConnectionStatus =
	| "connecting"
	| "connected"
	| "offline"
	| "error";

export type EnvironmentCatalogEntry = {
	readonly connectionKind: "local" | "relay" | "ssh" | "tailnet";
	readonly environmentId: string;
	readonly profileId: string | null;
	readonly label: string;
	readonly target: SshEnvironmentTarget | null;
	readonly descriptor: EnvironmentDescriptor | null;
	readonly status: CatalogConnectionStatus;
	readonly error: string | null;
	readonly folders: ReadonlyArray<Folder>;
	/** Git origin per folder id (`null` = no origin / lookup failed). */
	readonly originsByFolder: Readonly<Record<string, GitOriginInfo | null>>;
	readonly chatsByProject: Readonly<Record<string, ReadonlyArray<Chat>>>;
	readonly sessionsByProject: Readonly<Record<string, ReadonlyArray<Session>>>;
};

export const orderEnvironmentCatalog = (
	entries: ReadonlyArray<EnvironmentCatalogEntry>,
): ReadonlyArray<EnvironmentCatalogEntry> =>
	[...entries].sort((left, right) => {
		if (left.connectionKind === "local") return -1;
		if (right.connectionKind === "local") return 1;
		if (left.status === "connected" && right.status !== "connected") return -1;
		if (right.status === "connected" && left.status !== "connected") return 1;
		return left.label.localeCompare(right.label);
	});

export const validateSshTarget = (
	target: SshEnvironmentTarget,
): string | null => {
	if (target.hostname.trim().length === 0)
		return "Enter a host name or address.";
	if (
		target.port !== null &&
		(!Number.isInteger(target.port) || target.port < 1 || target.port > 65_535)
	) {
		return "Port must be between 1 and 65535.";
	}
	return null;
};

type EnvironmentCatalogState = {
	readonly entries: ReadonlyArray<EnvironmentCatalogEntry>;
	readonly activeEnvironmentId: string;
	readonly initialized: boolean;
	readonly hiddenRelayEnvironmentIds: ReadonlyArray<string>;
	initialize: () => Promise<void>;
	syncAccountEnvironments: () => Promise<void>;
	add: (target: SshEnvironmentTarget, label?: string) => Promise<void>;
	/** Resolves with the connected computer's label once the link settles. */
	addTailnet: (pairingLink: string, label?: string) => Promise<string>;
	retry: (profileId: string) => Promise<void>;
	retryEnvironment: (environmentId: string) => Promise<void>;
	ensureEnvironmentConnected: (environmentId: string) => Promise<void>;
	refreshEnvironment: (environmentId: string) => Promise<void>;
	disconnect: (profileId: string) => Promise<void>;
	remove: (profileId: string) => Promise<void>;
	rename: (profileId: string, label: string) => Promise<void>;
	hideRelayEnvironment: (environmentId: string) => Promise<void>;
	unhideRelayEnvironments: () => Promise<void>;
	activate: (environmentId: string) => Promise<void>;
};

const HIDDEN_RELAY_STORAGE_KEY = "zuse.catalog.hiddenRelayEnvironments";

const readHiddenRelayEnvironmentIds = (): ReadonlyArray<string> => {
	try {
		const raw = window.localStorage.getItem(HIDDEN_RELAY_STORAGE_KEY);
		if (raw === null) return [];
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.filter((id): id is string => typeof id === "string")
			: [];
	} catch {
		return [];
	}
};

const writeHiddenRelayEnvironmentIds = (ids: ReadonlyArray<string>): void => {
	try {
		if (ids.length === 0) {
			window.localStorage.removeItem(HIDDEN_RELAY_STORAGE_KEY);
		} else {
			window.localStorage.setItem(
				HIDDEN_RELAY_STORAGE_KEY,
				JSON.stringify(ids),
			);
		}
	} catch {
		// Persisting hidden computers is best-effort.
	}
};

// Everything stored in `entry.error` is user-facing (project picker, sidebar
// notice, settings rows) — always humanize through the shared formatter.
const errorMessage = (cause: unknown): string => formatError(cause);

const profileEntry = (
	profile: RemoteEnvironmentProfile,
): EnvironmentCatalogEntry => ({
	connectionKind: "ssh",
	environmentId: profile.environmentId,
	profileId: profile.profileId,
	label: profile.label,
	target: profile.target,
	descriptor: null,
	status: "connecting",
	error: null,
	folders: [],
	originsByFolder: {},
	chatsByProject: {},
	sessionsByProject: {},
});

const tailnetProfileEntry = (
	profile: TailnetEnvironmentProfile,
): EnvironmentCatalogEntry => ({
	connectionKind: "tailnet",
	environmentId: profile.environmentId,
	profileId: profile.profileId,
	label: profile.label,
	target: null,
	descriptor: null,
	status: "connecting",
	error: null,
	folders: [],
	originsByFolder: {},
	chatsByProject: {},
	sessionsByProject: {},
});

const relayEntry = (
	environment: RelayEnvironmentRecord,
): EnvironmentCatalogEntry => ({
	connectionKind: "relay",
	environmentId: environment.environmentId,
	profileId: null,
	label: environment.label ?? "Unnamed computer",
	target: null,
	descriptor: null,
	status: "connecting",
	error: null,
	folders: [],
	originsByFolder: {},
	chatsByProject: {},
	sessionsByProject: {},
});

export const relayEnvironmentsNeedingConnection = (
	environments: ReadonlyArray<RelayEnvironmentRecord>,
	entries: ReadonlyArray<EnvironmentCatalogEntry>,
): ReadonlyArray<RelayEnvironmentRecord> =>
	environments.filter((environment) => {
		const entry = entries.find(
			(candidate) => candidate.environmentId === environment.environmentId,
		);
		return entry !== undefined && entry.status !== "connected";
	});

export const cloudConnectionFailure = (cause: unknown): Error => {
	const detail = errorMessage(cause);
	const normalized = detail.toLowerCase();
	if (/\b(401|403|auth|unauthori[sz]ed|forbidden)\b/u.test(normalized))
		return new Error(`Authentication failed: ${detail}`);
	if (/upgrade|unexpected response/u.test(normalized))
		return new Error(`WebSocket upgrade failed: ${detail}`);
	if (/handshake|protocol|wire version/u.test(normalized))
		return new Error(`Protocol handshake failed: ${detail}`);
	if (/timeout|timed out|network|socket|connect|unreachable/u.test(normalized))
		return new Error(`Endpoint reachability failed: ${detail}`);
	return new Error(`Secure connection failed: ${detail}`);
};

export const createConnectionAttemptCoordinator = () => {
	const attempts = new Map<string, Promise<void>>();
	const attemptIds = new Map<string, symbol>();
	return {
		run: (
			key: string,
			operation: (isCurrent: () => boolean) => Promise<void>,
			replace = false,
		): Promise<void> => {
			const current = attempts.get(key);
			if (!replace && current !== undefined) return current;
			const attemptId = Symbol(key);
			attemptIds.set(key, attemptId);
			const isCurrent = () => attemptIds.get(key) === attemptId;
			const attempt = operation(isCurrent).finally(() => {
				if (!isCurrent()) return;
				attempts.delete(key);
				attemptIds.delete(key);
			});
			attempts.set(key, attempt);
			return attempt;
		},
	};
};

const entryKey = (entry: EnvironmentCatalogEntry): string =>
	entry.connectionKind === "ssh" || entry.connectionKind === "tailnet"
		? `${entry.connectionKind}:${entry.profileId}`
		: `${entry.connectionKind}:${entry.environmentId}`;

const relayGrantUrl = (grant: RelayConnectGrant): string => {
	const url = new URL(grant.endpoint.wsBaseUrl);
	url.searchParams.set("token", grant.connectToken);
	url.searchParams.set("wireVersion", String(WIRE_PROTOCOL_VERSION));
	return url.toString();
};

const hydrateEntry = async (
	environmentId: string,
	previous?: Pick<EnvironmentCatalogEntry, "folders" | "originsByFolder">,
): Promise<
	Pick<
		EnvironmentCatalogEntry,
		"folders" | "originsByFolder" | "chatsByProject" | "sessionsByProject"
	>
> => {
	const client = await getRpcClient(environmentId);
	const folders = await Effect.runPromise(client["workspace.list"]({}));
	const pairs = await Promise.all(
		folders.map(async (folder) => {
			const [chats, sessions] = await Promise.all([
				Effect.runPromise(client["chat.list"]({ projectId: folder.id })),
				Effect.runPromise(client["session.list"]({ projectId: folder.id })),
			]);
			return [folder.id, chats, sessions] as const;
		}),
	);
	// Origins are effectively immutable per folder, so only re-fetch when the
	// folder id set changed — the 15s poller would otherwise issue one extra
	// RPC per folder per tick.
	const folderSetUnchanged =
		previous !== undefined &&
		previous.folders.length === folders.length &&
		folders.every((folder) =>
			previous.folders.some((candidate) => candidate.id === folder.id),
		);
	const originsByFolder = folderSetUnchanged
		? previous.originsByFolder
		: await (async () => {
				const results = await Promise.allSettled(
					folders.map((folder) =>
						Effect.runPromise(client["git.origin"]({ folderId: folder.id })),
					),
				);
				return Object.fromEntries(
					folders.map((folder, index) => {
						const result = results[index];
						return [
							folder.id,
							result?.status === "fulfilled" ? result.value : null,
						];
					}),
				);
			})();
	return {
		folders,
		originsByFolder,
		chatsByProject: Object.fromEntries(
			pairs.map(([projectId, chats]) => [projectId, chats]),
		),
		sessionsByProject: Object.fromEntries(
			pairs.map(([projectId, , sessions]) => [projectId, sessions]),
		),
	};
};

export const useEnvironmentCatalogStore = create<EnvironmentCatalogState>(
	(set, get) => {
		const recoverySubscriptions = new Map<string, () => void>();
		const relayRecords = new Map<string, RelayEnvironmentRecord>();
		const connectionAttempts = createConnectionAttemptCoordinator();
		const fallbackPollers = new Map<string, number>();
		const workspaceChangeFibers = new Map<
			string,
			Fiber.Fiber<unknown, unknown>
		>();
		const catalogPollsInFlight = new Set<string>();
		const stoppedRuntimes = new Set<string>();
		const initializeOnce = createInitializationGate();
		const automaticRetry = createCatalogRetryController((delayMs, run) => {
			const timer = window.setTimeout(run, delayMs);
			return () => window.clearTimeout(timer);
		});
		/**
		 * Previous folders + origins for an entry so `hydrateEntry` can skip
		 * re-resolving git origins when the folder set is unchanged.
		 */
		const previousCatalog = (
			catalogKey: string,
		):
			| Pick<EnvironmentCatalogEntry, "folders" | "originsByFolder">
			| undefined => {
			const entry = get().entries.find(
				(candidate) => entryKey(candidate) === catalogKey,
			);
			return entry === undefined
				? undefined
				: { folders: entry.folders, originsByFolder: entry.originsByFolder };
		};
		const patchEntry = (
			key: string,
			patch: Partial<EnvironmentCatalogEntry>,
		): void =>
			set((state) => ({
				entries: orderEnvironmentCatalog(
					state.entries.map((entry) =>
						entryKey(entry) === key ? { ...entry, ...patch } : entry,
					),
				),
			}));
		const stopFallbackPoller = (key: string): void => {
			const timer = fallbackPollers.get(key);
			if (timer !== undefined) window.clearTimeout(timer);
			fallbackPollers.delete(key);
		};
		const startFallbackPoller = (
			key: string,
			environmentId: string,
			catalogKey: string,
		): void => {
			if (fallbackPollers.has(key)) return;
			fallbackPollers.set(
				key,
				window.setTimeout(() => {
					fallbackPollers.delete(key);
					if (stoppedRuntimes.has(key)) return;
					if (workspaceChangeFibers.has(key)) return;
					if (catalogPollsInFlight.has(key)) {
						startFallbackPoller(key, environmentId, catalogKey);
						return;
					}
					catalogPollsInFlight.add(key);
					void hydrateEntry(environmentId, previousCatalog(catalogKey))
						.then((catalog) => patchEntry(catalogKey, catalog))
						.catch(() => undefined)
						.finally(() => {
							catalogPollsInFlight.delete(key);
							if (!stoppedRuntimes.has(key)) {
								startFallbackPoller(key, environmentId, catalogKey);
							}
						});
				}, 15_000),
			);
		};
		const startWorkspaceChangeStream = async (
			key: string,
			environmentId: string,
			catalogKey: string,
		): Promise<void> => {
			stoppedRuntimes.delete(key);
			const previous = workspaceChangeFibers.get(key);
			if (previous !== undefined) {
				await Effect.runPromise(Fiber.interrupt(previous)).catch(
					() => undefined,
				);
			}
			const client = await getRpcClient(environmentId).catch(() => null);
			if (client === null) {
				startFallbackPoller(key, environmentId, catalogKey);
				return;
			}
			stopFallbackPoller(key);
			const program = Stream.runForEach(
				client["workspace.streamChanges"]({}),
				(folders) =>
					Effect.tryPromise({
						try: async () => {
							if (get().activeEnvironmentId === environmentId) {
								useWorkspaceStore.setState((workspace) => ({
									folders,
									selectedFolderId:
										workspace.selectedFolderId !== null &&
										folders.some(
											(folder) => folder.id === workspace.selectedFolderId,
										)
											? workspace.selectedFolderId
											: (folders[0]?.id ?? null),
								}));
							}
							const catalog = await hydrateEntry(
								environmentId,
								previousCatalog(catalogKey),
							);
							patchEntry(catalogKey, catalog);
						},
						catch: () => undefined,
					}).pipe(Effect.ignore),
			);
			const fiber = Effect.runFork(program);
			workspaceChangeFibers.set(key, fiber);
			void Effect.runPromise(Fiber.await(fiber)).finally(() => {
				if (workspaceChangeFibers.get(key) === fiber) {
					workspaceChangeFibers.delete(key);
					if (!stoppedRuntimes.has(key)) {
						startFallbackPoller(key, environmentId, catalogKey);
					}
				}
			});
		};
		const stopEntryRuntime = (catalogKey: string): void => {
			stoppedRuntimes.add(catalogKey);
			automaticRetry.stop(catalogKey);
			recoverySubscriptions.get(catalogKey)?.();
			recoverySubscriptions.delete(catalogKey);
			stopFallbackPoller(catalogKey);
			catalogPollsInFlight.delete(catalogKey);
			const workspaceFiber = workspaceChangeFibers.get(catalogKey);
			if (workspaceFiber !== undefined) {
				workspaceChangeFibers.delete(catalogKey);
				void Effect.runPromise(Fiber.interrupt(workspaceFiber)).catch(
					() => undefined,
				);
			}
		};
		const completeConnection = async (input: {
			readonly catalogKey: string;
			readonly environmentId: string;
			readonly patch: Partial<EnvironmentCatalogEntry>;
			readonly isCurrent?: () => boolean;
		}): Promise<void> => {
			// `getRpcClient` performs the WebSocket open and protocol handshake. Mark
			// the environment connected at that boundary; catalog hydration is useful
			// background work and must not block a fresh cloud agent.
			await getRpcClient(input.environmentId);
			if (input.isCurrent?.() === false) return;
			patchEntry(input.catalogKey, {
				...input.patch,
				status: "connected",
				error: null,
			});
			void hydrateEntry(input.environmentId, previousCatalog(input.catalogKey))
				.then((catalog) => {
					if (input.isCurrent?.() !== false)
						patchEntry(input.catalogKey, catalog);
				})
				.catch(() => undefined);
			automaticRetry.succeeded(input.catalogKey);
			if (!recoverySubscriptions.has(input.catalogKey)) {
				recoverySubscriptions.set(
					input.catalogKey,
					subscribeRendererRpcConnection((snapshot) => {
						if (snapshot.status === "connected") {
							patchEntry(input.catalogKey, {
								status: "connected",
								error: null,
							});
							return;
						}
						if (
							snapshot.status === "connecting" ||
							snapshot.status === "reconnecting"
						) {
							patchEntry(input.catalogKey, { status: "connecting" });
						}
						if (
							snapshot.status === "error" ||
							snapshot.status === "blockedAuth"
						) {
							patchEntry(input.catalogKey, {
								status: "error",
								error:
									snapshot.error === null ? null : formatError(snapshot.error),
							});
						}
					}, input.environmentId),
				);
			}
			void startWorkspaceChangeStream(
				input.catalogKey,
				input.environmentId,
				input.catalogKey,
			);
		};
		const failConnection = (
			catalogKey: string,
			cause: unknown,
			reconnect: () => Promise<void>,
		): void => {
			patchEntry(catalogKey, {
				status: "error",
				error: errorMessage(cause),
			});
			automaticRetry.schedule(catalogKey, () => void reconnect());
		};

		const connectProfile = (profileId: string): Promise<void> => {
			const catalogKey = `ssh:${profileId}`;
			return connectionAttempts.run(catalogKey, async () => {
				patchEntry(catalogKey, { status: "connecting", error: null });
				try {
					const connection = await window.zuse?.ssh?.ensureEnvironment({
						profileId,
					});
					if (connection === undefined) throw new Error("SSH is unavailable.");
					registerWebSocketEnvironment(
						connection.profile.environmentId,
						connection.descriptor.endpoint.wsBaseUrl,
					);
					await completeConnection({
						catalogKey,
						environmentId: connection.profile.environmentId,
						patch: {
							label: connection.profile.label,
							target: connection.profile.target,
							descriptor: connection.descriptor,
						},
					});
				} catch (cause) {
					failConnection(catalogKey, cause, () => connectProfile(profileId));
				}
			});
		};
		const connectTailnetConnection = async (
			connection: TailnetEnvironmentConnection,
		): Promise<void> => {
			const { profile } = connection;
			const catalogKey = `tailnet:${profile.profileId}`;
			registerWebSocketEnvironment(profile.environmentId, connection.wsUrl);
			try {
				const client = await getRpcClient(profile.environmentId);
				const descriptor = await Effect.runPromise(
					client["connect.describe"](),
				);
				if (descriptor.environmentId !== profile.environmentId) {
					throw new Error(
						"This Tailnet address now belongs to a different Zuse computer. Pair it again instead of reconnecting automatically.",
					);
				}
				const confirmedProfile = await window.zuse?.tailnet?.confirmEnvironment(
					profile.profileId,
					descriptor.environmentId,
				);
				if (confirmedProfile === undefined) {
					throw new Error("Tailnet connection confirmation is unavailable.");
				}
				await completeConnection({
					catalogKey,
					environmentId: profile.environmentId,
					patch: {
						label: confirmedProfile.label,
						descriptor,
					},
				});
			} catch (cause) {
				await removeRendererEnvironment(profile.environmentId).catch(
					() => undefined,
				);
				throw cause;
			}
		};
		const connectTailnetProfile = (profileId: string): Promise<void> => {
			const catalogKey = `tailnet:${profileId}`;
			return connectionAttempts.run(catalogKey, async () => {
				patchEntry(catalogKey, { status: "connecting", error: null });
				try {
					const connection = await window.zuse?.tailnet?.ensureEnvironment({
						profileId,
					});
					if (connection === undefined) {
						throw new Error("Tailnet connections are unavailable.");
					}
					try {
						await connectTailnetConnection(connection);
					} catch (cause) {
						patchEntry(`tailnet:${connection.profile.profileId}`, {
							status: "error",
							error: errorMessage(cause),
						});
						throw cause;
					}
				} catch (cause) {
					failConnection(catalogKey, cause, () =>
						connectTailnetProfile(profileId),
					);
				}
			});
		};
		const connectRelay = (
			environment: RelayEnvironmentRecord,
			localEnvironmentId: string,
			replace = false,
		): Promise<void> => {
			const catalogKey = `relay:${environment.environmentId}`;
			return connectionAttempts.run(
				catalogKey,
				async (isCurrent) => {
					try {
						const { grant, localClient } = await (async () => {
							try {
								const localClient = await getRpcClient(localEnvironmentId);
								const grant = await Effect.runPromise(
									localClient["environments.connect"]({
										environmentId: environment.environmentId,
									}),
								);
								return { grant, localClient };
							} catch (cause) {
								throw new Error(`Relay grant failed: ${errorMessage(cause)}`);
							}
						})();
						if (!isCurrent()) return;
						registerRelayEnvironment(
							environment.environmentId,
							relayGrantUrl(grant),
							async () =>
								relayGrantUrl(
									await Effect.runPromise(
										localClient["environments.connect"]({
											environmentId: environment.environmentId,
										}),
									),
								),
						);
						try {
							await completeConnection({
								catalogKey,
								environmentId: environment.environmentId,
								patch: {
									descriptor: {
										...environment,
										endpoint: grant.endpoint,
									},
								},
								isCurrent,
							});
						} catch (cause) {
							throw cloudConnectionFailure(cause);
						}
					} catch (cause) {
						if (!isCurrent()) return;
						failConnection(catalogKey, cause, () =>
							connectRelay(environment, localEnvironmentId),
						);
					}
				},
				replace,
			);
		};

		return {
			entries: [],
			activeEnvironmentId: LOCAL_ENVIRONMENT_KEY,
			initialized: false,
			hiddenRelayEnvironmentIds: [],
			initialize: () => {
				return initializeOnce(get().initialized, async () => {
					const localClient = await getRpcClient(LOCAL_ENVIRONMENT_KEY);
					const [descriptor, profiles, tailnetProfiles] = await Promise.all([
						Effect.runPromise(localClient["connect.describe"]()),
						window.zuse?.ssh?.listProfiles() ?? Promise.resolve([]),
						window.zuse?.tailnet?.listProfiles() ?? Promise.resolve([]),
					]);
					registerLocalEnvironment(descriptor.environmentId);
					setActiveEnvironment(descriptor.environmentId);
					const localCatalog = await hydrateEntry(descriptor.environmentId);
					const relayEnvironments = await Effect.runPromise(
						localClient["environments.list"](),
					).catch(() => ({ environments: [] as const }));
					const profileEnvironmentIds = new Set(
						[...profiles, ...tailnetProfiles].map(
							(profile) => profile.environmentId,
						),
					);
					const hiddenRelayEnvironmentIds = readHiddenRelayEnvironmentIds();
					const hiddenRelayIds = new Set(hiddenRelayEnvironmentIds);
					const accountRelayEnvironments =
						relayEnvironments.environments.filter(
							(environment) =>
								environment.environmentId !== descriptor.environmentId &&
								!profileEnvironmentIds.has(environment.environmentId),
						);
					// Record every account relay environment — including hidden ones —
					// so retry and unhide can reconnect without re-fetching the list.
					for (const environment of accountRelayEnvironments) {
						relayRecords.set(environment.environmentId, environment);
					}
					const visibleRelayEnvironments = accountRelayEnvironments.filter(
						(environment) => !hiddenRelayIds.has(environment.environmentId),
					);
					set({
						activeEnvironmentId: descriptor.environmentId,
						hiddenRelayEnvironmentIds,
						entries: orderEnvironmentCatalog([
							{
								connectionKind: "local",
								environmentId: descriptor.environmentId,
								profileId: null,
								label: descriptor.label ?? "This computer",
								target: null,
								descriptor,
								status: "connected",
								error: null,
								...localCatalog,
							},
							...visibleRelayEnvironments.map(relayEntry),
							...profiles.map(profileEntry),
							...tailnetProfiles.map(tailnetProfileEntry),
						]),
					});
					void startWorkspaceChangeStream(
						`local:${descriptor.environmentId}`,
						descriptor.environmentId,
						`local:${descriptor.environmentId}`,
					);
					await Promise.allSettled([
						...profiles.map((profile) => connectProfile(profile.profileId)),
						...tailnetProfiles.map((profile) =>
							connectTailnetProfile(profile.profileId),
						),
						...visibleRelayEnvironments.map((environment) =>
							connectRelay(environment, descriptor.environmentId),
						),
					]);
					set({ initialized: true });
				});
			},
			syncAccountEnvironments: async () => {
				const local = get().entries.find(
					(entry) => entry.connectionKind === "local",
				);
				if (local === undefined) {
					await get().initialize();
					return;
				}

				const localClient = await getRpcClient(local.environmentId);
				const result = await Effect.runPromise(
					localClient["environments.list"](),
				);
				const profileEnvironmentIds = new Set(
					get()
						.entries.filter(
							(entry) =>
								entry.connectionKind === "ssh" ||
								entry.connectionKind === "tailnet",
						)
						.map((entry) => entry.environmentId),
				);
				const hiddenRelayIds = new Set(get().hiddenRelayEnvironmentIds);
				const accountEnvironments = result.environments.filter(
					(environment) =>
						environment.environmentId !== local.environmentId &&
						!profileEnvironmentIds.has(environment.environmentId),
				);
				for (const environment of accountEnvironments) {
					relayRecords.set(environment.environmentId, environment);
				}

				const knownEnvironmentIds = new Set(
					get().entries.map((entry) => entry.environmentId),
				);
				const added = accountEnvironments.filter(
					(environment) =>
						!hiddenRelayIds.has(environment.environmentId) &&
						!knownEnvironmentIds.has(environment.environmentId),
				);
				if (added.length > 0)
					set((state) => ({
						entries: orderEnvironmentCatalog([
							...state.entries,
							...added.map(relayEntry),
						]),
					}));
				await Promise.allSettled(
					relayEnvironmentsNeedingConnection(
						accountEnvironments,
						get().entries,
					).map((environment) =>
						connectRelay(environment, local.environmentId),
					),
				);
			},
			add: async (target, label) => {
				const bridge = window.zuse?.ssh;
				if (bridge === undefined) throw new Error("SSH is unavailable.");
				const connection = await bridge.ensureEnvironment({ target, label });
				const relayKey = `relay:${connection.profile.environmentId}`;
				const duplicateRelay = get().entries.some(
					(entry) =>
						entry.connectionKind === "relay" &&
						entry.environmentId === connection.profile.environmentId,
				);
				if (
					duplicateRelay &&
					get().activeEnvironmentId === connection.profile.environmentId
				) {
					await bridge.removeProfile(connection.profile.profileId);
					throw new Error(
						"Switch to another computer before replacing this relay connection with SSH.",
					);
				}
				if (duplicateRelay) {
					stopEntryRuntime(relayKey);
					await removeRendererEnvironment(connection.profile.environmentId);
					set((state) => ({
						entries: state.entries.filter(
							(entry) => entryKey(entry) !== relayKey,
						),
					}));
				}
				registerWebSocketEnvironment(
					connection.profile.environmentId,
					connection.descriptor.endpoint.wsBaseUrl,
				);
				const catalog = await hydrateEntry(connection.profile.environmentId);
				const next = {
					...profileEntry(connection.profile),
					descriptor: connection.descriptor,
					status: "connected" as const,
					...catalog,
				};
				set((state) => ({
					entries: orderEnvironmentCatalog([
						...state.entries.filter(
							(entry) => entry.profileId !== next.profileId,
						),
						next,
					]),
				}));
				await connectProfile(connection.profile.profileId);
			},
			addTailnet: async (pairingLink, label) => {
				const bridge = window.zuse?.tailnet;
				if (bridge === undefined) {
					throw new Error("Tailnet connections are unavailable.");
				}
				const connection = await bridge.ensureEnvironment({
					pairingLink,
					label,
				});
				const duplicate = get().entries.find(
					(entry) =>
						entry.environmentId === connection.profile.environmentId &&
						entry.connectionKind !== "local",
				);
				if (
					duplicate !== undefined &&
					get().activeEnvironmentId === duplicate.environmentId
				) {
					await bridge.removeProfile(connection.profile.profileId);
					throw new Error(
						"Switch to another computer before replacing its current connection with Tailscale.",
					);
				}
				if (duplicate?.connectionKind === "ssh") {
					await bridge.removeProfile(connection.profile.profileId);
					throw new Error(
						"This computer is already saved through SSH. Remove that connection before adding it through Tailscale.",
					);
				}
				if (
					duplicate?.connectionKind === "relay" ||
					duplicate?.connectionKind === "tailnet"
				) {
					stopEntryRuntime(entryKey(duplicate));
					await removeRendererEnvironment(duplicate.environmentId);
				}
				const next = {
					...tailnetProfileEntry(connection.profile),
					descriptor: connection.descriptor,
				};
				set((state) => ({
					entries: orderEnvironmentCatalog([
						...state.entries.filter(
							(entry) =>
								entry.environmentId !== connection.profile.environmentId &&
								entry.profileId !== connection.profile.profileId,
						),
						next,
					]),
				}));
				try {
					await connectTailnetConnection(connection);
				} catch (cause) {
					const catalogKey = `tailnet:${connection.profile.profileId}`;
					patchEntry(catalogKey, {
						status: "error",
						error: errorMessage(cause),
					});
					automaticRetry.schedule(catalogKey, () => {
						void connectTailnetProfile(connection.profile.profileId);
					});
					throw cause;
				}
				return (
					get().entries.find(
						(entry) => entry.profileId === connection.profile.profileId,
					)?.label ?? connection.profile.label
				);
			},
			refreshEnvironment: async (environmentId) => {
				const entry = get().entries.find(
					(candidate) => candidate.environmentId === environmentId,
				);
				if (entry === undefined || entry.status !== "connected") return;
				const key = entryKey(entry);
				const catalog = await hydrateEntry(environmentId, previousCatalog(key));
				patchEntry(key, catalog);
			},
			retry: async (profileId) => {
				const entry = get().entries.find(
					(item) => item.profileId === profileId,
				);
				const catalogKey = `${entry?.connectionKind ?? "ssh"}:${profileId}`;
				automaticRetry.prepareManualRetry(catalogKey);
				if (entry?.connectionKind === "tailnet") {
					await connectTailnetProfile(profileId);
					return;
				}
				await connectProfile(profileId);
			},
			retryEnvironment: async (environmentId) => {
				const environment = relayRecords.get(environmentId);
				const local = get().entries.find(
					(entry) => entry.connectionKind === "local",
				);
				if (environment === undefined || local === undefined) return;
				automaticRetry.prepareManualRetry(`relay:${environmentId}`);
				patchEntry(`relay:${environmentId}`, {
					status: "connecting",
					error: null,
				});
				await connectRelay(environment, local.environmentId);
			},
			ensureEnvironmentConnected: async (environmentId) => {
				let local = get().entries.find(
					(entry) => entry.connectionKind === "local",
				);
				if (local === undefined) {
					await get().initialize();
					local = get().entries.find(
						(entry) => entry.connectionKind === "local",
					);
				}
				if (local === undefined)
					throw new Error(
						"Relay grant failed: local environment is unavailable.",
					);
				const localClient = await getRpcClient(local.environmentId);
				const listed = await Effect.runPromise(
					localClient["environments.list"](),
				).catch((cause) => {
					throw new Error(`Relay grant failed: ${errorMessage(cause)}`);
				});
				const environment = listed.environments.find(
					(candidate) => candidate.environmentId === environmentId,
				);
				if (environment === undefined)
					throw new Error(
						"Relay grant failed: cloud environment is not registered.",
					);
				relayRecords.set(environment.environmentId, environment);
				const catalogKey = `relay:${environment.environmentId}`;
				const existing = get().entries.find(
					(candidate) => candidate.environmentId === environmentId,
				);
				if (existing === undefined) {
					set((state) => ({
						entries: orderEnvironmentCatalog([
							...state.entries,
							relayEntry(environment),
						]),
					}));
				} else {
					patchEntry(catalogKey, { status: "connecting", error: null });
				}
				automaticRetry.prepareManualRetry(catalogKey);
				await connectRelay(environment, local.environmentId, true);
				const entry = get().entries.find(
					(candidate) => candidate.environmentId === environmentId,
				);
				if (entry?.status !== "connected")
					throw new Error(
						entry?.error ?? "Cloud runtime connection did not complete.",
					);
			},
			disconnect: async (profileId) => {
				const entry = get().entries.find(
					(item) => item.profileId === profileId,
				);
				if (entry?.connectionKind === "ssh") {
					await window.zuse?.ssh?.disconnectEnvironment(profileId);
				}
				if (entry !== undefined)
					await removeRendererEnvironment(entry.environmentId);
				if (entry === undefined) return;
				const catalogKey = `${entry.connectionKind}:${profileId}`;
				stopEntryRuntime(catalogKey);
				patchEntry(catalogKey, {
					status: "offline",
					error: null,
					descriptor: null,
				});
			},
			remove: async (profileId) => {
				const entry = get().entries.find(
					(item) => item.profileId === profileId,
				);
				if (entry?.connectionKind === "tailnet") {
					await window.zuse?.tailnet?.removeProfile(profileId);
				} else {
					await window.zuse?.ssh?.removeProfile(profileId);
				}
				if (entry !== undefined) {
					await removeRendererEnvironment(entry.environmentId);
					stopEntryRuntime(`${entry.connectionKind}:${profileId}`);
				}
				set((state) => ({
					entries: state.entries.filter((item) => item.profileId !== profileId),
				}));
			},
			rename: async (profileId, label) => {
				const entry = get().entries.find(
					(item) => item.profileId === profileId,
				);
				const profile =
					entry?.connectionKind === "tailnet"
						? await window.zuse?.tailnet?.updateProfileLabel(profileId, label)
						: await window.zuse?.ssh?.updateProfileLabel(profileId, label);
				if (profile === undefined) {
					throw new Error("Computer management is unavailable.");
				}
				patchEntry(`${entry?.connectionKind ?? "ssh"}:${profileId}`, {
					label: profile.label,
				});
			},
			hideRelayEnvironment: async (environmentId) => {
				if (get().activeEnvironmentId === environmentId) {
					throw new Error("Switch to another computer before hiding this one.");
				}
				const current = readHiddenRelayEnvironmentIds();
				const hiddenRelayEnvironmentIds = current.includes(environmentId)
					? current
					: [...current, environmentId];
				writeHiddenRelayEnvironmentIds(hiddenRelayEnvironmentIds);
				const catalogKey = `relay:${environmentId}`;
				stopEntryRuntime(catalogKey);
				await removeRendererEnvironment(environmentId).catch(() => undefined);
				set((state) => ({
					hiddenRelayEnvironmentIds,
					entries: state.entries.filter(
						(entry) => entryKey(entry) !== catalogKey,
					),
				}));
			},
			unhideRelayEnvironments: async () => {
				const hidden = readHiddenRelayEnvironmentIds();
				writeHiddenRelayEnvironmentIds([]);
				set({ hiddenRelayEnvironmentIds: [] });
				const local = get().entries.find(
					(entry) => entry.connectionKind === "local",
				);
				if (hidden.length === 0 || local === undefined) return;
				const records = hidden
					.map((environmentId) => relayRecords.get(environmentId))
					.filter(
						(record): record is RelayEnvironmentRecord => record !== undefined,
					)
					.filter(
						(record) =>
							!get().entries.some(
								(entry) => entry.environmentId === record.environmentId,
							),
					);
				if (records.length === 0) return;
				set((state) => ({
					entries: orderEnvironmentCatalog([
						...state.entries,
						...records.map(relayEntry),
					]),
				}));
				await Promise.allSettled(
					records.map((record) => connectRelay(record, local.environmentId)),
				);
			},
			activate: async (environmentId) => {
				const entry = get().entries.find(
					(item) => item.environmentId === environmentId,
				);
				if (entry?.status !== "connected") return;
				setActiveEnvironment(environmentId);
				set({ activeEnvironmentId: environmentId });
			},
		};
	},
);
