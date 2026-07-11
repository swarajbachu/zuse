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
	type ProviderStartCommand,
	type ProviderStopCommand,
	providerStartReactorDefinition,
	providerStopReactorDefinition,
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
		autoName.catchUp().pipe(Effect.asVoid, Effect.orDie),
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
			yield* runProviderStart;
			yield* runProviderStop;
			yield* runSession;
			yield* runChatArchive;
			yield* runChatDelete;
		}),
	};
});
