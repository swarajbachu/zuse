import Database, { type Statement as BetterStatement } from "better-sqlite3";
import { Context, Effect, Layer, Scope, Semaphore, Stream } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as Client from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { classifySqliteError, SqlError } from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";

export interface BetterSqliteClientConfig {
	readonly filename: string;
	readonly disableWAL?: boolean;
	readonly spanAttributes?: Record<string, unknown>;
}

const normalizeParams = (
	params: ReadonlyArray<unknown>,
): ReadonlyArray<unknown> =>
	params.some((param) => typeof param === "boolean")
		? params.map((param) =>
				typeof param === "boolean" ? (param ? 1 : 0) : param,
			)
		: params;

const sqlError = (
	cause: unknown,
	message: string,
	operation: string,
): SqlError =>
	new SqlError({
		reason: classifySqliteError(cause, { message, operation }),
	});

export const make = (
	options: BetterSqliteClientConfig,
): Effect.Effect<
	Client.SqlClient,
	SqlError,
	Scope.Scope | Reactivity.Reactivity
> =>
	Effect.gen(function* () {
		const compiler = Statement.makeCompilerSqlite();

		const makeConnection = Effect.gen(function* () {
			const db = yield* Effect.try({
				try: () => new Database(options.filename),
				catch: (cause) => sqlError(cause, "Failed to open database", "connect"),
			});
			yield* Effect.addFinalizer(() => Effect.sync(() => db.close()));
			yield* Effect.try({
				try: () => {
					db.pragma("foreign_keys = ON");
					if (options.disableWAL !== true) db.pragma("journal_mode = WAL");
				},
				catch: (cause) =>
					sqlError(cause, "Failed to configure database", "configure"),
			});

			const cache = new Map<string, BetterStatement>();
			const prepare = (sql: string): BetterStatement => {
				const cached = cache.get(sql);
				if (cached !== undefined) return cached;
				const statement = db.prepare(sql);
				cache.set(sql, statement);
				return statement;
			};

			const run = (
				sql: string,
				params: ReadonlyArray<unknown> = [],
				prepared = true,
				values = false,
				rawResult = false,
			): Effect.Effect<ReadonlyArray<unknown> | object, SqlError> =>
				Effect.withFiber((fiber) => {
					const useSafeIntegers = Context.get(
						fiber.context,
						Client.SafeIntegers,
					);
					return Effect.try({
						try: () => {
							const statement = prepared ? prepare(sql) : db.prepare(sql);
							statement.safeIntegers(useSafeIntegers);
							const normalized = normalizeParams(params) as unknown[];
							if (statement.reader) {
								statement.raw(values);
								return statement.all(...normalized);
							}
							const result = statement.run(...normalized);
							return rawResult
								? {
										changes: result.changes,
										lastInsertRowid: result.lastInsertRowid,
									}
								: [];
						},
						catch: (cause) =>
							sqlError(cause, "Failed to execute statement", "execute"),
					});
				});

			return {
				execute(sql, params, transformRows) {
					const result = run(sql, params) as Effect.Effect<
						ReadonlyArray<object>,
						SqlError
					>;
					return transformRows ? Effect.map(result, transformRows) : result;
				},
				executeRaw(sql, params) {
					return run(sql, params, true, false, true);
				},
				executeValues(sql, params) {
					return run(sql, params, true, true) as Effect.Effect<
						ReadonlyArray<ReadonlyArray<unknown>>,
						SqlError
					>;
				},
				executeValuesUnprepared(sql, params) {
					return run(sql, params, false, true) as Effect.Effect<
						ReadonlyArray<ReadonlyArray<unknown>>,
						SqlError
					>;
				},
				executeUnprepared(sql, params, transformRows) {
					const result = run(sql, params, false) as Effect.Effect<
						ReadonlyArray<object>,
						SqlError
					>;
					return transformRows ? Effect.map(result, transformRows) : result;
				},
				executeStream() {
					return Stream.die(new Error("executeStream not implemented"));
				},
			} satisfies Connection;
		});

		const semaphore = yield* Semaphore.make(1);
		const connection = yield* makeConnection;
		const acquirer = semaphore.withPermits(1)(Effect.succeed(connection));
		const transactionAcquirer = Effect.uninterruptibleMask((restore) =>
			Effect.as(
				Effect.andThen(
					restore(semaphore.take(1)),
					Effect.tap(Effect.scope, (scope) =>
						Scope.addFinalizer(scope, semaphore.release(1)),
					),
				),
				connection,
			),
		);

		return yield* Client.make({
			acquirer,
			compiler,
			transactionAcquirer,
			spanAttributes: [
				...(options.spanAttributes
					? Object.entries(options.spanAttributes)
					: []),
				["db.system.name", "sqlite"],
			],
		});
	});

export const layer = (
	config: BetterSqliteClientConfig,
): Layer.Layer<Client.SqlClient, SqlError> =>
	Layer.effectContext(
		Effect.map(make(config), (client) =>
			Context.make(Client.SqlClient, client),
		),
	).pipe(Layer.provide(Reactivity.layer));
