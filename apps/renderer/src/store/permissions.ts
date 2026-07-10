import { Effect, Fiber, Schedule, Stream } from "effect";
import { create } from "zustand";

import type {
  FolderId,
  PermissionDecision,
  PermissionRequest,
  SavedDecision,
  SessionId,
} from "@zuse/wire";

import { getRpcClient } from "../lib/rpc-client.ts";

/**
 * Catalog of pending permission prompts. The renderer subscribes once to
 * `permission.requests` (a server-side broadcast) and routes each into
 * `requestsById`. Per-session filtering happens at the component layer —
 * the toast subscribes by session and shows the head of the queue.
 *
 * Decisions clear the prompt immediately on the client; the server also
 * removes it when `permission.decide` resolves, so a late-arriving stream
 * echo is harmless.
 */
type PermissionsState = {
  readonly requestsById: Record<string, PermissionRequest>;
  readonly errorBySession: Record<string, string | null>;
  readonly decisionsByProject: Record<string, ReadonlyArray<SavedDecision>>;
  readonly loadingDecisionsByProject: Record<string, boolean>;
  readonly start: () => void;
  readonly hydrate: (sessionId: SessionId) => Promise<void>;
  readonly decide: (
    requestId: string,
    decision: PermissionDecision,
  ) => Promise<void>;
  readonly loadDecisions: (projectId: FolderId) => Promise<void>;
  readonly revoke: (projectId: FolderId, requestId: string) => Promise<void>;
};

const formatError = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "_tag" in err) {
    return String((err as { _tag: unknown })._tag);
  }
  return String(err);
};

let streamFiber: Fiber.RuntimeFiber<unknown, unknown> | null = null;
// Real guard against double-subscribe. `streamFiber` is only a handle —
// it must never be used as the latch, since the previous design left it
// non-null after the stream died and wedged `start()` into a permanent
// no-op (live delivery dead until full reload).
let started = false;

// Ids of requests the user just decided. `decide()` removes them optimistically
// and the server drops them from `pending` synchronously, but a `listPending`
// poll (or a late stream echo) already in flight can race ahead and re-add the
// decided request for one cycle. Suppress those ids on both ingest paths until
// the in-flight reads drain.
const decidedRecently = new Set<string>();

export const usePermissionsStore = create<PermissionsState>((set, get) => ({
  requestsById: {},
  errorBySession: {},
  decisionsByProject: {},
  loadingDecisionsByProject: {},
  start: () => {
    if (started) return;
    started = true;
    void (async () => {
      let client: Awaited<ReturnType<typeof getRpcClient>>;
      try {
        client = await getRpcClient();
      } catch {
        // Couldn't get the client at all — allow a later retry.
        started = false;
        return;
      }
      // Re-hydrate every session we already know about on each (re)subscribe
      // to repair missed/cleared requests. No-op on first boot (empty map).
      const rehydrateKnownSessions = Effect.sync(() => {
        const seen = new Set<SessionId>();
        for (const req of Object.values(get().requestsById)) {
          if (seen.has(req.sessionId)) continue;
          seen.add(req.sessionId);
          void get().hydrate(req.sessionId);
        }
      });
      const subscribe = Stream.runForEach(
        client.permission.requests({}),
        (req) =>
          Effect.sync(() => {
            if (decidedRecently.has(req.id)) return;
            set((s) => ({
              requestsById: { ...s.requestsById, [req.id]: req },
            }));
          }),
      );
      // Self-healing: re-establish after any completion/error with bounded
      // backoff. Without this the stream dies once (server restart, dev HMR,
      // scope close) and live delivery never recovers. Mirrors the
      // `statusFiber` reset idiom in store/messages.ts.
      const program = Effect.andThen(rehydrateKnownSessions, subscribe).pipe(
        Effect.catch(() => Effect.void),
        Effect.repeat(Schedule.spaced("2 seconds")),
        Effect.ensuring(
          Effect.sync(() => {
            streamFiber = null;
            started = false;
          }),
        ),
      );
      streamFiber = Effect.runFork(program);
    })();
  },
  hydrate: async (sessionId) => {
    try {
      const client = await getRpcClient();
      const pending = await Effect.runPromise(
        client.permission.listPending({ sessionId }),
      );
      set((s) => {
        const next = { ...s.requestsById };
        for (const [id, req] of Object.entries(next)) {
          if (req.sessionId === sessionId) delete next[id];
        }
        for (const req of pending) {
          if (decidedRecently.has(req.id)) continue;
          next[req.id] = req;
        }
        return {
          requestsById: next,
          errorBySession: { ...s.errorBySession, [sessionId]: null },
        };
      });
    } catch (err) {
      set((s) => ({
        errorBySession: {
          ...s.errorBySession,
          [sessionId]: formatError(err),
        },
      }));
    }
  },
  decide: async (requestId, decision) => {
    decidedRecently.add(requestId);
    // Long enough to outlast any in-flight `listPending` poll / stream echo.
    window.setTimeout(() => decidedRecently.delete(requestId), 5000);
    set((s) => {
      const next = { ...s.requestsById };
      delete next[requestId];
      return { requestsById: next };
    });
    try {
      const client = await getRpcClient();
      await Effect.runPromise(
        client.permission.decide({ requestId, decision }),
      );
    } catch {
      // The server drops the entry on success; a failed decide leaves it in
      // memory and we'll re-hydrate via listPending on the next session
      // mount. No noisy error UI for this case.
    }
  },
  loadDecisions: async (projectId) => {
    set((s) => ({
      loadingDecisionsByProject: {
        ...s.loadingDecisionsByProject,
        [projectId]: true,
      },
    }));
    try {
      const client = await getRpcClient();
      const decisions = await Effect.runPromise(
        client.permission.listDecisions({ projectId }),
      );
      set((s) => ({
        decisionsByProject: {
          ...s.decisionsByProject,
          [projectId]: decisions,
        },
        loadingDecisionsByProject: {
          ...s.loadingDecisionsByProject,
          [projectId]: false,
        },
      }));
    } catch {
      set((s) => ({
        loadingDecisionsByProject: {
          ...s.loadingDecisionsByProject,
          [projectId]: false,
        },
      }));
    }
  },
  revoke: async (projectId, requestId) => {
    // Optimistic — drop the row from the cached list before the RPC settles.
    // If the RPC fails we re-fetch to repair state. In practice a failure
    // here is a renderer-side bug, not a user-visible state divergence.
    const before = get().decisionsByProject[projectId];
    set((s) => ({
      decisionsByProject: {
        ...s.decisionsByProject,
        [projectId]: (s.decisionsByProject[projectId] ?? []).filter(
          (d) => d.requestId !== requestId,
        ),
      },
    }));
    try {
      const client = await getRpcClient();
      await Effect.runPromise(
        client.permission.revokeDecision({ requestId }),
      );
    } catch {
      if (before !== undefined) {
        set((s) => ({
          decisionsByProject: {
            ...s.decisionsByProject,
            [projectId]: before,
          },
        }));
      }
    }
  },
}));
