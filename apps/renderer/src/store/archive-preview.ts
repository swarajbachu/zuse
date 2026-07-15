import type {
	Chat,
	ChatId,
	FolderId,
	Message,
	Session,
	SessionId,
} from "@zuse/contracts";
import { Effect } from "effect";
import { create } from "zustand";

import { formatError } from "../lib/format-error.ts";
import { getRpcClient } from "../lib/rpc-client.ts";
import { useUiStore } from "./ui.ts";

type ArchivePreview = {
	readonly chat: Chat;
	readonly sessions: ReadonlyArray<Session>;
};

type ArchivePreviewState = {
	readonly chatsByProject: Record<string, ReadonlyArray<Chat>>;
	readonly loadedByProject: Record<string, boolean>;
	readonly loadingByProject: Record<string, boolean>;
	readonly folderExpandedByProject: Record<string, boolean>;
	readonly selectedChatByProject: Record<string, ChatId | null>;
	readonly previewsByChat: Record<string, ArchivePreview | undefined>;
	readonly previewLoadingByChat: Record<string, boolean>;
	readonly selectedSessionByChat: Record<string, SessionId | null>;
	readonly messagesBySession: Record<
		string,
		ReadonlyArray<Message> | undefined
	>;
	readonly messagesLoadingBySession: Record<string, boolean>;
	readonly restoringByChat: Record<string, boolean>;
	readonly errorByProject: Record<string, string | null>;
	readonly errorByChat: Record<string, string | null>;
	readonly errorBySession: Record<string, string | null>;
	readonly restoreErrorByChat: Record<string, string | null>;
	readonly loadProject: (projectId: FolderId, force?: boolean) => Promise<void>;
	readonly setFolderExpanded: (projectId: FolderId, expanded: boolean) => void;
	readonly openFolder: (projectId: FolderId) => Promise<void>;
	readonly openChat: (chat: Chat) => Promise<void>;
	readonly selectSession: (
		chatId: ChatId,
		sessionId: SessionId,
	) => Promise<void>;
	readonly upsertChat: (chat: Chat) => void;
	readonly removeChat: (chatId: ChatId, projectId: FolderId) => void;
	readonly setRestoring: (chatId: ChatId, restoring: boolean) => void;
	readonly setRestoreError: (chatId: ChatId, error: string | null) => void;
};

const projectLoads = new Map<string, Promise<void>>();
const previewLoads = new Map<string, Promise<void>>();
const messageLoads = new Map<string, Promise<void>>();
const projectGenerations = new Map<string, number>();
const chatGenerations = new Map<string, number>();
const sessionGenerations = new Map<string, number>();

const generation = (generations: Map<string, number>, id: string): number =>
	generations.get(id) ?? 0;

const bumpGeneration = (generations: Map<string, number>, id: string): void => {
	generations.set(id, generation(generations, id) + 1);
};

const archiveSortTime = (chat: Chat): number =>
	(chat.archivedAt ?? chat.updatedAt).getTime();

const upsertArchived = (
	rows: ReadonlyArray<Chat>,
	chat: Chat,
): ReadonlyArray<Chat> =>
	[chat, ...rows.filter((row) => row.id !== chat.id)].sort(
		(a, b) => archiveSortTime(b) - archiveSortTime(a),
	);

const preferredSession = (
	chat: Chat,
	sessions: ReadonlyArray<Session>,
): SessionId | null =>
	chat.activeSessionId !== null &&
	sessions.some((session) => session.id === chat.activeSessionId)
		? chat.activeSessionId
		: (sessions[0]?.id ?? null);

export const useArchivePreviewStore = create<ArchivePreviewState>(
	(set, get) => {
		const loadMessages = (sessionId: SessionId): Promise<void> => {
			if (get().messagesBySession[sessionId] !== undefined) {
				return Promise.resolve();
			}
			const pending = messageLoads.get(sessionId);
			if (pending !== undefined) return pending;
			const requestGeneration = generation(sessionGenerations, sessionId);
			const run = (async () => {
				set((state) => ({
					messagesLoadingBySession: {
						...state.messagesLoadingBySession,
						[sessionId]: true,
					},
					errorBySession: { ...state.errorBySession, [sessionId]: null },
				}));
				try {
					const client = await getRpcClient();
					const messages = await Effect.runPromise(
						client["messages.list"]({ sessionId }),
					);
					if (generation(sessionGenerations, sessionId) !== requestGeneration) {
						return;
					}
					set((state) => ({
						messagesBySession: {
							...state.messagesBySession,
							[sessionId]: messages,
						},
					}));
				} catch (error) {
					if (generation(sessionGenerations, sessionId) === requestGeneration) {
						set((state) => ({
							errorBySession: {
								...state.errorBySession,
								[sessionId]: formatError(error),
							},
						}));
					}
				} finally {
					if (generation(sessionGenerations, sessionId) === requestGeneration) {
						set((state) => ({
							messagesLoadingBySession: {
								...state.messagesLoadingBySession,
								[sessionId]: false,
							},
						}));
					}
					messageLoads.delete(sessionId);
				}
			})();
			messageLoads.set(sessionId, run);
			return run;
		};

		return {
			chatsByProject: {},
			loadedByProject: {},
			loadingByProject: {},
			folderExpandedByProject: {},
			selectedChatByProject: {},
			previewsByChat: {},
			previewLoadingByChat: {},
			selectedSessionByChat: {},
			messagesBySession: {},
			messagesLoadingBySession: {},
			restoringByChat: {},
			errorByProject: {},
			errorByChat: {},
			errorBySession: {},
			restoreErrorByChat: {},
			loadProject: (projectId, force = false) => {
				if (!force && get().loadedByProject[projectId] === true) {
					return Promise.resolve();
				}
				const pending = projectLoads.get(projectId);
				if (pending !== undefined) return pending;
				const run = (async () => {
					set((state) => ({
						loadingByProject: {
							...state.loadingByProject,
							[projectId]: true,
						},
						errorByProject: { ...state.errorByProject, [projectId]: null },
					}));
					try {
						const client = await getRpcClient();
						let chats: ReadonlyArray<Chat>;
						while (true) {
							const requestGeneration = generation(
								projectGenerations,
								projectId,
							);
							chats = await Effect.runPromise(
								client["chat.list"]({ projectId, includeArchived: true }),
							);
							if (
								generation(projectGenerations, projectId) === requestGeneration
							) {
								break;
							}
						}
						set((state) => ({
							chatsByProject: {
								...state.chatsByProject,
								[projectId]: chats
									.filter((chat) => chat.archivedAt !== null)
									.sort((a, b) => archiveSortTime(b) - archiveSortTime(a)),
							},
							loadedByProject: {
								...state.loadedByProject,
								[projectId]: true,
							},
						}));
					} catch (error) {
						set((state) => ({
							errorByProject: {
								...state.errorByProject,
								[projectId]: formatError(error),
							},
						}));
					} finally {
						set((state) => ({
							loadingByProject: {
								...state.loadingByProject,
								[projectId]: false,
							},
						}));
						projectLoads.delete(projectId);
					}
				})();
				projectLoads.set(projectId, run);
				return run;
			},
			setFolderExpanded: (projectId, expanded) => {
				set((state) => ({
					folderExpandedByProject: {
						...state.folderExpandedByProject,
						[projectId]: expanded,
					},
				}));
			},
			openFolder: async (projectId) => {
				get().setFolderExpanded(projectId, true);
				await get().loadProject(projectId);
			},
			openChat: (chat) => {
				useUiStore.getState().setActiveMainTab("archives");
				set((state) => ({
					selectedChatByProject: {
						...state.selectedChatByProject,
						[chat.projectId]: chat.id,
					},
					errorByChat: { ...state.errorByChat, [chat.id]: null },
				}));
				const cached = get().previewsByChat[chat.id];
				if (cached !== undefined) {
					const selected =
						get().selectedSessionByChat[chat.id] ??
						preferredSession(cached.chat, cached.sessions);
					set((state) => ({
						selectedSessionByChat: {
							...state.selectedSessionByChat,
							[chat.id]: selected,
						},
					}));
					return selected === null ? Promise.resolve() : loadMessages(selected);
				}
				const pending = previewLoads.get(chat.id);
				if (pending !== undefined) return pending;
				const requestGeneration = generation(chatGenerations, chat.id);
				const run = (async () => {
					set((state) => ({
						previewLoadingByChat: {
							...state.previewLoadingByChat,
							[chat.id]: true,
						},
					}));
					try {
						const client = await getRpcClient();
						const preview = await Effect.runPromise(
							client["chat.archivePreview"]({ chatId: chat.id }),
						);
						if (generation(chatGenerations, chat.id) !== requestGeneration) {
							return;
						}
						const selected = preferredSession(preview.chat, preview.sessions);
						if (generation(chatGenerations, chat.id) !== requestGeneration) {
							return;
						}
						set((state) => ({
							previewsByChat: {
								...state.previewsByChat,
								[chat.id]: preview,
							},
							selectedSessionByChat: {
								...state.selectedSessionByChat,
								[chat.id]: selected,
							},
						}));
						if (selected !== null) await loadMessages(selected);
					} catch (error) {
						if (generation(chatGenerations, chat.id) !== requestGeneration) {
							return;
						}
						set((state) => ({
							errorByChat: {
								...state.errorByChat,
								[chat.id]: formatError(error),
							},
						}));
					} finally {
						if (generation(chatGenerations, chat.id) === requestGeneration) {
							set((state) => ({
								previewLoadingByChat: {
									...state.previewLoadingByChat,
									[chat.id]: false,
								},
							}));
						}
						previewLoads.delete(chat.id);
					}
				})();
				previewLoads.set(chat.id, run);
				return run;
			},
			selectSession: async (chatId, sessionId) => {
				set((state) => ({
					selectedSessionByChat: {
						...state.selectedSessionByChat,
						[chatId]: sessionId,
					},
				}));
				await loadMessages(sessionId);
			},
			upsertChat: (chat) => {
				if (chat.archivedAt === null) return;
				bumpGeneration(projectGenerations, chat.projectId);
				set((state) => ({
					chatsByProject: {
						...state.chatsByProject,
						[chat.projectId]: upsertArchived(
							state.chatsByProject[chat.projectId] ?? [],
							chat,
						),
					},
				}));
			},
			removeChat: (chatId, projectId) => {
				bumpGeneration(projectGenerations, projectId);
				bumpGeneration(chatGenerations, chatId);
				set((state) => {
					const sessionIds =
						state.previewsByChat[chatId]?.sessions.map(
							(session) => session.id,
						) ?? [];
					const previewsByChat = { ...state.previewsByChat };
					const selectedSessionByChat = { ...state.selectedSessionByChat };
					const messagesBySession = { ...state.messagesBySession };
					const messagesLoadingBySession = {
						...state.messagesLoadingBySession,
					};
					const errorBySession = { ...state.errorBySession };
					const restoringByChat = { ...state.restoringByChat };
					const restoreErrorByChat = { ...state.restoreErrorByChat };
					const previewLoadingByChat = { ...state.previewLoadingByChat };
					const errorByChat = { ...state.errorByChat };
					for (const sessionId of sessionIds) {
						bumpGeneration(sessionGenerations, sessionId);
					}
					delete previewsByChat[chatId];
					delete selectedSessionByChat[chatId];
					delete restoringByChat[chatId];
					delete restoreErrorByChat[chatId];
					delete previewLoadingByChat[chatId];
					delete errorByChat[chatId];
					for (const sessionId of sessionIds) {
						delete messagesBySession[sessionId];
						delete messagesLoadingBySession[sessionId];
						delete errorBySession[sessionId];
					}
					return {
						chatsByProject: {
							...state.chatsByProject,
							[projectId]: (state.chatsByProject[projectId] ?? []).filter(
								(chat) => chat.id !== chatId,
							),
						},
						selectedChatByProject: {
							...state.selectedChatByProject,
							[projectId]:
								state.selectedChatByProject[projectId] === chatId
									? null
									: (state.selectedChatByProject[projectId] ?? null),
						},
						previewsByChat,
						selectedSessionByChat,
						messagesBySession,
						messagesLoadingBySession,
						errorBySession,
						restoringByChat,
						restoreErrorByChat,
						previewLoadingByChat,
						errorByChat,
					};
				});
			},
			setRestoring: (chatId, restoring) => {
				set((state) => ({
					restoringByChat: {
						...state.restoringByChat,
						[chatId]: restoring,
					},
				}));
			},
			setRestoreError: (chatId, error) => {
				set((state) => ({
					restoreErrorByChat: {
						...state.restoreErrorByChat,
						[chatId]: error,
					},
				}));
			},
		};
	},
);
