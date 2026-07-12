import type { Message, MessageId, SessionId } from "@zuse/contracts";
import {
  projectSessionEvent,
  sessionEventCursors,
} from "@zuse/client-runtime/session-events";
import { Effect, Fiber, Stream } from "effect";
import { AppState } from "react-native";
import { create } from "zustand";
import { connectionSessionKey } from "~/lib/session-key";
import { readMessagesSnapshot, writeMessagesSnapshot } from "~/offline/cache";
import { getConnectionClient, reportConnectionFailure } from "~/rpc/connection";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";

type MessagesState = {
  messagesBySession: Record<string, readonly Message[]>;
  reconnectingBySession: Record<string, boolean>;
  errorBySession: Record<string, string | null>;
  hydrate: (
    connKey: string,
    options: WsProtocolOptions,
    sessionId: SessionId,
  ) => Promise<void>;
  flush: (connKey: string, sessionId: SessionId) => Promise<void>;
};

const liveFibers = new Map<string, Fiber.Fiber<unknown, unknown>>();
const eventCursorKey = (liveKey: string): string =>
  `mobile:messages:${liveKey}`;
const optimisticIds = new Set<MessageId>();
let appStateInstalled = false;

const stop = async (key: string) => {
  const fiber = liveFibers.get(key);
  if (fiber !== undefined) {
    liveFibers.delete(key);
    await Effect.runPromise(Fiber.interrupt(fiber)).catch(() => {});
  }
};

export const useMobileMessagesStore = create<MessagesState>((set, get) => ({
  messagesBySession: {},
  reconnectingBySession: {},
  errorBySession: {},
  hydrate: async (connKey, options, sessionId) => {
    installAppStateFlush(get);
    const liveKey = connectionSessionKey(connKey, sessionId);
    await stop(liveKey);

    const cached = await Effect.runPromise(
      readMessagesSnapshot(connKey, sessionId),
    );
    if (cached !== null) {
      sessionEventCursors.set(eventCursorKey(liveKey), cached.highestSequence);
      set((state) => ({
        messagesBySession: {
          ...state.messagesBySession,
          [liveKey]: cached.messages,
        },
      }));
    }

    set((state) => ({
      reconnectingBySession: {
        ...state.reconnectingBySession,
        [liveKey]: false,
      },
      errorBySession: { ...state.errorBySession, [liveKey]: null },
    }));

    const run = async () => {
      try {
        const client = await Effect.runPromise(getConnectionClient(options));
        const listed = await Effect.runPromise(
          client["messages.list"]({ sessionId }),
        );
        if (listed.length > 0) {
          set((state) => ({
            messagesBySession: {
              ...state.messagesBySession,
              [liveKey]: listed,
            },
          }));
          void get().flush(connKey, sessionId);
        }
        console.info("[mobile] session.events", { sessionId });
        const afterSequence =
          sessionEventCursors.get(eventCursorKey(liveKey)) ?? 0;
        const program = Stream.runForEach(
          client["session.events"]({ sessionId, afterSequence }),
          (envelope) =>
            Effect.sync(() => {
              sessionEventCursors.set(
                eventCursorKey(liveKey),
                envelope.sequence,
              );
              console.info("[mobile] session.events envelope", {
                sessionId,
                sequence: envelope.sequence,
              });
              const projected = projectSessionEvent(envelope);
              if (projected._tag !== "message") return;
              const { message } = projected;
              set((state) => {
                const current = state.messagesBySession[liveKey] ?? [];
                if (optimisticIds.has(message.id)) {
                  optimisticIds.delete(message.id);
                  return {
                    messagesBySession: {
                      ...state.messagesBySession,
                      [liveKey]: current.map((currentMessage) =>
                        currentMessage.id === message.id
                          ? message
                          : currentMessage,
                      ),
                    },
                  };
                }
                const existingIndex = current.findIndex(
                  (currentMessage) => currentMessage.id === message.id,
                );
                if (existingIndex !== -1) {
                  return {
                    messagesBySession: {
                      ...state.messagesBySession,
                      [liveKey]: current.map((currentMessage, index) =>
                        index === existingIndex ? message : currentMessage,
                      ),
                    },
                  };
                }
                const next = [...current, message].slice(-500);
                return {
                  messagesBySession: {
                    ...state.messagesBySession,
                    [liveKey]: next,
                  },
                };
              });
              void get().flush(connKey, sessionId);
            }),
        ).pipe(
          Effect.catch((cause) =>
            Effect.sync(() => {
              set((state) => ({
                reconnectingBySession: {
                  ...state.reconnectingBySession,
                  [liveKey]: true,
                },
                errorBySession: {
                  ...state.errorBySession,
                  [liveKey]:
                    cause instanceof Error ? cause.message : String(cause),
                },
              }));
            }),
          ),
        );
        liveFibers.set(liveKey, Effect.runFork(program));
      } catch (cause) {
        reportConnectionFailure(options, cause);
        set((state) => ({
          reconnectingBySession: {
            ...state.reconnectingBySession,
            [liveKey]: true,
          },
          errorBySession: {
            ...state.errorBySession,
            [liveKey]: cause instanceof Error ? cause.message : String(cause),
          },
        }));
      }
    };

    await run();
  },
  flush: async (connKey, sessionId) => {
    const liveKey = connectionSessionKey(connKey, sessionId);
    const messages = get().messagesBySession[liveKey] ?? [];
    await Effect.runPromise(
      writeMessagesSnapshot(connKey, sessionId, {
        highestSequence: sessionEventCursors.get(eventCursorKey(liveKey)) ?? 0,
        messages,
      }),
    ).catch(() => {});
  },
}));

export const addOptimisticMessage = (key: string, message: Message): void => {
  optimisticIds.add(message.id);
  useMobileMessagesStore.setState((state) => ({
    messagesBySession: {
      ...state.messagesBySession,
      [key]: [...(state.messagesBySession[key] ?? []), message].slice(-500),
    },
  }));
};

export const removeOptimisticMessage = (
  key: string,
  messageId: MessageId,
): void => {
  optimisticIds.delete(messageId);
  useMobileMessagesStore.setState((state) => ({
    messagesBySession: {
      ...state.messagesBySession,
      [key]: (state.messagesBySession[key] ?? []).filter(
        (message) => message.id !== messageId,
      ),
    },
  }));
};

const installAppStateFlush = (get: () => MessagesState) => {
  if (appStateInstalled) return;
  appStateInstalled = true;
  AppState.addEventListener("change", (next) => {
    if (next !== "background") return;
    for (const key of liveFibers.keys()) {
      const [connKey, sessionId] = parseLiveKey(key);
      if (connKey !== undefined && sessionId !== undefined) {
        void get().flush(connKey, sessionId as SessionId);
      }
      void stop(key);
    }
  });
};

const parseLiveKey = (
  key: string,
): [string | undefined, string | undefined] => {
  try {
    return JSON.parse(key) as [string, string];
  } catch {
    return [undefined, undefined];
  }
};
