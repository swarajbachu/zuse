import { Context, type Effect, type Stream } from "effect";

import {
  type ChunkContent,
  type IndexStatus,
  type RefHit,
  type SearchHit,
  type SearchInput,
  type SymbolHit,
  type SymbolSummary,
} from "./types.ts";
import { type IndexError } from "./errors.ts";

/**
 * Public Effect Service contract for the index engine. Consumed by
 * apps/server (in-process) and apps/mcp-server (over MCP). Phase A ships
 * the read surface; Phase B fills in symbol/search behavior; later phases
 * extend `search` from symbol-only → hybrid.
 *
 * `reindex` is a manual trigger — Phase E adds a watcher that calls it
 * incrementally.
 */
export interface IndexServiceShape {
  readonly status: Effect.Effect<IndexStatus, IndexError>;

  /**
   * Stream of status snapshots published every time the service's internal
   * progress/state Ref changes. The first emit is the current value, so a
   * fresh subscriber doesn't race the first transition.
   */
  readonly statusStream: Stream.Stream<IndexStatus>;

  readonly reindex: (opts?: {
    readonly branch?: string;
  }) => Effect.Effect<IndexStatus, IndexError>;

  readonly search: (input: SearchInput) => Effect.Effect<
    ReadonlyArray<SearchHit>,
    IndexError
  >;

  readonly symbolLookup: (input: {
    readonly name: string;
    readonly kind?: string;
    readonly branch?: string;
    readonly limit?: number;
    readonly pathGlob?: string;
  }) => Effect.Effect<ReadonlyArray<SymbolHit>, IndexError>;

  readonly findReferences: (input: {
    readonly symbol: string;
    readonly branch?: string;
    readonly limit?: number;
    readonly pathGlob?: string;
  }) => Effect.Effect<ReadonlyArray<RefHit>, IndexError>;

  readonly readChunk: (input: {
    readonly chunkId: number;
    readonly branch?: string;
  }) => Effect.Effect<ChunkContent | null, IndexError>;

  readonly listModule: (input: {
    readonly path: string;
    readonly branch?: string;
  }) => Effect.Effect<ReadonlyArray<SymbolSummary>, IndexError>;
}

export class IndexService extends Context.Service<
  IndexService,
  IndexServiceShape
>()("memoize/IndexService") {}
