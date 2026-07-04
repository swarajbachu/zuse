import {
  Effect,
  Layer,
  Mailbox,
  ManagedRuntime,
  Ref,
  Stream,
} from "effect";
import { join } from "node:path";

import {
  IndexConfigTag,
  IndexService,
  IndexServiceLive,
  type ChunkContent,
  type IndexStatus,
  type RefHit,
  type SearchHit,
  type SymbolHit,
  type SymbolSummary,
} from "@zuse/index";

import { IndexRegistry, type IndexHandle } from "../services/index-registry.ts";

/**
 * One IndexHandle per workspace root. Each entry owns a `ManagedRuntime`
 * provisioned with `IndexServiceLive` (which holds the SQLite handle + the
 * fan-out mailbox), so every method call below routes through the same
 * Effect Service the standalone MCP server uses. Errors bubble as rejected
 * promises — callers (Claude SDK tools) report them as tool failures, not
 * session-level fatals.
 */
interface Entry {
  readonly handle: IndexHandle;
  readonly close: () => Promise<void>;
}

const emptyStatus = (branch: string): IndexStatus => ({
  state: "idle",
  branch,
  progress: null,
  stats: { blobs: 0, chunks: 0, symbols: 0, refs: 0 },
});

/**
 * Live `IndexRegistry`. Per workspace root we open a single SQLite handle
 * at `<root>/.zuse/index.sqlite`, run migrations once, and serve every
 * subsequent lookup from the same handle.
 *
 * `ensureIndexed()` is the trigger that populates the DB. The workspace
 * service calls it on `setSelected` / `add`, and the renderer subscribes
 * to `statusStream()` over RPC to drive the top-bar progress chip.
 */
export const IndexRegistryLive = Layer.scoped(
  IndexRegistry,
  Effect.gen(function* () {
    const entries = yield* Ref.make(new Map<string, Entry>());

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const map = yield* Ref.get(entries);
        for (const [, e] of map) {
          yield* Effect.tryPromise({
            try: () => e.close(),
            catch: () => new Error("close failed"),
          }).pipe(Effect.ignore);
        }
      }),
    );

    const construct = async (root: string, branch: string): Promise<Entry> => {
      const dbPath = join(root, ".zuse", "index.sqlite");
      const configLayer = Layer.succeed(IndexConfigTag, {
        root,
        branch,
        dbPath,
      });
      const runtime = ManagedRuntime.make(
        IndexServiceLive.pipe(Layer.provide(configLayer)),
      );

      const callP = <A>(
        f: (svc: IndexService["Type"]) => Effect.Effect<A, unknown>,
      ): Promise<A> =>
        runtime.runPromise(
          Effect.flatMap(IndexService, f) as Effect.Effect<A, unknown, never>,
        );

      // Mutable cache so `state()` can answer synchronously without an
      // Effect round-trip. Updated by the per-entry subscriber fiber below.
      let currentState: IndexStatus["state"] = "idle";
      let lastStatus: IndexStatus = emptyStatus(branch);
      const subscribers = new Set<Mailbox.Mailbox<IndexStatus>>();

      // Subscribe to the IndexService's fan-out and shovel snapshots into
      // (a) our cached `state()`/`lastStatus` and (b) every per-subscriber
      // mailbox. One fiber for the entry's lifetime.
      const subscriberFiber = runtime.runFork(
        Stream.runForEach(
          Effect.flatMap(IndexService, (svc) => Effect.succeed(svc.statusStream)).pipe(
            Stream.unwrap,
          ),
          (snapshot: IndexStatus) =>
            Effect.sync(() => {
              currentState = snapshot.state;
              lastStatus = snapshot;
              for (const m of subscribers) m.unsafeOffer(snapshot);
            }),
        ),
      );

      let inFlight: Promise<void> | null = null;

      const ensureIndexed = async (): Promise<void> => {
        // Refresh `currentState` from the engine in case nothing has fired
        // yet (cold start). `status()` honors `branchExists` so a populated
        // DB short-circuits to "ready" without re-walking the tree.
        const snapshot = await callP((svc) => svc.status).catch(
          () => null as IndexStatus | null,
        );
        if (snapshot) {
          currentState = snapshot.state;
          lastStatus = snapshot;
        }
        if (currentState === "ready") return;
        if (inFlight) return inFlight;
        inFlight = callP((svc) => svc.reindex())
          .then(() => undefined)
          .finally(() => {
            inFlight = null;
          });
        return inFlight;
      };

      const statusStream = (): Stream.Stream<IndexStatus> =>
        Stream.unwrapScoped(
          Effect.gen(function* () {
            const mailbox = yield* Mailbox.make<IndexStatus>();
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                subscribers.delete(mailbox);
              }),
            );
            subscribers.add(mailbox);
            // Seed with the cached current snapshot — no race with the next
            // transition.
            mailbox.unsafeOffer(lastStatus);
            return Mailbox.toStream(mailbox);
          }),
        );

      const handle: IndexHandle = {
        state: () => currentState,
        statusStream,
        ensureIndexed,
        status: () => callP((svc) => svc.status) as Promise<IndexStatus>,
        reindex: () => callP((svc) => svc.reindex()) as Promise<IndexStatus>,
        symbolLookup: ({ name, kind, limit, pathGlob }) =>
          callP((svc) =>
            svc.symbolLookup({ name, kind, limit, pathGlob }),
          ) as Promise<ReadonlyArray<SymbolHit>>,
        findReferences: ({ symbol, limit, pathGlob }) =>
          callP((svc) =>
            svc.findReferences({ symbol, limit, pathGlob }),
          ) as Promise<ReadonlyArray<RefHit>>,
        readChunk: ({ chunkId }) =>
          callP((svc) => svc.readChunk({ chunkId })) as Promise<
            ChunkContent | null
          >,
        listModule: ({ path }) =>
          callP((svc) => svc.listModule({ path })) as Promise<
            ReadonlyArray<SymbolSummary>
          >,
        search: ({ query, kind, limit, pathGlob }) =>
          callP((svc) =>
            svc.search({ query, kind, limit, pathGlob }),
          ) as Promise<ReadonlyArray<SearchHit>>,
      };

      return {
        handle,
        close: async () => {
          await Effect.runPromise(subscriberFiber.pipe(Effect.asVoid)).catch(
            () => {},
          );
          await runtime.dispose();
        },
      };
    };

    return IndexRegistry.of({
      getHandle: (root, branch) =>
        Effect.promise(async () => {
          const map = await Effect.runPromise(Ref.get(entries));
          const existing = map.get(root);
          if (existing) return existing.handle;
          const entry = await construct(root, branch);
          await Effect.runPromise(
            Ref.update(entries, (m) => {
              const next = new Map(m);
              next.set(root, entry);
              return next;
            }),
          );
          return entry.handle;
        }),
    });
  }),
);
