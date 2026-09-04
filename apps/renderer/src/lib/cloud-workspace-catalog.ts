import {
	type ChatId,
	CloudChatSummary,
	type EnvironmentId,
	type FolderId,
	type SessionId,
} from "@zuse/contracts";
import { Schema } from "effect";

import { createAtomStore as create } from "../state/atom-store.ts";
import { cloudChatCatalogPersistence } from "./session-timeline-cache.ts";

export type CloudSyncPrefs = Readonly<{
	enabled: boolean;
}>;

/** Preserve the existing default-on behavior until a user explicitly disables sync. */
export const cloudSyncPreferenceEnabled = (
	prefs: CloudSyncPrefs | null | undefined,
): boolean => prefs?.enabled !== false;

type CloudChatCatalogState = Readonly<{
	summaries: ReadonlyArray<CloudChatSummary>;
	localProjectByEnvironment: Readonly<Record<string, FolderId>>;
	archiveIntents: Readonly<
		Record<string, { readonly commandId: string; readonly requestedAt: number }>
	>;
	syncPrefs: Readonly<Record<string, CloudSyncPrefs>>;
}>;

const EMPTY_CATALOG: CloudChatCatalogState = {
	summaries: [],
	localProjectByEnvironment: {},
	archiveIntents: {},
	syncPrefs: {},
};
const LEGACY_CLOUD_CATALOG_STORAGE_KEY = "zuse:cloud-chat-catalog:v1";

const decodePersistedCatalog = (value: unknown): CloudChatCatalogState => {
	try {
		if (typeof value !== "object" || value === null) return EMPTY_CATALOG;
		const parsed = value as Readonly<Record<string, unknown>>;
		const summaries = Array.isArray(parsed.summaries)
			? parsed.summaries.flatMap((value) => {
					try {
						return [Schema.decodeUnknownSync(CloudChatSummary)(value)];
					} catch {
						return [];
					}
				})
			: [];
		const projects =
			typeof parsed.localProjectByEnvironment === "object" &&
			parsed.localProjectByEnvironment !== null
				? Object.fromEntries(
						Object.entries(parsed.localProjectByEnvironment).filter(
							(entry): entry is [string, FolderId] =>
								typeof entry[1] === "string",
						),
					)
				: {};
		const archiveIntents =
			typeof parsed.archiveIntents === "object" &&
			parsed.archiveIntents !== null
				? Object.fromEntries(
						Object.entries(parsed.archiveIntents).flatMap(
							([workspaceId, entry]) =>
								typeof entry === "object" &&
								entry !== null &&
								"commandId" in entry &&
								typeof entry.commandId === "string" &&
								"requestedAt" in entry &&
								typeof entry.requestedAt === "number"
									? [
											[
												workspaceId,
												{
													commandId: entry.commandId,
													requestedAt: entry.requestedAt,
												},
											],
										]
									: [],
						),
					)
				: {};
		const syncPrefs =
			typeof parsed.syncPrefs === "object" && parsed.syncPrefs !== null
				? Object.fromEntries(
						Object.entries(parsed.syncPrefs).flatMap(([workspaceId, entry]) =>
							typeof entry === "object" &&
							entry !== null &&
							"enabled" in entry &&
							typeof entry.enabled === "boolean"
								? [[workspaceId, { enabled: entry.enabled }]]
								: [],
						),
					)
				: {};
		return {
			summaries,
			localProjectByEnvironment: projects,
			archiveIntents,
			syncPrefs,
		};
	} catch {
		return EMPTY_CATALOG;
	}
};

const sortSummaries = (
	summaries: ReadonlyArray<CloudChatSummary>,
): ReadonlyArray<CloudChatSummary> =>
	[...summaries].sort(
		(left, right) =>
			(right.lastMessageAt ?? right.createdAt) -
			(left.lastMessageAt ?? left.createdAt),
	);

/** Lifecycle revision fences runtime generations. Within one lifecycle
 * revision, API's runtime summary revision owns title/activity metadata and
 * its represented session head. `updatedAt` is only a compatibility fallback
 * for summaries decoded before runtime revisions were introduced. */
export const compareCloudChatSummaryVersion = (
	left: CloudChatSummary,
	right: CloudChatSummary,
): number =>
	left.revision !== right.revision
		? left.revision - right.revision
		: left.summaryRevision !== right.summaryRevision
			? left.summaryRevision - right.summaryRevision
			: left.sessionHeadVersion !== right.sessionHeadVersion
				? left.sessionHeadVersion - right.sessionHeadVersion
				: left.updatedAt - right.updatedAt;

export const mergeCloudChatSummaries = (
	current: ReadonlyArray<CloudChatSummary>,
	incoming: ReadonlyArray<CloudChatSummary>,
): ReadonlyArray<CloudChatSummary> => {
	const byEnvironment = new Map(
		current.map((summary) => [summary.workspaceId, summary]),
	);
	for (const summary of incoming) {
		const previous = byEnvironment.get(summary.workspaceId);
		const comparison =
			previous === undefined
				? 1
				: compareCloudChatSummaryVersion(summary, previous);
		if (previous === undefined || comparison > 0) {
			byEnvironment.set(summary.workspaceId, summary);
			continue;
		}
		if (comparison === 0) {
			byEnvironment.set(summary.workspaceId, {
				...previous,
				unread: previous.unread || summary.unread,
				lastMessageAt:
					previous.lastMessageAt === null
						? summary.lastMessageAt
						: summary.lastMessageAt === null
							? previous.lastMessageAt
							: Math.max(previous.lastMessageAt, summary.lastMessageAt),
			});
		}
	}
	return sortSummaries([...byEnvironment.values()]);
};

export const useCloudChatCatalogStore = create<CloudChatCatalogState>(
	() => EMPTY_CATALOG,
);

let catalogPersistenceReady = false;
let catalogHydration: Promise<void> | null = null;
export const hydrateCloudChatCatalogPersistence = async (): Promise<void> => {
	if (catalogPersistenceReady || cloudChatCatalogPersistence === null) return;
	catalogHydration ??= (async () => {
		let stored = await cloudChatCatalogPersistence.load().catch(() => null);
		if (stored === null && typeof window !== "undefined") {
			try {
				const legacy = window.localStorage.getItem(
					LEGACY_CLOUD_CATALOG_STORAGE_KEY,
				);
				stored = legacy === null ? null : JSON.parse(legacy);
				window.localStorage.removeItem(LEGACY_CLOUD_CATALOG_STORAGE_KEY);
			} catch {
				// A malformed or unavailable prototype catalog is safe to ignore.
			}
		}
		const persisted = decodePersistedCatalog(stored);
		useCloudChatCatalogStore.setState((current) => ({
			summaries: mergeCloudChatSummaries(
				persisted.summaries,
				current.summaries,
			),
			localProjectByEnvironment: {
				...persisted.localProjectByEnvironment,
				...current.localProjectByEnvironment,
			},
			archiveIntents: {
				...persisted.archiveIntents,
				...current.archiveIntents,
			},
			syncPrefs: {
				...persisted.syncPrefs,
				...current.syncPrefs,
			},
		}));
		catalogPersistenceReady = true;
		await cloudChatCatalogPersistence
			.save(useCloudChatCatalogStore.getState())
			.catch(() => undefined);
	})();
	await catalogHydration;
};

void hydrateCloudChatCatalogPersistence();
let catalogWriteTail = Promise.resolve();
useCloudChatCatalogStore.subscribe((state) => {
	if (!catalogPersistenceReady) return;
	catalogWriteTail = catalogWriteTail
		.then(() => cloudChatCatalogPersistence?.save(state))
		.then(() => undefined)
		.catch(() => undefined);
});

export const optimisticallyArchiveCloudChat = (
	summary: CloudChatSummary,
	archivedAt: number,
	commandId: string,
): CloudChatSummary => {
	const optimistic = {
		...summary,
		desiredState: "archived" as const,
		archivedAt,
	};
	useCloudChatCatalogStore.setState((state) => ({
		...state,
		archiveIntents: {
			...state.archiveIntents,
			[summary.workspaceId]: { commandId, requestedAt: archivedAt },
		},
		summaries: state.summaries.map((candidate) =>
			candidate.workspaceId === summary.workspaceId ? optimistic : candidate,
		),
	}));
	return optimistic;
};

export const optimisticallyUnarchiveCloudChat = (
	summary: CloudChatSummary,
): CloudChatSummary => {
	const optimistic = {
		...summary,
		state: "paused" as const,
		desiredState: "paused" as const,
		runtimeState: "offline" as const,
		statusCode: "unarchive-queued",
		archivedAt: undefined,
	};
	useCloudChatCatalogStore.setState((state) => {
		const archiveIntents = { ...state.archiveIntents };
		delete archiveIntents[summary.workspaceId];
		return {
			...state,
			archiveIntents,
			summaries: state.summaries.map((candidate) =>
				candidate.workspaceId === summary.workspaceId ? optimistic : candidate,
			),
		};
	});
	return optimistic;
};

export const registerCloudChat = (
	summary: CloudChatSummary,
	projectId?: FolderId,
): void => {
	useCloudChatCatalogStore.setState((state) => ({
		summaries: mergeCloudChatSummaries(state.summaries, [summary]),
		localProjectByEnvironment:
			projectId === undefined
				? state.localProjectByEnvironment
				: {
						...state.localProjectByEnvironment,
						[summary.workspaceId]: projectId,
					},
	}));
};

export const cloudSyncPrefsFor = (workspaceId: string): CloudSyncPrefs | null =>
	useCloudChatCatalogStore.getState().syncPrefs[workspaceId] ?? null;

export const setCloudSyncPrefs = (
	workspaceId: string,
	prefs: CloudSyncPrefs | null,
): void => {
	useCloudChatCatalogStore.setState((state) => {
		const syncPrefs = { ...state.syncPrefs };
		if (prefs === null) delete syncPrefs[workspaceId];
		else syncPrefs[workspaceId] = prefs;
		return { ...state, syncPrefs };
	});
};

export const forgetCloudChat = (workspaceId: string): void => {
	useCloudChatCatalogStore.setState((state) => ({
		summaries: state.summaries.filter(
			(summary) => summary.workspaceId !== workspaceId,
		),
		localProjectByEnvironment: Object.fromEntries(
			Object.entries(state.localProjectByEnvironment).filter(
				([environmentId]) => environmentId !== workspaceId,
			),
		),
		archiveIntents: Object.fromEntries(
			Object.entries(state.archiveIntents).filter(
				([environmentId]) => environmentId !== workspaceId,
			),
		),
	}));
};

/**
 * Reconciles a successful `scope=all` response. API owns catalog membership,
 * so a workspace omitted from that authoritative response was deleted and must
 * not survive as a renderer-only history row. Versions for workspaces which
 * are still present remain monotonic.
 */
export const reconcileCloudChatCatalog = (
	incoming: ReadonlyArray<CloudChatSummary>,
): ReadonlyArray<CloudChatSummary> => {
	const incomingIds = new Set(incoming.map((summary) => summary.workspaceId));
	const previous = useCloudChatCatalogStore.getState();
	const removed = previous.summaries.filter(
		(summary) => !incomingIds.has(summary.workspaceId),
	);
	const summaries = incoming.flatMap((summary) => {
		const intent = previous.archiveIntents[summary.workspaceId];
		const protectedSummary =
			intent === undefined || summary.state === "archived"
				? summary
				: {
						...summary,
						desiredState: "archived" as const,
						archivedAt: intent.requestedAt,
					};
		const current = previous.summaries.find(
			(candidate) => candidate.workspaceId === summary.workspaceId,
		);
		return mergeCloudChatSummaries(current === undefined ? [] : [current], [
			protectedSummary,
		]);
	});
	useCloudChatCatalogStore.setState({
		summaries: sortSummaries(summaries),
		localProjectByEnvironment: Object.fromEntries(
			Object.entries(previous.localProjectByEnvironment).filter(
				([environmentId]) => incomingIds.has(environmentId),
			),
		),
		archiveIntents: Object.fromEntries(
			Object.entries(previous.archiveIntents).filter(([environmentId]) => {
				if (!incomingIds.has(environmentId)) return false;
				const authoritative = incoming.find(
					(summary) => summary.workspaceId === environmentId,
				);
				if (authoritative?.state !== "archived") return true;
				const current = previous.summaries.find(
					(summary) => summary.workspaceId === environmentId,
				);
				return (
					current !== undefined &&
					compareCloudChatSummaryVersion(authoritative, current) < 0
				);
			}),
		),
	});
	return removed;
};

export const cloudSummaryForChat = (chatId: string): CloudChatSummary | null =>
	useCloudChatCatalogStore
		.getState()
		.summaries.find((summary) => summary.chatId === chatId) ?? null;

export const cloudSummaryForSession = (
	sessionId: SessionId,
): CloudChatSummary | null =>
	useCloudChatCatalogStore
		.getState()
		.summaries.find((summary) => summary.initialSessionId === sessionId) ??
	null;

/**
 * Resolve cloud ownership for a selected chat surface.
 *
 * A catalog row only carries the workspace's initial session id, while every
 * later tab keeps the same chat id. Prefer the chat identity so secondary
 * sessions never fall back to whichever environment happens to be globally
 * active; retain the session lookup for startup selections whose chat row has
 * not hydrated yet.
 */
export const findCloudSummaryForSelection = (
	summaries: ReadonlyArray<CloudChatSummary>,
	{
		chatId,
		sessionId,
	}: {
		readonly chatId: ChatId | null;
		readonly sessionId: SessionId | null;
	},
): CloudChatSummary | null => {
	if (chatId !== null) {
		const byChat = summaries.find((summary) => summary.chatId === chatId);
		if (byChat !== undefined) return byChat;
	}
	return sessionId === null
		? null
		: (summaries.find((summary) => summary.initialSessionId === sessionId) ??
				null);
};

export const cloudSummaryForSelection = (input: {
	readonly chatId: ChatId | null;
	readonly sessionId: SessionId | null;
}): CloudChatSummary | null =>
	findCloudSummaryForSelection(
		useCloudChatCatalogStore.getState().summaries,
		input,
	);

export const cloudSummaryForEnvironment = (
	environmentId: EnvironmentId | string,
): CloudChatSummary | null =>
	useCloudChatCatalogStore
		.getState()
		.summaries.find((summary) => summary.workspaceId === environmentId) ?? null;

export const localProjectForCloudEnvironment = (
	environmentId: EnvironmentId | string,
): FolderId | null =>
	useCloudChatCatalogStore.getState().localProjectByEnvironment[
		environmentId
	] ?? null;

export const localProjectForCloudChat = (chatId: string): FolderId | null => {
	const summary = cloudSummaryForChat(chatId);
	return summary === null
		? null
		: localProjectForCloudEnvironment(summary.workspaceId);
};

let refreshCatalog: (() => Promise<void>) | null = null;

export const registerCloudChatCatalogRefresh = (
	refresh: () => Promise<void>,
): void => {
	refreshCatalog = refresh;
};

export const refreshCloudChatCatalog = (): Promise<void> =>
	refreshCatalog?.() ?? Promise.resolve();
