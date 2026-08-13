import type { ExternalThread } from "@zuse/contracts";
import { CommandId, EnvironmentId } from "@zuse/contracts";
import { overlayActiveEnvironmentShell } from "../lib/environment-entities.ts";
import { dispatchEnvironmentShellCommand } from "../lib/environment-shell-client-bus.ts";
import { formatError } from "../lib/format-error.ts";
import { getActiveEnvironment } from "../lib/rpc-client.ts";
import { createAtomStore as create } from "../state/atom-store.ts";
import { useChatsStore } from "./chats.ts";
import { useSessionsStore } from "./sessions.ts";
import { useWorkspaceStore } from "./workspace.ts";
import { useWorktreesStore } from "./worktrees.ts";

type ExternalThreadsState = {
	readonly threads: ReadonlyArray<ExternalThread>;
	readonly loading: boolean;
	readonly continuingId: string | null;
	readonly error: string | null;
	readonly hydrate: () => Promise<void>;
	readonly continueThread: (thread: ExternalThread) => Promise<boolean>;
};

let commandCounter = 0;
const dispatchExternalThreadsCommand = <Result>(
	kind: string,
	payload: unknown,
) =>
	dispatchEnvironmentShellCommand<unknown, Result>({
		environmentId: EnvironmentId.make(getActiveEnvironment()),
		kind,
		commandId: CommandId.make(
			`${kind}:${Date.now().toString(36)}:${(commandCounter++).toString(36)}`,
		),
		payload,
	});

export const useExternalThreadsStore = create<ExternalThreadsState>(
	(set, get) => ({
		threads: [],
		loading: false,
		continuingId: null,
		error: null,
		hydrate: async () => {
			if (get().loading) return;
			set({ loading: true, error: null });
			try {
				const threads = (
					await dispatchExternalThreadsCommand<ReadonlyArray<ExternalThread>>(
						"externalThreads.list",
						{ limit: 12 },
					)
				).result;
				set({ threads, loading: false });
			} catch (err) {
				set({ error: formatError(err), loading: false });
			}
		},
		continueThread: async (thread) => {
			if (!thread.available || get().continuingId !== null) return false;
			set({ continuingId: thread.id, error: null });
			try {
				const result = (
					await dispatchExternalThreadsCommand<{
						readonly project: import("@zuse/contracts").Folder;
						readonly chat: import("@zuse/contracts").Chat;
						readonly session: import("@zuse/contracts").Session;
						readonly worktree: import("@zuse/contracts").Worktree | null;
					}>("externalThreads.continue", {
						providerId: thread.providerId,
						cursor: thread.cursor,
						projectPath: thread.projectPath,
						title: thread.title,
						sourcePath: thread.sourcePath,
					})
				).result;
				useWorkspaceStore.setState((s) => ({
					folders: s.folders.some((folder) => folder.id === result.project.id)
						? s.folders
						: [...s.folders, result.project],
					selectedFolderId: result.project.id,
				}));
				// Imported transcript rows are already durable in the runtime. The
				// qualified timeline resource catches up from its bounded snapshot after
				// selection; copying the RPC response would create a second authority.
				const continuedWorktree = result.worktree;
				if (continuedWorktree !== null) {
					useWorktreesStore.setState((s) => {
						const existing = s.byProject[result.project.id] ?? [];
						return {
							byProject: {
								...s.byProject,
								[result.project.id]: existing.some(
									(worktree) => worktree.id === continuedWorktree.id,
								)
									? existing
									: [continuedWorktree, ...existing],
							},
						};
					});
				}
				await useWorkspaceStore.getState().select(result.project.id);
				overlayActiveEnvironmentShell((shell) => ({
					...shell,
					chatsByProject: {
						...shell.chatsByProject,
						[result.project.id]: [
							result.chat,
							...(shell.chatsByProject[result.project.id] ?? []).filter(
								(chat) => chat.id !== result.chat.id,
							),
						],
					},
					sessionsByProject: {
						...shell.sessionsByProject,
						[result.project.id]: [
							result.session,
							...(shell.sessionsByProject[result.project.id] ?? []).filter(
								(session) => session.id !== result.session.id,
							),
						],
					},
				}));
				useChatsStore.setState((s) => ({
					selectedChatId: result.chat.id,
					selectedChatByProject: {
						...s.selectedChatByProject,
						[result.project.id]: result.chat.id,
					},
				}));
				useSessionsStore.setState((s) => ({
					selectedSessionId: result.session.id,
					selectedSessionByProject: {
						...s.selectedSessionByProject,
						[result.project.id]: result.session.id,
					},
				}));
				useChatsStore.getState().select(result.chat.id);
				set({ continuingId: null });
				return true;
			} catch (err) {
				set({ error: formatError(err), continuingId: null });
				return false;
			}
		},
	}),
);
