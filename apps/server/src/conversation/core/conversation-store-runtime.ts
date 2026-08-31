import { canonicalizeToolInput } from "@zuse/agents/kernel/tool-input";
import {
	type AgentDefinition,
	AgentTurnId,
	type Chat,
	type FolderId,
	Message,
	type MessageContent,
	MessageId,
	type Session,
	type SessionId,
	SessionNotFoundError,
	ThreadGoal,
} from "@zuse/contracts";
import type { SessionCommand } from "@zuse/domain/core/commands";
import type { SessionDomainApi } from "@zuse/domain/engine/session-domain";
import type { SqlSessionQueriesApi } from "@zuse/domain/queries/sql-session-queries";
import { Effect, PubSub, type Scope } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { ApiActivityPublisherApi } from "../../api/activity-publisher.ts";
import type { NdjsonLoggerShape } from "../../persistence/ndjson-logger.ts";
import type { ProviderServiceShape } from "../../provider/services/provider-service.ts";
import type { ConversationOperations } from "../services/conversation-services.ts";
import type { ChatChangeEvent } from "./chat-change-event.ts";
import { makeConversationEventRuntime } from "./conversation-event-runtime.ts";
import type { ConversationGoalState } from "./conversation-goal-state.ts";
import { makeConversationGoalState } from "./conversation-goal-state.ts";
import {
	parentItemIdOfContent,
	roleForContent,
} from "./conversation-message-mapping.ts";
import { parseAgents, sessionFromRecord } from "./conversation-records.ts";
import type { ConversationStateApi } from "./conversation-state.ts";
import type { PersistedMessage } from "./conversation-store-types.ts";

export interface ConversationStoreRuntimeOptions {
	readonly serviceScope: Scope.Scope;
	readonly sql: SqlClient.SqlClient;
	readonly state: ConversationStateApi;
	readonly sessionQueries: SqlSessionQueriesApi;
	readonly sessionDomain: SessionDomainApi;
	readonly currentTimestamp: Effect.Effect<number>;
	readonly ndjson: NdjsonLoggerShape;
	readonly apiActivity: ApiActivityPublisherApi;
	readonly provider: ProviderServiceShape;
	readonly dispatchSessionCommand: (
		sessionId: SessionId,
		command: SessionCommand,
	) => Effect.Effect<void>;
	readonly runSessionReactors: Effect.Effect<void>;
	readonly flushQueueAfterIdle: (sessionId: SessionId) => Effect.Effect<void>;
	readonly shutdownQueueSession: (sessionId: SessionId) => Effect.Effect<void>;
}

export interface ConversationStoreRuntime {
	readonly beginTurn: (
		sessionId: SessionId,
		turnIdOverride?: AgentTurnId,
	) => Effect.Effect<AgentTurnId>;
	readonly resolveActiveTurn: (
		sessionId: SessionId,
	) => Effect.Effect<AgentTurnId | undefined>;
	readonly settleTurn: (
		sessionId: SessionId,
		turnId: AgentTurnId,
		outcome: "completed" | "interrupted" | "error",
	) => Effect.Effect<void>;
	/** Persist settlement while already inside the serialized reactor runner. */
	readonly settleTurnFromReactor: (
		sessionId: SessionId,
		turnId: AgentTurnId,
		outcome: "completed" | "interrupted" | "error",
	) => Effect.Effect<void>;
	readonly ndjsonAppend: (
		sessionId: SessionId,
		persisted: PersistedMessage,
	) => Effect.Effect<void>;
	readonly goalState: ConversationGoalState;
	readonly chatChangesHub: PubSub.PubSub<ChatChangeEvent>;
	readonly broadcastChat: (chat: Chat) => Effect.Effect<void>;
	readonly currentChatRevision: () => number;
	readonly lookupSession: ConversationOperations["getSession"];
	readonly agentsFor: ConversationStateApi["agents"];
	readonly persistMessage: (
		sessionId: SessionId,
		content: MessageContent,
		idOverride?: MessageId,
		turnIdOverride?: AgentTurnId,
	) => Effect.Effect<PersistedMessage>;
	readonly submitTurn: (
		sessionId: SessionId,
		turnId: AgentTurnId,
		content: MessageContent,
		providerInputJson: string,
		idOverride?: MessageId,
		commandId?: string,
	) => Effect.Effect<PersistedMessage>;
	readonly setStatus: (
		sessionId: SessionId,
		status: Session["status"],
	) => Effect.Effect<void>;
	readonly startSubscription: (sessionId: SessionId) => Effect.Effect<void>;
	readonly interruptProviderFiber: (
		sessionId: SessionId,
	) => Effect.Effect<void>;
	readonly teardownSubscription: (sessionId: SessionId) => Effect.Effect<void>;
}

export const makeConversationStoreRuntime = Effect.fn(
	"ConversationStoreRuntime.make",
)(function* (options: ConversationStoreRuntimeOptions) {
	const {
		serviceScope,
		sql,
		state,
		sessionQueries,
		sessionDomain,
		currentTimestamp,
		ndjson,
		apiActivity,
		provider,
		dispatchSessionCommand,
		runSessionReactors,
		flushQueueAfterIdle,
		shutdownQueueSession,
	} = options;
	const resolveActiveTurn = Effect.fn(
		"ConversationStoreRuntime.resolveActiveTurn",
	)(function* (sessionId: SessionId) {
		const cached = state.activeTurn(sessionId);
		if (cached !== undefined) return AgentTurnId.make(cached);
		const rows = yield* sql<{
			readonly type: string;
			readonly turn_id: string | null;
		}>`
			SELECT type, json_extract(payload_json, '$.turnId') AS turn_id
			FROM events
			WHERE stream_kind = 'session'
				AND stream_id = ${sessionId}
				AND type IN ('TurnStarted', 'TurnSettled')
			ORDER BY stream_version DESC
			LIMIT 1
		`.pipe(Effect.orDie);
		const latest = rows[0];
		if (latest?.type !== "TurnStarted" || latest.turn_id === null) {
			return undefined;
		}
		const turnId = AgentTurnId.make(latest.turn_id);
		state.rememberActiveTurn(sessionId, turnId);
		return turnId;
	});
	const beginTurn = (
		sessionId: SessionId,
		turnIdOverride?: AgentTurnId,
	): Effect.Effect<AgentTurnId> => {
		const existing = state.activeTurn(sessionId);
		if (existing !== undefined) return Effect.succeed(existing as AgentTurnId);
		const turnId =
			turnIdOverride ?? (`turn_${crypto.randomUUID()}` as AgentTurnId);
		return Effect.gen(function* () {
			const startedAt = yield* currentTimestamp;
			// The durable decider is the authority. After a restart (or if two
			// callers race before the cache is populated), it returns the already
			// running turn instead of letting this process invent a second one.
			const resolvedTurnId = (yield* sessionDomain
				.dispatch({
					commandId: crypto.randomUUID(),
					streamId: sessionId,
					command: { _tag: "StartTurn", turnId, startedAt },
				})
				.pipe(
					Effect.as(turnId),
					Effect.catchTag("TurnAlreadyRunning", (error) =>
						Effect.succeed(error.turnId),
					),
					Effect.orDie,
				)) as AgentTurnId;
			if (resolvedTurnId === turnId) yield* runSessionReactors;
			state.rememberActiveTurn(sessionId, resolvedTurnId);
			return resolvedTurnId;
		});
	};

	const persistTurnSettlement = (
		sessionId: SessionId,
		turnId: AgentTurnId,
		outcome: "completed" | "interrupted" | "error",
	): Effect.Effect<void> =>
		Effect.gen(function* () {
			yield* sessionDomain
				.dispatch({
					commandId: `turn:settle:${sessionId}:${turnId}:${outcome}`,
					streamId: sessionId,
					command: {
						_tag: "SettleTurn",
						turnId,
						outcome,
						settledAt: yield* currentTimestamp,
					},
				})
				.pipe(Effect.asVoid, Effect.orDie);
			if (state.activeTurn(sessionId) === turnId) {
				state.clearActiveTurn(sessionId);
			}
		});

	const settleTurnFromReactor: ConversationStoreRuntime["settleTurnFromReactor"] =
		(sessionId, turnId, outcome) =>
			persistTurnSettlement(sessionId, turnId, outcome).pipe(
				Effect.andThen(
					outcome === "error"
						? Effect.void
						: Effect.forkIn(flushQueueAfterIdle(sessionId), serviceScope),
				),
				Effect.asVoid,
			);

	const settleTurn: ConversationStoreRuntime["settleTurn"] = (
		sessionId,
		turnId,
		outcome,
	) =>
		Effect.gen(function* () {
			yield* persistTurnSettlement(sessionId, turnId, outcome);
			yield* runSessionReactors;
			if (outcome !== "error") {
				yield* Effect.forkIn(flushQueueAfterIdle(sessionId), serviceScope);
			}
		});

	const ndjsonAppend = (
		sessionId: SessionId,
		persisted: PersistedMessage,
	): Effect.Effect<void> =>
		Effect.gen(function* () {
			const message = persisted.message;
			let projectId = state.projectId(sessionId);
			if (projectId === undefined) {
				const rows = yield* sql<{ readonly project_id: string }>`
            SELECT project_id FROM sessions WHERE id = ${sessionId} LIMIT 1
          `.pipe(
					Effect.catch(() =>
						Effect.succeed(
							[] as ReadonlyArray<{ readonly project_id: string }>,
						),
					),
				);
				const [row] = rows;
				if (row === undefined) return;
				projectId = row.project_id as FolderId;
				state.setProjectId(sessionId, projectId);
			}
			yield* ndjson.append(sessionId, projectId, message);
		});

	const goalState = yield* makeConversationGoalState();

	// Single hub for chat-row changes (create / title / worktree binding).
	// Chats are few and updates rare, so one project-filtered hub keeps it
	// simple. `streamChatChanges` subscribes to this hub before reading its SQL
	// snapshot, closing the backfill-to-live gap for orchestrated creates.
	const chatChangesHub = yield* PubSub.unbounded<ChatChangeEvent>();
	let chatRevision = 0;
	const currentChatRevision = (): number => chatRevision;
	const broadcastChat = (chat: Chat): Effect.Effect<void> =>
		Effect.sync(() => {
			chatRevision += 1;
			PubSub.publishUnsafe(chatChangesHub, {
				projectId: chat.projectId,
				change: { _tag: "change", chat },
			});
		});

	// Chats whose LLM auto-name is in flight — cleared when the fiber ends.
	// Chats that already received a successful LLM title this process lifetime.

	const lookupSession = (
		sessionId: SessionId,
	): Effect.Effect<Session, SessionNotFoundError> =>
		Effect.gen(function* () {
			const record = yield* sessionQueries
				.get(sessionId)
				.pipe(
					Effect.catch((error) =>
						error._tag === "SessionQueryNotFound"
							? Effect.fail(new SessionNotFoundError({ sessionId }))
							: Effect.die(error),
					),
				);
			// Hydrate the agents cache from the row on first sight after boot
			// so resume / lazy-restart pick up the same roster the session was
			// created with.
			if (state.agents(sessionId) === undefined) {
				const parsed = parseAgents(record.agentsJson);
				if (parsed !== null && "agents" in parsed) {
					const hydrated = parsed as unknown as {
						agents: Record<string, AgentDefinition>;
						enableSubagents?: boolean;
					};
					state.setAgents(sessionId, {
						agents: hydrated.agents,
						enableSubagents: hydrated.enableSubagents ?? true,
					});
				}
			}
			return sessionFromRecord(record);
		});

	const agentsFor = (sessionId: SessionId) => state.agents(sessionId);

	const toolUseFingerprint = (
		content: Extract<MessageContent, { readonly _tag: "tool_use" }>,
	): string => {
		try {
			return JSON.stringify({
				itemId: content.itemId,
				tool: content.tool,
				input: canonicalizeToolInput(content.input),
				parentItemId: content.parentItemId ?? null,
			});
		} catch {
			return `${content.itemId}:${content.tool}:${String(content.input)}:${content.parentItemId ?? ""}`;
		}
	};

	const isDuplicateToolUse = (
		sessionId: SessionId,
		content: Extract<MessageContent, { readonly _tag: "tool_use" }>,
	): Effect.Effect<boolean> =>
		Effect.gen(function* () {
			const rows = yield* sql<{ readonly content_json: string }>`
          SELECT content_json FROM messages
          WHERE session_id = ${sessionId}
            AND kind = 'tool_use'
            AND json_valid(content_json)
            AND json_extract(content_json, '$.itemId') = ${content.itemId}
          ORDER BY sequence DESC
        `.pipe(Effect.orDie);
			const nextFingerprint = toolUseFingerprint(content);
			for (const row of rows) {
				try {
					const existing = JSON.parse(row.content_json) as MessageContent;
					if (
						existing._tag === "tool_use" &&
						existing.itemId === content.itemId &&
						toolUseFingerprint(existing) === nextFingerprint
					) {
						return true;
					}
				} catch {
					// Ignore malformed legacy rows; the normal schema path keeps JSON valid.
				}
			}
			return false;
		});

	const persistMessage = (
		sessionId: SessionId,
		content: MessageContent,
		idOverride?: MessageId,
		turnIdOverride?: AgentTurnId,
		commandIdentityOverride?: string,
	): Effect.Effect<PersistedMessage> =>
		Effect.gen(function* () {
			// `idOverride` is the renderer-minted `clientMessageId` for an
			// optimistic user message — reuse it so the live-stream echo carries
			// the same id the renderer already inserted. All other persists
			// (assistant/tool/error/goal) omit it and get a fresh server id.
			const id = idOverride ?? MessageId.make(crypto.randomUUID());
			const role = roleForContent(content);
			const now = new Date();
			const parentItemId = parentItemIdOfContent(content);
			const checkpoint =
				content._tag === "assistant" || content._tag === "thinking"
					? content.checkpoint
					: undefined;
			const receipt = yield* sessionDomain
				.dispatch({
					commandId:
						commandIdentityOverride === undefined
							? `message:persist:${id}`
							: `message:persist:${id}:${commandIdentityOverride}`,
					streamId: sessionId,
					command: {
						_tag: "PersistMessage",
						messageId: id,
						turnId: turnIdOverride ?? state.activeTurn(sessionId) ?? null,
						role,
						kind: content._tag,
						contentJson: JSON.stringify(content),
						parentItemId,
						checkpointRevision: checkpoint?.revision,
						checkpointFinal: checkpoint?.final,
						createdAt: now.getTime(),
					},
				})
				.pipe(Effect.orDie);
			const projected = yield* sql<{
				readonly sequence: number;
				readonly role: typeof role;
				readonly content_json: string;
				readonly created_at: string;
			}>`
							SELECT sequence, role, content_json, created_at
							FROM messages WHERE id = ${id} LIMIT 1
						`.pipe(Effect.orDie);
			const row = projected[0];
			if (row === undefined) {
				return yield* Effect.die(
					new Error(`message projection missing after dispatch: ${id}`),
				);
			}
			const projectedContent = JSON.parse(row.content_json) as MessageContent;
			return {
				message: Message.make({
					id,
					sessionId,
					role: row.role,
					content: projectedContent,
					createdAt: new Date(row.created_at),
				}),
				sequence: row.sequence,
				changed: receipt.eventIds.length > 0,
			};
		});

	const submitTurn = (
		sessionId: SessionId,
		turnId: AgentTurnId,
		content: MessageContent,
		providerInputJson: string,
		idOverride?: MessageId,
		commandId?: string,
	): Effect.Effect<PersistedMessage> =>
		Effect.gen(function* () {
			const id = idOverride ?? MessageId.make(crypto.randomUUID());
			const role = roleForContent(content);
			const now = new Date();
			const receipt = yield* sessionDomain
				.dispatch({
					commandId: commandId ?? `turn:submit:${id}`,
					streamId: sessionId,
					command: {
						_tag: "SubmitTurn",
						turnId,
						messageId: id,
						role,
						kind: content._tag,
						contentJson: JSON.stringify(content),
						parentItemId: parentItemIdOfContent(content),
						providerInputJson,
						createdAt: now.getTime(),
					},
				})
				.pipe(Effect.orDie);
			if (receipt.streamId !== sessionId) {
				return yield* Effect.die(
					new Error(
						`command receipt ${receipt.commandId} belongs to ${receipt.streamId}, not ${sessionId}`,
					),
				);
			}
			const messageEventId = receipt.eventIds[0];
			if (messageEventId === undefined) {
				return yield* Effect.die(
					new Error(
						`turn submit receipt ${receipt.commandId} has no message event`,
					),
				);
			}
			// The transport may lose the first successful response. A retry carries
			// the same command id but can mint a different local message/turn id, and
			// can arrive after the original turn settled or a successor started. Read
			// the original result from the receipt's events instead of assuming this
			// attempt's ids were appended.
			const projected = yield* sql<{
				readonly id: string;
				readonly turn_id: string | null;
				readonly sequence: number;
				readonly role: Message["role"];
				readonly content_json: string;
				readonly created_at: string;
			}>`
				SELECT m.id, m.turn_id, m.sequence, m.role, m.content_json,
					m.created_at
				FROM events e
				JOIN messages m
					ON m.id = json_extract(e.payload_json, '$.messageId')
				WHERE e.stream_kind = 'session'
					AND e.stream_id = ${sessionId}
					AND e.event_id = ${messageEventId}
					AND e.type = 'MessagePersisted'
					AND e.stream_version <= ${receipt.streamVersion}
				ORDER BY e.stream_version ASC
				LIMIT 1
			`.pipe(Effect.orDie);
			const row = projected[0];
			if (row === undefined || row.turn_id === null) {
				return yield* Effect.die(
					new Error(
						`message projection missing after turn submit: ${receipt.commandId}`,
					),
				);
			}

			// Keep the synchronous provider callback cache aligned to the durable
			// head, but only if another task has not changed it while this query was
			// in flight. In particular, replaying an old receipt must never clear or
			// replace a successor turn.
			const cachedTurnBeforeHeadRead = state.activeTurn(sessionId);
			const heads = yield* sql<{ readonly current_turn_id: string | null }>`
				SELECT current_turn_id FROM sessions WHERE id = ${sessionId} LIMIT 1
			`.pipe(Effect.orDie);
			const durableActiveTurn = heads[0]?.current_turn_id ?? null;
			yield* Effect.sync(() => {
				if (state.activeTurn(sessionId) !== cachedTurnBeforeHeadRead) return;
				if (durableActiveTurn !== null) {
					state.rememberActiveTurn(sessionId, durableActiveTurn);
				} else if (cachedTurnBeforeHeadRead === row.turn_id) {
					state.clearActiveTurn(sessionId);
				}
			});

			// Reactor effects are receipt-backed as well. Running reconciliation on
			// every retry closes the crash window between accepting the prompt and
			// starting the provider without duplicating already-completed effects.
			yield* runSessionReactors;
			return {
				message: Message.make({
					id: MessageId.make(row.id),
					sessionId,
					role: row.role,
					content: JSON.parse(row.content_json) as MessageContent,
					createdAt: new Date(row.created_at),
				}),
				sequence: row.sequence,
			};
		});

	const setStatus = (
		sessionId: SessionId,
		status: Session["status"],
	): Effect.Effect<void> =>
		Effect.gen(function* () {
			yield* dispatchSessionCommand(sessionId, {
				_tag: "SetStatus",
				status,
				updatedAt: yield* currentTimestamp,
			});
			if (status === "idle" || status === "closed") {
				yield* Effect.forkIn(flushQueueAfterIdle(sessionId), serviceScope);
			}
		});

	const publishApiActivity = (
		sessionId: SessionId,
		kind:
			| "approval-needed"
			| "question-needed"
			| "completed"
			| "error"
			| "running",
	): Effect.Effect<void> =>
		apiActivity
			.publish({ sessionId, kind })
			.pipe(
				Effect.catch((error) =>
					Effect.logDebug(
						`[ConversationServices] api activity publish failed: ${error.reason}`,
					),
				),
			);

	/**
	 * Fork a daemon that consumes the provider's event stream for one
	 * session and persists each renderable event into `messages` while
	 * fanning a copy out to live subscribers. Lifecycle events drive
	 * `sessions.status`. Failure paths are swallowed at the daemon
	 * boundary — the alternative is a runaway error that bubbles into the
	 * RPC server and tears down the whole transport.
	 */
	const eventRuntime = yield* makeConversationEventRuntime({
		scope: serviceScope,
		events: (sessionId) => provider.events(sessionId),
		providerId: (sessionId) =>
			lookupSession(sessionId).pipe(
				Effect.orDie,
				Effect.map((session) => session.providerId),
			),
		settleTurn,
		setResume: (sessionId, cursor, strategy, providerEventCursor) =>
			Effect.gen(function* () {
				yield* dispatchSessionCommand(sessionId, {
					_tag: "SetResume",
					cursor,
					resumeStrategy: strategy,
					...(providerEventCursor === undefined ? {} : { providerEventCursor }),
					updatedAt: yield* currentTimestamp,
				});
				if (providerEventCursor !== undefined) {
					yield* (
						provider.acknowledgeProviderEventCursor?.(
							sessionId,
							providerEventCursor,
						) ?? Effect.void
					).pipe(Effect.catch(() => Effect.void));
				}
			}),
		releaseProviderEventCursor: (sessionId, cursor) =>
			(
				provider.releaseProviderEventCursor?.(sessionId, cursor) ?? Effect.void
			).pipe(Effect.catch(() => Effect.void)),
		setPermissionMode: (sessionId, mode) =>
			Effect.gen(function* () {
				yield* dispatchSessionCommand(sessionId, {
					_tag: "SetPermissionMode",
					permissionMode: mode,
					updatedAt: yield* currentTimestamp,
				});
			}),
		publishGoal: (sessionId, goal) =>
			goalState.publish(
				sessionId,
				goal === null ? null : ThreadGoal.make(goal),
			),
		publishApiActivity,
		ignoreError: () => false,
		isDuplicateToolUse,
		persist: (sessionId, turnId, content, providerItemIdentity) =>
			Effect.gen(function* () {
				const checkpoint =
					content._tag === "assistant" || content._tag === "thinking"
						? content.checkpoint
						: undefined;
				const serialized = JSON.stringify(content);
				let fingerprint = 2166136261;
				for (let index = 0; index < serialized.length; index += 1) {
					fingerprint ^= serialized.charCodeAt(index);
					fingerprint = Math.imul(fingerprint, 16777619);
				}
				const stableId =
					providerItemIdentity === undefined
						? undefined
						: MessageId.make(`provider:${turnId}:${providerItemIdentity}`);
				const persisted = yield* persistMessage(
					sessionId,
					content,
					stableId,
					turnId,
					providerItemIdentity === undefined
						? undefined
						: checkpoint === undefined
							? (fingerprint >>> 0).toString(16)
							: `checkpoint:${checkpoint.revision}`,
				);
				if (persisted.changed !== false)
					yield* ndjsonAppend(sessionId, persisted);
			}),
	});
	const startSubscription = eventRuntime.start;
	const interruptProviderFiber = eventRuntime.interrupt;

	const teardownSubscription = (sessionId: SessionId): Effect.Effect<void> =>
		Effect.gen(function* () {
			yield* interruptProviderFiber(sessionId);
			yield* shutdownQueueSession(sessionId);
		});

	return {
		beginTurn,
		resolveActiveTurn,
		settleTurn,
		settleTurnFromReactor,
		ndjsonAppend,
		goalState,
		chatChangesHub,
		broadcastChat,
		currentChatRevision,
		lookupSession,
		agentsFor,
		persistMessage,
		submitTurn,
		setStatus,
		startSubscription,
		interruptProviderFiber,
		teardownSubscription,
	};
});
