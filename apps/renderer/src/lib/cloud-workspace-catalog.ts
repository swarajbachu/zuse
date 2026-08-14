import {
	CloudChatSummary,
	type EnvironmentId,
	type FolderId,
	type SessionId,
} from "@zuse/contracts";
import { Schema } from "effect";

import { createAtomStore as create } from "../state/atom-store.ts";

type CloudChatCatalogState = Readonly<{
	summaries: ReadonlyArray<CloudChatSummary>;
	localProjectByEnvironment: Readonly<Record<string, FolderId>>;
}>;

const CLOUD_CATALOG_STORAGE_KEY = "zuse:cloud-chat-catalog:v1";

const loadPersistedCatalog = (): CloudChatCatalogState => {
	if (typeof window === "undefined")
		return { summaries: [], localProjectByEnvironment: {} };
	try {
		const raw = window.localStorage.getItem(CLOUD_CATALOG_STORAGE_KEY);
		if (raw === null) return { summaries: [], localProjectByEnvironment: {} };
		const parsed = JSON.parse(raw) as Readonly<Record<string, unknown>>;
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
		return { summaries, localProjectByEnvironment: projects };
	} catch {
		return { summaries: [], localProjectByEnvironment: {} };
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
 * revision, Relay's runtime summary revision owns title/activity metadata and
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

export const useCloudChatCatalogStore = create<CloudChatCatalogState>(() =>
	loadPersistedCatalog(),
);

if (typeof window !== "undefined") {
	useCloudChatCatalogStore.subscribe((state) => {
		try {
			window.localStorage.setItem(
				CLOUD_CATALOG_STORAGE_KEY,
				JSON.stringify(state),
			);
		} catch {
			// Storage can be unavailable in hardened/private contexts. The durable
			// IndexedDB transcript checkpoint remains the primary local snapshot.
		}
	});
}

export const optimisticallyArchiveCloudChat = (
	summary: CloudChatSummary,
	archivedAt: number,
): CloudChatSummary => {
	const optimistic = {
		...summary,
		desiredState: "archived" as const,
		archivedAt,
	};
	useCloudChatCatalogStore.setState((state) => ({
		...state,
		summaries: state.summaries.map((candidate) =>
			candidate.workspaceId === summary.workspaceId ? optimistic : candidate,
		),
	}));
	return optimistic;
};

export const rollbackOptimisticCloudArchive = (
	previous: CloudChatSummary,
	archivedAt: number,
): void => {
	useCloudChatCatalogStore.setState((state) => ({
		...state,
		summaries: state.summaries.map((candidate) =>
			candidate.workspaceId === previous.workspaceId &&
			candidate.revision === previous.revision &&
			candidate.archivedAt === archivedAt
				? previous
				: candidate,
		),
	}));
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

/**
 * Reconciles a successful `scope=all` response. Relay owns catalog membership,
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
		const current = previous.summaries.find(
			(candidate) => candidate.workspaceId === summary.workspaceId,
		);
		return mergeCloudChatSummaries(current === undefined ? [] : [current], [
			summary,
		]);
	});
	useCloudChatCatalogStore.setState({
		summaries: sortSummaries(summaries),
		localProjectByEnvironment: Object.fromEntries(
			Object.entries(previous.localProjectByEnvironment).filter(
				([environmentId]) => incomingIds.has(environmentId),
			),
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
