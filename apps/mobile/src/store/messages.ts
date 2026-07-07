import type { Message, SessionId } from "@zuse/wire";
import { Effect, Fiber, Stream } from "effect";
import { AppState } from "react-native";
import { create } from "zustand";

import { readMessagesSnapshot, writeMessagesSnapshot } from "~/offline/cache";
import { connectionSessionKey } from "~/lib/session-key";
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

const liveFibers = new Map<string, Fiber.RuntimeFiber<unknown, unknown>>();
const highestSequenceBySession = new Map<string, number>();
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
      highestSequenceBySession.set(liveKey, cached.highestSequence);
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
          client.messages.list({ sessionId }),
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
        const sinceSequence = highestSequenceBySession.get(liveKey);
        console.info("[mobile] messages.stream", { sessionId, sinceSequence });
        const program = Stream.runForEach(
          client.messages.stream({ sessionId, sinceSequence }),
          (envelope) =>
            Effect.sync(() => {
              const previous = highestSequenceBySession.get(liveKey) ?? 0;
              if (envelope.sequence <= previous) return;
              highestSequenceBySession.set(liveKey, envelope.sequence);
              console.info("[mobile] messages.stream envelope", {
                sessionId,
                sequence: envelope.sequence,
              });
              set((state) => {
                const current = state.messagesBySession[liveKey] ?? [];
                if (
                  current.some((message) => message.id === envelope.message.id)
                ) {
                  return state;
                }
                const next = [...current, envelope.message].slice(-500);
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
          Effect.tapError((cause) =>
            Effect.sync(() => reportConnectionFailure(options, cause)),
          ),
        );
        const fiber = await Effect.runPromise(program.pipe(Effect.fork));
        liveFibers.set(liveKey, fiber);
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
        highestSequence: highestSequenceBySession.get(liveKey) ?? 0,
        messages,
      }),
    ).catch(() => {});
  },
}));

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
