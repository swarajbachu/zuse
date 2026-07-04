# MVP 0.04 — Code Index

MVP 0.03 (everything under [../0.03-MVP/](../0.03-MVP/)) brought the chat
composer to first-class quality. MVP 0.04 turns inward: it gives the bundled
agent a real understanding of the user's codebase.

Today an agent inside memoize explores a repo the same way it does
anywhere — `Bash(rg ...)`, `Read`, `Glob`, iterate. On any real codebase
this is the dominant cost: 25–40k tokens across 5–8 tool calls before the
agent has the context to answer or edit. Most of that is *navigation tax*,
not real work.

0.04 ships a content-addressed code index with hybrid retrieval. The bundled
agent calls `code_search`, `symbol_lookup`, `find_references`, and
`read_chunk` instead of grepping. The same engine is also packaged as a
standalone `apps/mcp-server` so external agents (a terminal `claude`
session, a Codex session, a Cursor agent) get the same tools.

The wedge: memoize runs **N parallel agent workspaces on the same repo**:
multiple branches checked out side-by-side. Cursor,
Sourcegraph Cody, Greptile, Continue, Augment all index codebases, but none
handle this shape. A content-addressed chunk store with per-branch
manifests makes branch switches a sub-200ms manifest swap, and dedupes
across workspaces sharing a repo.

## What lands in 0.04

- **Index engine** as a standalone package `@zuse/index`. Tree-sitter
  chunking, symbol extraction, content-addressed blob store, per-branch
  manifest model. SQLite + `sqlite-vec` extension. Engine is transport-agnostic.
- **3-tier hybrid retrieval**: symbol lookup (Tier 1) → BM25 (Tier 2) →
  vector + RRF fusion + cross-encoder rerank (Tier 3). A query router
  classifies the query and picks tiers; fast paths (Tier 1) skip rerank.
- **Bundled agent integration**. The Claude SDK and Codex SDK adapters
  register five custom tools (`code_search`, `symbol_lookup`,
  `find_references`, `read_chunk`, `list_module`) at session start.
  In-process, no MCP overhead.
- **Standalone MCP server** as `apps/mcp-server`. A Bun-compiled binary
  (`zuse-mcp`) plus an npm package `@zuse/mcp-server`. stdio
  transport (default), HTTP transport (optional). Same engine, same tools,
  reusable by any agent runtime.
- **Local-first by default.** Embedding model: `nomic-embed-code` ONNX via
  `transformers.js`. Reranker: `bge-reranker-v2-m3` ONNX. Zero network
  calls in the default config.
- **BYOK opt-in for paid backends.** Voyage / Cohere / OpenAI / Jina keys
  live in `keytar` under the same pattern Phase 2 uses for agent provider
  keys. Chunks go user → provider directly; memoize is not in the path.
- **Branch-aware index**. File watcher + git checkout hook. Switching
  branches in a parallel workspace is a manifest swap, not a re-index.
  Content-addressed dedup means N parallel workspaces on one repo share
  one blob store.
- **Renderer scaffolding**. `index.*` RPCs registered in `@zuse/wire`.
  A command palette entry (`Cmd+P` → "Search code…") wires the renderer to
  the index. The primary consumer is the agent; the renderer surface is
  scaffolding for future UI.

## What's deliberately deferred

- **Cloud team index.** The chunk store is content-addressed and ready to
  sync; the actual S3-compatible sync worker, encryption keys, and team
  membership are deferred to a future MVP (sketched as Phase G).
- **Pay-per-usage billing.** Memoize-cloud as a paid embedding/rerank
  proxy is scaffolded as a provider stub but not implemented. ADR 0021
  documents the call. Adding it later doesn't require re-architecting.
- **Rust / Go / non-TS grammars at launch.** Memoize itself is TypeScript;
  ship TS + JS + TSX + JSON + Markdown grammars first, expand on demand.
- **Refactor / rename tooling.** The `refs` table powers read-only
  `find_references`; cross-file rename is out of scope (an LSP server's
  job, not ours).
- **Cross-repo search.** One workspace, one index, one repo per query.
- **In-app re-index UI.** A manual `index.reindex` RPC exists but the
  surface is hidden behind a debug command for v1.

## Where to read

- [features/code-index.md](features/code-index.md) — engine architecture,
  storage model, retrieval pipeline, MCP integration, RPC contracts.
- [roadmap.md](roadmap.md) — 7-phase delivery plan (A–G), acceptance
  criteria per phase, the experiment harness that gates Phase C.
- [decisions/0013-index-as-package.md](decisions/0013-index-as-package.md) —
  why the engine is a package, not a service inside `apps/server`.
- [decisions/0014-content-addressed-chunk-store.md](decisions/0014-content-addressed-chunk-store.md) —
  blob store + per-branch manifest; the parallel-workspace wedge.
- [decisions/0015-tree-sitter-chunking.md](decisions/0015-tree-sitter-chunking.md) —
  why tree-sitter for chunking and symbol extraction, not LSP.
- [decisions/0016-hybrid-over-pure-vector.md](decisions/0016-hybrid-over-pure-vector.md) —
  why BM25 + embeddings + rerank beats pure vector on code.
- [decisions/0017-branch-aware-manifest.md](decisions/0017-branch-aware-manifest.md) —
  manifest model and the < 200ms branch-switch budget.
- [decisions/0018-mcp-server-as-app.md](decisions/0018-mcp-server-as-app.md) —
  why `apps/mcp-server` is its own app, not a route in `apps/server`.
- [decisions/0019-sqlite-vec-extension.md](decisions/0019-sqlite-vec-extension.md) —
  extends ADR 0008; native module rebuild story.
- [decisions/0020-pluggable-rerank-and-embed.md](decisions/0020-pluggable-rerank-and-embed.md) —
  embedding and rerank provider abstraction.
- [decisions/0021-credentials-and-billing.md](decisions/0021-credentials-and-billing.md) —
  local default → BYOK in 0.04 → memoize-cloud deferred.

## Status

🚧 **Implementation in progress** — phases A–F shipped on PR #86
(`swarajbachu/mvp-0.04-impl`). The MVP retrieval surface (Tier-1 symbol
lookup + BM25 + RRF + cross-encoder rerank with BYOK providers) is live
end-to-end through the bundled agent; auto-reindex on workspace open is
wired; the renderer shows a progress chip while indexing.

The remaining work — wiring the watcher into the registry, real local
embedding + rerank providers (the semantic tier is currently disabled),
HTTP transport on the MCP server, the real LLM eval harness, and the
`Cmd+P` search modal — is catalogued in **[followups.md](./followups.md)**,
prioritized by what unblocks the most user value per hour of work.

Roadmap phase status is annotated inline in
[`roadmap.md`](./roadmap.md).
