import type {
	Chat,
	Folder,
	Message,
	PermissionMode,
	ProviderId,
	RuntimeMode,
	Session,
	SessionStatus,
	WorktreeId,
} from "@zuse/contracts";
import { Effect, Fiber, Stream } from "effect";
import { Atom } from "effect/unstable/reactivity";

import { connectionSessionKey } from "~/lib/session-key";
import { readSessionsSnapshot, writeSessionsSnapshot } from "~/offline/cache";
import {
	markChatRead as markChatReadRpc,
	renameChat as renameChatRpc,
	setSessionPermissionMode as setSessionPermissionModeRpc,
	setSessionRuntimeMode as setSessionRuntimeModeRpc,
} from "~/rpc/actions";
import { getConnectionClient, reportConnectionFailure } from "~/rpc/connection";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";

import { messagesBySessionAtom } from "./messages";
import { appAtomRegistry, batchAtomUpdates } from "./registry";

export type ProjectBundle = {
	project: Folder;
	chats: readonly Chat[];
	sessions: readonly Session[];
};

export const bundlesByConnectionAtom = Atom.make<
	Record<string, ProjectBundle[]>
>({}).pipe(Atom.keepAlive);
export const statusBySessionAtom = Atom.make<Record<string, SessionStatus>>(
	{},
).pipe(Atom.keepAlive);
export const errorByConnectionAtom = Atom.make<Record<string, string | null>>(
	{},
).pipe(Atom.keepAlive);
export const loadingByConnectionAtom = Atom.make<Record<string, boolean>>(
	{},
).pipe(Atom.keepAlive);

const EMPTY_BUNDLES: ProjectBundle[] = [];

/** Per-connection bundles; notifies only when this connection's change. */
export const connectionBundlesAtom = Atom.family((connKey: string) =>
	Atom.make((get) => get(bundlesByConnectionAtom)[connKey] ?? EMPTY_BUNDLES),
);
/** Per-session status; notifies only when this session's status changes. */
export const sessionStatusAtom = Atom.family((sessionKey: string) =>
	Atom.make((get) => get(statusBySessionAtom)[sessionKey]),
);
export const connectionSessionsErrorAtom = Atom.family((connKey: string) =>
	Atom.make((get) => get(errorByConnectionAtom)[connKey] ?? null),
);
export const connectionSessionsLoadingAtom = Atom.family((connKey: string) =>
	Atom.make((get) => get(loadingByConnectionAtom)[connKey] === true),
);

const chatFibers = new Map<string, Fiber.Fiber<unknown, unknown>>();
const sessionSummaryFibers = new Map<string, Fiber.Fiber<unknown, unknown>>();

const stopFiber = async (
	key: string,
	map: Map<string, Fiber.Fiber<unknown, unknown>>,
) => {
	const fiber = map.get(key);
	if (fiber !== undefined) {
		map.delete(key);
		await Effect.runPromise(Fiber.interrupt(fiber)).catch(() => {});
	}
};

export const resetSessionsRuntime = async (): Promise<void> => {
	await Promise.all([
		...Array.from(chatFibers.keys(), (key) => stopFiber(key, chatFibers)),
		...Array.from(sessionSummaryFibers.keys(), (key) =>
			stopFiber(key, sessionSummaryFibers),
		),
	]);
	batchAtomUpdates(() => {
		appAtomRegistry.set(bundlesByConnectionAtom, {});
		appAtomRegistry.set(statusBySessionAtom, {});
		appAtomRegistry.set(errorByConnectionAtom, {});
		appAtomRegistry.set(loadingByConnectionAtom, {});
	});
};

const currentBundles = (connKey: string): ProjectBundle[] =>
	appAtomRegistry.get(bundlesByConnectionAtom)[connKey] ?? [];

const setConnectionBundles = (
	connKey: string,
	bundles: ProjectBundle[],
): void => {
	appAtomRegistry.update(bundlesByConnectionAtom, (state) => ({
		...state,
		[connKey]: bundles,
	}));
};

const setConnectionError = (connKey: string, error: string | null): void => {
	appAtomRegistry.update(errorByConnectionAtom, (state) => ({
		...state,
		[connKey]: error,
	}));
};

const setConnectionLoading = (connKey: string, loading: boolean): void => {
	appAtomRegistry.update(loadingByConnectionAtom, (state) => ({
		...state,
		[connKey]: loading,
	}));
};

const messageOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

export const archiveChat = async (
	connKey: string,
	options: WsProtocolOptions,
	chatId: Chat["id"],
): Promise<void> => {
	const previous = currentBundles(connKey);
	setConnectionBundles(connKey, removeChat(previous, chatId));
	try {
		const client = await Effect.runPromise(getConnectionClient(options));
		await Effect.runPromise(client["chat.archive"]({ chatId }));
	} catch (cause) {
		reportConnectionFailure(options, cause);
		batchAtomUpdates(() => {
			setConnectionBundles(connKey, previous);
			setConnectionError(connKey, messageOf(cause));
		});
	}
};

export const archiveSession = async (
	connKey: string,
	options: WsProtocolOptions,
	sessionId: Session["id"],
): Promise<void> => {
	const previous = currentBundles(connKey);
	setConnectionBundles(connKey, removeSession(previous, sessionId));
	try {
		const client = await Effect.runPromise(getConnectionClient(options));
		await Effect.runPromise(client["session.archive"]({ sessionId }));
	} catch (cause) {
		reportConnectionFailure(options, cause);
		batchAtomUpdates(() => {
			setConnectionBundles(connKey, previous);
			setConnectionError(connKey, messageOf(cause));
		});
	}
};

export const renameChat = async (
	connKey: string,
	options: WsProtocolOptions,
	chatId: Chat["id"],
	title: string,
): Promise<void> => {
	const trimmed = title.trim();
	if (trimmed.length === 0) return;
	const previous = currentBundles(connKey);
	setConnectionBundles(
		connKey,
		patchChatFields(previous, chatId, { title: trimmed }),
	);
	try {
		const renamed = await Effect.runPromise(
			renameChatRpc({ connection: options, chatId, title: trimmed }),
		);
		setConnectionBundles(connKey, patchChat(currentBundles(connKey), renamed));
	} catch (cause) {
		reportConnectionFailure(options, cause);
		batchAtomUpdates(() => {
			setConnectionBundles(connKey, previous);
			setConnectionError(connKey, messageOf(cause));
		});
		throw cause;
	}
};

export const renameSession = async (
	connKey: string,
	options: WsProtocolOptions,
	sessionId: Session["id"],
	title: string,
): Promise<void> => {
	const trimmed = title.trim();
	if (trimmed.length === 0) return;
	const previous = findSession(currentBundles(connKey), sessionId);
	setConnectionBundles(
		connKey,
		patchSessionFields(currentBundles(connKey), sessionId, {
			title: trimmed,
		}),
	);
	try {
		const client = await Effect.runPromise(getConnectionClient(options));
		const renamed = await Effect.runPromise(
			client["session.rename"]({ sessionId, title: trimmed }),
		);
		setConnectionBundles(
			connKey,
			patchSession(currentBundles(connKey), renamed),
		);
	} catch (cause) {
		reportConnectionFailure(options, cause);
		if (previous !== null) {
			setConnectionBundles(
				connKey,
				patchSession(currentBundles(connKey), previous),
			);
		}
		throw cause;
	}
};

export const setActiveSession = async (
	connKey: string,
	options: WsProtocolOptions,
	chatId: Chat["id"],
	sessionId: Session["id"],
): Promise<void> => {
	const previous = findChat(currentBundles(connKey), chatId)?.activeSessionId;
	setConnectionBundles(
		connKey,
		patchChatFields(currentBundles(connKey), chatId, {
			activeSessionId: sessionId,
		}),
	);
	try {
		const client = await Effect.runPromise(getConnectionClient(options));
		await Effect.runPromise(
			client["chat.setActiveSession"]({ chatId, sessionId }),
		);
	} catch (cause) {
		reportConnectionFailure(options, cause);
		setConnectionBundles(
			connKey,
			patchChatFields(currentBundles(connKey), chatId, {
				activeSessionId: previous ?? null,
			}),
		);
		throw cause;
	}
};

export const markChatRead = async (
	connKey: string,
	options: WsProtocolOptions,
	chatId: Chat["id"],
): Promise<void> => {
	// Optimistically stamp last-read to now so the inbox unread styling clears
	// immediately; reconcile with the server's canonical chat on success.
	const now = new Date();
	setConnectionBundles(
		connKey,
		patchChatFields(currentBundles(connKey), chatId, { lastReadAt: now }),
	);
	try {
		const chat = await Effect.runPromise(
			markChatReadRpc({ connection: options, chatId }),
		);
		setConnectionBundles(connKey, patchChat(currentBundles(connKey), chat));
	} catch {
		// Non-fatal: the optimistic stamp stands until the next hydrate.
	}
};

export const setPermissionMode = async (
	connKey: string,
	options: WsProtocolOptions,
	sessionId: Session["id"],
	mode: PermissionMode,
): Promise<boolean> => {
	const previous = findSession(currentBundles(connKey), sessionId);
	batchAtomUpdates(() => {
		setConnectionBundles(
			connKey,
			patchSessionFields(currentBundles(connKey), sessionId, {
				permissionMode: mode,
			}),
		);
		setConnectionError(connKey, null);
	});
	try {
		await Effect.runPromise(
			setSessionPermissionModeRpc({
				connection: options,
				sessionId,
				mode,
			}),
		);
		return true;
	} catch (cause) {
		batchAtomUpdates(() => {
			if (previous !== null) {
				setConnectionBundles(
					connKey,
					patchSessionFields(currentBundles(connKey), sessionId, {
						permissionMode: previous.permissionMode,
					}),
				);
			}
			setConnectionError(connKey, messageOf(cause));
		});
		return false;
	}
};

export const setRuntimeMode = async (
	connKey: string,
	options: WsProtocolOptions,
	sessionId: Session["id"],
	mode: RuntimeMode,
): Promise<boolean> => {
	const previous = findSession(currentBundles(connKey), sessionId);
	batchAtomUpdates(() => {
		setConnectionBundles(
			connKey,
			patchSessionFields(currentBundles(connKey), sessionId, {
				runtimeMode: mode,
			}),
		);
		setConnectionError(connKey, null);
	});
	try {
		await Effect.runPromise(
			setSessionRuntimeModeRpc({
				connection: options,
				sessionId,
				runtimeMode: mode,
			}),
		);
		return true;
	} catch (cause) {
		batchAtomUpdates(() => {
			if (previous !== null) {
				setConnectionBundles(
					connKey,
					patchSessionFields(currentBundles(connKey), sessionId, {
						runtimeMode: previous.runtimeMode,
					}),
				);
			}
			setConnectionError(connKey, messageOf(cause));
		});
		return false;
	}
};

export const createChat = async (
	connKey: string,
	options: WsProtocolOptions,
	input: {
		projectId: Folder["id"];
		providerId: ProviderId;
		model: string;
		initialPrompt: string;
		runtimeMode?: RuntimeMode;
		permissionMode?: PermissionMode;
		modelOptions?: Record<string, string>;
		worktreeId?: WorktreeId | null;
	},
): Promise<{
	chat: Chat;
	initialSession: Session;
	initialMessage: Message | null;
}> => {
	try {
		const client = await Effect.runPromise(getConnectionClient(options));
		const result = await Effect.runPromise(
			client["chat.create"]({
				projectId: input.projectId,
				providerId: input.providerId,
				model: input.model,
				initialPrompt: input.initialPrompt,
				runtimeMode: input.runtimeMode,
				permissionMode: input.permissionMode,
				modelOptions: input.modelOptions,
				worktreeId: input.worktreeId ?? null,
			}),
		);
		batchAtomUpdates(() => {
			setConnectionBundles(
				connKey,
				patchCreatedChat(
					currentBundles(connKey),
					input.projectId,
					result.chat,
					result.initialSession,
				),
			);
			appAtomRegistry.update(statusBySessionAtom, (state) => ({
				...state,
				[connectionSessionKey(connKey, result.initialSession.id)]:
					result.initialSession.status,
			}));
			if (result.initialMessage !== null) {
				const initialMessage = result.initialMessage;
				appAtomRegistry.update(messagesBySessionAtom, (state) => ({
					...state,
					[connectionSessionKey(connKey, result.initialSession.id)]: [
						initialMessage,
					],
				}));
			}
		});
		return result;
	} catch (cause) {
		reportConnectionFailure(options, cause);
		setConnectionError(connKey, messageOf(cause));
		throw cause;
	}
};

export const createSession = async (
	connKey: string,
	options: WsProtocolOptions,
	input: {
		chatId: Chat["id"];
		providerId: ProviderId;
		model: string;
		title?: string;
		initialPrompt?: string;
		runtimeMode?: RuntimeMode;
		permissionMode?: PermissionMode;
		modelOptions?: Record<string, string>;
	},
): Promise<Session> => {
	try {
		const client = await Effect.runPromise(getConnectionClient(options));
		const session = await Effect.runPromise(
			client["session.create"]({
				chatId: input.chatId,
				providerId: input.providerId,
				model: input.model,
				title: input.title,
				initialPrompt: input.initialPrompt,
				runtimeMode: input.runtimeMode,
				permissionMode: input.permissionMode,
				modelOptions: input.modelOptions,
			}),
		);
		batchAtomUpdates(() => {
			setConnectionBundles(
				connKey,
				patchSession(currentBundles(connKey), session),
			);
			appAtomRegistry.update(statusBySessionAtom, (state) => ({
				...state,
				[connectionSessionKey(connKey, session.id)]: session.status,
			}));
		});
		return session;
	} catch (cause) {
		reportConnectionFailure(options, cause);
		throw cause;
	}
};

export const hydrateSessions = async (
	connKey: string,
	options: WsProtocolOptions,
): Promise<void> => {
	const cached = await Effect.runPromise(readSessionsSnapshot(connKey));
	if (cached !== null) {
		setConnectionBundles(
			connKey,
			rebuildBundles(
				cached.projects as readonly Folder[],
				cached.chats as readonly Chat[],
				cached.sessions as readonly Session[],
			),
		);
	}

	batchAtomUpdates(() => {
		setConnectionLoading(connKey, true);
		setConnectionError(connKey, null);
	});

	try {
		const client = await Effect.runPromise(getConnectionClient(options));
		const projects = await Effect.runPromise(client["workspace.list"]({}));
		const bundles = await Promise.all(
			projects.map(async (project) => {
				const [chats, sessions] = await Promise.all([
					Effect.runPromise(client["chat.list"]({ projectId: project.id })),
					Effect.runPromise(client["session.list"]({ projectId: project.id })),
				]);
				return { project, chats, sessions };
			}),
		);

		batchAtomUpdates(() => {
			setConnectionBundles(connKey, bundles);
			setConnectionLoading(connKey, false);
			appAtomRegistry.update(statusBySessionAtom, (state) =>
				patchConnectionStatuses(
					state,
					connKey,
					bundles.flatMap((bundle) => bundle.sessions),
				),
			);
		});

		await Effect.runPromise(
			writeSessionsSnapshot(connKey, {
				projects,
				chats: bundles.flatMap((b) => b.chats),
				sessions: bundles.flatMap((b) => b.sessions),
				savedAt: Date.now(),
			}),
		);

		for (const bundle of bundles) {
			await stopFiber(`${connKey}:chat:${bundle.project.id}`, chatFibers);
			const chatProgram = Stream.runForEach(
				client["chat.streamChanges"]({ projectId: bundle.project.id }),
				(chat) =>
					Effect.sync(() => {
						setConnectionBundles(
							connKey,
							patchChat(currentBundles(connKey), chat),
						);
						void persistConnectionBundles(connKey);
					}),
			).pipe(Effect.catch(() => Effect.void));
			chatFibers.set(
				`${connKey}:chat:${bundle.project.id}`,
				Effect.runFork(chatProgram),
			);

			const summaryKey = `${connKey}:sessions:${bundle.project.id}`;
			await stopFiber(summaryKey, sessionSummaryFibers);
			const summaryProgram = Stream.runForEach(
				client["session.streamChanges"]({ projectId: bundle.project.id }),
				(change) =>
					Effect.sync(() => {
						if (change._tag === "snapshot") {
							batchAtomUpdates(() => {
								setConnectionBundles(
									connKey,
									replaceProjectSessions(
										currentBundles(connKey),
										bundle.project.id,
										change.sessions,
									),
								);
								appAtomRegistry.update(statusBySessionAtom, (state) =>
									patchConnectionStatuses(state, connKey, change.sessions),
								);
							});
							void persistConnectionBundles(connKey);
							return;
						}
						if (change._tag === "change") {
							batchAtomUpdates(() => {
								setConnectionBundles(
									connKey,
									patchSession(currentBundles(connKey), change.session),
								);
								appAtomRegistry.update(statusBySessionAtom, (state) => ({
									...state,
									[connectionSessionKey(connKey, change.session.id)]:
										change.session.status,
								}));
							});
							void persistConnectionBundles(connKey);
							return;
						}
						setConnectionBundles(
							connKey,
							removeSession(currentBundles(connKey), change.sessionId),
						);
						void persistConnectionBundles(connKey);
					}),
			).pipe(Effect.catch(() => Effect.void));
			sessionSummaryFibers.set(summaryKey, Effect.runFork(summaryProgram));
		}
	} catch (cause) {
		reportConnectionFailure(options, cause);
		batchAtomUpdates(() => {
			setConnectionLoading(connKey, false);
			setConnectionError(connKey, messageOf(cause));
		});
	}
};

const removeChat = (
	bundles: readonly ProjectBundle[],
	chatId: Chat["id"],
): ProjectBundle[] =>
	bundles.map((bundle) => ({
		...bundle,
		chats: bundle.chats.filter((chat) => chat.id !== chatId),
		sessions: bundle.sessions.filter((session) => session.chatId !== chatId),
	}));

const removeSession = (
	bundles: readonly ProjectBundle[],
	sessionId: Session["id"],
): ProjectBundle[] =>
	bundles.map((bundle) => ({
		...bundle,
		sessions: bundle.sessions.filter((session) => session.id !== sessionId),
	}));

const replaceProjectSessions = (
	bundles: readonly ProjectBundle[],
	projectId: Folder["id"],
	sessions: readonly Session[],
): ProjectBundle[] =>
	bundles.map((bundle) =>
		bundle.project.id === projectId ? { ...bundle, sessions } : bundle,
	);

const rebuildBundles = (
	projects: readonly Folder[],
	chats: readonly Chat[],
	sessions: readonly Session[],
): ProjectBundle[] =>
	projects.map((project) => ({
		project,
		chats: chats.filter((chat) => chat.projectId === project.id),
		sessions: sessions.filter((session) => session.projectId === project.id),
	}));

const patchChat = (
	bundles: readonly ProjectBundle[],
	chat: Chat,
): ProjectBundle[] =>
	bundles.map((bundle) =>
		bundle.project.id !== chat.projectId
			? bundle
			: {
					...bundle,
					chats: [
						chat,
						...bundle.chats.filter((existing) => existing.id !== chat.id),
					].sort((a, b) => timestampOf(b.updatedAt) - timestampOf(a.updatedAt)),
				},
	);

const patchChatFields = (
	bundles: readonly ProjectBundle[],
	chatId: Chat["id"],
	fields: Partial<Chat>,
): ProjectBundle[] =>
	bundles.map((bundle) => ({
		...bundle,
		chats: bundle.chats.map((chat) =>
			chat.id === chatId ? ({ ...chat, ...fields } as Chat) : chat,
		),
	}));

const patchCreatedChat = (
	bundles: readonly ProjectBundle[],
	projectId: Folder["id"],
	chat: Chat,
	initialSession: Session,
): ProjectBundle[] =>
	bundles.map((bundle) =>
		bundle.project.id !== projectId
			? bundle
			: {
					...bundle,
					chats: [
						chat,
						...bundle.chats.filter((existing) => existing.id !== chat.id),
					].sort((a, b) => timestampOf(b.updatedAt) - timestampOf(a.updatedAt)),
					sessions: [
						initialSession,
						...bundle.sessions.filter(
							(existing) => existing.id !== initialSession.id,
						),
					],
				},
	);

const patchSession = (
	bundles: readonly ProjectBundle[],
	session: Session,
): ProjectBundle[] =>
	bundles.map((bundle) =>
		bundle.project.id !== session.projectId
			? bundle
			: {
					...bundle,
					sessions: [
						session,
						...bundle.sessions.filter((existing) => existing.id !== session.id),
					],
				},
	);

const findSession = (
	bundles: readonly ProjectBundle[],
	sessionId: Session["id"],
): Session | null => {
	for (const bundle of bundles) {
		const session = bundle.sessions.find((item) => item.id === sessionId);
		if (session !== undefined) return session;
	}
	return null;
};

const findChat = (
	bundles: readonly ProjectBundle[],
	chatId: Chat["id"],
): Chat | null => {
	for (const bundle of bundles) {
		const chat = bundle.chats.find((item) => item.id === chatId);
		if (chat !== undefined) return chat;
	}
	return null;
};

const patchSessionFields = (
	bundles: readonly ProjectBundle[],
	sessionId: Session["id"],
	fields: Partial<Session>,
): ProjectBundle[] =>
	bundles.map((bundle) => ({
		...bundle,
		sessions: bundle.sessions.map((session) =>
			session.id === sessionId
				? ({ ...session, ...fields } as Session)
				: session,
		),
	}));

export const selectSessionChat = (
	bundles: readonly ProjectBundle[],
	sessionId: string,
): { session: Session; chat: Chat | undefined; project: Folder } | null => {
	for (const bundle of bundles) {
		const session = bundle.sessions.find((item) => item.id === sessionId);
		if (session !== undefined) {
			return {
				session,
				chat: bundle.chats.find((chat) => chat.id === session.chatId),
				project: bundle.project,
			};
		}
	}
	return null;
};

const timestampOf = (value: unknown): number => {
	if (value instanceof Date) return value.getTime();
	if (typeof value === "string" || typeof value === "number") {
		const timestamp = new Date(value).getTime();
		return Number.isFinite(timestamp) ? timestamp : 0;
	}
	return 0;
};

const patchConnectionStatuses = (
	current: Readonly<Record<string, SessionStatus>>,
	connKey: string,
	sessions: readonly Session[],
): Record<string, SessionStatus> => ({
	...current,
	...Object.fromEntries(
		sessions.map((session) => [
			connectionSessionKey(connKey, session.id),
			session.status,
		]),
	),
});

export const isUnread = (chat: Chat): boolean => {
	const lastMessageAt = timestampOf(chat.lastMessageAt);
	const lastReadAt = timestampOf(chat.lastReadAt);
	return lastMessageAt > 0 && lastReadAt > 0 && lastMessageAt > lastReadAt;
};

async function persistConnectionBundles(connKey: string): Promise<void> {
	const bundles = currentBundles(connKey);
	await Effect.runPromise(
		writeSessionsSnapshot(connKey, {
			projects: bundles.map((bundle) => bundle.project),
			chats: bundles.flatMap((bundle) => bundle.chats),
			sessions: bundles.flatMap((bundle) => bundle.sessions),
			savedAt: Date.now(),
		}),
	).catch(() => {});
}
