import { Effect } from "effect";
import { createAtomStore as create } from "../state/atom-store.ts";

import type { ExternalThread } from "@zuse/contracts";

import { getRpcClient } from "../lib/rpc-client.ts";
import { formatError } from "../lib/format-error.ts";
import { useChatsStore } from "./chats.ts";
import { useMessagesStore } from "./messages.ts";
import { useSessionsStore } from "./sessions.ts";
import { useWorktreesStore } from "./worktrees.ts";
import { useWorkspaceStore } from "./workspace.ts";

type ExternalThreadsState = {
  readonly threads: ReadonlyArray<ExternalThread>;
  readonly loading: boolean;
  readonly continuingId: string | null;
  readonly error: string | null;
  readonly hydrate: () => Promise<void>;
  readonly continueThread: (thread: ExternalThread) => Promise<boolean>;
};

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
        const client = await getRpcClient();
        const threads = await Effect.runPromise(
          client["externalThreads.list"]({ limit: 12 }),
        );
        set({ threads, loading: false });
      } catch (err) {
        set({ error: formatError(err), loading: false });
      }
    },
    continueThread: async (thread) => {
      if (!thread.available || get().continuingId !== null) return false;
      set({ continuingId: thread.id, error: null });
      try {
        const client = await getRpcClient();
        const result = await Effect.runPromise(
          client["externalThreads.continue"]({
            providerId: thread.providerId,
            cursor: thread.cursor,
            projectPath: thread.projectPath,
            title: thread.title,
            sourcePath: thread.sourcePath,
          }),
        );
        useWorkspaceStore.setState((s) => ({
          folders: s.folders.some((folder) => folder.id === result.project.id)
            ? s.folders
            : [...s.folders, result.project],
          selectedFolderId: result.project.id,
        }));
        if (result.messages.length > 0) {
          useMessagesStore.setState((s) => ({
            messagesBySession: {
              ...s.messagesBySession,
              [result.session.id]: result.messages,
            },
          }));
        }
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
        useChatsStore.setState((s) => {
          const existing = s.chatsByProject[result.project.id] ?? [];
          return {
            chatsByProject: {
              ...s.chatsByProject,
              [result.project.id]: existing.some(
                (chat) => chat.id === result.chat.id,
              )
                ? existing
                : [result.chat, ...existing],
            },
            selectedChatId: result.chat.id,
            selectedChatByProject: {
              ...s.selectedChatByProject,
              [result.project.id]: result.chat.id,
            },
          };
        });
        useSessionsStore.setState((s) => {
          const existing = s.sessionsByProject[result.project.id] ?? [];
          return {
            sessionsByProject: {
              ...s.sessionsByProject,
              [result.project.id]: existing.some(
                (session) => session.id === result.session.id,
              )
                ? existing
                : [result.session, ...existing],
            },
            selectedSessionId: result.session.id,
            selectedSessionByProject: {
              ...s.selectedSessionByProject,
              [result.project.id]: result.session.id,
            },
          };
        });
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
