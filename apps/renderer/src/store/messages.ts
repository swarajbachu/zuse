import { SessionTimelineRegistry } from "@zuse/client-runtime/session-timeline";
import {
	AgentTurnId,
  ComposerInput,
  Message,
  type MessageContent,
	MessageId,
  type ProviderId,
	QueuedMessage,
  type SessionId,
	type SessionStatus,
  type ThreadGoal,
  type ThreadGoalSetInput,
} from "@zuse/contracts";
import { Effect, Fiber, Stream } from "effect";
import { formatError } from "../lib/format-error.ts";
import {
	markRendererInteraction,
	trackRendererRpc,
} from "../lib/performance-marks.ts";
import {
  dispatchRetryableRpcCommand,
  getRpcClient,
	reportRendererRpcStreamFailure,
	subscribeRendererRpcConnection,
} from "../lib/rpc-client.ts";
import { readStorageWithLegacy } from "../lib/storage-keys.ts";
import { createAtomStore as create } from "../state/atom-store.ts";
import {
	markQueueHydrated,
	subscribeSessionAcknowledged,
} from "./queue-hydration.ts";
import { useSessionsStore } from "./sessions.ts";

let getMessagesRpcClient: typeof getRpcClient = getRpcClient;
let dispatchMessagesRpcCommand: typeof dispatchRetryableRpcCommand =
  dispatchRetryableRpcCommand;
const queueFlushTails = new Map<SessionId, Promise<void>>();

export const setMessagesRpcClientForTest = (fn: typeof getRpcClient): void => {
  getMessagesRpcClient = fn;
};

export const setMessagesRpcCommandDispatcherForTest = (
  fn: typeof dispatchRetryableRpcCommand,
): void => {
  dispatchMessagesRpcCommand = fn;
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
   * Mirror of `Session.status === "running"`, fed by the `session.events`
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
	readonly queue: (
		sessionId: SessionId,
		input: ComposerInput,
		options?: {
			readonly queueId?: string;
			readonly persist?: boolean;
			readonly ready?: boolean;
		},
	) => string;
	readonly persistQueued: (
		sessionId: SessionId,
		queueId: string,
		input: ComposerInput,
		options?: { readonly ready?: boolean },
	) => Promise<void>;
  readonly updateQueued: (
    sessionId: SessionId,
    queueId: string,
    input: ComposerInput,
  ) => Promise<void>;
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
	readonly observeSessionStatuses: (
		statuses: ReadonlyArray<{
			readonly sessionId: SessionId;
			readonly status: SessionStatus;
		}>,
	) => void;
  /**
   * Re-send the most recent user turn. Used by the error-bubble Retry button
   * after the user fixed the underlying issue (re-auth, network back up).
   * No-op when there's no prior user message on the session.
   */
  readonly retry: (sessionId: SessionId) => Promise<void>;
};

const timelineFibers = new Map<SessionId, Fiber.Fiber<unknown, unknown>>();
const timelineTokens = new Map<SessionId, object>();
const timelineRegistry = new SessionTimelineRegistry();
const retainedTimelineSessions = new Set<SessionId>();
const pendingTimelineSessionCreations = new Set<SessionId>();
const timelineEvictionTimers = new Map<SessionId, ReturnType<typeof setTimeout>>();
const goalFibers = new Map<SessionId, Fiber.Fiber<unknown, unknown>>();
let liveConnectionGeneration: number | null = null;
let unsubscribeLiveConnection: (() => void) | null = null;
// Message ids we minted optimistically in `send()`. When the server echoes the
// same row back over the live stream (same id, because the renderer passes the
// id as `clientMessageId`), we replace the optimistic row in place with the
// canonical server message instead of skipping it, so server-side fixups
// (stripped `pending-` attachments, server `createdAt`) win.
const optimisticIds = new Set<MessageId>();
const stopLiveConnectionSubscription = (): void => {
	unsubscribeLiveConnection?.();
	unsubscribeLiveConnection = null;
	liveConnectionGeneration = null;
};

const ensureLiveConnectionSubscription = (): void => {
	if (unsubscribeLiveConnection !== null) return;
	unsubscribeLiveConnection = subscribeRendererRpcConnection((snapshot) => {
		if (snapshot.status !== "connected") return;
		if (liveConnectionGeneration === null) {
			liveConnectionGeneration = snapshot.generation;
			return;
		}
		if (liveConnectionGeneration === snapshot.generation) return;
		liveConnectionGeneration = snapshot.generation;
		const sessions = [...retainedTimelineSessions];
		for (const [sessionId, fiber] of timelineFibers) {
			timelineFibers.delete(sessionId);
			timelineTokens.delete(sessionId);
			void Effect.runPromise(Fiber.interrupt(fiber));
		}
		for (const sessionId of sessions) void useMessagesStore.getState().hydrate(sessionId);
	});
};

const reportActiveStreamFailure = (cause: unknown): void => {
	const generation = liveConnectionGeneration;
	if (generation === null) return;
	reportRendererRpcStreamFailure(generation, cause);
};

export const deferTimelineUntilSessionCreated = (sessionId: SessionId): void => {
	pendingTimelineSessionCreations.add(sessionId);
};

export const acknowledgeTimelineSessionCreated = (
	sessionId: SessionId,
): void => {
	pendingTimelineSessionCreations.delete(sessionId);
	if (retainedTimelineSessions.has(sessionId) && !timelineFibers.has(sessionId)) {
		void useMessagesStore.getState().hydrate(sessionId);
	}
};

export const discardTimelineSessionCreation = (sessionId: SessionId): void => {
	pendingTimelineSessionCreations.delete(sessionId);
};

export const teardownLiveStreams = async (sessionId?: SessionId): Promise<void> => {
	if (sessionId !== undefined) {
		retainedTimelineSessions.delete(sessionId);
		const previous = timelineEvictionTimers.get(sessionId);
		if (previous !== undefined) clearTimeout(previous);
		if (timelineRegistry.state(sessionId).projection?.currentTurn != null) return;
		timelineEvictionTimers.set(sessionId, setTimeout(() => {
			timelineEvictionTimers.delete(sessionId);
			if (retainedTimelineSessions.has(sessionId)) return;
			const fiber = timelineFibers.get(sessionId);
			if (fiber !== undefined) void Effect.runPromise(Fiber.interrupt(fiber));
			timelineFibers.delete(sessionId);
			timelineTokens.delete(sessionId);
			timelineRegistry.delete(sessionId);
		}, 5 * 60_000));
		return;
	}
	stopLiveConnectionSubscription();
	for (const timer of timelineEvictionTimers.values()) clearTimeout(timer);
	timelineEvictionTimers.clear();
	retainedTimelineSessions.clear();
	pendingTimelineSessionCreations.clear();
	const fibers = [...timelineFibers.values(), ...goalFibers.values()];
	timelineFibers.clear();
	timelineTokens.clear();
	goalFibers.clear();
	timelineRegistry.shutdown();
	await Promise.all(fibers.map((fiber) => Effect.runPromise(Fiber.interrupt(fiber))));
};

export const useMessagesStore = create<MessagesState>((set, get) => ({
  messagesBySession: {},
  errorBySession: {},
  runningBySession: {},
  queueBySession: {},
  queuePausedBySession: {},
  goalBySession: {},
  hydrate: async (sessionId) => {
		retainedTimelineSessions.add(sessionId);
		const eviction = timelineEvictionTimers.get(sessionId);
		if (eviction !== undefined) clearTimeout(eviction);
		timelineEvictionTimers.delete(sessionId);
		if (pendingTimelineSessionCreations.has(sessionId)) return;
		ensureLiveConnectionSubscription();
		if (timelineFibers.has(sessionId)) return;
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
			if (
				!retainedTimelineSessions.has(sessionId) ||
				timelineFibers.has(sessionId)
			) {
				return;
			}
      // Resume from the recorded cursor only while the store still holds the
      // rows the cursor accounts for; otherwise (first visit, page reload)
      // stream the full history. Pre-seeded optimistic rows never record a
      // cursor, so a fresh chat still gets its full replay + echo id-swap.
			const retainedTimeline = timelineRegistry.state(sessionId);
			const afterVersion =
				retainedTimeline.projection === null
					? undefined
					: retainedTimeline.appliedVersion;
			const publishTimelineState = (): void => {
				const timeline = timelineRegistry.state(sessionId);
				const projection = timeline.projection;
				if (projection === null) return;
				const durableIds = new Set(projection.messages.map((row) => row.id));
				for (const id of optimisticIds) {
					if (durableIds.has(id)) optimisticIds.delete(id);
				}
				const optimistic = (get().messagesBySession[sessionId] ?? []).filter(
					(row) => optimisticIds.has(row.id) && !durableIds.has(row.id),
							);
						if (
					projection.messages.length > 0 &&
					(get().messagesBySession[sessionId]?.length ?? 0) === 0
						) {
					markRendererInteraction(sessionId, "first-transcript-message");
					}
				set((state) => ({
						messagesBySession: {
							...state.messagesBySession,
						[sessionId]: [...projection.messages, ...optimistic],
						},
            runningBySession: {
              ...state.runningBySession,
						[sessionId]: projection.currentTurn !== null,
					},
					queueBySession: {
						...state.queueBySession,
						[sessionId]: projection.queue.items,
            },
					queuePausedBySession: {
						...state.queuePausedBySession,
						[sessionId]: projection.queue.paused,
					},
				}));
				markQueueHydrated(sessionId);
				get().observeSessionStatus(sessionId, projection.status);
          };
			const streamToken = {};
      const messageProgram = Stream.runForEach(
        client["session.events"]({
          sessionId,
					afterVersion,
					hasProjection: retainedTimeline.projection !== null,
        }),
				(frame) =>
          Effect.sync(() => {
						timelineRegistry.accept(sessionId, frame);
						publishTimelineState();
          }),
      ).pipe(
				Effect.andThen(
					Effect.sync(() => {
						reportActiveStreamFailure(
							new Error("active transcript stream completed unexpectedly"),
						);
					}),
				),
        Effect.catch((err) =>
          Effect.sync(() => {
						reportActiveStreamFailure(err);
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
						if (timelineTokens.get(sessionId) === streamToken) {
							timelineTokens.delete(sessionId);
							timelineFibers.delete(sessionId);
							}
            }),
        ),
      );
			const timelineFiber = Effect.runFork(messageProgram);
			timelineTokens.set(sessionId, streamToken);
			timelineFibers.set(sessionId, timelineFiber);
      const goalProvider = lookupSessionProvider(sessionId);
      if (goalProvider === "codex" || goalProvider === "grok") {
				goalFibers.set(
					sessionId,
					Effect.runFork(
          Stream.runForEach(
            client["session.goal.stream"]({
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
      await dispatchRetryableRpcCommand(messageId, async () => {
        const client = await getMessagesRpcClient();
        return Effect.runPromise(client["messages.send"](payload));
      });
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
        client["session.goal.set"]({
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
        client["session.goal.clear"]({
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
			const turnId =
				timelineRegistry.state(sessionId).projection?.currentTurn?.turnId;
			if (turnId === undefined) return;
      const client = await getMessagesRpcClient();
			await Effect.runPromise(
				client["messages.interrupt"]({ sessionId, turnId }),
			);
    } catch (err) {
      set((s) => ({
        errorBySession: {
          ...s.errorBySession,
          [sessionId]: classifyError(err, lookupSessionProvider(sessionId)),
        },
      }));
    }
  },
	queue: (sessionId, input, options) => {
		const queueId = options?.queueId ?? `q_${crypto.randomUUID()}`;
		const now = new Date();
        set((s) => {
          const existing = s.queueBySession[sessionId] ?? [];
			if (existing.some((item) => item.id === queueId)) return s;
          return {
            queueBySession: {
              ...s.queueBySession,
					[sessionId]: [
						...existing,
						QueuedMessage.make({
							id: queueId,
							sessionId,
							input,
							position: existing.length,
							createdAt: now,
							updatedAt: now,
							ready: options?.ready ?? true,
						}),
					],
            },
          };
        });
		markQueueHydrated(sessionId);
		if (options?.persist !== false) {
			void get().persistQueued(sessionId, queueId, input, {
				ready: options?.ready,
			});
		}
		return queueId;
	},
	persistQueued: async (sessionId, queueId, input, options) => {
		try {
			const item = await trackRendererRpc("messages.queue.add", () =>
				dispatchMessagesRpcCommand(
					`queue-add:${sessionId}:${queueId}`,
					async () => {
						const client = await getMessagesRpcClient();
						return Effect.runPromise(
							client["messages.queue.add"]({
								sessionId,
								queueId,
								input,
								...(options?.ready !== undefined
									? { ready: options.ready }
									: {}),
							}),
						);
					},
				),
			);
			markRendererInteraction(sessionId, "queue-persisted");
			set((s) => ({
				queueBySession: {
					...s.queueBySession,
					[sessionId]: (s.queueBySession[sessionId] ?? []).map((queued) =>
						queued.id === queueId ? item : queued,
					),
				},
				errorBySession: { ...s.errorBySession, [sessionId]: null },
			}));
			// The idle transition may have won the race with insertion. The server
			// also probes on add; this reconnect-safe command is a harmless fallback.
        get().flushQueue(sessionId);
      } catch (err) {
			// Keep the optimistic row visible: the stable queue id makes a retry safe.
        set((s) => ({
          errorBySession: {
            ...s.errorBySession,
            [sessionId]: classifyError(err, lookupSessionProvider(sessionId)),
          },
        }));
      }
  },
  updateQueued: async (sessionId, queueId, input) => {
    set((s) => ({
      queueBySession: {
        ...s.queueBySession,
        [sessionId]: (s.queueBySession[sessionId] ?? []).map((item) =>
          item.id === queueId
            ? { ...item, input, ready: true, updatedAt: new Date() }
            : item,
        ),
      },
    }));
    try {
      const client = await getMessagesRpcClient();
      const item = await Effect.runPromise(
        client["messages.queue.update"]({ sessionId, queueId, input }),
      );
		set((s) => ({
			queueBySession: {
				...s.queueBySession,
				[sessionId]: (s.queueBySession[sessionId] ?? []).map((queued) =>
					queued.id === queueId ? item : queued,
				),
			},
		}));
      } catch (err) {
			if (
				typeof err === "object" &&
				err !== null &&
				"_tag" in err &&
				err._tag === "QueuedMessageNotFoundError"
			) {
				const queued = (get().queueBySession[sessionId] ?? []).find(
					(item) => item.id === queueId,
				);
				if (queued !== undefined) {
					// The initial durable add may have failed while the optimistic row
					// stayed visible. Re-add only while that row still exists locally;
					// a user deletion therefore remains a tombstone for this finalizer.
					await get().persistQueued(sessionId, queueId, input, { ready: true });
				}
				return;
			}
        set((s) => ({
          errorBySession: {
            ...s.errorBySession,
            [sessionId]: classifyError(err, lookupSessionProvider(sessionId)),
          },
        }));
      }
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
    const previous = queueFlushTails.get(sessionId) ?? Promise.resolve();
    const commandId = `queue-flush:${sessionId}:${crypto.randomUUID()}`;
    const current = previous
      .catch(() => undefined)
      .then(() =>
        dispatchMessagesRpcCommand(commandId, async () => {
          const client = await getMessagesRpcClient();
          return Effect.runPromise(
            client["messages.queue.flush"]({ sessionId }),
          );
        }),
      );
    queueFlushTails.set(sessionId, current);
    void current
      .catch((err) => {
        set((s) => ({
          errorBySession: {
            ...s.errorBySession,
            [sessionId]: classifyError(err, lookupSessionProvider(sessionId)),
          },
        }));
      })
      .finally(() => {
        if (queueFlushTails.get(sessionId) === current) {
          queueFlushTails.delete(sessionId);
        }
      });
  },
  resumeQueue: async (sessionId) => {
    try {
      set((s) => ({
        queuePausedBySession: {
          ...s.queuePausedBySession,
          [sessionId]: false,
        },
      }));
      const client = await getMessagesRpcClient();
      await Effect.runPromise(client["messages.queue.resume"]({ sessionId }));
    } catch (err) {
      set((s) => ({
        errorBySession: {
          ...s.errorBySession,
          [sessionId]: classifyError(err, lookupSessionProvider(sessionId)),
        },
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
    try {
      const client = await getMessagesRpcClient();
			const currentTurn =
				timelineRegistry.state(sessionId).projection?.currentTurn;
			if (currentTurn === null || currentTurn === undefined) {
      await Effect.runPromise(
        client["messages.queue.sendNow"]({ sessionId, queueId }),
      );
			} else {
				await Effect.runPromise(
					client["messages.steer"]({
						sessionId,
						expectedTurnId: currentTurn.turnId,
						queueId,
						successorTurnId: AgentTurnId.make(`turn_${crypto.randomUUID()}`),
						commandId: `steer:${sessionId}:${queueId}:${crypto.randomUUID()}`,
					}),
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
  observeSessionStatus: (sessionId, status) => {
		get().observeSessionStatuses([{ sessionId, status }]);
	},
	observeSessionStatuses: (statuses) => {
		if (statuses.length === 0) return;
		const running = { ...get().runningBySession };
		for (const { sessionId, status } of statuses) {
			if (status === "idle" || status === "running") {
				markRendererInteraction(sessionId, "provider-ready");
			}
			const isRunning = status === "running";
			running[sessionId] = isRunning;
		}
		set({ runningBySession: running });
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

subscribeSessionAcknowledged((sessionId) => {
	const state = useMessagesStore.getState();
	for (const item of state.queueBySession[sessionId] ?? []) {
		void state.persistQueued(sessionId, item.id, item.input, {
			ready: item.ready,
		});
	}
});
