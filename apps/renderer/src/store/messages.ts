import { Effect, Fiber, Stream } from "effect";
import { create } from "zustand";

import {
  ComposerInput,
  Message,
  MessageId,
  type MessageContent,
  type ProviderId,
  type QueuedMessage,
  type SessionStatus,
  type SessionId,
  type ThreadGoal,
  type ThreadGoalSetInput,
} from "@zuse/contracts";

import { formatError } from "../lib/format-error.ts";
import { getRpcClient } from "../lib/rpc-client.ts";
import { readStorageWithLegacy } from "../lib/storage-keys.ts";
import { usePrDetailsStore } from "./pr-details.ts";
import { usePrStateStore } from "./pr-state.ts";
import { useSessionsStore } from "./sessions.ts";

let getMessagesRpcClient: typeof getRpcClient = getRpcClient;

export const setMessagesRpcClientForTest = (fn: typeof getRpcClient): void => {
  getMessagesRpcClient = fn;
};

/**
 * Tagged chat error shown in the message bubble at the bottom of a session.
 * The renderer classifies once on ingest so the bubble can show the right
 * CTA — "Sign in to Codex" for auth, "Connection lost" for network,
 * generic Retry otherwise — without re-parsing the message string on every
 * render.
 */
export type ChatError =
  | {
      readonly kind: "auth";
      readonly providerId?: ProviderId;
      readonly message: string;
    }
  | { readonly kind: "network"; readonly message: string }
  | { readonly kind: "generic"; readonly message: string };

const AUTH_PATTERN =
  /\b401\b|\bunauthorized\b|expired token|invalid_grant|signed?\s?out|sign\s?in required|please log in|please run \/login|not logged in|invalid authentication credentials|invalid api key|authorizationrequired|auth\(authorizationrequired\)|authentication failed/i;
const NETWORK_PATTERN =
  /\b(network|fetch|econn|enotfound|etimedout|timeout|getaddrinfo)\b/i;

/**
 * Read the per-session model-option bag the composer's ReasoningPicker
 * persists to sessionStorage. For opencode the value is a variant name
 * (`high`, `medium`, `super-high`, …) that comes from the live inventory,
 * so we pass it through as-is instead of enforcing the codex enum.
 *
 * Multiple keys are supported — the Claude provider uses `effort` for
 * its reasoning tier (with values `low | medium | high | xhigh | max |
 * ultracode`), `fastMode` / `thinking` booleans, and
 * `contextWindow` (`200k | 1m`). Non-Claude providers use `reasoning`.
 * Returns `null` when nothing has been set so the RPC payload stays
 * clean (drivers default to model presets).
 */
const SESSION_MODEL_OPTION_KEYS: ReadonlyArray<string> = [
  "reasoning",
  "effort",
  "fastMode",
  "thinking",
  "contextWindow",
];
const readSessionModelOptions = (
  sessionId: SessionId,
): Record<string, string> | null => {
  if (typeof window === "undefined") return null;
  const out: Record<string, string> = {};
  for (const key of SESSION_MODEL_OPTION_KEYS) {
    const v = readStorageWithLegacy(
      window.sessionStorage,
      `zuse.modelOptions.${sessionId}.${key}`,
      [`memoize.modelOptions.${sessionId}.${key}`],
    );
    if (v !== null && v.length > 0) out[key] = v;
  }
  // Backwards compat — the previous schema stored reasoning under a
  // bare `memoize.reasoning.<sessionId>` key. Read it if the new key
  // wasn't set so existing sessions don't lose their picker selection.
  if (out["reasoning"] === undefined) {
    const legacy = readStorageWithLegacy(
      window.sessionStorage,
      `zuse.reasoning.${sessionId}`,
      [`memoize.reasoning.${sessionId}`],
    );
    if (legacy !== null && legacy.length > 0) out["reasoning"] = legacy;
  }
  return Object.keys(out).length === 0 ? null : out;
};

export const classifyMessage = (
  message: string,
  providerId?: ProviderId,
): ChatError => {
  if (AUTH_PATTERN.test(message)) {
    return providerId
      ? { kind: "auth", providerId, message }
      : { kind: "auth", message };
  }
  if (NETWORK_PATTERN.test(message)) return { kind: "network", message };
  return { kind: "generic", message };
};

const classifyError = (err: unknown, providerId?: ProviderId): ChatError =>
  classifyMessage(formatError(err), providerId);

export const lookupSessionProvider = (
  sessionId: SessionId,
): ProviderId | undefined => {
  const buckets = useSessionsStore.getState().sessionsByProject;
  for (const list of Object.values(buckets)) {
    const sess = list.find((s) => s.id === sessionId);
    if (sess !== undefined) return sess.providerId;
  }
  return undefined;
};

type GoalRpcClient = {
  readonly session: {
    readonly "goal.stream": (payload: {
      readonly sessionId: SessionId;
    }) => Stream.Stream<
      { readonly sessionId: SessionId; readonly goal: ThreadGoal | null },
      unknown
    >;
    readonly "goal.set": (payload: {
      readonly sessionId: SessionId;
      readonly goal: ThreadGoalSetInput;
    }) => Effect.Effect<ThreadGoal, unknown>;
    readonly "goal.clear": (payload: {
      readonly sessionId: SessionId;
    }) => Effect.Effect<void, unknown>;
  };
};

/**
 * Live view of one session's message log. Subscribes to `messages.stream`
 * (which emits backfill rows then live ones), drops them straight into
 * `messagesBySession[sessionId]`. Switching sessions tears down the previous
 * subscription so a single live fiber is alive at any time.
 *
 * `inFlightBySession` is a heuristic — true while the last message is from
 * the user (assistant has not yet replied) or is a tool_use that hasn't
 * paired with a tool_result. PR 7 may swap this for a real session-status
 * subscription; for the chat-MVP it gives the composer a "running" indicator
 * that flips on send and back off when the assistant text arrives.
 */
/**
 * One queued mid-turn message. The user pressed Enter while a turn was in
 * flight; we hold the input here until the turn ends (auto-flush) or the
 * user clicks the Steer arrow on the chip.
 */
type MessagesState = {
  readonly messagesBySession: Record<string, ReadonlyArray<Message>>;
  readonly errorBySession: Record<string, ChatError | null>;
  /**
   * Mirror of `Session.status === "running"`, fed by the `session.streamStatus`
   * subscription. The composer reads this for its in-flight indicator so the
   * Send/Interrupt swap stays stable across the whole tool-call loop.
   */
  readonly runningBySession: Record<string, boolean>;
  readonly queueBySession: Record<string, ReadonlyArray<QueuedMessage>>;
  readonly queuePausedBySession: Record<string, boolean>;
  readonly goalBySession: Record<string, ThreadGoal | null>;
  readonly hydrate: (sessionId: SessionId) => Promise<void>;
  /**
   * Send a user turn. Accepts either a raw string (legacy / simple-text
   * callers) or a fully-typed `ComposerInput`. The underlying RPC accepts
   * both for the same reason — the composer migration to ComposerInput
   * lands incrementally across phases.
   */
  readonly send: (
    sessionId: SessionId,
    input: string | ComposerInput,
    opts?: { readonly asGoal?: boolean },
  ) => Promise<void>;
  readonly setGoal: (
    sessionId: SessionId,
    goal: ThreadGoalSetInput,
  ) => Promise<void>;
  readonly clearGoal: (sessionId: SessionId) => Promise<void>;
  readonly interrupt: (sessionId: SessionId) => Promise<void>;
  /** Append `input` to this session's queue. */
  readonly queue: (sessionId: SessionId, input: ComposerInput) => void;
  readonly updateQueued: (
    sessionId: SessionId,
    queueId: string,
    input: ComposerInput,
  ) => void;
  readonly reorderQueue: (
    sessionId: SessionId,
    queueIds: ReadonlyArray<string>,
  ) => void;
  readonly flushQueue: (sessionId: SessionId) => void;
  readonly resumeQueue: (sessionId: SessionId) => Promise<void>;
  /** Interrupt the running turn, then send `queueId` as the next user turn. */
  readonly steerFromQueue: (
    sessionId: SessionId,
    queueId: string,
  ) => Promise<void>;
  /** Silently drop a queue chip — no RPC call. */
  readonly dropFromQueue: (sessionId: SessionId, queueId: string) => void;
  readonly clearError: (sessionId: SessionId) => void;
  readonly observeSessionStatus: (
    sessionId: SessionId,
    status: SessionStatus,
  ) => void;
  /**
   * Re-send the most recent user turn. Used by the error-bubble Retry button
   * after the user fixed the underlying issue (re-auth, network back up).
   * No-op when there's no prior user message on the session.
   */
  readonly retry: (sessionId: SessionId) => Promise<void>;
};

let liveFiber: Fiber.Fiber<unknown, unknown> | null = null;
let statusFiber: Fiber.Fiber<unknown, unknown> | null = null;
let queueFiber: Fiber.Fiber<unknown, unknown> | null = null;
let goalFiber: Fiber.Fiber<unknown, unknown> | null = null;
let liveSessionId: SessionId | null = null;
// Monotonic token guarding `hydrate` against re-entrancy. `hydrate` mutates the
// module-global fibers + `liveSessionId` across two `await` points, so two
// overlapping calls (rapid tab switches, or React's mount→cleanup→mount) used
// to interleave and leave `liveFiber`/`liveSessionId` pointing at a session
// other than the one on screen — the active session then had no live stream, so
// freshly-sent / streamed messages never landed until a re-open re-ran the
// backfill. Each call captures the epoch on entry and bails after every await
// once a newer call (or `teardownLiveStreams`) has superseded it, so only the
// latest (rendered) session ever installs fibers.
let hydrateEpoch = 0;
// Message ids we minted optimistically in `send()`. When the server echoes the
// same row back over the live stream (same id, because the renderer passes the
// id as `clientMessageId`), we replace the optimistic row in place with the
// canonical server message instead of skipping it, so server-side fixups
// (stripped `pending-` attachments, server `createdAt`) win.
const optimisticIds = new Set<MessageId>();
// Highest event-log `sequence` seen per session (from `MessageEnvelope`).
// Passed back as `sinceSequence` on resubscribe so the server replays only
// the delta — gap-free reconnect without a full-history backfill. In-memory
// only: a reload starts from 0 and gets the full replay, which is correct.
const lastSequenceBySession = new Map<SessionId, number>();
const handoffRunningSessions = new Set<SessionId>();
const lastStatusBySession = new Map<SessionId, SessionStatus>();
const statusWaiters = new Map<
  SessionId,
  Set<(status: SessionStatus) => void>
>();
const handoffReleaseTimers = new Map<
  SessionId,
  ReturnType<typeof globalThis.setTimeout>
>();

const stopLiveFiber = async () => {
  // Clear the live marker FIRST, before any interrupt yields the event loop.
  // The status fiber's `resetOnStreamEnd` + stale-status-event handler both
  // guard on `liveSessionId === sessionId`. If a yield happens while this
  // still points at the outgoing session — e.g. the awaited `goalFiber`
  // interrupt below, which only exists for Codex/Grok — those handlers drain
  // and wrongly clobber `runningBySession[sessionId]` to false, dropping the
  // sidebar spinner for a backgrounded-but-still-running Codex/Grok chat the
  // moment you switch away. Claude has no `goalFiber` and so never yielded
  // here before this assignment, which is why the bug was Codex/Grok-only.
  liveSessionId = null;
  const tasks: Array<Promise<unknown>> = [];
  if (liveFiber !== null) {
    tasks.push(Effect.runPromise(Fiber.interrupt(liveFiber)));
    liveFiber = null;
  }
  if (statusFiber !== null) {
    tasks.push(Effect.runPromise(Fiber.interrupt(statusFiber)));
    statusFiber = null;
  }
  if (queueFiber !== null) {
    tasks.push(Effect.runPromise(Fiber.interrupt(queueFiber)));
    queueFiber = null;
  }
  if (goalFiber !== null) {
    await Effect.runPromise(Fiber.interrupt(goalFiber));
    goalFiber = null;
  }
  await Promise.all(tasks);
  // We intentionally do NOT clear the prior session's `runningBySession`
  // entry here. The sidebar-root `useSessionRunningSubscriptions` hook
  // keeps a persistent subscription per session, so the flag remains the
  // live truth even after switching away. Wiping it would make the
  // previous session's busy indicator disappear in the sidebar until
  // the next transition event.
};

/**
 * Tear down the single live message stream — called from the `ChatView`
 * effect cleanup on unmount / session change. Bumps `hydrateEpoch` first so a
 * `hydrate` still awaiting its RPC client can't resume and fork orphaned
 * fibers after the view is gone, then interrupts the live fibers.
 */
export const teardownLiveStreams = async (): Promise<void> => {
  hydrateEpoch++;
  await stopLiveFiber();
};

/**
 * Resolve when `runningBySession[sessionId]` becomes false (or stays false),
 * or when `timeoutMs` elapses. Used by steer to wait for the SDK's
 * post-interrupt cleanup before issuing the next send.
 */
const publishObservedStatus = (sessionId: SessionId, status: SessionStatus) => {
  lastStatusBySession.set(sessionId, status);
  const waiters = statusWaiters.get(sessionId);
  if (waiters === undefined) return;
  for (const waiter of waiters) waiter(status);
};

const holdRunningUntilNextTurn = (sessionId: SessionId) => {
  handoffRunningSessions.add(sessionId);
  const existingTimer = handoffReleaseTimers.get(sessionId);
  if (existingTimer !== undefined) globalThis.clearTimeout(existingTimer);
  const timer = globalThis.setTimeout(() => {
    handoffReleaseTimers.delete(sessionId);
    if (
      handoffRunningSessions.has(sessionId) &&
      lastStatusBySession.get(sessionId) !== "running"
    ) {
      handoffRunningSessions.delete(sessionId);
      useMessagesStore.setState((s) => ({
        runningBySession: { ...s.runningBySession, [sessionId]: false },
      }));
    }
  }, 5_000);
  handoffReleaseTimers.set(sessionId, timer);
  useMessagesStore.setState((s) => ({
    runningBySession: { ...s.runningBySession, [sessionId]: true },
  }));
};

const waitUntilIdle = (
  sessionId: SessionId,
  timeoutMs: number,
): Promise<void> =>
  new Promise((resolve) => {
    if (lastStatusBySession.get(sessionId) !== "running") {
      resolve();
      return;
    }
    const waiters = statusWaiters.get(sessionId) ?? new Set();
    statusWaiters.set(sessionId, waiters);
    const timeout = globalThis.setTimeout(() => {
      waiters.delete(onStatus);
      if (waiters.size === 0) statusWaiters.delete(sessionId);
      resolve();
    }, timeoutMs);
    const onStatus = (status: SessionStatus) => {
      if (status !== "running") {
        globalThis.clearTimeout(timeout);
        waiters.delete(onStatus);
        if (waiters.size === 0) statusWaiters.delete(sessionId);
        resolve();
      }
    };
    waiters.add(onStatus);
  });

export const useMessagesStore = create<MessagesState>((set, get) => ({
  messagesBySession: {},
  errorBySession: {},
  runningBySession: {},
  queueBySession: {},
  queuePausedBySession: {},
  goalBySession: {},
  hydrate: async (sessionId) => {
    if (
      liveSessionId === sessionId &&
      liveFiber !== null &&
      (get().messagesBySession[sessionId]?.length ?? 0) > 0
    ) {
      return;
    }
    const myEpoch = ++hydrateEpoch;
    await stopLiveFiber();
    // A newer hydrate (or a teardown) started while we were tearing down — let
    // it win rather than installing fibers for a session no longer on screen.
    if (myEpoch !== hydrateEpoch) return;
    set((s) => ({
      // Preserve any pre-seeded messages (e.g. the initial user message
      // that `chats.create` stuffed in optimistically) so the chat view
      // never flashes the empty state while the live stream connects.
      // The live subscription's id-set dedupe (~line 221) prevents the
      // backfill from double-emitting these rows.
      messagesBySession: {
        ...s.messagesBySession,
        [sessionId]: s.messagesBySession[sessionId] ?? [],
      },
      errorBySession: { ...s.errorBySession, [sessionId]: null },
    }));
    try {
      const client = await getMessagesRpcClient();
      // Superseded while awaiting the client — don't install stale fibers.
      if (myEpoch !== hydrateEpoch) return;
      // Set the live target + fork the fibers together (winner-only,
      // synchronously) so `liveSessionId` and the forked subscriptions can
      // never disagree. The `resetOnStreamEnd` / status guards below read
      // `liveSessionId`, so it must be correct before the fibers run.
      liveSessionId = sessionId;
      // Resume from the recorded cursor only while the store still holds the
      // rows the cursor accounts for; otherwise (first visit, page reload)
      // stream the full history. Pre-seeded optimistic rows never record a
      // cursor, so a fresh chat still gets its full replay + echo id-swap.
      const sinceSequence =
        (get().messagesBySession[sessionId]?.length ?? 0) > 0
          ? lastSequenceBySession.get(sessionId)
          : undefined;
      const messageProgram = Stream.runForEach(
        client["messages.stream"]({ sessionId, sinceSequence }),
        (envelope) =>
          Effect.sync(() => {
            const { sequence, message } = envelope;
            // Advance the cursor on EVERY envelope — including optimistic
            // echoes — before any dedup branch, so a reconnect can never
            // pass a cursor below an already-delivered row.
            const prev = lastSequenceBySession.get(sessionId) ?? 0;
            if (sequence > prev) lastSequenceBySession.set(sessionId, sequence);
            set((s) => {
              const current = s.messagesBySession[sessionId] ?? [];
              // The server echo of a message we inserted optimistically (same
              // id, passed as `clientMessageId` on send) — swap our placeholder
              // row for the canonical server row in place rather than skipping,
              // so server fixups (stripped `pending-` attachments, server
              // `createdAt`) take effect without a duplicate.
              if (optimisticIds.has(message.id)) {
                optimisticIds.delete(message.id);
                return {
                  messagesBySession: {
                    ...s.messagesBySession,
                    [sessionId]: current.map((m) =>
                      m.id === message.id ? message : m,
                    ),
                  },
                };
              }
              if (current.some((m) => m.id === message.id)) return s;
              const next = [...current, message];
              // Auto-untoggle plan mode when the SDK runs ExitPlanMode
              // successfully. The server already persists the flip via
              // a `PermissionModeChanged` agent-event side-effect; this
              // patches the renderer's session-store optimistically so
              // the chip flips without waiting for the next refresh.
              if (
                message.content._tag === "tool_result" &&
                message.content.isError === false
              ) {
                const useId = message.content.itemId;
                const paired = current.find(
                  (m) =>
                    m.content._tag === "tool_use" &&
                    m.content.itemId === useId &&
                    m.content.tool === "ExitPlanMode",
                );
                if (paired !== undefined) {
                  useSessionsStore.setState((sess) => {
                    let dirty = false;
                    const updated: typeof sess.sessionsByProject = {};
                    for (const [pid, list] of Object.entries(
                      sess.sessionsByProject,
                    )) {
                      updated[pid] = list.map((row) => {
                        if (
                          row.id === sessionId &&
                          row.permissionMode === "plan"
                        ) {
                          dirty = true;
                          return { ...row, permissionMode: "default" };
                        }
                        return row;
                      });
                    }
                    return dirty ? { sessionsByProject: updated } : sess;
                  });
                }
              }
              return {
                messagesBySession: {
                  ...s.messagesBySession,
                  [sessionId]: next,
                },
              };
            });
          }),
      ).pipe(
        Effect.catch((err) =>
          Effect.sync(() => {
            console.error("[messages] message stream errored", err);
            set((s) => ({
              errorBySession: {
                ...s.errorBySession,
                [sessionId]: classifyError(
                  err,
                  lookupSessionProvider(sessionId),
                ),
              },
            }));
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (liveSessionId === sessionId) liveFiber = null;
          }),
        ),
      );
      liveFiber = Effect.runFork(messageProgram);
      // Status mirror — keeps the composer's "running" indicator stable
      // across the whole tool-call loop. When a turn ends we also refresh
      // the project's PR state so freshly pushed branches recolor the
      // branch icon without waiting for the user to click around.
      // Reset the running flag if the status stream ever errors — otherwise
      // a transient RPC failure (server restart, dropped connection) leaves
      // `runningBySession[sessionId]` pinned `true`, and the composer is
      // stuck showing Interrupt with no way back to Send.
      //
      // BUT skip this reset when the stream ends because we deliberately
      // interrupted it during a session switch. In that case the OLD
      // session may still be running on the backend — the sidebar-root
      // `useSessionRunningSubscriptions` hook owns its state from now on
      // and we don't want to clobber its truth with a `false`.
      const resetOnStreamEnd = Effect.sync(() => {
        if (liveSessionId !== sessionId) return;
        useMessagesStore.setState((s) => {
          if (
            s.runningBySession[sessionId] !== true ||
            handoffRunningSessions.has(sessionId)
          ) {
            return s;
          }
          return {
            runningBySession: { ...s.runningBySession, [sessionId]: false },
          };
        });
      });
      const statusProgram = Stream.runForEach(
        client["session.streamStatus"]({ sessionId }).pipe(
          Stream.catch((err) => {
            console.error("[messages] status stream errored", err);
            return Stream.empty;
          }),
        ),
        (event) =>
          Effect.sync(() => {
            // Guard: the per-active-session statusFiber gets interrupted
            // when the user switches sessions, but its pending stream
            // events still drain during the async interrupt cleanup. Those
            // stale events would clobber the now-correct
            // `runningBySession[prevSessionId]` (typically a backend
            // `closed` emitted as the turn ends), making the prior
            // session's sidebar loader disappear the moment you navigate
            // away. The sidebar-root `useSessionRunningSubscriptions` hook
            // is the canonical writer for non-active sessions — let it
            // own those transitions.
            if (liveSessionId !== sessionId) return;
            const wasRunning = get().runningBySession[sessionId] === true;
            get().observeSessionStatus(sessionId, event.status);
            if (wasRunning && event.status !== "running") {
              // Refresh PR state for this session's specific (project,
              // worktree) pair — a turn that pushed commits on a worktree's
              // branch shouldn't touch the main checkout's cache entry.
              const sessions = useSessionsStore.getState().sessionsByProject;
              for (const list of Object.values(sessions)) {
                const sess = list.find((s) => s.id === sessionId);
                if (sess !== undefined) {
                  void usePrStateStore
                    .getState()
                    .refresh(sess.projectId, sess.worktreeId);
                  void usePrDetailsStore
                    .getState()
                    .refresh(sess.projectId, sess.worktreeId);
                  break;
                }
              }

              if (event.status === "idle" || event.status === "closed") {
                get().flushQueue(sessionId);
              }
            }
          }),
      ).pipe(Effect.ensuring(resetOnStreamEnd));
      statusFiber = Effect.runFork(statusProgram);
      queueFiber = Effect.runFork(
        Stream.runForEach(
          client["messages.queue.stream"]({ sessionId }),
          (state) =>
            Effect.sync(() => {
              set((s) => ({
                queueBySession: {
                  ...s.queueBySession,
                  [sessionId]: state.items,
                },
                queuePausedBySession: {
                  ...s.queuePausedBySession,
                  [sessionId]: state.paused,
                },
              }));
            }),
        ),
      );
      const goalProvider = lookupSessionProvider(sessionId);
      if (goalProvider === "codex" || goalProvider === "grok") {
        goalFiber = Effect.runFork(
          Stream.runForEach(
            (client as unknown as GoalRpcClient).session["goal.stream"]({
              sessionId,
            }).pipe(
              Stream.catch((err) => {
                console.error("[messages] goal stream errored", err);
                return Stream.empty;
              }),
            ),
            (event) =>
              Effect.sync(() => {
                set((s) => ({
                  goalBySession: {
                    ...s.goalBySession,
                    [sessionId]: event.goal,
                  },
                }));
              }),
          ),
        );
      }
    } catch (err) {
      set((s) => ({
        errorBySession: {
          ...s.errorBySession,
          [sessionId]: classifyError(err, lookupSessionProvider(sessionId)),
        },
      }));
    }
  },
  send: async (sessionId, input, opts) => {
    // Optimistic — flip running to true before the server status arrives so
    // the composer's Send→Interrupt swap doesn't flash through "idle" while
    // the RPC round-trip happens.
    // Codex goal sends don't run a turn immediately (Codex drives its own
    // status via native goal notifications), so we skip the optimistic flip
    // there. Grok runs goal mode by forwarding `/goal` as a real prompt turn,
    // so it should show the running indicator like any normal send.
    const skipOptimisticRunning =
      opts?.asGoal === true && lookupSessionProvider(sessionId) === "codex";
    // Optimistic message insert — show the user's turn instantly instead of
    // waiting for the server echo on the live stream. We mint the id here and
    // pass it as `clientMessageId` so the server persists the row under the
    // same id; the echo then dedupes against this row (and upgrades it to the
    // canonical server version in place — see the stream handler).
    const asGoal = opts?.asGoal === true;
    const optimisticContent: MessageContent =
      typeof input === "string"
        ? { _tag: "user", text: input, goal: asGoal }
        : (() => {
            const annotations = input.annotations ?? [];
            const hasRich =
              input.attachments.length > 0 ||
              input.fileRefs.length > 0 ||
              input.skillRefs.length > 0 ||
              annotations.length > 0;
            return hasRich
              ? {
                  _tag: "user_rich",
                  text: input.text,
                  attachments: input.attachments,
                  fileRefs: input.fileRefs,
                  skillRefs: input.skillRefs,
                  annotations,
                  goal: asGoal,
                }
              : { _tag: "user", text: input.text, goal: asGoal };
          })();
    const messageId = MessageId.make(crypto.randomUUID());
    const optimisticMessage = Message.make({
      id: messageId,
      sessionId,
      role: "user",
      content: optimisticContent,
      createdAt: new Date(),
    });
    optimisticIds.add(messageId);
    set((s) => ({
      errorBySession: { ...s.errorBySession, [sessionId]: null },
      runningBySession: skipOptimisticRunning
        ? s.runningBySession
        : { ...s.runningBySession, [sessionId]: true },
      messagesBySession: {
        ...s.messagesBySession,
        [sessionId]: [
          ...(s.messagesBySession[sessionId] ?? []),
          optimisticMessage,
        ],
      },
    }));
    try {
      const client = await getMessagesRpcClient();
      // Pick up the per-session reasoning selection the composer's
      // ReasoningPicker persists to sessionStorage. Drivers that don't
      // implement reasoning silently ignore it; only models whose
      // descriptor advertises a `reasoning` option even show the picker.
      const modelOptions = readSessionModelOptions(sessionId);
      const payload =
        typeof input === "string"
          ? {
              sessionId,
              text: input,
              asGoal: opts?.asGoal,
              clientMessageId: messageId,
              ...(modelOptions !== null ? { modelOptions } : {}),
            }
          : {
              sessionId,
              input,
              asGoal: opts?.asGoal,
              clientMessageId: messageId,
              ...(modelOptions !== null ? { modelOptions } : {}),
            };
      await Effect.runPromise(client["messages.send"](payload));
      void useSessionsStore.getState().refreshOne(sessionId);
    } catch (err) {
      // Reset the optimistic running flag — otherwise a failed send leaves
      // the composer stuck on Interrupt with no path back to Send (the
      // status stream won't emit "idle" if the server never saw the turn).
      // Also drop the optimistic message row so a failed send leaves no ghost.
      optimisticIds.delete(messageId);
      set((s) => ({
        errorBySession: {
          ...s.errorBySession,
          [sessionId]: classifyError(err, lookupSessionProvider(sessionId)),
        },
        runningBySession: { ...s.runningBySession, [sessionId]: false },
        messagesBySession: {
          ...s.messagesBySession,
          [sessionId]: (s.messagesBySession[sessionId] ?? []).filter(
            (m) => m.id !== messageId,
          ),
        },
      }));
    }
  },
  setGoal: async (sessionId, goal) => {
    try {
      const client = await getMessagesRpcClient();
      const next = await Effect.runPromise(
        (client as unknown as GoalRpcClient).session["goal.set"]({
          sessionId,
          goal,
        }),
      );
      set((s) => ({
        goalBySession: { ...s.goalBySession, [sessionId]: next },
      }));
    } catch (err) {
      set((s) => ({
        errorBySession: {
          ...s.errorBySession,
          [sessionId]: classifyError(err, lookupSessionProvider(sessionId)),
        },
      }));
    }
  },
  clearGoal: async (sessionId) => {
    try {
      const client = await getMessagesRpcClient();
      await Effect.runPromise(
        (client as unknown as GoalRpcClient).session["goal.clear"]({
          sessionId,
        }),
      );
      set((s) => ({
        goalBySession: { ...s.goalBySession, [sessionId]: null },
      }));
    } catch (err) {
      set((s) => ({
        errorBySession: {
          ...s.errorBySession,
          [sessionId]: classifyError(err, lookupSessionProvider(sessionId)),
        },
      }));
    }
  },
  interrupt: async (sessionId) => {
    try {
      const client = await getMessagesRpcClient();
      await Effect.runPromise(client["messages.interrupt"]({ sessionId }));
    } catch (err) {
      set((s) => ({
        errorBySession: {
          ...s.errorBySession,
          [sessionId]: classifyError(err, lookupSessionProvider(sessionId)),
        },
      }));
    }
  },
  queue: (sessionId, input) => {
    void (async () => {
      try {
        const client = await getMessagesRpcClient();
        const item = await Effect.runPromise(
          client["messages.queue.add"]({ sessionId, input }),
        );
        set((s) => {
          const existing = s.queueBySession[sessionId] ?? [];
          if (existing.some((q) => q.id === item.id)) return s;
          return {
            queueBySession: {
              ...s.queueBySession,
              [sessionId]: [...existing, item],
            },
          };
        });
      } catch (err) {
        set((s) => ({
          errorBySession: {
            ...s.errorBySession,
            [sessionId]: classifyError(err, lookupSessionProvider(sessionId)),
          },
        }));
      }
    })();
  },
  updateQueued: (sessionId, queueId, input) => {
    set((s) => ({
      queueBySession: {
        ...s.queueBySession,
        [sessionId]: (s.queueBySession[sessionId] ?? []).map((item) =>
          item.id === queueId
            ? { ...item, input, updatedAt: new Date() }
            : item,
        ),
      },
    }));
    void (async () => {
      try {
        const client = await getMessagesRpcClient();
        await Effect.runPromise(
          client["messages.queue.update"]({ sessionId, queueId, input }),
        );
      } catch (err) {
        set((s) => ({
          errorBySession: {
            ...s.errorBySession,
            [sessionId]: classifyError(err, lookupSessionProvider(sessionId)),
          },
        }));
      }
    })();
  },
  reorderQueue: (sessionId, queueIds) => {
    set((s) => {
      const current = s.queueBySession[sessionId] ?? [];
      const byId = new Map(current.map((item) => [item.id, item]));
      const ordered = [
        ...queueIds.flatMap((id) => {
          const item = byId.get(id);
          if (item === undefined) return [];
          byId.delete(id);
          return [item];
        }),
        ...current.filter((item) => byId.has(item.id)),
      ].map((item, position) => ({ ...item, position }));
      return {
        queueBySession: { ...s.queueBySession, [sessionId]: ordered },
      };
    });
    void (async () => {
      try {
        const client = await getMessagesRpcClient();
        await Effect.runPromise(
          client["messages.queue.reorder"]({ sessionId, queueIds }),
        );
      } catch (err) {
        set((s) => ({
          errorBySession: {
            ...s.errorBySession,
            [sessionId]: classifyError(err, lookupSessionProvider(sessionId)),
          },
        }));
      }
    })();
  },
  flushQueue: (sessionId) => {
    void (async () => {
      try {
        const client = await getMessagesRpcClient();
        await Effect.runPromise(client["messages.queue.flush"]({ sessionId }));
      } catch (err) {
        handoffRunningSessions.delete(sessionId);
        set((s) => ({
          errorBySession: {
            ...s.errorBySession,
            [sessionId]: classifyError(err, lookupSessionProvider(sessionId)),
          },
          runningBySession: { ...s.runningBySession, [sessionId]: false },
        }));
      }
    })();
  },
  resumeQueue: async (sessionId) => {
    try {
      if ((get().queueBySession[sessionId] ?? []).length > 0) {
        holdRunningUntilNextTurn(sessionId);
      }
      set((s) => ({
        queuePausedBySession: {
          ...s.queuePausedBySession,
          [sessionId]: false,
        },
      }));
      const client = await getMessagesRpcClient();
      await Effect.runPromise(client["messages.queue.resume"]({ sessionId }));
    } catch (err) {
      handoffRunningSessions.delete(sessionId);
      set((s) => ({
        errorBySession: {
          ...s.errorBySession,
          [sessionId]: classifyError(err, lookupSessionProvider(sessionId)),
        },
        runningBySession: { ...s.runningBySession, [sessionId]: false },
      }));
    }
  },
  dropFromQueue: (sessionId, queueId) => {
    set((s) => ({
      queueBySession: {
        ...s.queueBySession,
        [sessionId]: (s.queueBySession[sessionId] ?? []).filter(
          (q) => q.id !== queueId,
        ),
      },
    }));
    void (async () => {
      try {
        const client = await getMessagesRpcClient();
        await Effect.runPromise(
          client["messages.queue.delete"]({ sessionId, queueId }),
        );
      } catch (err) {
        set((s) => ({
          errorBySession: {
            ...s.errorBySession,
            [sessionId]: classifyError(err, lookupSessionProvider(sessionId)),
          },
        }));
      }
    })();
  },
  steerFromQueue: async (sessionId, queueId) => {
    const queue = get().queueBySession[sessionId] ?? [];
    const item = queue.find((q) => q.id === queueId);
    if (!item) return;
    // Optimistic — drop the chip from the queue before issuing the RPCs so
    // a re-click can't fire twice.
    set((s) => ({
      queueBySession: {
        ...s.queueBySession,
        [sessionId]: (s.queueBySession[sessionId] ?? []).filter(
          (q) => q.id !== queueId,
        ),
      },
    }));
    // Steer: interrupt the running turn, then wait for the SDK's post-interrupt
    // cleanup to land (mirrored by `runningBySession[sessionId] === false`)
    // before sending. Subscribing to the status mirror is race-free; the prior
    // 250ms sleep tripped over slow tool_result drains. A 4 s upper bound keeps
    // a stuck driver from hanging the queue forever.
    try {
      const wasRunning = get().runningBySession[sessionId] === true;
      if (wasRunning) {
        holdRunningUntilNextTurn(sessionId);
        await get().interrupt(sessionId);
        await waitUntilIdle(sessionId, 4_000);
      }
      const client = await getMessagesRpcClient();
      await Effect.runPromise(
        client["messages.queue.sendNow"]({ sessionId, queueId }),
      );
    } catch (err) {
      handoffRunningSessions.delete(sessionId);
      set((s) => ({
        errorBySession: {
          ...s.errorBySession,
          [sessionId]: classifyError(err, lookupSessionProvider(sessionId)),
        },
        runningBySession: { ...s.runningBySession, [sessionId]: false },
      }));
    }
  },
  observeSessionStatus: (sessionId, status) => {
    publishObservedStatus(sessionId, status);
    const isRunning = status === "running";
    if (isRunning) {
      handoffRunningSessions.delete(sessionId);
      const timer = handoffReleaseTimers.get(sessionId);
      if (timer !== undefined) {
        globalThis.clearTimeout(timer);
        handoffReleaseTimers.delete(sessionId);
      }
    }
    set((s) => ({
      runningBySession: {
        ...s.runningBySession,
        [sessionId]: isRunning || handoffRunningSessions.has(sessionId),
      },
    }));
  },
  clearError: (sessionId) =>
    set((s) => ({
      errorBySession: { ...s.errorBySession, [sessionId]: null },
    })),
  retry: async (sessionId) => {
    const msgs = get().messagesBySession[sessionId] ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!;
      const c = m.content;
      if (c._tag === "user_rich") {
        await get().send(
          sessionId,
          new ComposerInput({
            text: c.text,
            attachments: c.attachments,
            fileRefs: c.fileRefs,
            skillRefs: c.skillRefs,
            annotations: c.annotations,
          }),
        );
        return;
      }
      if (c._tag === "user") {
        await get().send(sessionId, c.text);
        return;
      }
    }
  },
}));
