import { Context, Crypto, Effect, Layer, Semaphore } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { SqlClient } from "effect/unstable/sql";

import {
	makeSqlSessionProjector,
	type SqlSessionProjectorError,
} from "../projectors/sql-session-projector.js";
import {
	type CommandReceipt,
	DispatchEngine,
	type DispatchFailure,
	type DispatchInput,
} from "./dispatch.js";
import { ProjectorRunner } from "./projector-runner.js";
import {
	makeSqlConsumerStorage,
	type SqlConsumerStorageError,
} from "./sql-consumer-storage.js";
import {
	makeSqlDispatchStorage,
	type SqlDispatchStorageError,
} from "./sql-dispatch-storage.js";

export type SessionDomainError =
	| DispatchFailure<SqlDispatchStorageError>
	| SqlConsumerStorageError
	| SqlSessionProjectorError
	| PlatformError;

export interface SessionDomainApi {
	readonly dispatch: (
		input: DispatchInput,
	) => Effect.Effect<CommandReceipt, SessionDomainError>;
	readonly catchUp: Effect.Effect<number, SessionDomainError>;
}

export class SessionDomain extends Context.Service<
	SessionDomain,
	SessionDomainApi
>()("zuse/domain/engine/SessionDomain") {
	static readonly layer: Layer.Layer<
		SessionDomain,
		never,
		SqlClient.SqlClient | Crypto.Crypto
	> = Layer.effect(
		SessionDomain,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const crypto = yield* Crypto.Crypto;
			return yield* makeSessionDomain(sql, () => crypto.randomUUIDv7);
		}),
	);
}

export const makeSessionDomain = Effect.fn("SessionDomain.make")(function* (
	sql: SqlClient.SqlClient,
	makeEventId: () => Effect.Effect<string, PlatformError>,
) {
	const dispatch = new DispatchEngine(makeSqlDispatchStorage(sql), makeEventId);
	const projector = new ProjectorRunner(
		makeSqlConsumerStorage(sql),
		makeSqlSessionProjector(sql),
	);
	const projectorLock = yield* Semaphore.make(1);
	const catchUp = Semaphore.withPermits(projectorLock, 1, projector.catchUp());

	return SessionDomain.of({
		catchUp,
		dispatch: Effect.fn("SessionDomain.dispatch")(function* (
			input: DispatchInput,
		) {
			const receipt = yield* dispatch.dispatch(input);
			yield* catchUp;
			return receipt;
		}),
	});
});
