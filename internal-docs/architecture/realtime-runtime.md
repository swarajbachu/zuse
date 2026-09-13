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
| Workspace lifecycle, identity, tickets, encrypted launch intent, encrypted command mailbox coordination, sealed public-automation delivery receipts | API control plane |
| Cached client projection and safe command outbox | Platform client persistence |

The API catalog carries only last-known metadata for discovery. It never
becomes the authority for interactive transcript events or client commands.
Encrypted launch intents and the durable mailbox bridge client commands to runtime enrollment.
The public automation API also maintains a content-bounded, row-bound encrypted
outbox and reply-excerpt ledger so machine callers can survive paused runtimes and
poll or receive webhooks. Both paths use stable domain command and turn IDs;
the workspace runtime consumes them through `SessionDomain`, which remains the
only transcript and execution authority. Sealed workspace-scoped automation
assets live in object storage and become ordinary runtime attachments only
after authenticated materialization. Full message payloads are retained on
a bounded horizon; compact idempotency receipts and scrubbed delivery
tombstones remain for restart replay until the owning workspace/endpoint is
deleted, so this boundary is content-bounded rather than row-count-bounded.

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

The epoch-scoped WorkspaceGateway Durable Object remains an opaque byte router
with no replay buffer. The stable WorkspaceMailbox Durable Object separately
owns encrypted command delivery, lane ordering, leases, and receipts. A sleeping
runtime therefore delays application rather than turning an accepted message
into a connection failure.

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
bypasses, and Api message-content schemas. Its named public-automation
exception is limited to the sealed outbox/receipt implementation; new behavior
must not turn that delivery view into a second execution authority.
