import { Context, type Effect, type Stream } from "effect";

import type {
  ChunkContent,
  IndexStatus,
  RefHit,
  SearchHit,
  SymbolHit,
  SymbolSummary,
} from "@zuse/index";

/**
 * Per-process registry of `IndexService` instances, keyed by absolute
 * workspace root. Sessions resolve a `(cwd, branch)` to a fully-constructed
 * IndexService here so the same SQLite handle and migrations are reused
 * across every session pointed at the same checkout.
 *
 * Construction is lazy — opening a workspace doesn't index it; the first
 * call to `getHandle(...)` opens the DB and runs migrations, and
 * `ensureIndexed()` is the explicit trigger that walks the tree (idempotent;
 * `setSelected` in WorkspaceService calls it on every workspace switch).
 */
export interface IndexRegistryShape {
  /**
   * Resolve a session's `(cwd, branch)` to an active handle. Returns a
   * thin object with the read methods + a `reindex` trigger; the
   * underlying service is cached so subsequent calls reuse the same DB.
   */
  readonly getHandle: (
    root: string,
    branch: string,
  ) => Effect.Effect<IndexHandle>;
}

export interface IndexHandle {
  /**
   * Synchronous read of the current state — used by Claude-SDK tools to
   * short-circuit with the "indexing in progress" payload without having
   * to await an async status() round-trip on every tool call.
   */
  readonly state: () => IndexStatus["state"];
  /**
   * Live stream of status snapshots — the first emit is the current value
   * so a fresh subscriber doesn't race the first transition.
   */
  readonly statusStream: () => Stream.Stream<IndexStatus>;
  /**
   * Kick off an indexing pass if one isn't running and the DB isn't already
   * populated. Idempotent: re-calling while indexing returns the in-flight
   * Promise; calling when `state === "ready"` no-ops. Returns after the
   * pass settles (success or error).
   */
  readonly ensureIndexed: () => Promise<void>;
  readonly status: () => Promise<IndexStatus>;
  readonly reindex: () => Promise<IndexStatus>;
  readonly symbolLookup: (input: {
    name: string;
    kind?: string;
    limit?: number;
    pathGlob?: string;
  }) => Promise<ReadonlyArray<SymbolHit>>;
  readonly findReferences: (input: {
    symbol: string;
    limit?: number;
    pathGlob?: string;
  }) => Promise<ReadonlyArray<RefHit>>;
  readonly readChunk: (input: { chunkId: number }) => Promise<ChunkContent | null>;
  readonly listModule: (input: {
    path: string;
  }) => Promise<ReadonlyArray<SymbolSummary>>;
  readonly search: (input: {
    query: string;
    kind?: "auto" | "symbol" | "text" | "semantic";
    limit?: number;
    pathGlob?: string;
  }) => Promise<ReadonlyArray<SearchHit>>;
}

export class IndexRegistry extends Context.Service<
  IndexRegistry,
  IndexRegistryShape
>()("memoize/IndexRegistry") {}
