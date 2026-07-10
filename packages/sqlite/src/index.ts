import { DatabaseSync, type StatementSync } from "node:sqlite";
import { Context, Effect, Layer, Scope, Semaphore, Stream } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as Client from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { classifySqliteError, SqlError } from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";

export interface NodeSqliteClientConfig {
	readonly filename: string;
	readonly disableWAL?: boolean | undefined;
	readonly spanAttributes?: Record<string, unknown> | undefined;
}

type SqliteRow = Record<string, unknown>;

const sqlError = (
	cause: unknown,
	message: string,
	operation: string,
): SqlError => {
	const normalizedCause =
		typeof cause === "object" &&
		cause !== null &&
		"errcode" in cause &&
		typeof cause.errcode === "number"
			? {
					code: "code" in cause ? cause.code : undefined,
					errno: cause.errcode,
					message: "message" in cause ? cause.message : undefined,
				}
			: cause;
	const detail =
		cause instanceof Error && cause.message.length > 0
			? `${message}: ${cause.message}`
			: message;
	return new SqlError({
		reason: classifySqliteError(normalizedCause, {
			message: detail,
			operation,
		}),
	});
};

const normalizeParams = (
	params: ReadonlyArray<unknown>,
): ReadonlyArray<unknown> =>
	params.some((param) => typeof param === "boolean")
		? params.map((param) =>
				typeof param === "boolean" ? (param ? 1 : 0) : param,
			)
		: params;

export const make = (
	options: NodeSqliteClientConfig,
): Effect.Effect<
	Client.SqlClient,
	SqlError,
	Scope.Scope | Reactivity.Reactivity
> =>
	Effect.gen(function* () {
		const compiler = Statement.makeCompilerSqlite();
		const makeConnection = Effect.gen(function* () {
			const db = yield* Effect.try({
				try: () =>
					new DatabaseSync(options.filename, {
						enableForeignKeyConstraints: true,
					}),
				catch: (cause) => sqlError(cause, "Failed to open database", "connect"),
			});
			yield* Effect.addFinalizer(() => Effect.sync(() => db.close()));
			if (options.disableWAL !== true) {
				yield* Effect.try({
					try: () => db.exec("PRAGMA journal_mode = WAL"),
					catch: (cause) =>
						sqlError(cause, "Failed to enable WAL", "configure"),
				});
			}

			const cache = new Map<string, StatementSync>();
			const prepare = (sql: string): StatementSync => {
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
			): Effect.Effect<ReadonlyArray<SqliteRow>, SqlError> =>
				Effect.withFiber((fiber) => {
					const useSafeIntegers = Context.get(
						fiber.context,
						Client.SafeIntegers,
					);
					try {
						const statement = prepared ? prepare(sql) : db.prepare(sql);
						statement.setReadBigInts(useSafeIntegers);
						return Effect.succeed(
							statement.all(
								...(normalizeParams(params) as Array<
									null | number | bigint | string | Uint8Array
								>),
							) as ReadonlyArray<SqliteRow>,
						);
					} catch (cause) {
						return Effect.fail(
							sqlError(cause, "Failed to execute statement", "execute"),
						);
					}
				});

			return {
				execute(sql, params, transformRows) {
					return transformRows
						? Effect.map(run(sql, params), transformRows)
						: run(sql, params);
				},
				executeRaw: (sql, params) => run(sql, params),
				executeValues: (sql, params) =>
					Effect.map(run(sql, params), (rows) =>
						rows.map((row) => Object.values(row as object)),
					),
				executeValuesUnprepared: (sql, params) =>
					Effect.map(run(sql, params, false), (rows) =>
						rows.map((row) => Object.values(row as object)),
					),
				executeUnprepared(sql, params, transformRows) {
					const result = run(sql, params, false);
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
	config: NodeSqliteClientConfig,
): Layer.Layer<Client.SqlClient, SqlError> =>
	Layer.effectContext(
		Effect.map(make(config), (client) =>
			Context.make(Client.SqlClient, client),
		),
	).pipe(Layer.provide(Reactivity.layer));
