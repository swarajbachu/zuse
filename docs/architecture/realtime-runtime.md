# Realtime Runtime Architecture

Zuse has one durable path for a session transcript, regardless of whether the
environment is local, SSH, or a cloud workspace:

```text
provider / client command
  -> SessionDomain transaction
  -> SQLite event log and projections
  -> bounded cursor synchronization
  -> one retained environment runtime
  -> keyed ClientBus resource
  -> UI selectors
```

## Authority boundaries

| State | Authority |
| --- | --- |
| Chats, sessions, messages, turns, queues, command receipts | Environment SQLite |
| Files and Git | Environment filesystem and repository |
| Terminal process/output ordering | Environment PTY runtime |
| Workspace lifecycle, identity, tickets, encrypted launch intent | Relay control plane |
| Cached client projection and safe command outbox | Platform client persistence |

The Relay catalog carries only last-known metadata for discovery. It never
projects normal transcript events and never accepts normal message commands.
The only content-bearing Relay record is an encrypted, expiring launch intent
used before a new workspace runtime exists. The runtime consumes it through the
same idempotent chat/session creation path and acknowledges the stable launch
command before the intent can be removed.

## Disconnect and catch-up

A client WebSocket is disposable. Provider consumption belongs to the runtime
and continues after the app quits, the laptop sleeps, or the network changes.
On reopen, the client paints its qualified cached resource first, then attaches
one live subscription before reading the durable head. It receives either a
bounded delta or a newest-page materialized snapshot, followed by buffered live
events. Epoch changes and gaps request one bounded reset while valid cached data
remains visible.

The cursor is `{ epoch, version }`. A result also carries its environment,
resource key, and connection generation. The ClientBus reducer rejects stale
generations, regressing versions, and unannounced epoch changes.

## Connection and gateway

Each environment has one retained runtime and one supervised retry policy.
Feature components do not construct clients or own retry loops. Cloud-specific
wake and short-lived ticket logic is isolated in the environment resolver.

The hibernatable workspace Durable Object is an opaque byte router. It owns no
chat log, replay queue, or pending-frame buffer. If either side is unavailable,
it returns a typed close so the one client supervisor reconnects and resumes
from the persisted cursor.

## Durability budgets

- Provider adapters emit stable absolute checkpoints. Codex delta events are
  cumulative; ACP providers flush within 50 ms or 4 KiB.
- Session delta catch-up is capped at 512 events or 1 MiB.
- A materialized first snapshot retains a 900 KiB projection budget and older
  messages load through cursor pagination.
- Active client checkpoints persist every 100–250 ms or 16 accepted events,
  plus immediately at synchronization and turn settlement.
- Archive quiesces new work, requests a final encrypted R2 transcript
  checkpoint, and pauses the same cloud sandbox for 30 days. R2 is a read-only
  transcript projection; the paused sandbox remains the complete filesystem
  until unarchive or permanent deletion. Recovery images and staging restores
  are intentionally deferred.

## Architectural enforcement

`bun run check:architecture` ratchets renderer raw-RPC and stream ownership,
unqualified resource keys, cloud-specific session pipelines, SessionDomain
bypasses, and Relay message-content schemas. New behavior must move those
counts toward zero; it may not introduce a new parallel path.
