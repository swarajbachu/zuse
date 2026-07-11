import { Context, Crypto, Effect, Layer, Schema, Semaphore } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { SqlClient } from "effect/unstable/sql";

import type { ChatCommand } from "../chat/commands.js";
import { type ChatDomainError, decideChat } from "../chat/decider.js";
import { ChatEvent } from "../chat/events.js";
import { evolveChats, initialChatState } from "../chat/state.js";
import { makeSqlChatProjector } from "../projectors/sql-chat-projector.js";
import { AggregateDispatchEngine } from "./aggregate-dispatch.js";
import type { CommandReceipt, DispatchInput } from "./dispatch.js";
import { ProjectorRunner } from "./projector-runner.js";
import {
	makeSqlConsumerStorage,
	type SqlConsumerStorageError,
} from "./sql-consumer-storage.js";
import {
	makeSqlDispatchStorage,
	type SqlDispatchStorageError,
} from "./sql-dispatch-storage.js";

const decodeChatEvent = Schema.decodeUnknownEffect(
	Schema.fromJsonString(ChatEvent),
);

export type ChatDomainServiceError =
	| ChatDomainError
	| SqlDispatchStorageError
	| SqlConsumerStorageError
	| PlatformError;

export interface ChatDomainApi {
	readonly dispatch: (
		input: DispatchInput<ChatCommand>,
	) => Effect.Effect<CommandReceipt, ChatDomainServiceError>;
	readonly catchUp: Effect.Effect<number, ChatDomainServiceError>;
}

export class ChatDomain extends Context.Service<ChatDomain, ChatDomainApi>()(
	"zuse/domain/engine/ChatDomain",
) {
	static readonly layer: Layer.Layer<
		ChatDomain,
		never,
		SqlClient.SqlClient | Crypto.Crypto
	> = Layer.effect(
		ChatDomain,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const crypto = yield* Crypto.Crypto;
			return yield* makeChatDomain(sql, () => crypto.randomUUIDv7);
		}),
	);
}

export const makeChatDomain = Effect.fn("ChatDomain.make")(function* (
	sql: SqlClient.SqlClient,
	makeEventId: () => Effect.Effect<string, PlatformError>,
) {
	const storageOptions = {
		streamKind: "chat",
		decodeEvent: decodeChatEvent,
	} as const;
	const dispatch = new AggregateDispatchEngine(
		makeSqlDispatchStorage(sql, storageOptions),
		{
			initialState: initialChatState,
			version: (state) => state.version,
			evolveAll: evolveChats,
			decide: decideChat,
		},
		makeEventId,
	);
	const projector = new ProjectorRunner(
		makeSqlConsumerStorage(sql, storageOptions),
		makeSqlChatProjector(sql),
	);
	const projectorLock = yield* Semaphore.make(1);
	const catchUp = Semaphore.withPermits(projectorLock, 1, projector.catchUp());

	return ChatDomain.of({
		catchUp,
		dispatch: Effect.fn("ChatDomain.dispatch")(function* (
			input: DispatchInput<ChatCommand>,
		) {
			const receipt = yield* dispatch.dispatch(input);
			yield* catchUp;
			return receipt;
		}),
	});
});
