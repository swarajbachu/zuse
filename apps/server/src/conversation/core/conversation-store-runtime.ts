import { canonicalizeToolInput } from "@zuse/agents/kernel/tool-input";
import {
	type AgentDefinition,
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
import type { NdjsonLoggerShape } from "../../persistence/ndjson-logger.ts";
import type { ProviderServiceShape } from "../../provider/services/provider-service.ts";
import type { RelayActivityPublisherApi } from "../../relay/activity-publisher.ts";
import type { ConversationOperations } from "../services/conversation-services.ts";
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
	readonly relayActivity: RelayActivityPublisherApi;
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
	readonly beginTurn: (sessionId: SessionId) => Effect.Effect<string>;
	readonly settleActiveTurn: (
		sessionId: SessionId,
		outcome: "completed" | "interrupted" | "error",
	) => Effect.Effect<void>;
	readonly ndjsonAppend: (
		sessionId: SessionId,
		persisted: PersistedMessage,
	) => Effect.Effect<void>;
	readonly goalState: ConversationGoalState;
	readonly chatChangesHub: PubSub.PubSub<Chat>;
	readonly broadcastChat: (chat: Chat) => Effect.Effect<void>;
	readonly lookupSession: ConversationOperations["getSession"];
	readonly agentsFor: ConversationStateApi["agents"];
	readonly persistMessage: (
		sessionId: SessionId,
		content: MessageContent,
		idOverride?: MessageId,
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
		relayActivity,
		provider,
		dispatchSessionCommand,
		runSessionReactors,
		flushQueueAfterIdle,
		shutdownQueueSession,
	} = options;
	const beginTurn = (sessionId: SessionId): Effect.Effect<string> => {
		const existing = state.activeTurn(sessionId);
		if (existing !== undefined) return Effect.succeed(existing);
		const turnId = `turn_${crypto.randomUUID()}`;
		return Effect.gen(function* () {
			const startedAt = yield* currentTimestamp;
			// The durable decider is the authority. After a restart (or if two
			// callers race before the cache is populated), it returns the already
			// running turn instead of letting this process invent a second one.
			const resolvedTurnId = yield* sessionDomain
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
				);
			if (resolvedTurnId === turnId) yield* runSessionReactors;
			state.rememberActiveTurn(sessionId, resolvedTurnId);
			return resolvedTurnId;
		});
	};

	const settleActiveTurn = (
		sessionId: SessionId,
		outcome: "completed" | "interrupted" | "error",
	): Effect.Effect<void> =>
		Effect.flatMap(currentTimestamp, (settledAt) =>
			dispatchSessionCommand(sessionId, {
				_tag: "SettleActiveTurn",
				outcome,
				settledAt,
			}),
		).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					state.clearActiveTurn(sessionId);
				}),
			),
		);

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
	const chatChangesHub = yield* PubSub.unbounded<Chat>();
	const broadcastChat = (chat: Chat): Effect.Effect<void> =>
		PubSub.publish(chatChangesHub, chat).pipe(Effect.asVoid);

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
			yield* sessionDomain
				.dispatch({
					commandId: `message:persist:${id}`,
					streamId: sessionId,
					command: {
						_tag: "PersistMessage",
						messageId: id,
						turnId: state.activeTurn(sessionId) ?? null,
						role,
						kind: content._tag,
						contentJson: JSON.stringify(content),
						parentItemId,
						createdAt: now.getTime(),
					},
				})
				.pipe(Effect.orDie);
			const projected = yield* sql<{ readonly sequence: number }>`
          SELECT sequence FROM messages WHERE id = ${id} LIMIT 1
        `.pipe(Effect.orDie);
			const sequence = projected[0]?.sequence;
			if (sequence === undefined) {
				return yield* Effect.die(
					new Error(`message projection missing after dispatch: ${id}`),
				);
			}
			return {
				message: Message.make({
					id,
					sessionId,
					role,
					content,
					createdAt: now,
				}),
				sequence,
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

	const publishRelayActivity = (
		sessionId: SessionId,
		kind:
			| "approval-needed"
			| "question-needed"
			| "completed"
			| "error"
			| "running",
	): Effect.Effect<void> =>
		relayActivity
			.publish({ sessionId, kind })
			.pipe(
				Effect.catch((error) =>
					Effect.logDebug(
						`[ConversationServices] relay activity publish failed: ${error.reason}`,
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
		setStatus,
		settleTurn: settleActiveTurn,
		setResume: (sessionId, cursor, strategy, providerEventCursor) =>
			Effect.gen(function* () {
				yield* dispatchSessionCommand(sessionId, {
					_tag: "SetResume",
					cursor,
					resumeStrategy: strategy,
					updatedAt: yield* currentTimestamp,
				});
				if (providerEventCursor !== undefined) {
					yield* options.sql`UPDATE sessions
						SET provider_event_cursor = ${providerEventCursor}
						WHERE id = ${sessionId}`.pipe(Effect.orDie);
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
		publishRelayActivity,
		ignoreError: () => false,
		isDuplicateToolUse,
		persist: (sessionId, content) =>
			Effect.gen(function* () {
				const persisted = yield* persistMessage(sessionId, content);
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
		settleActiveTurn,
		ndjsonAppend,
		goalState,
		chatChangesHub,
		broadcastChat,
		lookupSession,
		agentsFor,
		persistMessage,
		setStatus,
		startSubscription,
		interruptProviderFiber,
		teardownSubscription,
	};
});
