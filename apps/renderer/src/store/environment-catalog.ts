import type { ResourceLease } from "@zuse/client-runtime/client-bus";
import type { ResourceView } from "@zuse/client-runtime/resource-state";
import {
	type ApiConnectGrant,
	type ApiEnvironmentRecord,
	type Chat,
	type ChatId,
	type EnvironmentDescriptor,
	EnvironmentId,
	type Folder,
	isEnvironmentPresenceFresh,
	type RemoteEnvironmentProfile,
	type Session,
	type SshEnvironmentTarget,
	type TailnetEnvironmentConnection,
	type TailnetEnvironmentProfile,
	WIRE_PROTOCOL_VERSION,
} from "@zuse/contracts";
import { Effect } from "effect";
import { isCloudProjectFolder } from "../lib/cloud-project-folders.ts";
import {
	cloudSummaryActiveSessionId,
	cloudSummaryForChat,
	localProjectForCloudChat,
} from "../lib/cloud-workspace-catalog.ts";
import {
	type EnvironmentShellData,
	environmentShellSnapshot,
	normalizeEnvironmentShellData,
	retainEnvironmentShell,
	subscribeEnvironmentShell,
} from "../lib/environment-shell-client-bus.ts";
import { formatError } from "../lib/format-error.ts";
import { isHostedProduct } from "../lib/hosted-connect.ts";
import { createInitializationGate } from "../lib/initialization-gate.ts";
import { upsertLatestEntity } from "../lib/latest-entity.ts";
import { markRendererStartupMilestone } from "../lib/performance-marks.ts";
import {
	assertRendererAccountCurrent,
	rendererAccountSnapshot,
	subscribeRendererAccount,
} from "../lib/renderer-account.ts";
import {
	rendererWorkspaceSnapshot,
	subscribeRendererWorkspace,
} from "../lib/renderer-workspace.ts";
import {
	environmentBelongsToWorkspace,
	isDesktopLocalEnvironment,
	LOCAL_ENVIRONMENT_KEY,
	registerApiEnvironment,
	registerLocalEnvironment,
	registerWebSocketEnvironment,
	removeRendererEnvironment,
	setActiveEnvironment,
} from "../lib/rpc-client.ts";
import { runtimeOperationClient } from "../lib/runtime-operation-client.ts";
import { getRendererClientBus } from "../lib/session-timeline-client-bus.ts";
import { createAtomStore as create } from "../state/atom-store.ts";
import { activateAnnotationsEnvironment } from "./annotations.ts";
import {
	pendingCreationEntities,
	restorePendingCreation,
	useChatsStore,
} from "./chats.ts";
import { useSessionsStore } from "./sessions.ts";
import { useUiStore } from "./ui.ts";
import { useWorkspaceStore } from "./workspace.ts";

export type CatalogConnectionStatus =
	| "connecting"
	| "connected"
	| "offline"
	| "error";

export type EnvironmentCatalogEntry = {
	readonly connectionKind: "local" | "api" | "ssh" | "tailnet";
	readonly environmentId: string;
	readonly profileId: string | null;
	readonly label: string;
	readonly target: SshEnvironmentTarget | null;
	readonly descriptor: EnvironmentDescriptor | null;
	readonly status: CatalogConnectionStatus;
	readonly error: string | null;
	readonly lastHeartbeat?: number;
};

export type EnvironmentShellSeed = Readonly<{
	chat: Chat;
	initialSession: Session;
}>;

export type EnvironmentActivation = Readonly<{
	isCurrent?: () => boolean;
	folderId?: Folder["id"];
	chatId?: Chat["id"];
	seed?: EnvironmentShellSeed;
}>;

type EnvironmentProjectionOptions = EnvironmentActivation &
	Readonly<{ resetOptimisticState?: boolean }>;

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

const upsertChat = (
	chats: ReadonlyArray<Chat>,
	chat: Chat,
): ReadonlyArray<Chat> =>
	[chat, ...chats.filter((candidate) => candidate.id !== chat.id)].sort(
		(left, right) =>
			(right.updatedAt ?? right.createdAt).getTime() -
			(left.updatedAt ?? left.createdAt).getTime(),
	);

const resumedCreationOperations = new Set<string>();

export const projectEnvironmentShell = (
	data: EnvironmentShellData,
	options: EnvironmentProjectionOptions = {},
): Folder["id"] | null => {
	const normalized = normalizeEnvironmentShellData(data);
	const previousWorkspace = useWorkspaceStore.getState();
	const selectedFolderId =
		options.folderId !== undefined &&
		normalized.folders.some((folder) => folder.id === options.folderId)
			? options.folderId
			: options.resetOptimisticState !== true &&
					previousWorkspace.selectedFolderId !== null &&
					(isCloudProjectFolder(previousWorkspace.selectedFolderId) ||
						normalized.folders.some(
							(folder) => folder.id === previousWorkspace.selectedFolderId,
						))
				? previousWorkspace.selectedFolderId
				: (normalized.folders[0]?.id ?? null);

	const previousChats = useChatsStore.getState();
	const creationOperations = Object.values(
		normalized.creationOperationsByProject,
	).flat();
	const recoverableCreationOperationIds = new Set(
		creationOperations
			.filter(
				(operation) =>
					operation.phase !== "running" &&
					operation.phase !== "failed" &&
					operation.phase !== "cancelled",
			)
			.map((operation) => operation.operationId),
	);
	for (const operationId of resumedCreationOperations) {
		if (!recoverableCreationOperationIds.has(operationId)) {
			resumedCreationOperations.delete(operationId);
		}
	}
	const succeededOperationIds = new Set(
		creationOperations
			.filter(
				(operation) =>
					operation.phase === "running" || operation.phase === "cancelled",
			)
			.map((operation) => operation.operationId),
	);
	const pendingByChat = Object.fromEntries(
		Object.entries(
			options.resetOptimisticState === true
				? {}
				: previousChats.pendingCreationByChat,
		).filter(
			([, creation]) => !succeededOperationIds.has(creation.operationId),
		),
	);
	const restoredPending = Object.fromEntries(
		creationOperations
			.filter(
				(operation) =>
					operation.phase !== "running" && operation.phase !== "cancelled",
			)
			.map((operation) => {
				const pending = restorePendingCreation(operation);
				return [pending.chat.id, pending.creation] as const;
			}),
	);
	const optimisticChats = new Map<string, Chat>();
	const optimisticSessions = new Map<string, Session>();
	for (const creation of Object.values(pendingByChat)) {
		const optimistic = pendingCreationEntities(creation);
		optimisticChats.set(optimistic.chat.id, optimistic.chat);
		optimisticSessions.set(optimistic.session.id, optimistic.session);
	}
	for (const operation of creationOperations) {
		if (operation.phase === "running" || operation.phase === "cancelled")
			continue;
		const pending = restorePendingCreation(operation);
		optimisticChats.set(pending.chat.id, pending.chat);
		optimisticSessions.set(pending.session.id, pending.session);
	}
	// ClientBus overlays already survive into `normalized`; pending metadata is
	// retained below only to drive the creation progress surface.
	if (options.seed !== undefined) {
		optimisticChats.set(options.seed.chat.id, options.seed.chat);
		optimisticSessions.set(
			options.seed.initialSession.id,
			options.seed.initialSession,
		);
	}

	const chatsByProject = Object.fromEntries(
		normalized.folders.map((folder) => {
			let chats = normalized.chatsByProject[folder.id] ?? [];
			for (const chat of optimisticChats.values()) {
				if (chat.projectId === folder.id) chats = upsertChat(chats, chat);
			}
			return [folder.id, chats] as const;
		}),
	);
	const sessionsByProject = Object.fromEntries(
		normalized.folders.map((folder) => {
			let sessions = normalized.sessionsByProject[folder.id] ?? [];
			for (const session of optimisticSessions.values()) {
				if (session.projectId === folder.id) {
					sessions = upsertLatestEntity(sessions, session);
				}
			}
			return [folder.id, sessions] as const;
		}),
	);
	const selectedChatId = (() => {
		if (selectedFolderId === null) return null;
		const chats = chatsByProject[selectedFolderId] ?? [];
		const isRetainedCloudChat = (chatId: ChatId): boolean => {
			const summary = cloudSummaryForChat(chatId);
			return (
				summary !== null &&
				summary.archivedAt === undefined &&
				localProjectForCloudChat(chatId) === selectedFolderId
			);
		};
		if (
			options.chatId !== undefined &&
			(chats.some((chat) => chat.id === options.chatId) ||
				isRetainedCloudChat(options.chatId))
		) {
			return options.chatId;
		}
		if (
			options.resetOptimisticState !== true &&
			previousChats.selectedChatId !== null &&
			(chats.some((chat) => chat.id === previousChats.selectedChatId) ||
				isRetainedCloudChat(previousChats.selectedChatId))
		) {
			return previousChats.selectedChatId;
		}
		return null;
	})();
	const selectedChat =
		selectedFolderId === null || selectedChatId === null
			? null
			: (chatsByProject[selectedFolderId]?.find(
					(chat) => chat.id === selectedChatId,
				) ?? null);
	const selectedCloudSummary =
		selectedChatId === null ? null : cloudSummaryForChat(selectedChatId);
	const previousSessions = useSessionsStore.getState();
	const selectedSessionId = (() => {
		if (selectedFolderId === null) return null;
		if (
			selectedChat === null &&
			selectedCloudSummary !== null &&
			selectedCloudSummary.archivedAt === undefined &&
			localProjectForCloudChat(selectedCloudSummary.chatId) === selectedFolderId
		) {
			return cloudSummaryActiveSessionId(selectedCloudSummary);
		}
		if (selectedChat === null) return null;
		const sessions = sessionsByProject[selectedFolderId] ?? [];
		const previousSelection = previousSessions.selectedSessionId;
		if (
			options.resetOptimisticState !== true &&
			previousSelection !== null &&
			sessions.some(
				(session) =>
					session.id === previousSelection &&
					session.chatId === selectedChat.id,
			)
		) {
			return previousSelection;
		}
		if (
			selectedChat.activeSessionId !== null &&
			sessions.some((session) => session.id === selectedChat.activeSessionId)
		) {
			return selectedChat.activeSessionId;
		}
		return (
			sessions.find((session) => session.chatId === selectedChat.id)?.id ?? null
		);
	})();

	useWorkspaceStore.setState({
		folders: normalized.folders,
		selectedFolderId,
		loading: false,
		error: null,
	});
	markRendererStartupMilestone("projects-visible");
	// This function projects the canonical shell cell into compatibility stores.
	// Never write the projection back into that same cell: ClientBus notifies its
	// shell listener synchronously, so doing so recursively re-enters this
	// projector until the JavaScript stack overflows. Optimistic mutations are
	// applied at their command boundaries before this projection runs.
	useChatsStore.setState({
		selectedChatId,
		selectedChatByProject:
			selectedFolderId === null ? {} : { [selectedFolderId]: selectedChatId },
		loadingByProject: {},
		creatingByProject: Object.fromEntries(
			creationOperations
				.filter(
					(operation) =>
						operation.phase !== "running" &&
						operation.phase !== "failed" &&
						operation.phase !== "cancelled",
				)
				.map((operation) => [operation.projectId, true] as const),
		),
		pendingCreationByChat: { ...pendingByChat, ...restoredPending },
		archiveProgressByChat: {},
		error: null,
	});
	useSessionsStore.setState({
		selectedSessionId,
		selectedSessionByProject:
			selectedFolderId === null
				? {}
				: { [selectedFolderId]: selectedSessionId },
		loadingByProject: {},
		creatingByChat: {},
		error: null,
	});
	// A creation can outlive the RPC scope that started it (app reload, HMR,
	// laptop sleep, or a transport generation change). The canonical creation
	// stream is therefore also the recovery trigger. `retryCreation` is keyed by
	// operation id, so repeated snapshots cannot start competing attempts.
	for (const [chatId, creation] of Object.entries(restoredPending)) {
		if (
			creation.phase !== "failed" &&
			!resumedCreationOperations.has(creation.operationId)
		) {
			resumedCreationOperations.add(creation.operationId);
			queueMicrotask(() => {
				void useChatsStore.getState().retryCreation(chatId as ChatId, true);
			});
		}
	}
	return selectedFolderId;
};

type EnvironmentCatalogState = {
	readonly entries: ReadonlyArray<EnvironmentCatalogEntry>;
	readonly activeEnvironmentId: string;
	readonly initialized: boolean;
	readonly initializing: boolean;
	readonly initializationError: string | null;
	readonly accountDiscoveryError: string | null;
	readonly hiddenApiEnvironmentIds: ReadonlyArray<string>;
	initialize: () => Promise<void>;
	syncAccountEnvironments: () => Promise<void>;
	add: (target: SshEnvironmentTarget, label?: string) => Promise<void>;
	/** Resolves with the connected computer's label once the link settles. */
	addTailnet: (pairingLink: string, label?: string) => Promise<string>;
	retry: (profileId: string) => Promise<void>;
	retryEnvironment: (environmentId: string) => Promise<void>;
	ensureEnvironmentConnected: (environmentId: string) => Promise<void>;
	disconnect: (profileId: string) => Promise<void>;
	remove: (profileId: string) => Promise<void>;
	rename: (profileId: string, label: string) => Promise<void>;
	hideApiEnvironment: (environmentId: string) => Promise<void>;
	unhideApiEnvironments: () => Promise<void>;
	activate: (
		environmentId: string,
		selection?: EnvironmentActivation,
	) => Promise<Folder["id"] | null>;
	activateTransient: (
		environmentId: string,
		fallback: EnvironmentShellData,
		selection?: EnvironmentActivation,
	) => Promise<Folder["id"] | null>;
};

type EnvironmentShellRuntime = {
	readonly lifetime: AbortController;
	readonly ref: { readonly environmentId: EnvironmentId };
	readonly lease: ResourceLease;
	readonly unsubscribe: () => void;
	requestedActivation: "cache-only" | "connect";
};

const HIDDEN_API_STORAGE_KEY = "zuse.catalog.hiddenApiEnvironments";

const readHiddenApiEnvironmentIds = (): ReadonlyArray<string> => {
	try {
		const raw = window.localStorage.getItem(HIDDEN_API_STORAGE_KEY);
		if (raw === null) return [];
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.filter((id): id is string => typeof id === "string")
			: [];
	} catch {
		return [];
	}
};

const writeHiddenApiEnvironmentIds = (ids: ReadonlyArray<string>): void => {
	try {
		if (ids.length === 0) {
			window.localStorage.removeItem(HIDDEN_API_STORAGE_KEY);
		} else {
			window.localStorage.setItem(HIDDEN_API_STORAGE_KEY, JSON.stringify(ids));
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
	status: "offline",
	error: null,
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
});

const apiEntry = (
	environment: ApiEnvironmentRecord,
): EnvironmentCatalogEntry => ({
	connectionKind: "api",
	environmentId: environment.environmentId,
	profileId: null,
	label: environment.label ?? "Unnamed computer",
	target: null,
	descriptor: null,
	status: "offline",
	error: null,
	lastHeartbeat: environment.lastHeartbeat,
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

export const loadOptionalEnvironmentSources = async (input: {
	readonly sshProfiles: Promise<ReadonlyArray<RemoteEnvironmentProfile>>;
	readonly tailnetProfiles: Promise<ReadonlyArray<TailnetEnvironmentProfile>>;
	readonly apiEnvironments: Promise<
		Readonly<{ environments: ReadonlyArray<ApiEnvironmentRecord> }>
	>;
}): Promise<{
	readonly profiles: ReadonlyArray<RemoteEnvironmentProfile>;
	readonly tailnetProfiles: ReadonlyArray<TailnetEnvironmentProfile>;
	readonly apiEnvironments: ReadonlyArray<ApiEnvironmentRecord>;
	readonly apiError: string | null;
}> => {
	const [sshResult, tailnetResult, apiResult] = await Promise.allSettled([
		input.sshProfiles,
		input.tailnetProfiles,
		input.apiEnvironments,
	]);
	return {
		profiles: sshResult.status === "fulfilled" ? sshResult.value : [],
		tailnetProfiles:
			tailnetResult.status === "fulfilled" ? tailnetResult.value : [],
		apiEnvironments:
			apiResult.status === "fulfilled" ? apiResult.value.environments : [],
		apiError:
			apiResult.status === "rejected" ? errorMessage(apiResult.reason) : null,
	};
};

export type EnvironmentCatalogViewState =
	| "loading"
	| "unavailable"
	| "empty"
	| "ready";

export const environmentCatalogViewState = (input: {
	readonly initialized: boolean;
	readonly initializing: boolean;
	readonly initializationError: string | null;
	readonly projectCount: number;
	readonly projectsLoading: boolean;
}): EnvironmentCatalogViewState => {
	if (!input.initialized) {
		return !input.initializing && input.initializationError !== null
			? "unavailable"
			: "loading";
	}
	return input.projectCount === 0 && !input.projectsLoading ? "empty" : "ready";
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

const apiGrantUrl = (grant: ApiConnectGrant): string => {
	const url = new URL(grant.endpoint.wsBaseUrl);
	url.searchParams.set("token", grant.connectToken);
	url.searchParams.set("wireVersion", String(WIRE_PROTOCOL_VERSION));
	return url.toString();
};

export const useEnvironmentCatalogStore = create<EnvironmentCatalogState>(
	(set, get) => {
		const apiRecords = new Map<string, ApiEnvironmentRecord>();
		const connectionAttempts = createConnectionAttemptCoordinator();
		const shellRuntimes = new Map<string, EnvironmentShellRuntime>();
		let activeShellKey: string | null = null;
		const initializeOnce = createInitializationGate();
		let discoveryRevision = 0;
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
		const applyShellView = (
			catalogKey: string,
			environmentId: string,
			view: ResourceView<EnvironmentShellData>,
		): void => {
			const status: CatalogConnectionStatus =
				view.connection === "connected"
					? "connected"
					: view.connection === "dormant" || view.connection === "offline"
						? "offline"
						: view.connection === "failed" ||
								view.connection === "blocked-auth" ||
								view.connection === "update-required" ||
								view.connection === "revoked"
							? "error"
							: "connecting";
			patchEntry(catalogKey, {
				status,
				error:
					status === "error"
						? getRendererClientBus().connection(
								EnvironmentId.make(environmentId),
							).error
						: null,
			});
			if (
				view.data !== null &&
				get().activeEnvironmentId === environmentId &&
				environmentBelongsToWorkspace(environmentId)
			) {
				projectEnvironmentShell(view.data);
			}
		};
		const retainShell = (
			catalogKey: string,
			environmentId: string,
			activation: "cache-only" | "connect",
		): EnvironmentShellRuntime => {
			const existing = shellRuntimes.get(catalogKey);
			if (existing !== undefined) {
				if (
					activation === "connect" &&
					existing.requestedActivation !== "connect"
				) {
					existing.requestedActivation = "connect";
					existing.lease.activate("connect");
				}
				return existing;
			}
			const ref = { environmentId: EnvironmentId.make(environmentId) };
			const retained = retainEnvironmentShell(ref, activation);
			const runtime: EnvironmentShellRuntime = {
				lifetime: new AbortController(),
				ref,
				lease: retained.lease,
				unsubscribe: subscribeEnvironmentShell(ref, (view) =>
					applyShellView(catalogKey, environmentId, view),
				),
				requestedActivation: activation,
			};
			shellRuntimes.set(catalogKey, runtime);
			applyShellView(catalogKey, environmentId, environmentShellSnapshot(ref));
			return runtime;
		};
		const stopEntryRuntime = (catalogKey: string): void => {
			const runtime = shellRuntimes.get(catalogKey);
			if (runtime === undefined) return;
			if (activeShellKey === catalogKey) activeShellKey = null;
			runtime.lifetime.abort();
			runtime.unsubscribe();
			runtime.lease.release();
			shellRuntimes.delete(catalogKey);
		};
		const accountEnvironmentIds = (): Set<string> =>
			new Set([
				...apiRecords.keys(),
				...get()
					.entries.filter((entry) => entry.connectionKind === "api")
					.map((entry) => entry.environmentId),
			]);
		const removeAccountEnvironments = (
			environmentIds: ReadonlySet<string>,
		): void => {
			if (environmentIds.size === 0) return;
			const state = get();
			const removed = state.entries.filter(
				(entry) =>
					entry.connectionKind === "api" &&
					environmentIds.has(entry.environmentId),
			);
			const activeTransientRemoved =
				environmentIds.has(state.activeEnvironmentId) &&
				shellRuntimes.has(`transient:${state.activeEnvironmentId}`);
			for (const id of environmentIds) {
				const key = `transient:${id}`;
				const transient = shellRuntimes.has(key);
				stopEntryRuntime(key);
				apiRecords.delete(id);
				if (transient || removed.some((entry) => entry.environmentId === id))
					void removeRendererEnvironment(id).catch(() => undefined);
			}
			for (const entry of removed) {
				stopEntryRuntime(entryKey(entry));
			}
			const activeRemoved =
				activeTransientRemoved ||
				removed.some(
					(entry) => entry.environmentId === state.activeEnvironmentId,
				);
			const local = state.entries.find(
				(entry) => entry.connectionKind === "local",
			);
			set({
				entries: state.entries.filter(
					(entry) =>
						entry.connectionKind !== "api" ||
						!environmentIds.has(entry.environmentId),
				),
				...(activeRemoved
					? {
							activeEnvironmentId:
								local?.environmentId ?? LOCAL_ENVIRONMENT_KEY,
						}
					: {}),
			});
			if (activeRemoved) {
				setActiveEnvironment(local?.environmentId ?? LOCAL_ENVIRONMENT_KEY);
				const localRuntime =
					local === undefined ? undefined : shellRuntimes.get(entryKey(local));
				if (localRuntime !== undefined && local !== undefined) {
					activeShellKey = entryKey(local);
					localRuntime.requestedActivation = "connect";
					void Promise.resolve(localRuntime.lease.activate("connect")).catch(
						() => undefined,
					);
				}
				activateAnnotationsEnvironment();
				useUiStore.getState().clearRevealedAnnotation();
				projectEnvironmentShell(
					(localRuntime === undefined
						? null
						: environmentShellSnapshot(localRuntime.ref).data) ?? {
						folders: [],
						originsByFolder: {},
						chatsByProject: {},
						sessionsByProject: {},
						creationOperationsByProject: {},
					},
					{ resetOptimisticState: true },
				);
			}
		};
		const unsubscribeAccount = subscribeRendererAccount(() => {
			discoveryRevision++;
			const removed = accountEnvironmentIds();
			for (const [key, runtime] of shellRuntimes) {
				if (key.startsWith("transient:"))
					removed.add(runtime.ref.environmentId);
			}
			removeAccountEnvironments(removed);
			set({ accountDiscoveryError: null });
			const account = rendererAccountSnapshot();
			if (get().initialized && typeof account.subject === "string") {
				void get()
					.syncAccountEnvironments()
					.catch((cause) => {
						if (rendererAccountSnapshot() === account)
							set({ accountDiscoveryError: errorMessage(cause) });
					});
			}
		});
		if (import.meta.hot) import.meta.hot.dispose(unsubscribeAccount);
		// This desktop's projects are split by workspace at read time. Re-project
		// on switch so stores never keep the previous workspace's projects.
		const unsubscribeWorkspace = subscribeRendererWorkspace(() => {
			const state = get();
			if (
				!state.initialized ||
				!isDesktopLocalEnvironment(state.activeEnvironmentId)
			)
				return;
			projectEnvironmentShell(
				environmentShellSnapshot({
					environmentId: EnvironmentId.make(state.activeEnvironmentId),
				}).data ?? {
					folders: [],
					originsByFolder: {},
					chatsByProject: {},
					sessionsByProject: {},
					creationOperationsByProject: {},
				},
				{ resetOptimisticState: true },
			);
		});
		if (import.meta.hot) import.meta.hot.dispose(unsubscribeWorkspace);
		const waitForShellData = (
			runtime: EnvironmentShellRuntime,
		): Promise<EnvironmentShellData> => {
			return new Promise((resolve, reject) => {
				let settled = false;
				let unsubscribe = (): void => undefined;
				const abort = (): void => {
					if (settled) return;
					settled = true;
					cleanup();
					reject(new Error("Environment subscription was removed."));
				};
				const cleanup = (): void => {
					unsubscribe();
					runtime.lifetime.signal.removeEventListener("abort", abort);
				};
				const finish = (view: ResourceView<EnvironmentShellData>): void => {
					if (settled) return;
					if (view.data !== null) {
						settled = true;
						cleanup();
						resolve(normalizeEnvironmentShellData(view.data));
						return;
					}
					if (
						view.connection === "failed" ||
						view.connection === "blocked-auth" ||
						view.connection === "update-required" ||
						view.connection === "revoked"
					) {
						settled = true;
						cleanup();
						reject(
							new Error(
								getRendererClientBus().connection(runtime.ref.environmentId)
									.error ?? "Unable to synchronize environment.",
							),
						);
					}
				};
				if (runtime.lifetime.signal.aborted) {
					abort();
					return;
				}
				runtime.lifetime.signal.addEventListener("abort", abort, {
					once: true,
				});
				unsubscribe = subscribeEnvironmentShell(runtime.ref, (view) => {
					finish(view);
				});
				if (settled) cleanup();
				finish(environmentShellSnapshot(runtime.ref));
			});
		};
		const activateRuntime = async (
			catalogKey: string,
			runtime: EnvironmentShellRuntime,
			environmentId: string,
			selection: EnvironmentActivation | undefined,
			fallback?: EnvironmentShellData,
		): Promise<Folder["id"] | null> => {
			const workspace = rendererWorkspaceSnapshot();
			if (!environmentBelongsToWorkspace(environmentId, workspace.scope))
				throw new Error("This environment belongs to another workspace.");
			runtime.requestedActivation = "connect";
			await runtime.lease.activate("connect");
			const data = await waitForShellData(runtime).catch((cause) => {
				if (fallback !== undefined)
					return normalizeEnvironmentShellData(fallback);
				throw cause;
			});
			// Connection work can finish after the user has opened another draft.
			// Check before changing either the active environment or its selection.
			if (
				selection?.isCurrent?.() === false ||
				rendererWorkspaceSnapshot() !== workspace
			)
				return null;
			if (shellRuntimes.get(catalogKey) !== runtime)
				throw new Error("Environment activation was superseded.");
			if (activeShellKey !== null && activeShellKey !== catalogKey) {
				const previous = shellRuntimes.get(activeShellKey);
				if (previous !== undefined) {
					previous.requestedActivation = "cache-only";
					previous.lease.activate("cache-only");
				}
			}
			activeShellKey = catalogKey;
			setActiveEnvironment(environmentId);
			set({ activeEnvironmentId: environmentId });
			activateAnnotationsEnvironment();
			useUiStore.getState().clearRevealedAnnotation();
			return projectEnvironmentShell(data, {
				...selection,
				resetOptimisticState: true,
			});
		};
		const completeConnection = async (input: {
			readonly catalogKey: string;
			readonly environmentId: string;
			readonly patch: Partial<EnvironmentCatalogEntry>;
			readonly isCurrent?: () => boolean;
		}): Promise<void> => {
			if (input.isCurrent?.() === false) return;
			patchEntry(input.catalogKey, {
				...input.patch,
				status: "connecting",
				error: null,
			});
			const runtime = retainShell(
				input.catalogKey,
				input.environmentId,
				"connect",
			);
			await runtime.lease.activate("connect");
		};
		const failConnection = (catalogKey: string, cause: unknown): void => {
			patchEntry(catalogKey, {
				status: "error",
				error: errorMessage(cause),
			});
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
					failConnection(catalogKey, cause);
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
				const client = await runtimeOperationClient(profile.environmentId);
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
					failConnection(catalogKey, cause);
				}
			});
		};
		const connectApi = (
			environment: ApiEnvironmentRecord,
			localEnvironmentId: string,
			replace = false,
		): Promise<void> => {
			const account = rendererAccountSnapshot();
			const catalogKey = `api:${environment.environmentId}`;
			return connectionAttempts.run(
				`${catalogKey}:account:${account.epoch}`,
				async (isAttemptCurrent) => {
					const isCurrent = () =>
						isAttemptCurrent() && rendererAccountSnapshot() === account;
					try {
						const { grant, localClient } = await (async () => {
							try {
								const localClient =
									await runtimeOperationClient(localEnvironmentId);
								assertRendererAccountCurrent(account);
								const grant = await Effect.runPromise(
									localClient["environments.connect"]({
										environmentId: environment.environmentId,
									}),
								);
								return { grant, localClient };
							} catch (cause) {
								throw new Error(`API grant failed: ${errorMessage(cause)}`);
							}
						})();
						if (!isCurrent()) return;
						registerApiEnvironment(
							environment.environmentId,
							apiGrantUrl(grant),
							async () =>
								apiGrantUrl(
									await Effect.runPromise(
										localClient["environments.connect"]({
											environmentId: environment.environmentId,
										}),
									),
								),
							account,
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
						failConnection(catalogKey, cause);
					}
				},
				replace,
			);
		};

		return {
			entries: [],
			activeEnvironmentId: LOCAL_ENVIRONMENT_KEY,
			initialized: false,
			initializing: false,
			initializationError: null,
			accountDiscoveryError: null,
			hiddenApiEnvironmentIds: [],
			initialize: () => {
				if (isHostedProduct()) {
					set({ initialized: true, initializing: false });
					return Promise.resolve();
				}
				return initializeOnce(get().initialized, async () => {
					markRendererStartupMilestone("environment-catalog-started");
					set({ initializing: true, initializationError: null });
					try {
						const localClient = await runtimeOperationClient(
							LOCAL_ENVIRONMENT_KEY,
						);
						const descriptor = await Effect.runPromise(
							localClient["connect.describe"](),
						);
						registerLocalEnvironment(descriptor.environmentId);
						setActiveEnvironment(descriptor.environmentId);

						const hiddenApiEnvironmentIds = readHiddenApiEnvironmentIds();
						const localEntry: EnvironmentCatalogEntry = {
							connectionKind: "local",
							environmentId: descriptor.environmentId,
							profileId: null,
							label: descriptor.label ?? "This computer",
							target: null,
							descriptor,
							status: "offline",
							error: null,
						};
						set({
							activeEnvironmentId: descriptor.environmentId,
							hiddenApiEnvironmentIds,
							entries: [localEntry],
						});

						const localRuntime = retainShell(
							entryKey(localEntry),
							localEntry.environmentId,
							"cache-only",
						);
						// Discover the desktop in any workspace, but only activate its
						// Personal shell while that workspace is selected.
						if (environmentBelongsToWorkspace(localEntry.environmentId)) {
							await activateRuntime(
								entryKey(localEntry),
								localRuntime,
								localEntry.environmentId,
								undefined,
							);
						} else {
							useWorkspaceStore.setState({ loading: false, error: null });
						}
						set({ initialized: true, initializationError: null });

						// Remote catalogs are optional. A corrupt saved profile or an
						// unavailable account service must never hide the local workspace.
						const account = rendererAccountSnapshot();
						const revision = ++discoveryRevision;
						const { profiles, tailnetProfiles, apiEnvironments, apiError } =
							await loadOptionalEnvironmentSources({
								sshProfiles:
									window.zuse?.ssh?.listProfiles() ?? Promise.resolve([]),
								tailnetProfiles:
									window.zuse?.tailnet?.listProfiles() ?? Promise.resolve([]),
								apiEnvironments:
									typeof account.subject === "string"
										? Effect.runPromise(localClient["environments.list"]())
										: Promise.resolve({ environments: [] }),
							});
						const profileEnvironmentIds = new Set<string>(
							[...profiles, ...tailnetProfiles].map(
								(profile) => profile.environmentId,
							),
						);
						const hiddenApiIds = new Set(hiddenApiEnvironmentIds);
						// A sign-in refresh can finish before saved device profiles load.
						// Retire any API route before the same host becomes device-owned.
						removeAccountEnvironments(profileEnvironmentIds);
						const currentDiscovery =
							rendererAccountSnapshot() === account &&
							discoveryRevision === revision;
						const accountApiEnvironments = apiEnvironments.filter(
							(environment) =>
								currentDiscovery &&
								environment.environmentId !== descriptor.environmentId &&
								!profileEnvironmentIds.has(environment.environmentId),
						);
						for (const environment of accountApiEnvironments) {
							apiRecords.set(environment.environmentId, environment);
						}
						const optionalEntries = [
							...accountApiEnvironments
								.filter(
									(environment) => !hiddenApiIds.has(environment.environmentId),
								)
								.map(apiEntry),
							...profiles.map(profileEntry),
							...tailnetProfiles.map(tailnetProfileEntry),
						];
						set((state) => ({
							accountDiscoveryError: currentDiscovery
								? apiError
								: state.accountDiscoveryError,
							entries: orderEnvironmentCatalog([
								...state.entries.filter(
									(entry) =>
										entry.connectionKind === "local" ||
										(!currentDiscovery &&
											entry.connectionKind === "api" &&
											!profileEnvironmentIds.has(entry.environmentId)),
								),
								...optionalEntries,
							]),
						}));
						for (const entry of optionalEntries) {
							retainShell(entryKey(entry), entry.environmentId, "cache-only");
						}
					} catch (cause) {
						const message = errorMessage(cause);
						set({ initialized: false, initializationError: message });
						useWorkspaceStore.setState({ loading: false, error: message });
						throw cause;
					} finally {
						set({ initializing: false });
					}
				});
			},
			syncAccountEnvironments: async () => {
				const account = rendererAccountSnapshot();
				if (typeof account.subject !== "string") return;
				const revision = ++discoveryRevision;
				const isCurrent = () =>
					rendererAccountSnapshot() === account &&
					discoveryRevision === revision;
				const local = get().entries.find(
					(entry) => entry.connectionKind === "local",
				);
				if (local === undefined) {
					await get().initialize();
					return;
				}

				const localClient = await runtimeOperationClient(local.environmentId);
				if (!isCurrent()) return;
				const result = await Effect.runPromise(
					localClient["environments.list"](),
				).catch((cause) => {
					if (isCurrent()) throw cause;
					return null;
				});
				if (result === null || !isCurrent()) return;
				set({ accountDiscoveryError: null });
				const profileEnvironmentIds = new Set(
					get()
						.entries.filter(
							(entry) =>
								entry.connectionKind === "ssh" ||
								entry.connectionKind === "tailnet",
						)
						.map((entry) => entry.environmentId),
				);
				const hiddenApiIds = new Set(get().hiddenApiEnvironmentIds);
				const accountEnvironments = result.environments.filter(
					(environment) =>
						environment.environmentId !== local.environmentId &&
						!profileEnvironmentIds.has(environment.environmentId),
				);
				const available = new Set<string>(
					accountEnvironments.map((environment) => environment.environmentId),
				);
				removeAccountEnvironments(
					new Set(
						[...accountEnvironmentIds()].filter((id) => !available.has(id)),
					),
				);
				for (const environment of accountEnvironments) {
					apiRecords.set(environment.environmentId, environment);
				}
				// Refresh presence for computers already in the catalog. A computer
				// whose heartbeat just turned fresh came back from sleep or a network
				// drop: skip its retry backoff so it reconnects right away.
				const now = Date.now();
				const cameOnline: string[] = [];
				set((state) => ({
					entries: state.entries.map((entry) => {
						if (entry.connectionKind !== "api") return entry;
						const record = apiRecords.get(entry.environmentId);
						if (
							record === undefined ||
							record.lastHeartbeat === entry.lastHeartbeat
						)
							return entry;
						if (
							isEnvironmentPresenceFresh(record.lastHeartbeat, now) &&
							!isEnvironmentPresenceFresh(entry.lastHeartbeat, now) &&
							entry.status !== "connected"
						)
							cameOnline.push(entry.environmentId);
						return { ...entry, lastHeartbeat: record.lastHeartbeat };
					}),
				}));
				for (const environmentId of cameOnline) {
					getRendererClientBus().retryConnection(
						EnvironmentId.make(environmentId),
					);
				}

				const knownEnvironmentIds = new Set(
					get().entries.map((entry) => entry.environmentId),
				);
				const added = accountEnvironments.filter(
					(environment) =>
						!hiddenApiIds.has(environment.environmentId) &&
						!knownEnvironmentIds.has(environment.environmentId),
				);
				if (added.length > 0)
					set((state) => ({
						entries: orderEnvironmentCatalog([
							...state.entries,
							...added.map(apiEntry),
						]),
					}));
				for (const environment of added) {
					retainShell(
						`api:${environment.environmentId}`,
						environment.environmentId,
						"cache-only",
					);
				}
			},
			add: async (target, label) => {
				const bridge = window.zuse?.ssh;
				if (bridge === undefined) throw new Error("SSH is unavailable.");
				const connection = await bridge.ensureEnvironment({ target, label });
				const apiKey = `api:${connection.profile.environmentId}`;
				const duplicateApi = get().entries.some(
					(entry) =>
						entry.connectionKind === "api" &&
						entry.environmentId === connection.profile.environmentId,
				);
				if (
					duplicateApi &&
					get().activeEnvironmentId === connection.profile.environmentId
				) {
					await bridge.removeProfile(connection.profile.profileId);
					throw new Error(
						"Switch to another computer before replacing this api connection with SSH.",
					);
				}
				if (duplicateApi) {
					stopEntryRuntime(apiKey);
					await removeRendererEnvironment(connection.profile.environmentId);
					set((state) => ({
						entries: state.entries.filter(
							(entry) => entryKey(entry) !== apiKey,
						),
					}));
				}
				registerWebSocketEnvironment(
					connection.profile.environmentId,
					connection.descriptor.endpoint.wsBaseUrl,
				);
				const next = {
					...profileEntry(connection.profile),
					descriptor: connection.descriptor,
				};
				set((state) => ({
					entries: orderEnvironmentCatalog([
						...state.entries.filter(
							(entry) => entry.profileId !== next.profileId,
						),
						next,
					]),
				}));
				retainShell(
					`ssh:${connection.profile.profileId}`,
					connection.profile.environmentId,
					"cache-only",
				);
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
					duplicate?.connectionKind === "api" ||
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
				retainShell(
					`tailnet:${connection.profile.profileId}`,
					connection.profile.environmentId,
					"cache-only",
				);
				try {
					await connectTailnetConnection(connection);
				} catch (cause) {
					const catalogKey = `tailnet:${connection.profile.profileId}`;
					patchEntry(catalogKey, {
						status: "error",
						error: errorMessage(cause),
					});
					throw cause;
				}
				return (
					get().entries.find(
						(entry) => entry.profileId === connection.profile.profileId,
					)?.label ?? connection.profile.label
				);
			},
			retry: async (profileId) => {
				const entry = get().entries.find(
					(item) => item.profileId === profileId,
				);
				if (entry?.connectionKind === "tailnet") {
					await connectTailnetProfile(profileId);
					return;
				}
				await connectProfile(profileId);
			},
			retryEnvironment: async (environmentId) => {
				const entry = get().entries.find(
					(candidate) => candidate.environmentId === environmentId,
				);
				if (entry?.connectionKind === "local") {
					const catalogKey = entryKey(entry);
					const runtime = retainShell(catalogKey, environmentId, "connect");
					patchEntry(catalogKey, { status: "connecting", error: null });
					getRendererClientBus().retryConnection(
						EnvironmentId.make(environmentId),
					);
					await runtime.lease.activate("connect");
					return;
				}
				const environment = apiRecords.get(environmentId);
				const local = get().entries.find(
					(entry) => entry.connectionKind === "local",
				);
				if (environment === undefined || local === undefined) return;
				patchEntry(`api:${environmentId}`, {
					status: "connecting",
					error: null,
				});
				await connectApi(environment, local.environmentId);
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
						"API grant failed: local environment is unavailable.",
					);
				const localClient = await runtimeOperationClient(local.environmentId);
				const listed = await Effect.runPromise(
					localClient["environments.list"](),
				).catch((cause) => {
					throw new Error(`API grant failed: ${errorMessage(cause)}`);
				});
				const environment = listed.environments.find(
					(candidate) => candidate.environmentId === environmentId,
				);
				if (environment === undefined)
					throw new Error(
						"API grant failed: cloud environment is not registered.",
					);
				apiRecords.set(environment.environmentId, environment);
				const catalogKey = `api:${environment.environmentId}`;
				const existing = get().entries.find(
					(candidate) => candidate.environmentId === environmentId,
				);
				if (existing === undefined) {
					set((state) => ({
						entries: orderEnvironmentCatalog([
							...state.entries,
							apiEntry(environment),
						]),
					}));
				} else {
					patchEntry(catalogKey, { status: "connecting", error: null });
				}
				await connectApi(environment, local.environmentId, true);
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
			hideApiEnvironment: async (environmentId) => {
				if (get().activeEnvironmentId === environmentId) {
					throw new Error("Switch to another computer before hiding this one.");
				}
				const current = readHiddenApiEnvironmentIds();
				const hiddenApiEnvironmentIds = current.includes(environmentId)
					? current
					: [...current, environmentId];
				writeHiddenApiEnvironmentIds(hiddenApiEnvironmentIds);
				const catalogKey = `api:${environmentId}`;
				stopEntryRuntime(catalogKey);
				await removeRendererEnvironment(environmentId).catch(() => undefined);
				set((state) => ({
					hiddenApiEnvironmentIds,
					entries: state.entries.filter(
						(entry) => entryKey(entry) !== catalogKey,
					),
				}));
			},
			unhideApiEnvironments: async () => {
				const hidden = readHiddenApiEnvironmentIds();
				writeHiddenApiEnvironmentIds([]);
				set({ hiddenApiEnvironmentIds: [] });
				const local = get().entries.find(
					(entry) => entry.connectionKind === "local",
				);
				if (hidden.length === 0 || local === undefined) return;
				const records = hidden
					.map((environmentId) => apiRecords.get(environmentId))
					.filter(
						(record): record is ApiEnvironmentRecord => record !== undefined,
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
						...records.map(apiEntry),
					]),
				}));
				for (const record of records) {
					retainShell(
						`api:${record.environmentId}`,
						record.environmentId,
						"cache-only",
					);
				}
			},
			activate: async (environmentId, selection) => {
				const account = rendererAccountSnapshot();
				const workspace = rendererWorkspaceSnapshot();
				if (!environmentBelongsToWorkspace(environmentId, workspace.scope))
					throw new Error("This environment belongs to another workspace.");
				let entry = get().entries.find(
					(item) => item.environmentId === environmentId,
				);
				if (entry === undefined) {
					const catalogKey = `transient:${environmentId}`;
					const runtime = shellRuntimes.get(catalogKey);
					return runtime === undefined
						? null
						: activateRuntime(catalogKey, runtime, environmentId, selection);
				}
				if (entry.connectionKind === "ssh" && entry.profileId !== null) {
					await connectProfile(entry.profileId);
				} else if (
					entry.connectionKind === "tailnet" &&
					entry.profileId !== null
				) {
					await connectTailnetProfile(entry.profileId);
				} else if (entry.connectionKind === "api") {
					const api = apiRecords.get(environmentId);
					const local = get().entries.find(
						(candidate) => candidate.connectionKind === "local",
					);
					if (api === undefined || local === undefined) {
						throw new Error("API environment is unavailable.");
					}
					await connectApi(api, local.environmentId);
					assertRendererAccountCurrent(account);
				}
				entry = get().entries.find(
					(item) => item.environmentId === environmentId,
				);
				if (entry === undefined || entry.status === "error") {
					throw new Error(entry?.error ?? "Unable to connect to environment.");
				}
				const catalogKey = entryKey(entry);
				if (rendererWorkspaceSnapshot() !== workspace) return null;
				const runtime = retainShell(catalogKey, environmentId, "connect");
				return activateRuntime(catalogKey, runtime, environmentId, selection);
			},
			activateTransient: async (environmentId, fallback, selection) => {
				const catalogKey = `transient:${environmentId}`;
				const runtime = retainShell(catalogKey, environmentId, "connect");
				return activateRuntime(
					catalogKey,
					runtime,
					environmentId,
					selection,
					fallback,
				);
			},
		};
	},
);
