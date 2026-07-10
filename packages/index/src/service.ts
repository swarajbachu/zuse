import { Context, Effect, Layer, Queue, Ref, Stream } from "effect";
import { join } from "node:path";

import { closeIndexDb, openIndexDb, type IndexDb } from "./db/sqlite.ts";
import { runMigrations } from "./schema/migrations.ts";
import { IndexService } from "./api.ts";
import { countAll } from "./blob/store.ts";
import { branchExists } from "./manifest/manifest.ts";
import { indexRepo } from "./indexer.ts";
import { fetchChunk, findReferencesByName, listFileSymbols, lookupSymbol } from "./retrieval/symbol-lookup.ts";
import {
  type IndexStatus,
  type SearchInput,
} from "./types.ts";
import { search } from "./retrieval/search.ts";

/**
 * Per-workspace config the host provides at boot. `root` is the absolute
 * workspace path; `branch` is the active branch (apps/server resolves via
 * git rev-parse, mcp-server via its CLI flag or git rev-parse).
 *
 * `dbPath` defaults to `<root>/.zuse/index.sqlite`; tests override it to
 * `:memory:`.
 */
export interface IndexConfig {
  readonly root: string;
  readonly branch: string;
  readonly dbPath?: string;
}

export class IndexConfigTag extends Context.Service<
  IndexConfigTag,
  IndexConfig
>()("memoize/IndexConfig") {}

interface InternalState {
  readonly state: IndexStatus["state"];
  readonly progress: IndexStatus["progress"];
}

/**
 * Concrete IndexService Layer. Owns a single better-sqlite3 handle per
 * workspace; runs migrations on construction; tracks indexing progress in
 * a Ref so the renderer can poll `index.status`.
 *
 * The first `reindex()` call is what populates the DB — boot is cheap.
 * Phase E will add a watcher that calls `reindex` on a debounce; for
 * Phase A, callers (tests, the manual debug command) call it directly.
 */
export const IndexServiceLive = Layer.effect(
  IndexService,
  Effect.gen(function* () {
    const config = yield* IndexConfigTag;
    const dbFile =
      config.dbPath ?? join(config.root, ".zuse", "index.sqlite");

    const db: IndexDb = yield* Effect.acquireRelease(
      openIndexDb(dbFile),
      (handle) => closeIndexDb(handle),
    );

    yield* runMigrations(db);

    const stateRef = yield* Ref.make<InternalState>({
      state: "idle",
      progress: null,
    });

    // Fan-out for status updates. Each call to `statusStream` registers a
    // fresh per-subscriber mailbox; on every state transition we re-snapshot
    // and `unsafeOffer` into all live subscribers. A subscriber receives the
    // current value on subscribe so there's no race with the first transition.
    const subscribers = yield* Ref.make<
      ReadonlyArray<Queue.Queue<IndexStatus>>
    >([]);

    const branchOr = (b?: string): string => b ?? config.branch;

    const computeStatus = (): Effect.Effect<IndexStatus> =>
      Effect.gen(function* () {
        const { state, progress } = yield* Ref.get(stateRef);
        const stats = yield* countAll(db);
        const populated = yield* branchExists(db, config.branch);
        const resolved: IndexStatus["state"] =
          state === "indexing" || state === "error"
            ? state
            : populated
              ? "ready"
              : "idle";
        return {
          state: resolved,
          branch: config.branch,
          progress,
          stats,
        } satisfies IndexStatus;
      }).pipe(
        Effect.catch(() =>
          Effect.succeed<IndexStatus>({
            state: "error",
            branch: config.branch,
            progress: null,
            stats: { blobs: 0, chunks: 0, symbols: 0, refs: 0 },
          }),
        ),
      );

    const publishCurrent: Effect.Effect<void> = Effect.gen(function* () {
      const snapshot = yield* computeStatus();
      const subs = yield* Ref.get(subscribers);
      yield* Effect.forEach(subs, (queue) => Queue.offer(queue, snapshot), {
        discard: true,
      });
    });

    const setState = (next: InternalState): Effect.Effect<void> =>
      Ref.set(stateRef, next).pipe(Effect.andThen(publishCurrent));

    const statusStream: Stream.Stream<IndexStatus> = Stream.unwrap(
      Effect.gen(function* () {
        const mailbox = yield* Queue.make<IndexStatus>();
        yield* Effect.addFinalizer(() =>
          Ref.update(subscribers, (xs) => xs.filter((m) => m !== mailbox)),
        );
        yield* Ref.update(subscribers, (xs) => [...xs, mailbox]);
        // Seed with the current snapshot so a fresh subscriber doesn't race.
        const snapshot = yield* computeStatus();
        yield* Queue.offer(mailbox, snapshot);
        return Stream.fromQueue(mailbox);
      }),
    );

    const doReindex = (branch: string): Effect.Effect<IndexStatus, never> =>
      Effect.gen(function* () {
        yield* setState({ state: "indexing", progress: null });
        const result = yield* indexRepo(db, config.root, branch, (p) =>
          Effect.runSync(
            setState({
              state: "indexing",
              progress: { processed: p.processed, total: p.total },
            }),
          ),
        );
        yield* setState({
          state: "ready",
          progress: { processed: result.processed, total: result.total },
        });
        return yield* computeStatus();
      }).pipe(
        Effect.catch((err) =>
          Effect.gen(function* () {
            yield* Effect.logError("index reindex failed", err);
            yield* setState({ state: "error", progress: null });
            return yield* computeStatus();
          }),
        ),
      );

    return IndexService.of({
      status: computeStatus(),
      statusStream,
      reindex: (opts) => doReindex(branchOr(opts?.branch)),
      symbolLookup: ({ name, kind, branch, limit, pathGlob }) =>
        lookupSymbol(db, name, branchOr(branch), kind, limit ?? 10, pathGlob),
      findReferences: ({ symbol, branch, limit, pathGlob }) =>
        findReferencesByName(db, symbol, branchOr(branch), limit ?? 20, pathGlob),
      readChunk: ({ chunkId, branch }) =>
        fetchChunk(db, chunkId, branchOr(branch)),
      listModule: ({ path, branch }) =>
        listFileSymbols(db, path, branchOr(branch)),
      search: (input: SearchInput) => search(db, config.branch, input),
    });
  }),
);
