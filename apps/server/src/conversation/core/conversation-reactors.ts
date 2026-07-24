/** Wires durable conversation reactor runners to focused handlers. */
import type {
	ChatArchiveScriptError,
	ChatArchiveTimeoutError,
	ChatArchiveWorktreeError,
	ChatNotFoundError,
	SessionStartError,
} from "@zuse/contracts";
import { ChatEvent } from "@zuse/domain/chat/events";
import type { StoredEvent } from "@zuse/domain/engine/dispatch";
import {
	type ReactorDispatchInput,
	ReactorRunner,
} from "@zuse/domain/engine/reactor-runner";
import {
	makeSqlConsumerStorage,
	type SqlConsumerStorageError,
} from "@zuse/domain/engine/sql-consumer-storage";
import {
	type AutoNameCommand,
	autoNameReactorDefinition,
	type ChatArchiveCommand,
	type ChatDeleteCommand,
	chatArchiveReactorDefinition,
	chatDeleteReactorDefinition,
	type ProviderInterruptCommand,
	type ProviderStartCommand,
	type ProviderStopCommand,
	type ProviderTurnCommand,
	providerInterruptReactorDefinition,
	providerStartReactorDefinition,
	providerStopReactorDefinition,
	providerTurnReactorDefinition,
	type ScheduledSuccessorCommand,
	scheduledSuccessorReactorDefinition,
} from "@zuse/domain/reactors/conversation";
import { Effect, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";

export type ChatArchiveReactorError =
	| ChatNotFoundError
	| ChatArchiveScriptError
	| ChatArchiveTimeoutError
	| ChatArchiveWorktreeError;

export interface ConversationReactorHandlers {
	readonly providerStart: (
		input: ReactorDispatchInput<ProviderStartCommand>,
	) => Effect.Effect<void, SessionStartError>;
	readonly providerStop: (
		input: ReactorDispatchInput<ProviderStopCommand>,
	) => Effect.Effect<void>;
	readonly providerTurn: (
		input: ReactorDispatchInput<ProviderTurnCommand>,
	) => Effect.Effect<void>;
	readonly providerInterrupt: (
		input: ReactorDispatchInput<ProviderInterruptCommand>,
	) => Effect.Effect<void>;
	readonly scheduledSuccessor: (
		input: ReactorDispatchInput<ScheduledSuccessorCommand>,
	) => Effect.Effect<void>;
	readonly autoName: (
		input: ReactorDispatchInput<AutoNameCommand>,
	) => Effect.Effect<void>;
	readonly chatArchive: (
		input: ReactorDispatchInput<ChatArchiveCommand>,
	) => Effect.Effect<void, ChatArchiveReactorError>;
	readonly chatDelete: (
		input: ReactorDispatchInput<ChatDeleteCommand>,
	) => Effect.Effect<void, ChatNotFoundError>;
}

export interface ConversationReactorRuntime {
	readonly runSession: Effect.Effect<void>;
	readonly runProviderStart: Effect.Effect<void, SessionStartError>;
	readonly runProviderStop: Effect.Effect<void>;
	readonly runChatArchive: Effect.Effect<void, ChatArchiveReactorError>;
	readonly runChatDelete: Effect.Effect<void, ChatNotFoundError>;
	readonly catchUpAll: Effect.Effect<
		void,
		SessionStartError | ChatArchiveReactorError | ChatNotFoundError
	>;
}

const decodeChatEvent = Schema.decodeUnknownEffect(
	Schema.fromJsonString(ChatEvent),
);

const providerTurnKey = (sessionId: string, turnId: string) =>
	`${sessionId}\u0000${turnId}`;

export const loadSettledProviderTurnKeys = Effect.fn(
	"ConversationReactors.loadSettledProviderTurnKeys",
)(function* (sql: SqlClient.SqlClient) {
	const rows = yield* sql<{
		readonly stream_id: string;
		readonly turn_id: string;
	}>`
		SELECT
			requested.stream_id,
			json_extract(requested.payload_json, '$.turnId') AS turn_id
		FROM events AS requested
		WHERE requested.stream_kind = 'session'
			AND requested.type = 'ProviderTurnRequested'
			AND requested.sequence > COALESCE(
				(
					SELECT last_sequence
					FROM projector_cursors
					WHERE projector_name = 'reactor:provider-turn'
				),
				0
			)
			AND EXISTS (
				SELECT 1
				FROM events AS settled
				WHERE settled.stream_kind = 'session'
					AND settled.stream_id = requested.stream_id
					AND settled.type = 'TurnSettled'
					AND settled.sequence > requested.sequence
					AND json_extract(settled.payload_json, '$.turnId')
						= json_extract(requested.payload_json, '$.turnId')
			)
	`.pipe(Effect.orDie);
	return new Set(
		rows.map((row) => providerTurnKey(row.stream_id, row.turn_id)),
	);
});

const serialize = Effect.fn("ConversationReactors.serialize")(function* <
	A,
	E,
	R,
>(effect: Effect.Effect<A, E, R>): Effect.fn.Return<Effect.Effect<A, E, R>> {
	const semaphore = yield* Semaphore.make(1);
	return Effect.suspend(() => semaphore.withPermits(1)(effect));
});

export const makeConversationReactorRuntime = Effect.fn(
	"ConversationReactors.make",
)(function* (
	handlers: ConversationReactorHandlers,
): Effect.fn.Return<ConversationReactorRuntime, never, SqlClient.SqlClient> {
	const sql = yield* SqlClient.SqlClient;
	const sessionStorage = makeSqlConsumerStorage(sql);
	const chatStorage = () =>
		makeSqlConsumerStorage(sql, {
			streamKind: "chat",
			decodeEvent: decodeChatEvent,
		});

	const providerStart = new ReactorRunner<
		StoredEvent,
		ProviderStartCommand,
		SqlConsumerStorageError,
		never,
		SessionStartError
	>(sessionStorage, handlers.providerStart, providerStartReactorDefinition);
	const providerStop = new ReactorRunner<
		StoredEvent,
		ProviderStopCommand,
		SqlConsumerStorageError
	>(sessionStorage, handlers.providerStop, providerStopReactorDefinition);
	const settledProviderTurnsAtStartup = new Set<string>();
	const providerTurn = new ReactorRunner<
		StoredEvent,
		ProviderTurnCommand,
		SqlConsumerStorageError
	>(
		sessionStorage,
		(input) => {
			const key = providerTurnKey(input.streamId, input.command.turnId);
			if (settledProviderTurnsAtStartup.delete(key)) return Effect.void;
			return handlers.providerTurn(input);
		},
		providerTurnReactorDefinition,
	);
	const providerInterrupt = new ReactorRunner<
		StoredEvent,
		ProviderInterruptCommand,
		SqlConsumerStorageError
	>(
		sessionStorage,
		handlers.providerInterrupt,
		providerInterruptReactorDefinition,
	);
	const scheduledSuccessor = new ReactorRunner<
		StoredEvent,
		ScheduledSuccessorCommand,
		SqlConsumerStorageError
	>(
		sessionStorage,
		handlers.scheduledSuccessor,
		scheduledSuccessorReactorDefinition,
	);
	const autoName = new ReactorRunner<
		StoredEvent,
		AutoNameCommand,
		SqlConsumerStorageError
	>(sessionStorage, handlers.autoName, autoNameReactorDefinition);
	const chatArchive = new ReactorRunner<
		StoredEvent<typeof ChatEvent.Type>,
		ChatArchiveCommand,
		SqlConsumerStorageError,
		never,
		ChatArchiveReactorError
	>(chatStorage(), handlers.chatArchive, chatArchiveReactorDefinition);
	const chatDelete = new ReactorRunner<
		StoredEvent<typeof ChatEvent.Type>,
		ChatDeleteCommand,
		SqlConsumerStorageError,
		never,
		ChatNotFoundError
	>(chatStorage(), handlers.chatDelete, chatDeleteReactorDefinition);

	const runProviderStart = yield* serialize(
		providerStart.catchUp().pipe(
			Effect.asVoid,
			Effect.catch((error) =>
				error._tag === "SessionStartError"
					? Effect.fail(error)
					: Effect.die(error),
			),
		),
	);
	const runProviderStop = yield* serialize(
		providerStop.catchUp().pipe(Effect.asVoid, Effect.orDie),
	);
	const runSession = yield* serialize(
		Effect.gen(function* () {
			yield* providerInterrupt.catchUp().pipe(Effect.orDie);
			// Cancellation settlement makes an interrupt-then-send successor
			// eligible, so claim it before delivering provider-turn effects.
			yield* scheduledSuccessor.catchUp().pipe(Effect.orDie);
			yield* providerTurn.catchUp().pipe(Effect.orDie);
			yield* autoName.catchUp().pipe(Effect.orDie);
		}),
	);
	const runChatArchive = yield* serialize(
		chatArchive.catchUp().pipe(
			Effect.asVoid,
			Effect.catch((error) =>
				error._tag === "ChatArchiveScriptError" ||
				error._tag === "ChatArchiveTimeoutError" ||
				error._tag === "ChatArchiveWorktreeError" ||
				error._tag === "ChatNotFoundError"
					? Effect.fail(error)
					: Effect.die(error),
			),
		),
	);
	const runChatDelete = yield* serialize(
		chatDelete.catchUp().pipe(
			Effect.asVoid,
			Effect.catch((error) =>
				error._tag === "ChatNotFoundError"
					? Effect.fail(error)
					: Effect.die(error),
			),
		),
	);

	return {
		runSession,
		runProviderStart,
		runProviderStop,
		runChatArchive,
		runChatDelete,
		catchUpAll: Effect.gen(function* () {
			const settledKeys = yield* loadSettledProviderTurnKeys(sql);
			for (const key of settledKeys) settledProviderTurnsAtStartup.add(key);
			yield* runProviderStart;
			yield* runProviderStop;
			yield* runSession;
			yield* runChatArchive;
			yield* runChatDelete;
		}),
	};
});
