# ADR 0004: Distribute the model catalog from zuse.sh

- Status: Accepted
- Date: 2026-09-04

## Context

Every provider's model list, defaults, option descriptors, aliases, and
reference pricing lived in one constant inside `@zuse/contracts`. The
renderer, server, mobile app, CLI, and analytics all imported it directly.
Shipping a new model therefore required a source change plus a full desktop
release, and every release cycle for a data change delayed users by days.
Two providers already had live inventory RPCs, but each spawned a process
per call with no server-side cache, and the renderer kept two duplicate
localStorage caches for them.

The repository also referred to the public site as `zuse.dev` in schema ids,
docs, and the bundled skill, while the real domain is `zuse.sh`.

## Decision

1. **The curated catalog is data.** `BUNDLED_MODEL_CATALOG` in
   `packages/contracts/src/model-catalog/` is the single hand-maintained
   source, typed by the `ModelCatalog` schema and carrying a monotonic
   `revision`.
2. **It is published from the marketing site.** `bun run catalog:generate`
   writes `apps/web/public/models/v1.json`, served at
   `https://zuse.sh/models/v1.json` with CDN caching. A merge to `main`
   ships a model change; no desktop release.
3. **The server merges live inventories.** `ModelCatalogService` keeps the
   curated document (bundled, disk, or remote — highest revision wins) and
   per-provider live listings (Codex, Claude, Cursor, Kiro, OpenCode) behind
   a shared stale-while-revalidate cache, and serves the merged result via
   `model.catalog`. Nothing on a request path waits for the network or a
   provider process.
4. **Clients start from the bundled snapshot.** Renderer and mobile render
   the compiled-in catalog immediately, then the last persisted server
   answer, then the live one. An old server without the RPC keeps the
   bundled snapshot.
5. **Drivers receive resolved descriptors.** `ProviderService` canonicalizes
   slugs and attaches `StartSessionInput.modelDescriptor`; `packages/agents`
   reads no static model list.
6. **Canonical domains are constants.** `packages/contracts/src/model-catalog/urls.ts`
   defines `https://zuse.sh`, `https://docs.zuse.sh`, and `https://api.zuse.sh`.
   `zuse.dev` is not a Zuse domain.

## Consequences

- Persisted model visibility flags are no longer filtered against the
  compiled-in list, so a choice about a remotely added model survives
  restarts.
- Analytics allowlists still come from the bundled snapshot; live-only
  models report as `custom` until curated.
- The published JSON must be regenerated with every catalog change; a unit
  test and `bun run catalog:check` enforce it.
- Fable 5.1 and GPT-6 Astra ship through this path as the new Claude and
  Codex defaults.

## Required verification

- `packages/contracts` catalog and merge tests, `apps/server` cache and
  publish tests, renderer and mobile type checks.
- Launching offline shows the bundled catalog instantly; launching online
  writes `<userData>/model-catalog/curated.json` with an ETag.
