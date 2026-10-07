/**
 * Public surface of @zuse/index. Two consumers: apps/server (in-process)
 * and apps/mcp-server (over MCP). Both build a Layer with their workspace
 * paths injected via {@link IndexConfigTag} and consume {@link IndexService}.
 */
export { IndexService, type IndexServiceShape } from "./api.ts";
// Internal helpers exposed for the test harness and the upcoming
// apps/mcp-server scaffold (Phase F builds its own Layer using these
// without going through Effect Service composition).
export { blakeOf, hexOf } from "./blob/hash.ts";
export { countAll, type IndexStats } from "./blob/store.ts";
export { chunkSource } from "./chunker/index.ts";
export { detectLanguage } from "./chunker/language.ts";
export {
	closeIndexDb,
	type IndexDb,
	type IndexStmt,
	openIndexDb,
} from "./db/sqlite.ts";
export {
	type EmbeddingProvider,
	getEmbeddingProvider,
	NullProvider,
	setEmbeddingProvider,
} from "./embedding/provider.ts";
export { drainAll, drainEmbedQueue } from "./embedding/worker.ts";
export {
	IndexDbError,
	type IndexError,
	IndexIoError,
	IndexParseError,
	IndexUnsupportedLanguageError,
} from "./errors.ts";
export { forgetFile, reindexFile } from "./incremental.ts";
export { indexRepo } from "./indexer.ts";
export {
	branchExists,
	listManifest,
	removeManifestEntry,
	setManifestBulk,
	setManifestEntry,
} from "./manifest/manifest.ts";
export {
	diffManifest,
	type ManifestDiff,
	swapBranchManifest,
} from "./manifest/swap.ts";
export {
	applyRerank,
	CohereRerankProvider,
	getRerankProvider,
	NullRerankProvider,
	type RerankProvider,
	setRerankProvider,
	VoyageRerankProvider,
} from "./rerank/index.ts";
export { type Bm25Hit, bm25Search } from "./retrieval/bm25.ts";
export { route, type Tier } from "./retrieval/router.ts";
export { reciprocalRankFusion } from "./retrieval/rrf.ts";
export { search } from "./retrieval/search.ts";
export {
	fetchChunk,
	findReferencesByName,
	listFileSymbols,
	lookupSymbol,
} from "./retrieval/symbol-lookup.ts";
export {
	isVectorAvailable,
	type VectorHit,
	vectorSearch,
	writeEmbeddings,
} from "./retrieval/vector.ts";
export { runMigrations } from "./schema/migrations.ts";
export {
	type IndexConfig,
	IndexConfigTag,
	IndexServiceLive,
} from "./service.ts";
export {
	type ImportRelation,
	indexSnapshot,
	type SnapshotFiles,
	snapshotManifestKey,
} from "./snapshot.ts";
export type {
	BlobRecord,
	ChunkContent,
	ChunkKind,
	ChunkRecord,
	IndexStatus,
	LanguageId,
	ManifestEntry,
	ParsedChunk,
	ParsedSymbol,
	ParseResult,
	RefHit,
	RefRecord,
	SearchHit,
	SearchInput,
	SymbolHit,
	SymbolKind,
	SymbolRecord,
	SymbolSummary,
} from "./types.ts";
export { streamRepo, type WalkLimits, walkRepo } from "./walker.ts";
