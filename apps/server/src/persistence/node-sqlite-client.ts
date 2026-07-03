import * as Reactivity from "@effect/experimental/Reactivity";
import * as Client from "@effect/sql/SqlClient";
import type { Connection } from "@effect/sql/SqlConnection";
import { SqlError } from "@effect/sql/SqlError";
import * as Statement from "@effect/sql/Statement";
import { Context, Effect, Layer, Scope, Stream } from "effect";
import { DatabaseSync, type StatementSync } from "node:sqlite";

/**
 * SqlClient over Node's built-in `node:sqlite` (stable since Node 22.13).
 *
 * Why not `@effect/sql-sqlite-node` (better-sqlite3)? A native addon is
 * ABI-locked to one runtime: the Electron prebuild is rejected by system
 * Node, so the headless `zuse serve` could never share the Electron build's
 * persistence. `node:sqlite` is built into every Node ≥22 — one persistence
 * layer for the in-process Electron path and the headless WS path alike.
 *
 * The shape mirrors the upstream sqlite drivers: a single connection guarded
 * by a one-permit semaphore (SQLite file-level locking), `Client.make` for
 * the query/transaction machinery. Only the generic `SqlClient` tag is
 * provided — nothing in this repo used the sqlite-specific extras
 * (`export`/`backup`/`loadExtension`).
 */
export interface NodeSqliteClientConfig {
  readonly filename: string;
  readonly disableWAL?: boolean | undefined;
  readonly spanAttributes?: Record<string, unknown> | undefined;
}

/** `node:sqlite` cannot bind booleans (SQLITE bind rejects them); bun's
 * driver coerces silently. Coerce here so a bun-green test cannot hide a
 * production bind failure. */
const normalizeParams = (
  params: ReadonlyArray<unknown>,
): ReadonlyArray<unknown> =>
  params.some((p) => typeof p === "boolean")
    ? params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p))
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
        // FK enforcement must stay ON: better-sqlite3 ships
        // SQLITE_DEFAULT_FOREIGN_KEYS=1 and deleteChat/deleteSession rely on
        // ON DELETE CASCADE. node:sqlite defaults to true — pinned explicitly.
        try: () =>
          new DatabaseSync(options.filename, {
            enableForeignKeyConstraints: true,
          }),
        catch: (cause) =>
          new SqlError({ cause, message: "Failed to open database" }),
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => db.close()));
      if (options.disableWAL !== true) {
        yield* Effect.try({
          try: () => db.exec("PRAGMA journal_mode = WAL"),
          catch: (cause) =>
            new SqlError({ cause, message: "Failed to enable WAL" }),
        });
      }

      // Statement cache: the SQL text universe is the finite set of tagged
      // templates in this repo. sqlite recompiles stale statements internally
      // (prepare_v2 semantics), so entries survive schema migrations.
      const cache = new Map<string, StatementSync>();
      const prepare = (sql: string): StatementSync => {
        const hit = cache.get(sql);
        if (hit !== undefined) return hit;
        const statement = db.prepare(sql);
        cache.set(sql, statement);
        return statement;
      };

      const run = (
        sql: string,
        params: ReadonlyArray<unknown> = [],
        prepared = true,
      ): Effect.Effect<ReadonlyArray<any>, SqlError> =>
        Effect.withFiberRuntime((fiber) => {
          const useSafeIntegers = Context.get(
            fiber.currentContext,
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
              ),
            );
          } catch (cause) {
            return Effect.fail(
              new SqlError({ cause, message: "Failed to execute statement" }),
            );
          }
        });

      return {
        execute(sql, params, transformRows) {
          return transformRows
            ? Effect.map(run(sql, params), transformRows)
            : run(sql, params);
        },
        executeRaw(sql, params) {
          return run(sql, params);
        },
        executeValues(sql, params) {
          return Effect.map(run(sql, params), (rows) =>
            rows.map((row) => Object.values(row as object)),
          );
        },
        executeUnprepared(sql, params, transformRows) {
          // uncached path — BEGIN/COMMIT/SAVEPOINT from withTransaction land here
          const result = run(sql, params, false);
          return transformRows ? Effect.map(result, transformRows) : result;
        },
        executeStream(_sql, _params) {
          return Stream.dieMessage("executeStream not implemented");
        },
      } satisfies Connection;
    });

    const semaphore = yield* Effect.makeSemaphore(1);
    const connection = yield* makeConnection;
    const acquirer = semaphore.withPermits(1)(Effect.succeed(connection));
    const transactionAcquirer = Effect.uninterruptibleMask((restore) =>
      Effect.as(
        Effect.zipRight(
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
  Layer.scopedContext(
    Effect.map(make(config), (client) =>
      Context.make(Client.SqlClient, client),
    ),
  ).pipe(Layer.provide(Reactivity.layer));
