import { Rpc } from "effect/unstable/rpc";
import { Schema } from "effect";

import { FolderId } from "./ids.ts";

/**
 * Wire schemas for the Phase 0.04 code index. The engine in
 * `@zuse/index` defines a richer TS type per kind; here we keep the
 * shapes flat and primitive so they cross the effect/unstable/rpc + MCP JSON-schema
 * boundaries without ceremony.
 */

const IndexState = Schema.Literals(["idle", "indexing", "ready", "error"]);
export type IndexState = typeof IndexState.Type;

const IndexProgress = Schema.NullOr(
  Schema.Struct({ processed: Schema.Number, total: Schema.Number }),
);

const IndexStats = Schema.Struct({
  blobs: Schema.Number,
  chunks: Schema.Number,
  symbols: Schema.Number,
  refs: Schema.Number,
});

export class IndexStatusInfo extends Schema.Class<IndexStatusInfo>(
  "IndexStatusInfo",
)({
  state: IndexState,
  branch: Schema.NullOr(Schema.String),
  progress: IndexProgress,
  stats: IndexStats,
}) {}

const SymbolKind = Schema.Literals([
  "function",
  "method",
  "class",
  "interface",
  "type",
  "enum",
  "const",
  "variable",
  "property",
  "export",
]);

const Range = Schema.Struct({ start: Schema.Number, end: Schema.Number });

const SearchKind = Schema.Literals(["auto", "symbol", "text", "semantic"]);

const SearchHit = Schema.Struct({
  chunkId: Schema.Number,
  file: Schema.String,
  range: Range,
  symbol: Schema.NullOr(
    Schema.Struct({ name: Schema.String, kind: SymbolKind }),
  ),
  content: Schema.String,
  score: Schema.Number,
  source: Schema.Literals(["symbol", "bm25", "vector", "fused"]),
});

const SymbolHit = Schema.Struct({
  symbolId: Schema.Number,
  chunkId: Schema.NullOr(Schema.Number),
  name: Schema.String,
  kind: SymbolKind,
  signature: Schema.NullOr(Schema.String),
  file: Schema.String,
  range: Range,
  exported: Schema.Boolean,
});

const RefHit = Schema.Struct({
  refId: Schema.Number,
  file: Schema.String,
  range: Range,
  context: Schema.String,
});

const ChunkContent = Schema.NullOr(
  Schema.Struct({
    chunkId: Schema.Number,
    file: Schema.String,
    content: Schema.String,
    range: Range,
  }),
);

const SymbolSummary = Schema.Struct({
  name: Schema.String,
  kind: SymbolKind,
  signature: Schema.NullOr(Schema.String),
  startLine: Schema.Number,
  exported: Schema.Boolean,
});

export const IndexStatusRpc = Rpc.make("index.status", {
  payload: Schema.Struct({ folderId: FolderId }),
  success: IndexStatusInfo,
});

export const IndexStatusStreamRpc = Rpc.make("index.statusStream", {
  payload: Schema.Struct({ folderId: FolderId }),
  success: IndexStatusInfo,
  stream: true,
});

export const IndexReindexRpc = Rpc.make("index.reindex", {
  payload: Schema.Struct({ folderId: FolderId }),
  success: IndexStatusInfo,
});

export const IndexSearchRpc = Rpc.make("index.search", {
  payload: Schema.Struct({
    folderId: FolderId,
    query: Schema.String,
    kind: Schema.optional(SearchKind),
    limit: Schema.optional(Schema.Number),
    pathGlob: Schema.optional(Schema.String),
  }),
  success: Schema.Array(SearchHit),
});

export const IndexSymbolLookupRpc = Rpc.make("index.symbolLookup", {
  payload: Schema.Struct({
    folderId: FolderId,
    name: Schema.String,
    kind: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Number),
    pathGlob: Schema.optional(Schema.String),
  }),
  success: Schema.Array(SymbolHit),
});

export const IndexFindReferencesRpc = Rpc.make("index.findReferences", {
  payload: Schema.Struct({
    folderId: FolderId,
    symbol: Schema.String,
    limit: Schema.optional(Schema.Number),
    pathGlob: Schema.optional(Schema.String),
  }),
  success: Schema.Array(RefHit),
});

export const IndexReadChunkRpc = Rpc.make("index.readChunk", {
  payload: Schema.Struct({
    folderId: FolderId,
    chunkId: Schema.Number,
  }),
  success: ChunkContent,
});

export const IndexListModuleRpc = Rpc.make("index.listModule", {
  payload: Schema.Struct({
    folderId: FolderId,
    path: Schema.String,
  }),
  success: Schema.Array(SymbolSummary),
});
