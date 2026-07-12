/**
 * Public types for the index engine. Wire-layer ergonomics in mind:
 * primitive types, no Effect objects in payloads, so these flow cleanly
 * through effect/unstable/rpc and the MCP JSON-schema layer in apps/mcp-server.
 */

export type LanguageId =
  | "typescript"
  | "tsx"
  | "javascript"
  | "jsx"
  | "json"
  | "markdown"
  | "unknown";

export type ChunkKind = "function" | "class" | "method" | "interface" | "type" | "section" | "window";

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "const"
  | "variable"
  | "property"
  | "export";

export interface BlobRecord {
  readonly id: number;
  readonly sha: Uint8Array;
  readonly language: LanguageId;
  readonly size: number;
  readonly parsedAt: number;
}

export interface ChunkRecord {
  readonly id: number;
  readonly blobId: number;
  readonly kind: ChunkKind;
  readonly startLine: number;
  readonly endLine: number;
  readonly symbolId: number | null;
  readonly content: string;
}

export interface SymbolRecord {
  readonly id: number;
  readonly blobId: number;
  readonly name: string;
  readonly kind: SymbolKind;
  readonly signature: string | null;
  readonly startLine: number;
  readonly endLine: number;
  readonly parentId: number | null;
  readonly exported: boolean;
}

export interface RefRecord {
  readonly id: number;
  readonly symbolId: number;
  readonly blobId: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly context: string;
}

export interface ManifestEntry {
  readonly branch: string;
  readonly filePath: string;
  readonly blobId: number;
}

export interface ParsedChunk {
  readonly kind: ChunkKind;
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
  readonly symbolName?: string;
}

export interface ParsedSymbol {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly signature: string | null;
  readonly startLine: number;
  readonly endLine: number;
  readonly exported: boolean;
  /** Local index of the parent in the same parse output, if nested. */
  readonly parentIndex: number | null;
}

export interface ParseResult {
  readonly chunks: ReadonlyArray<ParsedChunk>;
  readonly symbols: ReadonlyArray<ParsedSymbol>;
}

export interface SearchInput {
  readonly query: string;
  readonly branch?: string;
  readonly kind?: "auto" | "symbol" | "text" | "semantic";
  readonly limit?: number;
  /**
   * SQLite GLOB pattern applied to `manifests.file_path` to scope results
   * (e.g. `"apps/**"` or `"packages/index/**"`). Empty/undefined = no scoping.
   */
  readonly pathGlob?: string;
}

export interface SearchHit {
  readonly chunkId: number;
  readonly file: string;
  readonly range: { readonly start: number; readonly end: number };
  readonly symbol: { readonly name: string; readonly kind: SymbolKind } | null;
  readonly content: string;
  readonly score: number;
  readonly source: "symbol" | "bm25" | "vector" | "fused";
}

export interface SymbolHit {
  readonly symbolId: number;
  /**
   * Id of the chunk that contains this symbol's body, or `null` for symbols
   * with no enclosing chunk (most type aliases, properties). Hand this
   * directly to `readChunk` — feeding a `symbolId` to `readChunk` returns
   * a different table's row and is the namespace-collision footgun this
   * field exists to prevent.
   */
  readonly chunkId: number | null;
  readonly name: string;
  readonly kind: SymbolKind;
  readonly signature: string | null;
  readonly file: string;
  readonly range: { readonly start: number; readonly end: number };
  readonly exported: boolean;
}

export interface RefHit {
  readonly refId: number;
  readonly file: string;
  readonly range: { readonly start: number; readonly end: number };
  readonly context: string;
}

export interface ChunkContent {
  readonly chunkId: number;
  readonly file: string;
  readonly content: string;
  readonly range: { readonly start: number; readonly end: number };
}

export interface SymbolSummary {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly signature: string | null;
  readonly startLine: number;
  readonly exported: boolean;
}

export interface IndexStatus {
  readonly state: "idle" | "indexing" | "ready" | "error";
  readonly branch: string | null;
  readonly progress: { readonly processed: number; readonly total: number } | null;
  readonly stats: {
    readonly blobs: number;
    readonly chunks: number;
    readonly symbols: number;
    readonly refs: number;
  };
}
