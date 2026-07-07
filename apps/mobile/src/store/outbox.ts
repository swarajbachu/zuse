import type { SessionId } from "@zuse/wire";
import { Effect } from "effect";
import { create } from "zustand";

import type { QueuedMessage } from "~/offline/cache";
import { readOutboxSnapshot, writeOutboxSnapshot } from "~/offline/cache";
import { connectionSessionKey } from "~/lib/session-key";
import { flushServerQueue, makeTextInput, queueMessage } from "~/rpc/actions";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";

/**
 * Per-session outbox for messages composed while the session is offline. Items
 * are persisted to disk on every mutation so a force-quit doesn't lose queued
 * text, and flushed in order the moment the session reconnects. Flush keeps the
 * server-generated message id (no `clientMessageId`) — the live stream echoes
 * the row back and the message store dedupes by id.
 */
type OutboxState = {
  queuedBySession: Record<string, readonly QueuedMessage[]>;
  sendingBySession: Record<string, boolean>;
  errorBySession: Record<string, string | null>;
  hydrate: (connKey: string, sessionId: SessionId) => Promise<void>;
  enqueue: (
    connKey: string,
    sessionId: SessionId,
    text: string,
  ) => Promise<void>;
  flush: (
    connKey: string,
    options: WsProtocolOptions,
    sessionId: SessionId,
  ) => Promise<void>;
};

// In-flight guard so a reconnect burst can't start two overlapping flushes for
// the same session (which would double-send the head of the queue).
const flushing = new Set<string>();
let counter = 0;

const makeClientId = () =>
  `${Date.now().toString(36)}-${(counter++).toString(36)}`;

const persist = (
  connKey: string,
  sessionId: SessionId,
  items: readonly QueuedMessage[],
) =>
  Effect.runPromise(writeOutboxSnapshot(connKey, sessionId, { items })).catch(
    () => {},
  );

export const useOutboxStore = create<OutboxState>((set, get) => ({
  queuedBySession: {},
  sendingBySession: {},
  errorBySession: {},
  hydrate: async (connKey, sessionId) => {
    const key = connectionSessionKey(connKey, sessionId);
    if (get().queuedBySession[key] !== undefined) return;
    const cached = await Effect.runPromise(
      readOutboxSnapshot(connKey, sessionId),
    ).catch(() => null);
    const items = cached?.items ?? [];
    set((state) => ({
      queuedBySession: { ...state.queuedBySession, [key]: items },
      sendingBySession: { ...state.sendingBySession, [key]: false },
      errorBySession: { ...state.errorBySession, [key]: null },
    }));
  },
  enqueue: async (connKey, sessionId, text) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const item: QueuedMessage = {
      clientId: makeClientId(),
      text: trimmed,
      createdAt: Date.now(),
    };
    const key = connectionSessionKey(connKey, sessionId);
    const next = [...(get().queuedBySession[key] ?? []), item];
    set((state) => ({
      queuedBySession: { ...state.queuedBySession, [key]: next },
      errorBySession: { ...state.errorBySession, [key]: null },
    }));
    await persist(connKey, sessionId, next);
  },
  flush: async (connKey, options, sessionId) => {
    const key = connectionSessionKey(connKey, sessionId);
    if (flushing.has(key)) return;
    const queued = get().queuedBySession[key] ?? [];
    if (queued.length === 0) return;
    flushing.add(key);
    set((state) => ({
      sendingBySession: { ...state.sendingBySession, [key]: true },
      errorBySession: { ...state.errorBySession, [key]: null },
    }));
    try {
      // Hand local offline items to the server queue in order. Once accepted by
      // the server, the item is no longer local state; server queue flushing is
      // responsible for waiting until the session is idle.
      let remaining = queued;
      for (const item of queued) {
        try {
          await Effect.runPromise(
            queueMessage({
              connection: options,
              sessionId,
              input: makeTextInput(item.text),
            }),
          );
          await Effect.runPromise(flushServerQueue({ connection: options, sessionId }));
        } catch {
          set((state) => ({
            errorBySession: {
              ...state.errorBySession,
              [key]: "Could not send queued message. It will retry when the connection is ready.",
            },
          }));
          break;
        }
        remaining = remaining.filter(
          (entry) => entry.clientId !== item.clientId,
        );
        set((state) => ({
          queuedBySession: { ...state.queuedBySession, [key]: remaining },
        }));
        await persist(connKey, sessionId, remaining);
      }
    } finally {
      flushing.delete(key);
      set((state) => ({
        sendingBySession: { ...state.sendingBySession, [key]: false },
      }));
    }
  },
}));
