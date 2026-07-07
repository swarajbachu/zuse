import type { Chat, Folder, Session, SessionStatus } from "@zuse/wire";
import { Effect, Fiber, Stream } from "effect";
import { create } from "zustand";

import { readSessionsSnapshot, writeSessionsSnapshot } from "~/offline/cache";
import { connectionSessionKey } from "~/lib/session-key";
import { getConnectionClient, reportConnectionFailure } from "~/rpc/connection";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";

type ProjectBundle = {
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
};

const statusFibers = new Map<string, Fiber.RuntimeFiber<unknown, unknown>>();
const chatFibers = new Map<string, Fiber.RuntimeFiber<unknown, unknown>>();

const stopFiber = async (
  key: string,
  map: Map<string, Fiber.RuntimeFiber<unknown, unknown>>,
) => {
  const fiber = map.get(key);
  if (fiber !== undefined) {
    map.delete(key);
    await Effect.runPromise(Fiber.interrupt(fiber)).catch(() => {});
  }
};

export const useSessionsStore = create<SessionsState>((set, get) => ({
  bundlesByConnection: {},
  statusBySession: {},
  errorByConnection: {},
  loadingByConnection: {},
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
      const projects = await Effect.runPromise(client.workspace.list({}));
      const bundles = await Promise.all(
        projects.map(async (project) => {
          const [chats, sessions] = await Promise.all([
            Effect.runPromise(client.chat.list({ projectId: project.id })),
            Effect.runPromise(client.session.list({ projectId: project.id })),
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
        const chatFiber = await Effect.runPromise(
          Stream.runForEach(
            client.chat.streamChanges({ projectId: bundle.project.id }),
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
              }),
          ).pipe(
            Effect.tapError((cause) =>
              Effect.sync(() => reportConnectionFailure(options, cause)),
            ),
            Effect.fork,
          ),
        );
        chatFibers.set(`${connKey}:chat:${bundle.project.id}`, chatFiber);
      }

      for (const session of bundles.flatMap((b) => b.sessions)) {
        const key = `${connKey}:status:${session.id}`;
        await stopFiber(key, statusFibers);
        const fiber = await Effect.runPromise(
          Stream.runForEach(
            client.session.streamStatus({ sessionId: session.id }),
            (event) =>
              Effect.sync(() => {
                set((state) => ({
                  statusBySession: {
                    ...state.statusBySession,
                    [connectionSessionKey(connKey, event.sessionId)]:
                      event.status,
                  },
                }));
              }),
          ).pipe(
            Effect.tapError((cause) =>
              Effect.sync(() => reportConnectionFailure(options, cause)),
            ),
            Effect.fork,
          ),
        );
        statusFibers.set(key, fiber);
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

export const isUnread = (chat: Chat): boolean => {
  const lastMessageAt = timestampOf(chat.lastMessageAt);
  const lastReadAt = timestampOf(chat.lastReadAt);
  return lastMessageAt > 0 && lastReadAt > 0 && lastMessageAt > lastReadAt;
};
