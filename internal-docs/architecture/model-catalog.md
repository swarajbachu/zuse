# Model catalog

The model catalog is the list of models each provider offers, with the
metadata the app needs to drive them: labels, badges, option descriptors
(reasoning tiers, fast mode, context window), plan-mode / web-search
support, slug aliases, and reference pricing. It used to be a constant
compiled into every build, so adding a model meant a desktop release.

It is now data that flows through three layers, each of which is instant
to read and refreshes off the request path.

## Data flow

```
packages/contracts/src/model-catalog/bundled.ts   (hand-maintained, typed)
        │  bun run catalog:generate
        ▼
apps/web/public/models/v1.json  ──deploy──▶  https://zuse.sh/models/v1.json
        │                                      (CDN: s-maxage 1h, SWR 1d)
        ▼
apps/server ModelCatalogService
   curated:  memory ◀ disk (<userData>/model-catalog/curated.json) ◀ zuse.sh
             6h TTL, conditional GET with ETag, highest `revision` wins
   live:     one cache per provider, 24h TTL, keyed by a CLI/credential
             fingerprint, at most two provider processes at once
             codex   → app-server `model/list`          (authoritative)
             claude  → Claude Agent SDK `supportedModels` (additive only)
             cursor  → `Cursor.models.list`             (authoritative)
             kiro    → control plane / `kiro-cli chat --list-models`
             opencode→ `opencode serve` `provider.list`  (authoritative)
   resolved: resolveModelCatalog(curated, live) → `model.catalog` RPC
             and `model.catalog.stream`
        ▼
renderer store (`apps/renderer/src/store/model-catalog.ts`)
   bundled snapshot → localStorage → server, stale-while-revalidate
mobile store (`apps/mobile/src/store/model-catalog.ts`)
   bundled snapshot → disk snapshot → server, per connection
```

The merge (`packages/contracts/src/model-catalog/resolve.ts`) is pure and
shared by every client: curated entries win for labels, badges, and
descriptors; live-only models are appended with humanized labels and
provider-default descriptors; curated models missing from an authoritative
live list are marked `available: false` (hidden unless selected). The
server never downgrades: a remote document with a lower `revision` than the
bundled snapshot is ignored, and an unknown `schemaVersion` is rejected.

## Server contract

`ModelCatalogService` (`apps/server/src/model-catalog/`) exposes:

- `current()` — the resolved catalog from memory, never blocks.
- `refresh({ remote, live })` — forced refresh, used by the picker's
  refresh and by the poller (20 s after boot, then every 6 h, jittered).
- `changes()` — stream for `model.catalog.stream`.
- `findModel` / `resolveSlug` — what `ProviderService` uses at session
  start to canonicalize the slug and attach `StartSessionInput.modelDescriptor`
  so drivers never read a static list.
- `invalidateLive(providerId)` — called when credentials change so the next
  refresh re-probes that provider.

The shared cache primitive is `apps/server/src/cache/swr-cache.ts`
(single-flight, TTL, error back-off, fingerprint staleness, disk envelope).
New caches should use it instead of hand-rolled `Map` + TTL code.

Environment overrides:

| Variable                      | Effect                                             |
| ----------------------------- | -------------------------------------------------- |
| `ZUSE_MODEL_CATALOG_URL`      | Fetch the curated document from another origin.    |
| `ZUSE_MODEL_CATALOG_OFFLINE=1`| Never touch the network (tests, air-gapped hosts). |

Tests (`VITEST`, `NODE_ENV=test`) are offline automatically.

## How to add a model

1. Edit `packages/contracts/src/model-catalog/bundled.ts` (use the helpers
   in `authoring.ts`; add aliases and pricing when known).
2. Bump `revision` (format `YYYYMMDDNN`).
3. Run `bun run catalog:generate` and commit
   `apps/web/public/models/v1.json` with the change.
4. Update `packages/contracts/test/unit/model-catalog.test.ts` if defaults
   or ordering changed.
5. Merge. The web deploy publishes the file; installed apps see it within
   the CDN `s-maxage` (1 h) plus their 6 h TTL, or immediately when the
   user refreshes the picker. No desktop release is needed.

Models that only exist upstream (a provider ships something before the
curated entry lands) still appear: the live listing adds them with a
humanized label and the provider's default knobs.

## Canonical domains

Public URLs are derived from `packages/contracts/src/model-catalog/urls.ts`;
do not spell hostnames inline.

| Purpose        | Origin                    |
| -------------- | ------------------------- |
| Web + assets   | `https://zuse.sh`         |
| Documentation  | `https://docs.zuse.sh`    |
| Control plane  | `https://api.zuse.sh`     |

Published schemas live under `https://zuse.sh/schemas/` and the model
catalog under `https://zuse.sh/models/v1.json`.
