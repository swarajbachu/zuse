# Realtime, cache, and transcript storage

Cloud chat navigation is offline-first. The client should show the best durable
projection it already has, improve it from R2 without waking compute, and then
attach to a live runtime only when appropriate.

## Storage roles

| Store | Data | Authority | Availability purpose |
| --- | --- | --- | --- |
| Runtime SQLite | Event log, projections, turns, queues, receipts, full transcript | Writable authority | Correct execution and resumable sync |
| R2 | Encrypted immutable newest projections and bounded older pages | Read-only derivative | Cross-device and paused-sandbox catch-up |
| Desktop/web IndexedDB | Qualified materialized resources, cursors, safe outbox | Client cache | Immediate launch and offline reading |
| Mobile SQLite adapter | Same client persistence contract | Client cache | Immediate mobile launch and offline reading |
| API Postgres | Lifecycle, catalog summaries, checkpoint pointers | Control-plane authority | Discovery, authorization, monotonic metadata |
| Durable Object | Live attachment metadata | No content authority | Low-latency opaque frame routing |

R2 does not store repositories, uncommitted files, terminal bytes, credentials,
or writable command queues. Paused E2B storage is the only complete workspace
filesystem during the archive window.

## Opening a chat

```text
select route
  -> render local projection if present
  -> fetch API catalog/checkpoint pointer in background
  -> download and decrypt R2 only when its cursor is newer
  -> persist and apply that projection once
  -> attach live only if runtime is already online
  -> request wake only for an interactive action
```

The selected route is retained during every phase. Transport failure changes
status but never replaces valid data with a blank screen. A skeleton appears
only when there is no local projection. A paused or unreachable workspace can
therefore remain readable without API, the gateway, or E2B.

The target is cached display below 100 ms and R2 catch-up p95 below 750 ms.
Network work does not block navigation.

## Live synchronization

The runtime cursor is `{ epoch, version }`. Synchronization attaches the live
subscription before reading the durable head, buffers concurrent commits, and
then returns one of:

- a delta when the cursor is in the current epoch and within 512 events and
  1 MiB;
- a materialized newest-page snapshot when the delta would be too large;
- `reset-required` for a compacted, restored, or invalid cursor; and
- `synchronized` after the buffer has been applied.

The client applies catch-up silently, persists it, and notifies UI subscribers
once at synchronization. It does not animate thousands of missed token events
as though they were live. Older messages load through cursor-paginated immutable
pages when the user scrolls upward.

The client advances its stored cursor only after reducer application and cache
persistence succeed. Every result includes environment, resource, connection
generation, epoch, and version.

## Precedence and fencing

From strongest to weakest:

1. A newer live runtime projection.
2. A newer encrypted R2 checkpoint.
3. The persisted local projection.
4. API catalog summary as a last-known placeholder.

An equal or older source cannot regress state. Results from an old environment
or connection generation are discarded before reduction. An epoch change
causes one bounded reset, not a second reconnect loop.

## Provider checkpoints

Provider adapters emit absolute checkpoints with a stable turn ID, item ID,
monotonic revision, complete content-so-far, and final flag. The runtime
coalesces small deltas, durably upserts the same message ID, and publishes only
after commit. An older revision is ignored and finalization is idempotent.

This is why a provider can continue while all clients are absent and why a
runtime restart retains partial output. Client WebSockets never own provider
consumption.

## R2 checkpoints

After committed session changes, the runtime produces a bounded transcript
projection. It compresses and encrypts the payload with AES-256-GCM and binds
workspace, session, epoch, version, and schema version as authenticated data.
Objects use immutable versioned keys.

API verifies runtime generation, object hash, byte size, and monotonic cursor.
It writes the object before compare-and-setting the latest pointer. An upload
failure never rolls back SQLite or blocks provider output. Active uploads are
coalesced; settlement and pause/archive request an immediate bounded flush.

The initial decrypted projection remains below 1 MiB by retaining newest
complete messages rather than splitting a message. Older history lives in
separate bounded pages. A new device can therefore show the newest state without
downloading a multi-year transcript or waking E2B.

## Commands and offline safety

Retry-safe mutations carry stable command IDs and relevant concurrency
preconditions. Prompts, cancellation, queue edits, renames, mode changes, and
explicit file writes may enter the durable client outbox. The client retries
the same command ID until its server receipt is observed.

Terminal input and non-idempotent Git operations are never blindly replayed.
Pending commands are keyed by environment and resource so switching chats or
environments cannot deliver them elsewhere.

## Connection supervision

One supervisor per environment owns resolution, tickets, WebSocket generation,
resume single-flight, and retry. Components do not construct their own clients.
Typed close outcomes have deterministic handling:

- auth expiry refreshes the short-lived ticket once;
- runtime unavailable refreshes lifecycle and waits without resume spam;
- stale generation discards the socket and resolves the current generation;
- update required or revoked stops retrying;
- network or backpressure retries with capped exponential backoff and jitter.

A short visual grace period hides transient network churn, but persistent
failure remains visible while cached content stays usable.
