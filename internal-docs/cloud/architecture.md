# Cloud architecture

Zuse Cloud separates durable workspace execution from client presence. A
workspace can continue an accepted turn with no connected client, while a
returning client can render cached state before compute is resumed.

## End-to-end shape

```text
desktop / mobile
  | WorkOS identity, lifecycle commands, tickets, checkpoint reads
  v
API Worker ---- Postgres (catalog, lifecycle, receipts, billing metadata)
	|       |
	|       +---- R2 (encrypted read-only transcript projections)
	|       +---- account CloudAuthAuthority (sole reusable credential owner)
	|
	+---- WorkspaceMailbox Durable Object (encrypted command coordination)
	|                       |
	|                       +---- wake / runtime lease / encrypted receipt
	|
	+---- WorkspaceGateway Durable Object (opaque live WebSocket routing)
                         |
                         v
                 workspace runtime in E2B
                         |
                         +---- SQLite (session authority)
                         +---- repository and worktree
                         +---- PTYs and provider processes
```

There are two distinct planes:

- The control plane handles identity, authorization, workspace lifecycle,
  placement, short-lived connection tickets, catalog summaries, transcript
  checkpoint pointers, and billing.
- The data plane handles commands and runtime output. Eligible cloud mutations
  are accepted as encrypted envelopes by the stable workspace mailbox before
  compute wakes. The runtime leases them and commits through `SessionDomain`;
  live-only operations still travel through the gateway. API does not replicate
  command plaintext or writable transcript state into Postgres.

The only pre-runtime content exception is the encrypted, expiring launch
intent. It lets an initial prompt survive the interval between workspace
creation and runtime enrollment. The runtime consumes it through the normal
idempotent command path and Api removes it only after receipt.

The public automation API has one additional, deliberately narrow exception:
an account-authorized, row-bound encrypted command outbox and content-bounded
result ledger for the workspace's initial session. These rows are delivery receipts
and reply excerpts for polling/webhooks, not the authoritative chat transcript.
Workspace-scoped automation assets are sealed in object storage rather than
Postgres; only the authenticated owning runtime can materialize them into its
normal `.context/files/` attachment path.
The runtime still commits every accepted command through `SessionDomain`, and a
stable command/turn id ties each Api receipt to exactly one domain turn.
Api commits the assistant excerpt, compact turn receipt, and eligible webhook
delivery rows atomically. Exact runtime replays repair missing delivery rows;
replays whose canonical event digest differs are rejected without mutation.
Terminal message ciphertext is pruned after the retention window once it falls
outside the newest 1,000 rows. Compact turn receipts and payload-scrubbed
webhook tombstones remain until their workspace or endpoint is deleted because
runtimes deliberately replay the durable domain log from zero after restart.
This bounds retained content bytes, not receipt-row cardinality; operations must
monitor those compact tables as automation volume grows.

## Component responsibilities

| Component | Owns | Must not own |
| --- | --- | --- |
| ClientBus | Qualified cached projections, resource leases, command outbox, one connection supervisor per environment | Server authority, feature-specific sockets, inferred active environment |
| API Worker | WorkOS/API-key auth, beta authorization, lifecycle, catalog, tickets, checkpoint metadata, billing, sealed public-automation outbox | Canonical transcript content, file state, terminal output |
| CloudAuthAuthority | Account-level provider credentials, serialized Codex/Grok refresh, provider-bound grant sealing | Workspace session state, per-chat credential copies |
| Postgres | Control-plane records, command receipts, lifecycle revisions, immutable billing ledger, content-bounded sealed public-automation receipts | Authoritative or interactive chat projection |
| WorkspaceGateway Durable Object | Authenticated live attachments and opaque frame forwarding | Replay log, transcript, pending command buffer |
| WorkspaceMailbox Durable Object | Encrypted command envelopes, ordering, leases, lifecycle status, encrypted terminal results | Command plaintext, transcript projection, provider state |
| Workspace runtime | Provider process, `SessionDomain`, SQLite, repository, Git, PTYs, checkpoint production | Account policy or billing decisions |
| R2 | Encrypted immutable transcript checkpoints and older pages | Commands, files, Git, terminal state, plaintext keys |
| E2B | Isolated compute and paused workspace storage | Zuse identity or transcript semantics |

## One session path

```text
provider checkpoint or client command
  -> SessionDomain transaction
  -> SQLite event log, projection, cursor, and command receipt
  -> ordered post-commit publication
  -> bounded runtime synchronization
  -> SessionTimelineResource in ClientBus
  -> sidebar, chat, queue, and status selectors
```

The SQL projector and client use the same domain timeline semantics. A repeated
command ID returns the recorded receipt; a repeated provider item revision
upserts the same message. The WebSocket is a delivery optimization, not the
record of truth.

Files, Git, reviews, and terminals share the environment connection supervisor
and resource-state vocabulary but keep typed resource adapters. Terminal bytes
go directly to the retained terminal sink; only lifecycle, process epoch,
sequence, and gaps enter canonical state.

## Client architecture

Each retained environment has one `EnvironmentRuntime`:

- one resolver and connection generation;
- one ticket/wake single-flight;
- one supervised retry policy;
- keyed controllers for shell, timeline, files, Git, review, and terminal;
- one serialized reducer input path; and
- one platform persistence adapter.

Several UI surfaces can retain the same resource without opening competing
streams. Resource data survives transport failure. A skeleton is valid only
when no cached or runtime data exists.

Cloud-specific behavior ends at the ClientBus transport boundary. Eligible
cloud commands use the mailbox without waiting for a runtime; local, SSH, and
live-only commands retain wake-and-RPC behavior. All environments keep the same
resource ownership model.

The first rollout enables text message sends. Messages that reference newly
uploaded attachments retain the live path until command-owned encrypted R2
staging is enabled, so the mailbox never accepts a dependency it cannot recover.
The shared eligibility registry records the required recovery strategy for the
remaining command families before each family is advertised.

## Project preparation and placement

A cloud project may prepare a sanitized provider snapshot to make workspace
startup faster. The builder clones a bare repository mirror and removes
credentials, runtime identity, authorized keys, and shell history before
publishing the snapshot. It does not install project dependencies or run
untrusted repository setup.

A new workspace forks a compatible prepared snapshot when possible. Otherwise
it starts from the current reviewed base template and performs the normal
authenticated clone. Snapshot failure affects startup speed, not workspace
availability. Provider-specific template identifiers stay inside the E2B
adapter; the user-facing sandbox offer remains provider-neutral.

## Version compatibility

The base template and runtime are built from an exact release commit. Template
versions and protocol versions are immutable configuration inputs. New
workspaces use the current template. Existing workspaces enroll with their
runtime generation; stale generations cannot overwrite newer lifecycle or
checkpoint state.

Runtime update channels are signed and checksum-verified. A client or runtime
outside the supported protocol window receives `update-required` rather than
silently using a partially compatible path. Lifecycle reconciliation may
repair or update an existing sandbox; client components never deploy code into
one directly.

## Public API delivery implementation

- The api is the durable queue: messages and webhook deliveries are Postgres
  rows; the workspace gateway only nudges the runtime that work is waiting.
- The runtime pulls pending commands, injects them idempotently, and acks;
  a missed nudge is recovered on gateway reconnect and by the cron sweep.
- Message content, attachment bytes, webhook payloads, and webhook secrets are sealed at rest
  with the api data-encryption key, bound to their owning account and row.
