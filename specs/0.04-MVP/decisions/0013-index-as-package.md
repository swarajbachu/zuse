# ADR 0013 — `@zuse/index` as a standalone package

Date: 2026-05-06
Status: Accepted

## Context

0.04 introduces a code index with tree-sitter chunking, symbol extraction,
hybrid retrieval (BM25 + vector + rerank), a content-addressed blob store,
and per-branch manifests. The engine has multiple consumers:

1. The desktop server (`apps/server`) — consumes the engine in-process and
   exposes `index.*` RPCs to the renderer.
2. A standalone MCP binary (`apps/mcp-server`) — wraps the engine for
   external agents (terminal Claude Code, Codex, Cursor) over the
   Model Context Protocol.
3. A future cloud-sync worker (deferred Phase G) — would push the
   content-addressed blob store to S3-compatible storage for team sharing.

The engine is non-trivial: SQL schema + migrations, tree-sitter grammars,
chunking, symbol extraction, FTS5 + sqlite-vec wrappers, rerank/embed
provider abstractions, a query router, RRF fusion, file watcher hooks. It
has its own tests, its own native-module surface, and its own version of
SQLite extensions.

If we land the engine as a service inside `apps/server`, the MCP binary
either has to import from `apps/server` (pulling in Electron + RPC
machinery it doesn't need) or duplicate the engine. Both are bad.

## Decision

Ship the engine as a standalone workspace package: **`@zuse/index`**.

### Layout

```
packages/index/
  package.json
  src/
    api.ts                            # exported Effect Service contract
    schema/migrations/                # SQL files
    chunker/                          # tree-sitter chunking
    symbols/                          # symbol extraction + ref resolution
    retrieval/
      symbol-lookup.ts                # Tier 1
      bm25.ts                         # FTS5 wrapper
      vector.ts                       # sqlite-vec wrapper
      rerank.ts                       # cross-encoder caller
      router.ts                       # query classification
      fuse.ts                         # reciprocal rank fusion
    manifest/                         # branch model
    watcher/                          # incremental file-change indexer
    embedding/                        # pluggable embedding providers
```

### Public API

The package exports an Effect Service (`IndexService`) with a Default
Layer that wires the SQL client, embedding provider, and rerank provider.
Consumers compose it into their own runtime — `apps/server` adds it to
the main-process Layer alongside `WorkspaceService`, `ProviderService`,
etc. `apps/mcp-server` adds it to a minimal Layer with no Electron, no
RPC.

```ts
// packages/index/src/api.ts
export class IndexService extends Effect.Service<IndexService>()(
  "IndexService",
  {
    effect: Effect.gen(function* () { /* ... */ }),
    accessors: true,
  }
) {}
```

### Catalog entries

Native dependencies live in the root catalog (per ADR 0006):

- `tree-sitter` and grammar packages (`tree-sitter-typescript`, etc.)
- `sqlite-vec` (SQLite extension binding)
- `@huggingface/transformers` (ONNX inference for nomic-embed-code +
  bge-reranker-v2-m3)
- `@parcel/watcher` (native file watcher)
- `blake3` (faster than `crypto.createHash('sha256')`)
- `@modelcontextprotocol/sdk` (used by `apps/mcp-server`, not the package
  itself)

### What stays out of the package

- Electron-specific code (lives in `apps/desktop`).
- IPC / RPC wiring (lives in `apps/server`).
- MCP transport (lives in `apps/mcp-server`).
- Renderer UI (lives in `apps/renderer`).

The package is **transport-agnostic**: it knows about SQLite, tree-sitter,
embeddings — not about how callers reach it.

## Consequences

### Positive

- One implementation, multiple consumers. No drift between desktop and
  MCP binary.
- `apps/mcp-server` doesn't import Electron or RPC machinery — it can be
  bundled as a small standalone binary via `bun build --compile`.
- The package is independently testable: `bun --filter @zuse/index test`
  runs unit + integration tests without booting Electron.
- Future cloud-sync worker is a third consumer, not a fork.
- `IndexService` plugs into the existing Effect Layer pattern with no
  special-casing — same shape as `WorkspaceService`, `ProviderService`.

### Negative

- One more package in the monorepo to maintain.
- Native modules (`tree-sitter`, `sqlite-vec`, `@parcel/watcher`,
  `transformers.js`'s ONNX runtime) need rebuild handling for Electron in
  `apps/desktop`. Adds to the existing rebuild list (see ADR 0019).
- Effect Service patterns are now expected in a non-app package. The
  `@zuse/contracts` package is contract-only; this is the first package
  with implementation. We accept the precedent.

## Alternatives considered

### Service inside `apps/server`

- Pro: matches existing `apps/server/src/<domain>/` pattern.
- Con: `apps/mcp-server` would either import from `apps/server` (pulling
  in Electron-relevant code) or fork the engine. Either way, drift
  becomes a maintenance hazard — and the standalone binary picks up
  cruft.

### Multiple per-domain packages (`@zuse/index-chunker`,
`@zuse/index-retrieval`, etc.)

- Pro: smaller individual packages.
- Con: premature partitioning. The engine is one concept and changes
  cross domains routinely. Splitting it forces every cross-domain change
  to negotiate package boundaries — same anti-pattern ADR 0005 warned
  against for `@zuse/contracts`.

### Fork the engine for the MCP binary

- Pro: each consumer optimizes for its shape.
- Con: drift is inevitable. The whole point of the index is that the
  bundled agent and external agents see the *same* answers from the *same*
  data. Fork-and-drift breaks the value prop.

## What we deliberately rejected

- Putting the engine in `@zuse/contracts`. Wire is contract-only.
- Making `apps/server` a peer of the engine instead of a consumer.
- Bundling MCP transport into the engine package — keeps the package
  transport-agnostic.

## Reference

This mirrors how `@zuse/contracts` is structured (one package, multiple
consumers — main and renderer) and ADR 0007's transport-agnostic split.
The index is the second cross-cutting package; it follows the same rule.
