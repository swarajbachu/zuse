import {
	type Chat,
	type EnvironmentDescriptor,
	type Folder,
	type RelayConnectGrant,
	type RelayEnvironmentRecord,
	type RemoteEnvironmentProfile,
	type Session,
	type SshEnvironmentTarget,
	WIRE_PROTOCOL_VERSION,
} from "@zuse/contracts";
import { Effect } from "effect";

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

export type CatalogConnectionStatus =
	| "connecting"
	| "connected"
	| "offline"
	| "error";

export type EnvironmentCatalogEntry = {
	readonly connectionKind: "local" | "relay" | "ssh";
	readonly environmentId: string;
	readonly profileId: string | null;
	readonly label: string;
	readonly target: SshEnvironmentTarget | null;
	readonly descriptor: EnvironmentDescriptor | null;
	readonly status: CatalogConnectionStatus;
	readonly error: string | null;
	readonly folders: ReadonlyArray<Folder>;
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
	initialize: () => Promise<void>;
	add: (target: SshEnvironmentTarget, label?: string) => Promise<void>;
	retry: (profileId: string) => Promise<void>;
	retryEnvironment: (environmentId: string) => Promise<void>;
	disconnect: (profileId: string) => Promise<void>;
	remove: (profileId: string) => Promise<void>;
	rename: (profileId: string, label: string) => Promise<void>;
	activate: (environmentId: string) => Promise<void>;
};

const errorMessage = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

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
	chatsByProject: {},
	sessionsByProject: {},
});

const entryKey = (entry: EnvironmentCatalogEntry): string =>
	entry.connectionKind === "ssh"
		? `ssh:${entry.profileId}`
		: `${entry.connectionKind}:${entry.environmentId}`;

const relayGrantUrl = (grant: RelayConnectGrant): string => {
	const url = new URL(grant.endpoint.wsBaseUrl);
	url.searchParams.set("token", grant.connectToken);
	url.searchParams.set("wireVersion", String(WIRE_PROTOCOL_VERSION));
	return url.toString();
};

const hydrateEntry = async (
	environmentId: string,
): Promise<
	Pick<
		EnvironmentCatalogEntry,
		"folders" | "chatsByProject" | "sessionsByProject"
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
	return {
		folders,
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
		const catalogPollers = new Map<string, number>();
		const catalogPollsInFlight = new Set<string>();
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
					void hydrateEntry(environmentId)
						.then((catalog) => patchEntry(catalogKey, catalog))
						.catch(() => undefined)
						.finally(() => catalogPollsInFlight.delete(key));
				}, 15_000),
			);
		};

		const connectProfile = async (profileId: string): Promise<void> => {
			const catalogKey = `ssh:${profileId}`;
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
				const catalog = await hydrateEntry(connection.profile.environmentId);
				patchEntry(catalogKey, {
					environmentId: connection.profile.environmentId,
					label: connection.profile.label,
					target: connection.profile.target,
					descriptor: connection.descriptor,
					status: "connected",
					error: null,
					...catalog,
				});
				if (!recoverySubscriptions.has(profileId)) {
					recoverySubscriptions.set(
						profileId,
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
			} catch (cause) {
				patchEntry(catalogKey, {
					status: "error",
					error: errorMessage(cause),
				});
			}
		};
		const connectRelay = async (
			environment: RelayEnvironmentRecord,
			localEnvironmentId: string,
		): Promise<void> => {
			const catalogKey = `relay:${environment.environmentId}`;
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
									error: snapshot.error,
								});
							}
						}, environment.environmentId),
					);
				}
				const catalog = await hydrateEntry(environment.environmentId);
				patchEntry(catalogKey, {
					descriptor: {
						...environment,
						endpoint: grant.endpoint,
					},
					status: "connected",
					error: null,
					...catalog,
				});
				startCatalogPoller(catalogKey, environment.environmentId, catalogKey);
			} catch (cause) {
				patchEntry(catalogKey, {
					status: "error",
					error: errorMessage(cause),
				});
			}
		};

		return {
			entries: [],
			activeEnvironmentId: LOCAL_ENVIRONMENT_KEY,
			initialized: false,
			initialize: async () => {
				if (get().initialized) return;
				set({ initialized: true });
				try {
					const localClient = await getRpcClient(LOCAL_ENVIRONMENT_KEY);
					const [descriptor, profiles] = await Promise.all([
						Effect.runPromise(localClient["connect.describe"]()),
						window.zuse?.ssh?.listProfiles() ?? Promise.resolve([]),
					]);
					registerLocalEnvironment(descriptor.environmentId);
					setActiveEnvironment(descriptor.environmentId);
					const localCatalog = await hydrateEntry(descriptor.environmentId);
					const relayEnvironments = await Effect.runPromise(
						localClient["relay.environments"](),
					).catch(() => ({ environments: [] as const }));
					const profileEnvironmentIds = new Set(
						profiles.map((profile) => profile.environmentId),
					);
					const visibleRelayEnvironments =
						relayEnvironments.environments.filter(
							(environment) =>
								environment.environmentId !== descriptor.environmentId &&
								!profileEnvironmentIds.has(environment.environmentId),
						);
					for (const environment of visibleRelayEnvironments) {
						relayRecords.set(environment.environmentId, environment);
					}
					set({
						activeEnvironmentId: descriptor.environmentId,
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
						]),
					});
					startCatalogPoller(
						`local:${descriptor.environmentId}`,
						descriptor.environmentId,
						`local:${descriptor.environmentId}`,
					);
					await Promise.allSettled([
						...profiles.map((profile) => connectProfile(profile.profileId)),
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
					recoverySubscriptions.get(relayKey)?.();
					recoverySubscriptions.delete(relayKey);
					window.clearInterval(catalogPollers.get(relayKey));
					catalogPollers.delete(relayKey);
					catalogPollsInFlight.delete(relayKey);
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
			retry: async (profileId) => connectProfile(profileId),
			retryEnvironment: async (environmentId) => {
				const environment = relayRecords.get(environmentId);
				const local = get().entries.find(
					(entry) => entry.connectionKind === "local",
				);
				if (environment === undefined || local === undefined) return;
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
				await window.zuse?.ssh?.disconnectEnvironment(profileId);
				if (entry !== undefined)
					await removeRendererEnvironment(entry.environmentId);
				recoverySubscriptions.get(profileId)?.();
				recoverySubscriptions.delete(profileId);
				window.clearInterval(catalogPollers.get(`ssh:${profileId}`));
				catalogPollers.delete(`ssh:${profileId}`);
				catalogPollsInFlight.delete(`ssh:${profileId}`);
				patchEntry(`ssh:${profileId}`, {
					status: "offline",
					error: null,
					descriptor: null,
				});
			},
			remove: async (profileId) => {
				const entry = get().entries.find(
					(item) => item.profileId === profileId,
				);
				await window.zuse?.ssh?.removeProfile(profileId);
				if (entry !== undefined)
					await removeRendererEnvironment(entry.environmentId);
				recoverySubscriptions.get(profileId)?.();
				recoverySubscriptions.delete(profileId);
				window.clearInterval(catalogPollers.get(`ssh:${profileId}`));
				catalogPollers.delete(`ssh:${profileId}`);
				catalogPollsInFlight.delete(`ssh:${profileId}`);
				set((state) => ({
					entries: state.entries.filter((item) => item.profileId !== profileId),
				}));
			},
			rename: async (profileId, label) => {
				const profile = await window.zuse?.ssh?.updateProfileLabel(
					profileId,
					label,
				);
				if (profile === undefined) throw new Error("SSH is unavailable.");
				patchEntry(`ssh:${profileId}`, { label: profile.label });
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
