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
import { create } from "zustand";
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
import { useMobileMessagesStore } from "./messages";

export type ProjectBundle = {
	project: Folder;
	chats: readonly Chat[];
	sessions: readonly Session[];
};

type SessionsState = {
	bundlesByConnection: Record<string, ProjectBundle[]>;
	statusBySession: Record<string, SessionStatus>;
	errorByConnection: Record<string, string | null>;
	loadingByConnection: Record<string, boolean>;
	hydrate: (connKey: string, options: WsProtocolOptions) => Promise<void>;
	archiveChat: (
		connKey: string,
		options: WsProtocolOptions,
		chatId: Chat["id"],
	) => Promise<void>;
	archiveSession: (
		connKey: string,
		options: WsProtocolOptions,
		sessionId: Session["id"],
	) => Promise<void>;
	renameChat: (
		connKey: string,
		options: WsProtocolOptions,
		chatId: Chat["id"],
		title: string,
	) => Promise<void>;
	renameSession: (
		connKey: string,
		options: WsProtocolOptions,
		sessionId: Session["id"],
		title: string,
	) => Promise<void>;
	setActiveSession: (
		connKey: string,
		options: WsProtocolOptions,
		chatId: Chat["id"],
		sessionId: Session["id"],
	) => Promise<void>;
	markChatRead: (
		connKey: string,
		options: WsProtocolOptions,
		chatId: Chat["id"],
	) => Promise<void>;
	setPermissionMode: (
		connKey: string,
		options: WsProtocolOptions,
		sessionId: Session["id"],
		mode: PermissionMode,
	) => Promise<boolean>;
	setRuntimeMode: (
		connKey: string,
		options: WsProtocolOptions,
		sessionId: Session["id"],
		mode: RuntimeMode,
	) => Promise<boolean>;
	createChat: (
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
	) => Promise<{
		chat: Chat;
		initialSession: Session;
		initialMessage: Message | null;
	}>;
	createSession: (
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
	) => Promise<Session>;
};

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
	useSessionsStore.setState({
		bundlesByConnection: {},
		statusBySession: {},
		errorByConnection: {},
		loadingByConnection: {},
	});
};

export const useSessionsStore = create<SessionsState>((set, get) => ({
	bundlesByConnection: {},
	statusBySession: {},
	errorByConnection: {},
	loadingByConnection: {},
	archiveChat: async (connKey, options, chatId) => {
		const previous = get().bundlesByConnection[connKey] ?? [];
		set((state) => ({
			bundlesByConnection: {
				...state.bundlesByConnection,
				[connKey]: removeChat(previous, chatId),
			},
		}));
		try {
			const client = await Effect.runPromise(getConnectionClient(options));
			await Effect.runPromise(client["chat.archive"]({ chatId }));
		} catch (cause) {
			reportConnectionFailure(options, cause);
			set((state) => ({
				bundlesByConnection: {
					...state.bundlesByConnection,
					[connKey]: previous,
				},
				errorByConnection: {
					...state.errorByConnection,
					[connKey]: cause instanceof Error ? cause.message : String(cause),
				},
			}));
		}
	},
	archiveSession: async (connKey, options, sessionId) => {
		const previous = get().bundlesByConnection[connKey] ?? [];
		set((state) => ({
			bundlesByConnection: {
				...state.bundlesByConnection,
				[connKey]: removeSession(previous, sessionId),
			},
		}));
		try {
			const client = await Effect.runPromise(getConnectionClient(options));
			await Effect.runPromise(client["session.archive"]({ sessionId }));
		} catch (cause) {
			reportConnectionFailure(options, cause);
			set((state) => ({
				bundlesByConnection: {
					...state.bundlesByConnection,
					[connKey]: previous,
				},
				errorByConnection: {
					...state.errorByConnection,
					[connKey]: cause instanceof Error ? cause.message : String(cause),
				},
			}));
		}
	},
	renameChat: async (connKey, options, chatId, title) => {
		const trimmed = title.trim();
		if (trimmed.length === 0) return;
		const previous = get().bundlesByConnection[connKey] ?? [];
		set((state) => ({
			bundlesByConnection: {
				...state.bundlesByConnection,
				[connKey]: patchChatFields(previous, chatId, { title: trimmed }),
			},
		}));
		try {
			const renamed = await Effect.runPromise(
				renameChatRpc({ connection: options, chatId, title: trimmed }),
			);
			set((state) => ({
				bundlesByConnection: {
					...state.bundlesByConnection,
					[connKey]: patchChatFields(
						state.bundlesByConnection[connKey] ?? [],
						chatId,
						{ title: renamed.title },
					),
				},
			}));
		} catch (cause) {
			set((state) => ({
				bundlesByConnection: {
					...state.bundlesByConnection,
					[connKey]: previous,
				},
				errorByConnection: {
					...state.errorByConnection,
					[connKey]: cause instanceof Error ? cause.message : String(cause),
				},
			}));
			throw cause;
		}
	},
	renameSession: async (connKey, options, sessionId, title) => {
		const trimmed = title.trim();
		if (trimmed.length === 0) return;
		const previous = findSession(
			get().bundlesByConnection[connKey] ?? [],
			sessionId,
		);
		set((state) => ({
			bundlesByConnection: {
				...state.bundlesByConnection,
				[connKey]: patchSessionFields(
					state.bundlesByConnection[connKey] ?? [],
					sessionId,
					{ title: trimmed },
				),
			},
		}));
		try {
			const client = await Effect.runPromise(getConnectionClient(options));
			const renamed = await Effect.runPromise(
				client["session.rename"]({ sessionId, title: trimmed }),
			);
			set((state) => ({
				bundlesByConnection: {
					...state.bundlesByConnection,
					[connKey]: patchSession(
						state.bundlesByConnection[connKey] ?? [],
						renamed,
					),
				},
			}));
		} catch (cause) {
			reportConnectionFailure(options, cause);
			if (previous !== null) {
				set((state) => ({
					bundlesByConnection: {
						...state.bundlesByConnection,
						[connKey]: patchSession(
							state.bundlesByConnection[connKey] ?? [],
							previous,
						),
					},
				}));
			}
			throw cause;
		}
	},
	setActiveSession: async (connKey, options, chatId, sessionId) => {
		const previous = findChat(
			get().bundlesByConnection[connKey] ?? [],
			chatId,
		)?.activeSessionId;
		set((state) => ({
			bundlesByConnection: {
				...state.bundlesByConnection,
				[connKey]: patchChatFields(
					state.bundlesByConnection[connKey] ?? [],
					chatId,
					{ activeSessionId: sessionId },
				),
			},
		}));
		try {
			const client = await Effect.runPromise(getConnectionClient(options));
			await Effect.runPromise(
				client["chat.setActiveSession"]({ chatId, sessionId }),
			);
		} catch (cause) {
			reportConnectionFailure(options, cause);
			set((state) => ({
				bundlesByConnection: {
					...state.bundlesByConnection,
					[connKey]: patchChatFields(
						state.bundlesByConnection[connKey] ?? [],
						chatId,
						{ activeSessionId: previous ?? null },
					),
				},
			}));
			throw cause;
		}
	},
	markChatRead: async (connKey, options, chatId) => {
		// Optimistically stamp last-read to now so the inbox unread styling clears
		// immediately; reconcile with the server's canonical chat on success.
		const now = new Date();
		set((state) => ({
			bundlesByConnection: {
				...state.bundlesByConnection,
				[connKey]: patchChatFields(
					state.bundlesByConnection[connKey] ?? [],
					chatId,
					{ lastReadAt: now },
				),
			},
		}));
		try {
			const chat = await Effect.runPromise(
				markChatReadRpc({ connection: options, chatId }),
			);
			set((state) => ({
				bundlesByConnection: {
					...state.bundlesByConnection,
					[connKey]: patchChat(state.bundlesByConnection[connKey] ?? [], chat),
				},
			}));
		} catch {
			// Non-fatal: the optimistic stamp stands until the next hydrate.
		}
	},
	setPermissionMode: async (connKey, options, sessionId, mode) => {
		const previous = findSession(
			get().bundlesByConnection[connKey] ?? [],
			sessionId,
		);
		set((state) => ({
			bundlesByConnection: {
				...state.bundlesByConnection,
				[connKey]: patchSessionFields(
					state.bundlesByConnection[connKey] ?? [],
					sessionId,
					{ permissionMode: mode },
				),
			},
			errorByConnection: { ...state.errorByConnection, [connKey]: null },
		}));
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
			set((state) => ({
				bundlesByConnection: {
					...state.bundlesByConnection,
					[connKey]:
						previous === null
							? (state.bundlesByConnection[connKey] ?? [])
							: patchSessionFields(
									state.bundlesByConnection[connKey] ?? [],
									sessionId,
									{ permissionMode: previous.permissionMode },
								),
				},
				errorByConnection: {
					...state.errorByConnection,
					[connKey]: cause instanceof Error ? cause.message : String(cause),
				},
			}));
			return false;
		}
	},
	setRuntimeMode: async (connKey, options, sessionId, mode) => {
		const previous = findSession(
			get().bundlesByConnection[connKey] ?? [],
			sessionId,
		);
		set((state) => ({
			bundlesByConnection: {
				...state.bundlesByConnection,
				[connKey]: patchSessionFields(
					state.bundlesByConnection[connKey] ?? [],
					sessionId,
					{ runtimeMode: mode },
				),
			},
			errorByConnection: { ...state.errorByConnection, [connKey]: null },
		}));
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
			set((state) => ({
				bundlesByConnection: {
					...state.bundlesByConnection,
					[connKey]:
						previous === null
							? (state.bundlesByConnection[connKey] ?? [])
							: patchSessionFields(
									state.bundlesByConnection[connKey] ?? [],
									sessionId,
									{ runtimeMode: previous.runtimeMode },
								),
				},
				errorByConnection: {
					...state.errorByConnection,
					[connKey]: cause instanceof Error ? cause.message : String(cause),
				},
			}));
			return false;
		}
	},
	createChat: async (connKey, options, input) => {
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
			set((state) => ({
				bundlesByConnection: {
					...state.bundlesByConnection,
					[connKey]: patchCreatedChat(
						state.bundlesByConnection[connKey] ?? [],
						input.projectId,
						result.chat,
						result.initialSession,
					),
				},
				statusBySession: {
					...state.statusBySession,
					[connectionSessionKey(connKey, result.initialSession.id)]:
						result.initialSession.status,
				},
			}));
			if (result.initialMessage !== null) {
				const initialMessage = result.initialMessage;
				useMobileMessagesStore.setState((state) => ({
					messagesBySession: {
						...state.messagesBySession,
						[connectionSessionKey(connKey, result.initialSession.id)]: [
							initialMessage,
						],
					},
				}));
			}
			return result;
		} catch (cause) {
			reportConnectionFailure(options, cause);
			set((state) => ({
				errorByConnection: {
					...state.errorByConnection,
					[connKey]: cause instanceof Error ? cause.message : String(cause),
				},
			}));
			throw cause;
		}
	},
	createSession: async (connKey, options, input) => {
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
			set((state) => ({
				bundlesByConnection: {
					...state.bundlesByConnection,
					[connKey]: patchSession(
						state.bundlesByConnection[connKey] ?? [],
						session,
					),
				},
				statusBySession: {
					...state.statusBySession,
					[connectionSessionKey(connKey, session.id)]: session.status,
				},
			}));
			return session;
		} catch (cause) {
			reportConnectionFailure(options, cause);
			throw cause;
		}
	},
	hydrate: async (connKey, options) => {
		const cached = await Effect.runPromise(readSessionsSnapshot(connKey));
		if (cached !== null) {
			set((state) => ({
				bundlesByConnection: {
					...state.bundlesByConnection,
					[connKey]: rebuildBundles(
						cached.projects as readonly Folder[],
						cached.chats as readonly Chat[],
						cached.sessions as readonly Session[],
					),
				},
			}));
		}

		set((state) => ({
			loadingByConnection: { ...state.loadingByConnection, [connKey]: true },
			errorByConnection: { ...state.errorByConnection, [connKey]: null },
		}));

		try {
			const client = await Effect.runPromise(getConnectionClient(options));
			const projects = await Effect.runPromise(client["workspace.list"]({}));
			const bundles = await Promise.all(
				projects.map(async (project) => {
					const [chats, sessions] = await Promise.all([
						Effect.runPromise(client["chat.list"]({ projectId: project.id })),
						Effect.runPromise(
							client["session.list"]({ projectId: project.id }),
						),
					]);
					return { project, chats, sessions };
				}),
			);

			set((state) => ({
				bundlesByConnection: {
					...state.bundlesByConnection,
					[connKey]: bundles,
				},
				loadingByConnection: { ...state.loadingByConnection, [connKey]: false },
				statusBySession: patchConnectionStatuses(
					state.statusBySession,
					connKey,
					bundles.flatMap((bundle) => bundle.sessions),
				),
			}));

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
							set((state) => ({
								bundlesByConnection: {
									...state.bundlesByConnection,
									[connKey]: patchChat(
										state.bundlesByConnection[connKey] ?? [],
										chat,
									),
								},
							}));
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
								set((state) => ({
									bundlesByConnection: {
										...state.bundlesByConnection,
										[connKey]: replaceProjectSessions(
											state.bundlesByConnection[connKey] ?? [],
											bundle.project.id,
											change.sessions,
										),
									},
									statusBySession: patchConnectionStatuses(
										state.statusBySession,
										connKey,
										change.sessions,
									),
								}));
								void persistConnectionBundles(connKey);
								return;
							}
							if (change._tag === "change") {
								set((state) => ({
									bundlesByConnection: {
										...state.bundlesByConnection,
										[connKey]: patchSession(
											state.bundlesByConnection[connKey] ?? [],
											change.session,
										),
									},
									statusBySession: {
										...state.statusBySession,
										[connectionSessionKey(connKey, change.session.id)]:
											change.session.status,
									},
								}));
								void persistConnectionBundles(connKey);
								return;
							}
							set((state) => ({
								bundlesByConnection: {
									...state.bundlesByConnection,
									[connKey]: removeSession(
										state.bundlesByConnection[connKey] ?? [],
										change.sessionId,
									),
								},
							}));
							void persistConnectionBundles(connKey);
						}),
				).pipe(Effect.catch(() => Effect.void));
				sessionSummaryFibers.set(summaryKey, Effect.runFork(summaryProgram));
			}
		} catch (cause) {
			reportConnectionFailure(options, cause);
			set((state) => ({
				loadingByConnection: { ...state.loadingByConnection, [connKey]: false },
				errorByConnection: {
					...state.errorByConnection,
					[connKey]: cause instanceof Error ? cause.message : String(cause),
				},
			}));
		}
	},
}));

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
	const bundles =
		useSessionsStore.getState().bundlesByConnection[connKey] ?? [];
	await Effect.runPromise(
		writeSessionsSnapshot(connKey, {
			projects: bundles.map((bundle) => bundle.project),
			chats: bundles.flatMap((bundle) => bundle.chats),
			sessions: bundles.flatMap((bundle) => bundle.sessions),
			savedAt: Date.now(),
		}),
	).catch(() => {});
}
