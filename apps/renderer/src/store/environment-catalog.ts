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
	add: (target: SshEnvironmentTarget, label?: string) => Promise<void>;
	/** Resolves with the connected computer's label once the link settles. */
	addTailnet: (pairingLink: string, label?: string) => Promise<string>;
	retry: (profileId: string) => Promise<void>;
	retryEnvironment: (environmentId: string) => Promise<void>;
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
		const recovering = new Set<string>();
		const connectionAttempts = new Map<string, Promise<void>>();
		const catalogPollers = new Map<string, number>();
		const workspaceChangeFibers = new Map<
			string,
			Fiber.Fiber<unknown, unknown>
		>();
		const catalogPollsInFlight = new Set<string>();
		const automaticRetry = createCatalogRetryController((delayMs, run) => {
			const timer = window.setTimeout(run, delayMs);
			return () => window.clearTimeout(timer);
		});
		const runConnectionAttempt = (
			key: string,
			operation: () => Promise<void>,
		): Promise<void> => {
			const current = connectionAttempts.get(key);
			if (current !== undefined) return current;
			const attempt = operation().finally(() => connectionAttempts.delete(key));
			connectionAttempts.set(key, attempt);
			return attempt;
		};
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
		const startCatalogPoller = (
			key: string,
			environmentId: string,
			catalogKey: string,
		): void => {
			if (catalogPollers.has(key)) return;
			catalogPollers.set(
				key,
				window.setInterval(() => {
					if (catalogPollsInFlight.has(key)) return;
					catalogPollsInFlight.add(key);
					void hydrateEntry(environmentId, previousCatalog(catalogKey))
						.then((catalog) => patchEntry(catalogKey, catalog))
						.catch(() => undefined)
						.finally(() => catalogPollsInFlight.delete(key));
				}, 15_000),
			);
		};
		const startWorkspaceChangeStream = async (
			key: string,
			environmentId: string,
			catalogKey: string,
		): Promise<void> => {
			const previous = workspaceChangeFibers.get(key);
			if (previous !== undefined) {
				await Effect.runPromise(Fiber.interrupt(previous)).catch(
					() => undefined,
				);
			}
			const client = await getRpcClient(environmentId).catch(() => null);
			if (client === null) return;
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
			workspaceChangeFibers.set(key, Effect.runFork(program));
		};
		const stopEntryRuntime = (catalogKey: string): void => {
			automaticRetry.stop(catalogKey);
			recoverySubscriptions.get(catalogKey)?.();
			recoverySubscriptions.delete(catalogKey);
			window.clearInterval(catalogPollers.get(catalogKey));
			catalogPollers.delete(catalogKey);
			catalogPollsInFlight.delete(catalogKey);
			const workspaceFiber = workspaceChangeFibers.get(catalogKey);
			if (workspaceFiber !== undefined) {
				workspaceChangeFibers.delete(catalogKey);
				void Effect.runPromise(Fiber.interrupt(workspaceFiber)).catch(
					() => undefined,
				);
			}
		};

		const connectProfile = (profileId: string): Promise<void> => {
			const catalogKey = `ssh:${profileId}`;
			return runConnectionAttempt(catalogKey, async () => {
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
					const catalog = await hydrateEntry(
						connection.profile.environmentId,
						previousCatalog(catalogKey),
					);
					patchEntry(catalogKey, {
						environmentId: connection.profile.environmentId,
						label: connection.profile.label,
						target: connection.profile.target,
						descriptor: connection.descriptor,
						status: "connected",
						error: null,
						...catalog,
					});
					automaticRetry.succeeded(catalogKey);
					if (!recoverySubscriptions.has(catalogKey)) {
						recoverySubscriptions.set(
							catalogKey,
							subscribeRendererRpcConnection((snapshot) => {
								if (
									(snapshot.status === "reconnecting" ||
										snapshot.status === "error") &&
									!recovering.has(profileId)
								) {
									recovering.add(profileId);
									void connectProfile(profileId).finally(() =>
										recovering.delete(profileId),
									);
								}
							}, connection.profile.environmentId),
						);
					}
					startCatalogPoller(
						catalogKey,
						connection.profile.environmentId,
						catalogKey,
					);
					void startWorkspaceChangeStream(
						catalogKey,
						connection.profile.environmentId,
						catalogKey,
					);
				} catch (cause) {
					patchEntry(catalogKey, {
						status: "error",
						error: errorMessage(cause),
					});
					automaticRetry.schedule(catalogKey, () => {
						void connectProfile(profileId);
					});
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
				const catalog = await hydrateEntry(
					profile.environmentId,
					previousCatalog(catalogKey),
				);
				patchEntry(catalogKey, {
					environmentId: profile.environmentId,
					label: confirmedProfile.label,
					descriptor,
					status: "connected",
					error: null,
					...catalog,
				});
				automaticRetry.succeeded(catalogKey);
				if (!recoverySubscriptions.has(catalogKey)) {
					recoverySubscriptions.set(
						catalogKey,
						subscribeRendererRpcConnection((snapshot) => {
							if (
								(snapshot.status === "reconnecting" ||
									snapshot.status === "error") &&
								!recovering.has(catalogKey)
							) {
								recovering.add(catalogKey);
								void connectTailnetProfile(profile.profileId).finally(() =>
									recovering.delete(catalogKey),
								);
							}
						}, profile.environmentId),
					);
				}
				startCatalogPoller(catalogKey, profile.environmentId, catalogKey);
				void startWorkspaceChangeStream(
					catalogKey,
					profile.environmentId,
					catalogKey,
				);
			} catch (cause) {
				await removeRendererEnvironment(profile.environmentId).catch(
					() => undefined,
				);
				throw cause;
			}
		};
		const connectTailnetProfile = (profileId: string): Promise<void> => {
			const catalogKey = `tailnet:${profileId}`;
			return runConnectionAttempt(catalogKey, async () => {
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
					patchEntry(catalogKey, {
						status: "error",
						error: errorMessage(cause),
					});
					automaticRetry.schedule(catalogKey, () => {
						void connectTailnetProfile(profileId);
					});
				}
			});
		};
		const connectRelay = (
			environment: RelayEnvironmentRecord,
			localEnvironmentId: string,
		): Promise<void> => {
			const catalogKey = `relay:${environment.environmentId}`;
			return runConnectionAttempt(catalogKey, async () => {
				try {
					const localClient = await getRpcClient(localEnvironmentId);
					const grant = await Effect.runPromise(
						localClient["relay.connectEnvironment"]({
							environmentId: environment.environmentId,
						}),
					);
					registerRelayEnvironment(
						environment.environmentId,
						relayGrantUrl(grant),
						async () =>
							relayGrantUrl(
								await Effect.runPromise(
									localClient["relay.connectEnvironment"]({
										environmentId: environment.environmentId,
									}),
								),
							),
					);
					if (!recoverySubscriptions.has(catalogKey)) {
						recoverySubscriptions.set(
							catalogKey,
							subscribeRendererRpcConnection((snapshot) => {
								if (snapshot.status === "connected") {
									patchEntry(catalogKey, { status: "connected", error: null });
								} else if (
									snapshot.status === "connecting" ||
									snapshot.status === "reconnecting"
								) {
									patchEntry(catalogKey, { status: "connecting" });
								} else if (
									snapshot.status === "error" ||
									snapshot.status === "blockedAuth"
								) {
									patchEntry(catalogKey, {
										status: "error",
										error:
											snapshot.error === null
												? null
												: formatError(snapshot.error),
									});
								}
							}, environment.environmentId),
						);
					}
					const catalog = await hydrateEntry(
						environment.environmentId,
						previousCatalog(catalogKey),
					);
					patchEntry(catalogKey, {
						descriptor: {
							...environment,
							endpoint: grant.endpoint,
						},
						status: "connected",
						error: null,
						...catalog,
					});
					automaticRetry.succeeded(catalogKey);
					startCatalogPoller(catalogKey, environment.environmentId, catalogKey);
					void startWorkspaceChangeStream(
						catalogKey,
						environment.environmentId,
						catalogKey,
					);
				} catch (cause) {
					patchEntry(catalogKey, {
						status: "error",
						error: errorMessage(cause),
					});
					automaticRetry.schedule(catalogKey, () => {
						void connectRelay(environment, localEnvironmentId);
					});
				}
			});
		};

		return {
			entries: [],
			activeEnvironmentId: LOCAL_ENVIRONMENT_KEY,
			initialized: false,
			hiddenRelayEnvironmentIds: [],
			initialize: async () => {
				if (get().initialized) return;
				set({ initialized: true });
				try {
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
						localClient["relay.environments"](),
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
					startCatalogPoller(
						`local:${descriptor.environmentId}`,
						descriptor.environmentId,
						`local:${descriptor.environmentId}`,
					);
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
				} catch (cause) {
					set({ initialized: false });
					throw cause;
				}
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
