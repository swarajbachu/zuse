# Feature: Code Index

A content-addressed code index with hybrid retrieval. Two consumers: the
bundled agent (in-process via `apps/server`) and external agents (over MCP
via `apps/mcp-server`). One engine, one chunk store, two transports.

## Why this exists

Agents inside memoize spend most of their token budget on navigation —
`Bash(rg ...)` → `Read` → repeat. On a real codebase: 25–40k tokens across
5–8 tool calls before the agent has the context to work. Most of that is
*tax*, not value.

Existing tools (Cursor, Sourcegraph Cody, Greptile, Continue, Augment) all
build codebase indexes. None handle the **N parallel agent workspaces on
the same repo** shape that memoize produces. That's
the wedge: not "vector DB for code," but "the only index built for the
parallel-workspace agent workflow."

## Goals

1. **Tokens-per-task ↓ 3–10×** vs. baseline grep agent on real memoize tasks.
2. **Wall-clock-per-task ↓ 2–3×** (driven by fewer LLM round-trips, not
   faster retrieval).
3. **Branch switches in < 200 ms**, not minutes — parallel workspace
   ergonomics demand this.
4. **Local-first**, zero network calls in the default config.
5. **Reusable**: memoize is one consumer, not the only consumer.

## Non-goals

- Cloud team index (deferred to a future MVP).
- IDE-grade rename / refactor (call graphs are read-only, no edits).
- More than one embedding model per workspace.
- Cross-repo search.

## Package + app layout

The engine is a **package**, not a service. Putting it in a package keeps
it transport-agnostic — `apps/server` consumes it directly, `apps/mcp-server`
wraps it as MCP, and a future cloud-sync worker is a third consumer.

```
packages/
  index/                              # @zuse/index — pure engine
    src/
      schema/migrations/              # SQL files
      chunker/                        # tree-sitter chunking
      symbols/                        # symbol extraction + ref resolution
      retrieval/
        symbol-lookup.ts              # Tier 1
        bm25.ts                       # FTS5 wrapper
        vector.ts                     # sqlite-vec wrapper
        rerank.ts                     # cross-encoder caller
        router.ts                     # query classification
        fuse.ts                       # reciprocal rank fusion
      manifest/                       # branch model
      watcher/                        # incremental file-change indexer
      embedding/                      # pluggable embedding providers
      api.ts                          # exported Effect Service contract

apps/
  server/
    src/
      index/                          # consumes @zuse/index
        index-service.ts              # Effect.Service wrapping the engine
        index-handlers.ts             # RPC handlers → renderer
  mcp-server/                         # NEW — standalone MCP app
    src/
      server.ts                       # MCP stdio + HTTP entry
      tools/                          # MCP tool wrappers
      bin.ts                          # `zuse-mcp` executable
```

The desktop renderer never talks to the index directly — it goes through
`apps/server` via existing RPC, preserving ADR 0007 (server is the only
source of truth).

See [ADR 0013](../decisions/0013-index-as-package.md) for the package vs
service decision.

## Storage model — content-addressed chunk store

All indexed content lives in **one SQLite file** per workspace (extends
ADR 0008).

```sql
-- One row per unique blob (file content) we've ever seen, keyed by SHA.
-- Switching branches doesn't re-add blobs we already have.
blobs (
  id          INTEGER PRIMARY KEY,
  sha         BLOB NOT NULL UNIQUE,
  language    TEXT,
  size        INTEGER NOT NULL,
  parsed_at   INTEGER
);

-- One row per chunk inside a blob.
chunks (
  id          INTEGER PRIMARY KEY,
  blob_id     INTEGER NOT NULL REFERENCES blobs(id),
  kind        TEXT NOT NULL,             -- function|class|method|window
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  symbol_id   INTEGER REFERENCES symbols(id),
  content     TEXT NOT NULL              -- materialized for FTS + reads
);

-- One row per named entity.
symbols (
  id          INTEGER PRIMARY KEY,
  blob_id     INTEGER NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,             -- function|class|type|const|...
  signature   TEXT,
  start_line  INTEGER, end_line INTEGER,
  parent_id   INTEGER REFERENCES symbols(id),
  exported    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX symbols_name ON symbols(name);
CREATE INDEX symbols_parent ON symbols(parent_id);

-- References (callers/usages).
refs (
  id          INTEGER PRIMARY KEY,
  symbol_id   INTEGER NOT NULL,
  blob_id     INTEGER NOT NULL,
  start_line  INTEGER, end_line INTEGER,
  context     TEXT
);

-- Vector index via sqlite-vec extension. Lazy: chunks not yet embedded
-- still work via BM25 / symbol lookup.
CREATE VIRTUAL TABLE chunk_vec USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding FLOAT[768]
);

-- Full-text via FTS5.
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  content, content='chunks', content_rowid='id',
  tokenize = "trigram"
);

-- Per-branch manifest. Switching branches = swap rows here.
manifests (
  branch       TEXT NOT NULL,
  file_path    TEXT NOT NULL,
  blob_id      INTEGER NOT NULL,
  PRIMARY KEY (branch, file_path)
);
CREATE INDEX manifests_blob ON manifests(blob_id);
```

**Why content-addressed.** Five parallel workspaces on the same repo
means five branches checked out concurrently. With a content-addressed
store, the common 95% of files dedupe across branches; only the changed
files cost re-parsing. Switching branches is a manifest swap, not a
re-index.

See [ADR 0014](../decisions/0014-content-addressed-chunk-store.md) for the
chunk store; [ADR 0017](../decisions/0017-branch-aware-manifest.md) for
the manifest model.

## Indexing pipeline

```
on workspace open:
  walk respecting .gitignore + index-ignore patterns
  for each file:
    sha = blake3(content)              -- blake3 > sha256 for speed
    if blobs[sha] exists: skip parse
    else:
      lang = detect(file)
      tree = tree-sitter.parse(content, lang)
      chunks = extract_chunks(tree)    -- prefer function/class boundaries
      symbols = extract_symbols(tree)  -- name, kind, signature, parent
      refs    = extract_refs(tree)     -- via tree-sitter scope queries
      insert blobs, chunks, symbols, refs
      enqueue chunks for embedding (async, batched 64 per request)
  upsert manifests(branch, file, blob_id)

on file change (watcher):
  same as above for one file; tree-sitter is incremental

on branch switch:
  diff old_manifest vs new_manifest
  swap changed rows
  no re-parsing for unchanged blobs
```

Initial index of a memoize-sized repo (~80k LOC TypeScript): target
60–120s. Per-file change: 10–50ms. Branch switch: < 200ms.

**Tree-sitter grammars** loaded on demand: TypeScript, JavaScript, TSX,
JSON, Markdown for v1. Python / Go / Rust shipped on demand.

See [ADR 0015](../decisions/0015-tree-sitter-chunking.md) for tree-sitter
vs LSP-based extraction.

## Retrieval — 3-tier hybrid

Given a query, *which retrieval method runs?* The router classifies,
executes, fuses.

```ts
interface SearchInput {
  query: string
  branch?: string                       // defaults to active
  kind?: "auto" | "symbol" | "text" | "semantic"
  limit?: number                        // default 5
}

interface SearchHit {
  chunkId: number
  file: string
  range: { start: number; end: number }
  symbol?: { name: string; kind: string }
  content: string
  score: number
  source: "symbol" | "bm25" | "vector" | "fused"
}

function route(input: SearchInput): Tier[] {
  if (input.kind && input.kind !== "auto") return [tierFor(input.kind)]
  if (looksLikeSymbol(input.query))   return ["symbol"]            // Tier 1
  if (looksLikeCode(input.query))     return ["symbol", "bm25"]    // Tier 1+2
  if (isNaturalLanguage(input.query)) return ["bm25", "vector"]    // Tier 3
  return ["symbol", "bm25", "vector"]                              // run all
}
```

**Heuristics.** `looksLikeSymbol`: matches `^[A-Z][a-zA-Z0-9_]*$` or
`^[a-z][a-zA-Z0-9_]*$` with no whitespace, ≤ 3 tokens. `looksLikeCode`:
contains `{}`, `;`, `()`, `=>`, or `import`. `isNaturalLanguage`: > 4
words and contains a stopword.

### Tier 1 — Symbol lookup

```sql
SELECT s.*, b.* FROM symbols s
JOIN blobs b ON b.id = s.blob_id
JOIN manifests m ON m.blob_id = b.id AND m.branch = ?
WHERE s.name = ? OR s.name LIKE ?
ORDER BY (s.exported DESC), length(s.name) ASC
LIMIT ?
```

< 1ms. Returns ~50 tokens per hit. Wins for ~60–70% of agent queries.

### Tier 2 — BM25 over chunk content

```sql
SELECT c.id, bm25(chunks_fts) AS rank, c.*
FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
JOIN manifests m ON m.blob_id = c.blob_id AND m.branch = ?
WHERE chunks_fts MATCH ?
ORDER BY rank LIMIT 50
```

5ms. SQLite FTS5 trigram tokenizer handles code identifiers well.

### Tier 3 — Vector + fused rerank

```ts
const candidates = await Promise.all([
  bm25Search(query, branch, 50),
  vectorSearch(await embed(query), branch, 50),
])
const fused = reciprocalRankFusion(candidates, k = 60).slice(0, 20)
const reranked = await rerank(query, fused.map(c => c.content))
return reranked.slice(0, limit)
```

**Reciprocal Rank Fusion** (one-line, hard to beat):

```
score(chunk) = Σ_methods 1 / (k + rank_method(chunk))
```

See [ADR 0016](../decisions/0016-hybrid-over-pure-vector.md) for why
hybrid beats pure vector on code retrieval benchmarks.

## Reranking

Pluggable cross-encoder.

| Backend | Where | Latency | Cost | Quality |
|---|---|---|---|---|
| **bge-reranker-v2-m3** (local, ONNX via `transformers.js`) | in-process | 100–300ms / batch of 20 | $0 | strong |
| **Voyage rerank-2** | API | 80–200ms | ~$0.05 / 1000 q | best on code |
| **Cohere rerank-3** | API | 100–300ms | ~$0.10 / 1000 q | strong, robust |
| **none** | — | 0 | $0 | -20% NDCG |

Default for v1: `bge-reranker-v2-m3` local. The reranker is **always on
for Tier 3**; for Tier 1 and 2-only paths it's skipped. It dominates
Tier 3 latency budget but lifts top-5 quality 2–3× over cosine similarity
alone — the single highest-leverage component.

## Embedding model

Pluggable.

| Backend | Dim | Where | Cost | Quality on code |
|---|---|---|---|---|
| **voyage-code-3** | 1024 | API | ~$0.06 / 1M tok | SOTA |
| **jina-code-v2** | 768 | API or local | low / $0 | strong |
| **nomic-embed-code** | 768 | local (ONNX) | $0 | good |
| **bge-code-v1** | 1024 | local | $0 | good |

Default for v1: `nomic-embed-code` local. Embedding is async — chunks sit
in a queue and are embedded opportunistically. **Search works before
embeddings exist**; uncovered chunks fall back to BM25.

See [ADR 0020](../decisions/0020-pluggable-rerank-and-embed.md) for the
provider abstraction.

## Credentials & billing

Three concentric tiers. **Only the first two ship in 0.04.**

| Tier | Mode | What user does | Where memoize is in the path |
|---|---|---|---|
| **1. Local** (default) | nomic-embed-code + bge-reranker-v2-m3 via `transformers.js` | Nothing. Works out of the box. | Not in the path. |
| **2. BYOK** | User pastes their Voyage / Cohere / OpenAI / Jina key | One-time: paste key in Settings → Index | Not in the path. Chunks go user → provider directly. |
| **3. Memoize-cloud** (deferred) | Pay memoize (subscription or metered); we proxy | Sign up, swipe card | In the path — chunks traverse memoize's proxy. |

**BYOK storage** uses the existing `keytar` pattern from agent integration
(see [agent-integration.md](../../0.01-MVP/features/agent-integration.md)),
same shape, new key slots:

```
memoize:embed:voyage     → VOYAGE_API_KEY
memoize:embed:openai     → OPENAI_API_KEY
memoize:embed:jina       → JINA_API_KEY
memoize:rerank:cohere    → COHERE_API_KEY
memoize:rerank:voyage    → VOYAGE_API_KEY
```

Never logged. Never written to disk in plaintext. Never sent to memoize
servers (because there are none in 0.04).

See [ADR 0021](../decisions/0021-credentials-and-billing.md) for why
pay-per-usage is deferred.

## MCP integration

Two consumption shapes.

### Shape 1 — In-process (memoize's bundled agent)

`apps/server` consumes `@zuse/index` directly. The Claude Code SDK and
Codex SDK adapters register five custom tools at session start:

```ts
// apps/server/src/provider/drivers/claude.ts (additions)
registerTool("code_search",     IndexService.search)
registerTool("symbol_lookup",   IndexService.symbolLookup)
registerTool("find_references", IndexService.findReferences)
registerTool("read_chunk",      IndexService.readChunk)
registerTool("list_module",     IndexService.listModule)
```

No MCP overhead. Function call → Effect → SQLite. Lowest latency.

### Shape 2 — External MCP server (`apps/mcp-server`)

A standalone binary that any agent runtime can spawn. Implements the
Model Context Protocol over stdio (default) and HTTP (optional).

```
zuse-mcp --workspace /path/to/repo
zuse-mcp --workspace /path/to/repo --http :7421
```

Distribution:

- npm: `npx @zuse/mcp-server`
- Bun standalone binary via `bun build --compile` (single executable per OS)
- Bundled inside the desktop app for users who want their memoize-managed
  index served to outside agents

Tool surface (mirrors Shape 1):

```jsonc
[
  { "name": "code_search",
    "inputSchema": { "query": "string", "kind": "auto|symbol|text|semantic", "branch": "string?", "limit": "number?" } },
  { "name": "symbol_lookup",
    "inputSchema": { "name": "string", "kind": "string?" } },
  { "name": "find_references",
    "inputSchema": { "symbol": "string", "limit": "number?" } },
  { "name": "read_chunk",
    "inputSchema": { "chunkId": "number" } },
  { "name": "list_module",
    "inputSchema": { "path": "string" } },
  { "name": "index_status",
    "inputSchema": {} }
]
```

A typical external-agent setup (terminal Claude Code) drops a line in
`~/.claude/mcp.json`:

```json
{ "servers": { "memoize": { "command": "zuse-mcp", "args": ["--workspace", "."] } } }
```

…and gets the same tools as the bundled agent.

See [ADR 0018](../decisions/0018-mcp-server-as-app.md) for why
`apps/mcp-server` is its own app.

### Why both shapes

- In-process is faster (no MCP serialization, no extra process).
- External MCP server makes the index reusable — Cursor, Codex, arbitrary
  agents share the same engine without forking it.
- One engine, one chunk store, one set of tests. Keeping the engine in a
  package and the transports in apps prevents drift.

## RPC contracts (renderer ↔ server)

New methods in `packages/contracts/src/index.ts`:

```ts
"index.status"        // {} → { state: "idle" | "indexing" | "ready" | "error", progress?: { processed: number; total: number } }
"index.search"        // SearchInput → SearchHit[]
"index.symbolLookup"  // { name, kind? } → SymbolHit[]
"index.findReferences"// { symbol } → RefHit[]
"index.readChunk"     // { chunkId } → ChunkContent
"index.listModule"    // { path } → SymbolSummary[]
"index.reindex"       // {} → void  (manual trigger)
```

A command palette entry (`Cmd+P` → "Search code…") wires the renderer to
`index.search`. The primary consumer is the agent; the renderer surface is
scaffolding for future UI.

## Verification

1. **Unit tests** (`bun --filter @zuse/index test`): chunker fixtures,
   symbol extraction fixtures, manifest swap, RRF correctness, router
   classification edge cases.
2. **Integration tests** (`apps/server`): reindex this repo, run a sample
   of `index.search` calls, assert top-1 hit on known-symbol queries.
3. **Eval harness** (`tools/index-eval/`): 20 hand-curated tasks (find a
   specific function; explain a module; locate a bug class; trace a flow
   through services). Run `bun run eval` which invokes a real agent twice
   — once with grep-only, once with index tools — and reports a CSV of
   `tokens, wall_seconds, succeeded`.
4. **MCP smoke test**: spawn `apps/mcp-server` from a script; connect via
   the `@modelcontextprotocol/sdk` client; call each tool with a fixture
   query; assert response shape.
5. **Manual dogfood**: open memoize on the memoize repo itself; ask the
   bundled agent "where is the PTY service spun up and how does it stream
   data to the renderer?"; observe it answers in 1–2 tool calls instead
   of 5+.
6. **Branch-switch benchmark**: measure manifest swap time across `main`
   ↔ `swarajbachu/0.04-index-spec` ↔ a hypothetical 1000-file-changed branch.

## Open questions

These are real decisions still to make — flag for discussion before
Phase B freezes:

1. **Reranker default install size.** bge-reranker-v2-m3 weights are
   ~120MB. Acceptable bundled, or default-off with an explicit toggle?
2. **Eval harness — synthetic vs. real tasks.** Curating 20 *real* tasks
   is best signal but slow. Phase B accept synthetic fixtures first, with
   the real eval gating Phase C?
3. **Refs accuracy floor.** Tree-sitter alone gets 70–80% accurate refs;
   full TS resolution needs `ts-morph` (heavy). Recommendation: ship
   tree-sitter-only; upgrade later if evals show false negatives matter.
4. **MCP server distribution.** Ship `@zuse/mcp-server` as a separate
   npm package from day 1, or bundle inside the Electron app first?
   Recommendation: ship the npm package in Phase F.
