import type {
	Chat,
	ChatId,
	EnvironmentId,
	FolderId,
	Session,
	SessionId,
} from "@zuse/contracts";
import { CommandId } from "@zuse/contracts";
import { cloudSummaryForChat } from "../lib/cloud-workspace-catalog.ts";
import { dispatchEnvironmentShellCommand } from "../lib/environment-shell-client-bus.ts";
import { formatError } from "../lib/format-error.ts";
import { createAtomStore as create } from "../state/atom-store.ts";
import { useUiStore } from "./ui.ts";

type ArchivePreview = {
	readonly chat: Chat;
	readonly sessions: ReadonlyArray<Session>;
};

type ArchiveCommand = <Result>(input: {
	readonly environmentId: EnvironmentId;
	readonly kind: "chat.list" | "chat.archivePreview";
	readonly payload: Readonly<Record<string, unknown>>;
}) => Promise<Result>;

let runArchiveCommand: ArchiveCommand = async <Result>(input: {
	readonly environmentId: EnvironmentId;
	readonly kind: "chat.list" | "chat.archivePreview";
	readonly payload: Readonly<Record<string, unknown>>;
}): Promise<Result> => {
	const receipt = await dispatchEnvironmentShellCommand<
		Readonly<Record<string, unknown>>,
		Result
	>({
		environmentId: input.environmentId,
		kind: input.kind,
		commandId: CommandId.make(`archive-query:${crypto.randomUUID()}`),
		payload: input.payload,
	});
	return receipt.result;
};

export const setArchiveCommandForTest = (command: ArchiveCommand): void => {
	runArchiveCommand = command;
};

type ArchivePreviewState = {
	readonly chatsByProject: Record<string, ReadonlyArray<Chat>>;
	readonly loadedByProject: Record<string, boolean>;
	readonly loadingByProject: Record<string, boolean>;
	readonly selectedChatByProject: Record<string, ChatId | null>;
	readonly previewsByChat: Record<string, ArchivePreview | undefined>;
	readonly previewLoadingByChat: Record<string, boolean>;
	readonly selectedSessionByChat: Record<string, SessionId | null>;
	readonly restoringByChat: Record<string, boolean>;
	readonly errorByProject: Record<string, string | null>;
	readonly errorByChat: Record<string, string | null>;
	readonly restoreErrorByChat: Record<string, string | null>;
	readonly loadProject: (
		environmentId: EnvironmentId,
		projectId: FolderId,
		force?: boolean,
	) => Promise<void>;
	readonly showList: (
		environmentId: EnvironmentId,
		projectId: FolderId,
	) => Promise<void>;
	readonly openChat: (
		environmentId: EnvironmentId,
		chat: Chat,
	) => Promise<void>;
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
const projectGenerations = new Map<string, number>();
const chatGenerations = new Map<string, number>();

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
		return {
			chatsByProject: {},
			loadedByProject: {},
			loadingByProject: {},
			selectedChatByProject: {},
			previewsByChat: {},
			previewLoadingByChat: {},
			selectedSessionByChat: {},
			restoringByChat: {},
			errorByProject: {},
			errorByChat: {},
			restoreErrorByChat: {},
			loadProject: (environmentId, projectId, force = false) => {
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
						let chats: ReadonlyArray<Chat>;
						while (true) {
							const requestGeneration = generation(
								projectGenerations,
								projectId,
							);
							chats = await runArchiveCommand<ReadonlyArray<Chat>>({
								environmentId,
								kind: "chat.list",
								payload: { projectId, includeArchived: true },
							});
							if (
								generation(projectGenerations, projectId) === requestGeneration
							) {
								break;
							}
						}
						set((state) => ({
							chatsByProject: {
								...state.chatsByProject,
								[projectId]: [
									...chats.filter((chat) => chat.archivedAt !== null),
									...(state.chatsByProject[projectId] ?? []).filter(
										(chat) =>
											cloudSummaryForChat(chat.id) !== null &&
											!chats.some((candidate) => candidate.id === chat.id),
									),
								].sort((a, b) => archiveSortTime(b) - archiveSortTime(a)),
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
			showList: async (environmentId, projectId) => {
				set((state) => ({
					selectedChatByProject: {
						...state.selectedChatByProject,
						[projectId]: null,
					},
				}));
				await get().loadProject(environmentId, projectId, true);
			},
			openChat: (environmentId, chat) => {
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
					return Promise.resolve();
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
						const preview = await runArchiveCommand<ArchivePreview>({
							environmentId,
							kind: "chat.archivePreview",
							payload: { chatId: chat.id },
						});
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
					const previewsByChat = { ...state.previewsByChat };
					const selectedSessionByChat = { ...state.selectedSessionByChat };
					const restoringByChat = { ...state.restoringByChat };
					const restoreErrorByChat = { ...state.restoreErrorByChat };
					const previewLoadingByChat = { ...state.previewLoadingByChat };
					const errorByChat = { ...state.errorByChat };
					delete previewsByChat[chatId];
					delete selectedSessionByChat[chatId];
					delete restoringByChat[chatId];
					delete restoreErrorByChat[chatId];
					delete previewLoadingByChat[chatId];
					delete errorByChat[chatId];
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
