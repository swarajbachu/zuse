# 0.04 Roadmap

Estimates assume a single developer, ~6 productive hours/day, with a capable
LLM pair-programmer. Effect-touching work has 30% headroom baked in.

Phases ordered by ROI. Each phase ends with a measurable result. Phases B
and C have explicit gating experiments — if the numbers don't materialize,
we reconsider before continuing.

**Status as of 2026-05-19** — Phases A–F all shipped on PR #86
(`swarajbachu/mvp-0.04-impl`). The MVP retrieval surface (Tier-1 symbol
lookup + BM25 + RRF + cross-encoder rerank) is live, end-to-end through
the bundled agent. Auto-reindex on workspace open + the renderer status
chip are in. Tasks left for the 0.04 release proper are catalogued in
[`followups.md`](./followups.md); the headline open items are:

- Semantic tier is **disabled** today (NullProvider) — needs a real local
  embedding provider before `code_search` semantic queries become useful
- File watcher exists in `@zuse/index` but isn't wired into
  `IndexRegistry`, so edits don't trigger incremental reindex yet
- MCP server ships stdio only — HTTP transport + `bun build --compile`
  packaging both still pending
- Real LLM eval harness is stubbed; the acceptance numbers below haven't
  been measured against a real agent yet

## Phase A — Foundation (~1 week) ✅ shipped

Tree-sitter chunker, symbol extractor, SQLite schema, content-addressed
blob store, manifest model. **No retrieval yet.**

- `packages/index/` scaffold + Effect Service contract
- ADR 0013 — `@zuse/index` as standalone package
- ADR 0014 — content-addressed chunk store + per-branch manifest
- ADR 0015 — tree-sitter for chunking & symbols
- TypeScript + JavaScript + TSX grammars only
- Migrations under `packages/index/src/schema/migrations/`
- Tests: index memoize itself; assert chunk count, symbol count, blob
  dedup across two branches with shared files

**Acceptance:** `bun --filter @zuse/index test` passes; indexing this
repo produces > 5,000 chunks and > 2,000 symbols; switching `main` ↔ a
branch with one changed file results in exactly one new blob row.

## Phase B — Symbol-search MVP + experiment (~3 days) ✅ shipped (eval pending)

**Tier 1 only**, no embeddings. Wired into the bundled Claude agent. Run
the experiment that justifies the rest of the work.

- `IndexService.symbolLookup`, `findReferences`, `readChunk`, `listModule`
- Register tools in the Claude SDK adapter (`apps/server/src/provider/drivers/claude.ts`)
- Build a 20-task evaluation harness under `tools/index-eval/`:
  task descriptions, fixtures, scoring (token usage, wall time, success)
- Run baseline (grep agent) vs. Tier-1-enabled

**Acceptance:** Tier-1 agent uses ≤ 50% baseline tokens on ≥ 70% of tasks.
If we miss this bar, **stop and reconsider** before building Tier 3.
Numbers logged to `specs/0.04-MVP/eval/phase-b.md`.

## Phase C — BM25 + embeddings + RRF (~1 week) ✅ shipped (semantic tier disabled until Phase D' below)

Tier 2 + Tier 3 retrieval. **No rerank yet** — this phase isolates the
fusion lift from the rerank lift.

- FTS5 virtual table, sqlite-vec extension wired
- ADR 0019 — sqlite-vec extension (extends ADR 0008)
- Embedding provider abstraction (default: nomic-embed-code local)
- ADR 0020 — pluggable rerank and embed
- Async embedding worker — chunks queue, batches of 64
- Reciprocal Rank Fusion implementation
- ADR 0016 — hybrid retrieval over pure vector
- Re-run the 20-task harness

**Acceptance:** Hybrid agent (no rerank) uses ≤ 35% baseline tokens on
≥ 80% of tasks. Vector + BM25 alone shows clear lift over Tier 1.

## Phase D — Reranker (~3 days) ✅ shipped (BYOK providers; local transformers.js model deferred — see followups)

Cross-encoder rerank for Tier 3.

- bge-reranker-v2-m3 via transformers.js (default, local)
- Pluggable Voyage / Cohere backends behind keytar-stored keys
- Top-5 reranked replaces top-5 fused
- Re-run the harness

**Acceptance:** NDCG@5 on the eval set up ≥ 20% over Phase C; tokens-per-task
budget down further (target ≤ 25% baseline).

## Phase E — Watcher + branch model (~4 days) ◐ engine landed, registry wiring pending

Incremental updates and fast branch switches.

- File watcher via `@parcel/watcher` (fast, native, no chokidar polling)
- Branch detection: hook `git checkout` via `apps/server/src/git/`
- ADR 0017 — branch-aware manifest
- Manifest swap path proven against parallel workspaces (5 branches)

**Acceptance:** Branch switch < 200ms on a repo with > 10k files; file edit
re-indexes only the changed file in < 50ms; running 5 parallel workspaces
on the same repo uses one shared blob store (deduped).

## Phase F — `apps/mcp-server` packaging (~1 week) ◐ stdio only; HTTP + compile pending

Standalone MCP binary, npm-distributable, Bun-compiled.

- `apps/mcp-server` scaffold using `@modelcontextprotocol/sdk`
- ADR 0018 — MCP server as standalone app
- stdio transport (default), HTTP transport (optional)
- All five tools registered, JSON Schema validated
- `bun build --compile` produces `zuse-mcp` per OS
- npm publish: `@zuse/mcp-server`
- ADR 0021 — credentials and billing (BYOK in 0.04, cloud deferred)
- Smoke test: terminal Claude Code session pointed at the MCP server can
  call all five tools end-to-end

**Acceptance:** `npx @zuse/mcp-server --workspace .` runs; an external
agent (terminal `claude`) using only `zuse-mcp` tools (no built-in
grep) finishes ≥ 80% of the eval harness tasks.

## Phase G — Cloud team index (deferred)

Out of scope for 0.04. Spec'd separately in a future MVP.

- S3-compatible chunk-store sync (the blob store is already content-addressed)
- Per-team encryption keys
- Embedding inversion mitigation (research, not yet a decision)
- Memoize-cloud as a paid embedding/rerank proxy

## Total

| Milestone | Calendar |
|---|---|
| Phase A foundation | end week 1 |
| Phase B Tier-1 + experiment gate | end week 1 |
| Phase C hybrid retrieval | end week 2 |
| Phase D rerank | mid week 3 |
| Phase E watcher + branches | end week 3 |
| Phase F MCP server published | end week 4 |
| 0.04 release | week 4 |
| Phase G cloud (deferred) | future MVP |

## Beyond 0.04

ADR 0007's transport-agnostic split keeps these costs bounded — each
becomes a focused PR, not a redesign.

| Milestone | What changes |
|---|---|
| Cloud team index | Drop in a sync worker over the existing content-addressed blob store; add `memoize-cloud` provider for embed/rerank. |
| Symbol-aware refactors | The `refs` table is already populated — building rename/extract on top is incremental. |
| Cross-repo search | Index multiple workspaces under one query — needs a workspace-spanning manifest layer. |

See [ADR 0013](decisions/0013-index-as-package.md) for the rules that keep
these costs bounded.
