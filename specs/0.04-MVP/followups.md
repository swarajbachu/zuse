# 0.04 Follow-ups — what's left after PR #86

PR #86 (`swarajbachu/mvp-0.04-impl`, 10 commits, +6395/−474) landed
phases A–F of the spec plus auto-reindex on workspace open. This doc is
the punch list of everything between "shipped" and "0.04 release-ready,"
ordered by what unblocks the most user value per hour of work.

This is a *living* doc: when an item is fully shipped, strike it through;
when a new follow-up gets discovered during real-world use, add it here
rather than scattering it across commit messages or issues.

---

## What's already on PR #86

For context — the surface this doc is building on:

- `@zuse/index` engine: tree-sitter chunking, content-addressed blob
  store, branch-aware manifest, FTS5 BM25, sqlite-vec scaffolding, RRF
  fusion, cross-encoder rerank with BYOK providers
- Five MCP tools registered with the bundled Claude agent
  (`code_search`, `symbol_lookup`, `find_references`, `read_chunk`,
  `list_module`) and as the standalone `@zuse/mcp-server` binary
- Auto-reindex on `workspace.setSelected` and `workspace.add`,
  end-to-end status stream from engine → renderer top-bar chip
- Seven `index.*` RPCs, full handler layer
- Quality fixes from first real-world use: walker ignores `.forkzero/`,
  `target/`, `vendor/`; `chunkId` on `SymbolHit` to kill the
  symbolId/chunkId namespace footgun; `pathGlob` filter on the three
  search tools; vector tier short-circuited when no embedding provider
  is configured; tool descriptions rewritten to encode the "known
  identifier → symbol_lookup, conceptual → code_search, literal → grep"
  rule of thumb
- Desktop infrastructure fixes: tree-sitter natives externalized in
  tsdown; `electron-rebuild` whitelist switched to strict; the five
  `mcp__zuse__*` tools auto-allowed in the Claude permission system

---

## Critical path to 0.04 release

These three unblock the headline claim that the index is "live, useful,
and faster than grep." Without them the spec's acceptance numbers are
aspirational.

### 1. Wire watchers into `IndexRegistry` — ~half a day

**Why:** Phase E shipped the engine-level `reindexFile` + `fs.watch`
glue, but `IndexHandle` doesn't subscribe to it. So today, editing a
file does *not* re-index it; the agent's tools return stale chunks
until the user re-runs an explicit reindex. This is the single biggest
gap between "works in tests" and "useful in daily use."

**Acceptance**

- Each `IndexHandle` owns a debounced (~150 ms) watcher subscription
  rooted at the workspace path, honoring the same ignore list as the
  initial walker
- File modification → `reindexFile` fires within debounce window;
  status stream emits `indexing → ready` so the renderer chip ticks
- Git `HEAD` change (existing `subscribeHeadChanges` in
  `apps/server/src/git/`) fires `swapBranchManifest` and re-publishes
  status — branch switch < 200 ms target from the spec
- New test: write a file under a temp root, wait for the watcher to
  fire, assert the new symbol shows up in `symbol_lookup`

**Files:** `apps/server/src/code-index/layers/index-registry.ts` (per-entry
watcher lifecycle), `packages/index/src/incremental.ts` (already exists,
just needs subscribing).

### 2. Real LLM eval harness — ~1–2 days

**Why:** Phases B, C, D each carry an explicit gating acceptance
number (≤ 50% tokens at Tier 1, ≤ 35% at hybrid, NDCG@5 up ≥ 20% with
rerank). None of these have been measured against a real agent —
`tools/index-eval/` runs the *retrieval* path but not a real LLM with
the tools attached. Without this we don't actually know if the index
is paying for its own complexity.

**Acceptance**

- `tools/index-eval/` runs a real agent twice per task (baseline: grep
  only; treatment: index tools enabled), emits CSV of
  `task_id, tokens, wall_seconds, succeeded` per row
- 20 hand-curated tasks on the memoize repo itself (matching the spec's
  Phase B language: find a specific function, explain a module, trace a
  flow, locate a bug class)
- Numbers logged to `specs/0.04-MVP/eval/phase-{b,c,d}.md` so future
  changes can regress against them
- Real number replaces the "TBD" in [the README's results
  table](./README.md) — even if it falls short of spec, *know* the
  number

**Files:** `tools/index-eval/src/{harness,tasks,scoring}.ts`,
`tools/index-eval/run-eval.ts` entry point.

### 3. Real local embedding provider — ~1–2 days

**Why:** This is what un-disables the semantic tier. Today
`NullProvider` returns zero vectors and the router strips the vector
tier; `kind: "semantic"` degrades to BM25. Conceptual queries like
"where is the retry logic" hit BM25-on-identifiers and miss. ADR 0020
already specifies transformers.js + nomic-embed-code as the default.

**Acceptance**

- `setEmbeddingProvider(...)` gets called from
  `apps/server/src/runtime.ts` at boot with a transformers.js-backed
  implementation
- Model weights either bundled inside the dmg (acceptable up to ~80 MB)
  or downloaded on first use into `<userData>/models/` with a progress
  toast; choose based on actual on-disk size — flagged in [Open
  Question 1](./features/code-index.md#open-questions)
- `EmbeddingProvider.id` is no longer `"null"` so the router stops
  stripping the vector tier
- The eval harness shows hybrid retrieval (with semantic enabled) beats
  Tier-1 + BM25 alone on conceptual tasks
- Tool description for `code_search` reverts: drop the "currently
  degrades to BM25" caveat once this lands

**Files:** new `packages/index/src/embedding/transformers.ts` provider;
wire-up in `apps/server/src/runtime.ts`; possibly a model-download
helper in `apps/desktop/src/main.ts`.

---

## Should-do before 0.04 ships

These don't block the headline value but they're cheap and they round
out the "things just work" experience.

### 4. Local rerank provider via transformers.js — ~half a day

Mirror of #3 but for the cross-encoder. Today BYOK Voyage/Cohere
ranking works; default is `NullRerankProvider` (pass-through). Land
`bge-reranker-v2-m3` via transformers.js, then strike the BYOK-only
caveat from the rerank ADR.

**Files:** `packages/index/src/rerank/transformers.ts`, wire-up next to #3.

### 5. HTTP transport on `@zuse/mcp-server` — ~half a day

Spec lists this as Phase F deliverable. Stdio is in; HTTP is two
handlers (`/messages` POST + `/events` SSE) on a tiny Bun.serve. Lets
remote agents (Codex, custom clients) reach the server without a child
process. Acceptance: `npx @zuse/mcp-server --workspace . --http 0`
boots, `curl /events` streams, all five tools callable.

**Files:** `apps/mcp-server/src/transport-http.ts`, plumb through
`apps/mcp-server/src/bin.ts` CLI flag.

### 6. `bun build --compile` produces a working binary — ~half a day

Phase F's stretch deliverable. Today the MCP server ships as a Bun
script; spec calls for a single-file native binary per OS. Verify
`bun build --compile --target=bun-darwin-arm64 src/bin.ts -o zuse-mcp`
produces something that boots, opens the SQLite handle, and serves
tools over stdio. Document the exact incantation in the mcp-server
README.

**Files:** `apps/mcp-server/scripts/build-binary.mjs`, `package.json`
`scripts` entry, CI workflow if we're publishing artifacts.

### 7. Refs extraction (`find_references` populates) — ~1 day

`find_references` currently returns `[]` — the refs table is wired but
extraction is gated to "Phase E+" per ADR 0015. Ship the tree-sitter
query that emits an entry for every identifier-call-site, store into
`refs`, with the explicit caveat (per ADR) that tree-sitter alone is
70–80% accurate. Tool description already warns the agent to fall back
to `Bash(rg)` until this lands; once it ships, update the description
and the spec's open question 3.

**Files:** `packages/index/src/symbols/refs.ts` (new), wire into
`indexer.ts` per-file pass.

### 8. `Cmd+P` "Search code…" modal — ~1 day

Spec lists this as a Phase F deliverable. RPCs are already in
(`index.search`, `index.symbolLookup`), so this is renderer-only:
modal component, keybinding, results pane with file path + line range
+ a snippet. Use the existing command-palette pattern in
`apps/renderer/src/lib/commands.ts`.

**Files:** `apps/renderer/src/components/search-code-modal.tsx`,
keybinding registration, store glue.

---

## Should-do before 1.0 (but not 0.04-blocking)

### 9. Strip foreign-platform tree-sitter prebuilds in electron-builder

Each tree-sitter package ships `prebuilds/{darwin,linux,win32}-{arm64,x64}/`.
Without a `files` filter in `electron-builder.yml`, every Mac dmg
carries the Linux + Windows `.node` files — ~7 MB of dead weight.
3-line config fix. Worth doing before any public release but trivially
deferrable.

**Files:** `apps/desktop/electron-builder.yml` (or equivalent).

### 10. `@parcel/watcher` instead of `fs.watch`

The spec's Phase E originally specced `@parcel/watcher` for performance.
We shipped `fs.watch` instead — documented deviation. Real impact only
shows up on Linux (`fs.watch` is unreliable on networked filesystems)
and on repos > 10k files (recursive watching is expensive). Swap if/when
we hit those cases.

### 11. Settings UI for BYOK rerank/embedding keys

Today the rerank providers (Voyage, Cohere) read their API keys from
keytar but there's no UI to set them. Renderer needs a settings panel
that calls `keytar.setPassword` + flips the active provider. Same UI
hook used by Phase 3 of the original 0.04 ADR 0021.

**Files:** `apps/renderer/src/components/settings/rerank-providers.tsx`,
new RPCs in `packages/wire/src/keytar.ts`.

### 12. Path-glob default-scoping on monorepos

Today `pathGlob` is opt-in. On the memoize repo (a workspace with
parallel worktrees), unfiltered queries still return more noise than
needed. Could auto-detect a monorepo (`pnpm-workspace.yaml`,
`bun-workspace`, `lerna.json`, `turbo.json`) and default-scope to the
current focused project. Tradeoff: cross-package queries get worse
without an explicit opt-out flag.

---

## Open questions still on the spec

Carried forward from
[`features/code-index.md#open-questions`](./features/code-index.md#open-questions),
now with the additional context PR #86 brought:

1. **Reranker default install size.** transformers.js + bge-reranker
   weights are ~120 MB. Bundle inside the dmg or download on first
   use? Same question for the embedding model. The desktop dmg is
   ~150 MB today; bundling both pushes us past 300 MB. Lean toward
   *download on first run with a progress toast*. Decide when #3 lands.

2. **Eval harness — synthetic vs. real tasks.** Real tasks gate Phase C
   acceptance. Recommendation in #2 above: 20 real tasks on the memoize
   repo itself, since we're our own first user.

3. **Refs accuracy floor.** Tree-sitter alone hits 70–80%; full TS
   resolution needs `ts-morph` (heavy). Recommendation: ship
   tree-sitter only per #7, upgrade later if evals show false
   negatives matter.

4. **MCP server distribution.** Ship `@zuse/mcp-server` as a
   separate npm package from day 1, or bundle inside the Electron app
   first? Spec recommendation was "ship the npm package in Phase F";
   #6 is the path to that.

## Deferred to Phase G / future MVPs

These stay out of scope for 0.04 entirely — captured here so they
don't leak into follow-up work without a fresh decision:

- Cloud team index (S3 sync over the existing content-addressed blob
  store, per-team encryption, embedding inversion mitigation)
- Cross-repo search across multiple workspaces under one query
- Symbol-aware refactors (rename, extract function) — the `refs` table
  enables it but the editing surface is its own MVP
- Memoize-cloud as a paid embedding/rerank proxy
- IDE-grade incremental parsing (we re-parse the whole file on
  change; ADR 0015 makes the inverse case)

---

## Tracking

The numbered items above map 1:1 to the in-conversation task list:

| # | Item                                           | Task # |
|---|------------------------------------------------|--------|
| 1 | Wire watchers into IndexRegistry               | 7      |
| 2 | Real LLM eval harness                          | 12     |
| 3 | Real local embedding provider                  | 10     |
| 4 | Local rerank provider                          | 11     |
| 5 | HTTP transport on MCP server                   | 8      |
| 6 | `bun build --compile` produces a binary        | 9      |
| 7 | Refs extraction                                | new    |
| 8 | `Cmd+P` search modal                           | new    |
| 9 | Strip foreign tree-sitter prebuilds            | new    |
| 10 | `@parcel/watcher` swap                        | new    |
| 11 | Settings UI for BYOK keys                     | new    |
| 12 | Path-glob default-scoping on monorepos        | new    |
