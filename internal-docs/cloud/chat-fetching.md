# Cloud chat fetching

Boat and E2B share the same transcript fetch path. An unopened chat has no local transcript: the renderer requests the encrypted recent checkpoint through its existing account control-plane RPC, validates/decrypts it, persists it, and publishes the canonical ClientBus view. Reading a paused transcript does not wake compute. The checkpoint bytes live in object storage; the workspace gateway Durable Object handles live transport, not the stored transcript download.

## Recent content and history

Cloud clients opt into `session.events.historyMode = background`. New runtimes acknowledge it on the snapshot, send the bounded recent projection and synchronization barrier, then stream live events immediately. Clients only relax full-history synchronization checks after that acknowledgement. Local sessions and older runtimes retain the original stream behavior.

A shared scheduler fetches older pages separately, with two requests across the app and one per resource. Selection sets priority; disposal and logout abort work. Page merges check generation, epoch, and continuation position, while allowing live version advancement. Existing messages win over overlapping older rows. Failures retain the conversation and offer an inline retry. Older pages are persisted separately, fenced by the authoritative checkpoint epoch and version. Local disk persistence remains before checkpoint publication to the UI.

## Catalog

`GET /v1/cloud/chats` keeps its response shape but reads workspace/project/runtime summary data in one query. Migration 0025 publishes account revisions in the same transaction as each committed mutation; a compact latest-change table includes deletion tombstones. `GET /v1/cloud/chats/changes?cursor=...` resumes from the revision or returns an authoritative reset. Revision allocation serializes commit order per account. An absent or ahead-of-server cursor resets.

`cloud.chats.watch` reuses authenticated control-plane streaming RPC. The control-plane transport polls the small delta endpoint every 750 ms plus request time; this is not server-pushed WebSocket notification. Reconnect preserves the last applied cursor. Initial synchronization keeps cached sidebar rows visible and pending archive intents hidden. Archive retries no longer block the initial fetch.

## Measurements and diagnostics

Renderer performance measures `zuse.cloud.fetch.*` cover selection to request start, control-plane availability, download, decryption, canonical head, paint, live synchronization, and separate history completion. API `[cloud-timing]` events distinguish workspace lookup, checkpoint metadata, object download, and key opening. No transcript text or credentials are logged.

A September 17 baseline from the user's Mac, using authenticated HTTP and no transcript cache:

- Small Boat transcript (6.4 KB): 1,075 / 1,745 / 449 ms.
- Small paused E2B transcript (2.5 KB): 431 / 449 / 424 ms.
- Paused E2B transcript (63 KB): 2,598 / 480 / 462 ms.
- Full catalog requested by the UI (`scope=all`): staging 35 rows, 8,317 ms; production 7 rows, 3,908 ms. These remain baseline deployed API measurements.

These are HTTP timings, not selection-to-paint results. They do not establish disk writes as a bottleneck. Prioritize an uncached API-created chat, including Slack-created E2B chats, for end-to-end validation.

A separate local SQLite stream benchmark (2 KB/message, excludes network, DO, decryption and rendering) compares the legacy synchronization barrier with the recent-first barrier:

| Messages | Legacy barrier | Recent-first barrier | Legacy bytes | Recent-first bytes |
| --- | --- | --- | --- | --- |
| 10 | 10.63 ms | 5.20 ms | 23,789 | 23,816 |
| 1,000 | 86.41 ms | 13.67 ms | 2,345,234 | 234,796 |
| 10,000 | 2,069.40 ms | 41.93 ms | 23,460,047 | 234,899 |

Run `packages/domain/test/integration/engine/cloud-history-benchmark.test.ts` with `ZUSE_BENCHMARK_OUTPUT` to record results. These figures must not be substituted for real uncached cloud first paint.

## Rollout

Publish the signed staging runtime, apply additive migration 0025 to the verified staging database, then deploy staging API. Validate current and older runtime clients, paused Boat/E2B reads, live/history interleaving, account isolation, archive/delete races and uncached first paint before production. Production rollout and complete desktop end-to-end measurements are still outstanding.

### September 17 staging validation

Runtime commit `676e91f91` was published and verified by workflow run `35211820796`. Migration 0025 was applied to the approved staging Hyperdrive origin after checking the exact 0024 ledger hash, then verified; the authenticated temporary migration Worker was deleted. API version `ea4aaf32-6742-40e3-ae89-d59bee43208b` includes catalog batching and request-independent WorkOS public verification-key reuse. Every request still verifies token signature, expiry, issuer and client identity; no token/principal cache was introduced.

The same 35-row full catalog measured **775 / 523 / 551 ms** after batching versus the **8,317 ms** baseline. A subsequent run measured 490 / 668 / 477 ms. The resumable feed returned all 35 rows on reset and zero rows for an unchanged cursor (283 ms).

Small uncached transcript requests still show network/server variability. The final successful trace measured Boat 2,139 / 440 / 457 / 444 / 444 ms and E2B 431 / 419 / 452 / 475 / 1,685 ms. No selection-to-paint claim follows from these HTTP results, and public-key reuse alone has not demonstrated a consistent latency improvement. Captured server stages were approximately 100–121 ms for workspace lookup, 94–110 ms for checkpoint metadata, 124–277 ms for object download, and below clock resolution for key opening. These explain the steady-state path but not all intermittent pre-route delays. Expired-login responses were excluded.

Validation passed: 330 API unit tests, 162 client-runtime unit tests, session-domain stream tests, runtime checkpoint tests, renderer behavior checks, real Postgres catalog transaction/account-isolation tests, browser IndexedDB page fencing, types, localization checks, and applicable Biome checks (two existing unrelated unused-function warnings). The exact production Boat test chat and Slack-created first-open UI trace remain to be validated; no production mutation or deployment was performed.
