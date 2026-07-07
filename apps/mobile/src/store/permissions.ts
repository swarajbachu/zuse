import type {
  PermissionDecision,
  PermissionRequest,
  SessionId,
} from "@zuse/wire";
import { Effect, Fiber, Stream } from "effect";
import { create } from "zustand";

import { decidePermission } from "~/rpc/actions";
import { connectionSessionKey } from "~/lib/session-key";
import { getConnectionClient, reportConnectionFailure } from "~/rpc/connection";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";

/**
 * Pending tool-permission prompts, surfaced as inline approval cards. These
 * arrive on the global `permission.requests` stream (not the message log), so
 * this store cold-loads via `permission.listPending` on mount and then filters
 * the live stream down to the active session — mirroring the fiber lifecycle of
 * the messages store.
 */
type PermissionsState = {
  pendingBySession: Record<string, readonly PermissionRequest[]>;
  hydrate: (
    connKey: string,
    options: WsProtocolOptions,
    sessionId: SessionId,
  ) => Promise<void>;
  decide: (
    connKey: string,
    options: WsProtocolOptions,
    sessionId: SessionId,
    requestId: string,
    decision: PermissionDecision,
  ) => Promise<void>;
};

const liveFibers = new Map<string, Fiber.RuntimeFiber<unknown, unknown>>();

const stop = async (key: string) => {
  const fiber = liveFibers.get(key);
  if (fiber !== undefined) {
    liveFibers.delete(key);
    await Effect.runPromise(Fiber.interrupt(fiber)).catch(() => {});
  }
};

export const usePermissionsStore = create<PermissionsState>((set, get) => ({
  pendingBySession: {},
  hydrate: async (connKey, options, sessionId) => {
    const liveKey = connectionSessionKey(connKey, sessionId);
    await stop(liveKey);
    try {
      const client = await Effect.runPromise(getConnectionClient(options));

      const listed = await Effect.runPromise(
        client.permission.listPending({ sessionId }),
      );
      set((state) => ({
        pendingBySession: { ...state.pendingBySession, [liveKey]: listed },
      }));

      const program = Stream.runForEach(
        client.permission.requests({}),
        (request) =>
          Effect.sync(() => {
            if (request.sessionId !== sessionId) return;
            set((state) => {
              const current = state.pendingBySession[liveKey] ?? [];
              if (current.some((entry) => entry.id === request.id))
                return state;
              return {
                pendingBySession: {
                  ...state.pendingBySession,
                  [liveKey]: [...current, request],
                },
              };
            });
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
      // A dropped permission stream is non-fatal: the messages store already
      // surfaces the connection error, and hydrate re-runs on the next mount.
    }
  },
  decide: async (connKey, options, sessionId, requestId, decision) => {
    // Optimistically drop the card; the server won't re-emit a decided request.
    const key = connectionSessionKey(connKey, sessionId);
    set((state) => ({
      pendingBySession: {
        ...state.pendingBySession,
        [key]: (state.pendingBySession[key] ?? []).filter(
          (entry) => entry.id !== requestId,
        ),
      },
    }));
    await Effect.runPromise(
      decidePermission({ connection: options, requestId, decision }),
    ).catch(() => {});
  },
}));
