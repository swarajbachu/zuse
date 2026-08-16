# Cloud lifecycle

Relay owns cloud lifecycle as a revisioned desired-state machine. Routes record
intent; a leased reconciler performs provider operations and commits observed
state with compare-and-set protection. Retrying a request cannot create a
second workspace transition.

## Project and workspace are different resources

A cloud project describes repository access and optional prepared build state.
A cloud workspace is one interactive, isolated checkout created for a chat or
task. Preparing a project can improve startup time, but a workspace can still
start by cloning normally when no compatible prepared snapshot exists.

The provider's sandbox is an implementation detail of the workspace placement.
“Builder” means a temporary sandbox used to prepare a sanitized project
snapshot. It is not the user's workspace and contains no agent credential or
chat history.

## State vocabulary

The durable observed workspace states are:

| State | Meaning |
| --- | --- |
| `queued` | Accepted and waiting for reconciliation |
| `provisioning` | Allocating provider compute |
| `setup` | Bootstrapping identity, repository, and runtime |
| `ready` | Workspace exists and can be online or paused |
| `pausing` | Quiescing and asking the provider to pause |
| `paused` | Provider compute is stopped; workspace storage is retained |
| `resuming` | Resuming the same provider sandbox and runtime generation flow |
| `archiving` | Settling work, checkpointing, and pausing for trash retention |
| `archived` | Hidden from active chats and retained for the archive window |
| `deleting` | Permanently removing provider and transcript resources |
| `deleted` | Content is gone; only a temporary tombstone remains |
| `failed` | Reconciliation reached an actionable failure state |

Desired states are smaller: `ready`, `paused`, `archived`, and `deleted`.
Observed state may pass through intermediate states while converging on the
desired state.

Startup exposes stable phases for user feedback: allocating, booting,
authenticating the runtime, syncing the repository, starting the agent, and
running. Runtime connectivity is separately offline, connecting, or online. A
running agent does not change a healthy cloud icon from online to reconnecting.

## Create and start

1. Relay authenticates the WorkOS account and checks private-beta access.
2. The client sends a stable workspace and command identity.
3. Relay records the workspace request and encrypted launch intent atomically.
4. The reconciler chooses the provider adapter and compatible project snapshot.
5. E2B allocates the sandbox and starts bootstrap with a one-time token.
6. The runtime registers its signing and encryption keys, receives scoped
   credentials, prepares the worktree, and consumes the launch command.
7. The runtime records the command receipt in SQLite and reports a monotonic
   summary to Relay.

Agent execution begins only after worktree setup is complete. A client closing
after acceptance does not interrupt the runtime consumer.

## View, connect, and wake

Viewing a cloud chat does not imply compute:

- `cache-only` reads local persistence.
- `sync` reads catalog metadata and a newer R2 checkpoint without waking E2B.
- `connect` attaches only when the runtime is already online.
- `wake` resumes or creates compute, then attaches.

Opening a paused or archived transcript uses cache/R2. Sending a message,
cancelling, changing a queue, or opening an interactive file/Git/review/terminal
resource requests `wake`. Resume is single-flight for all surfaces.

## Pause and resume

Pause quiesces new work, attempts a bounded final transcript checkpoint, records
provider usage, and pauses the same E2B sandbox. Checkpoint upload failure does
not destroy the authoritative SQLite database or block pause; the cloud copy is
marked stale and retried when the runtime next runs.

Resume reuses the same sandbox ID. Relay fences the prior connection generation,
issues fresh short-lived credentials, and waits for runtime enrollment. The
client keeps cached data visible throughout.

## Archive is 30-day trash

Archive is not a recovery-image operation and does not copy a complete machine.
It is an idempotent lifecycle command with immediate optimistic UI behavior:

1. The client persists the archive intent and removes the chat from Active.
2. Relay records `archiveRequestedAt` and a deletion deadline 30 days later.
3. Active work is stopped gracefully and its latest partial transcript is
   committed.
4. The runtime attempts a final encrypted R2 checkpoint.
5. Relay pauses the same E2B sandbox and marks the workspace archived.

Catalog refresh cannot return a pending archive to Active. A retriable failure
stays in Archives and retries; a definitive rejection restores the row with one
error. The archived transcript remains readable from local persistence or R2.

Unarchive cancels the deletion deadline and returns the chat to Active without
resuming compute. The first interactive action resumes the same paused sandbox.
Re-archiving creates a fresh 30-day deadline.

At the deadline, or on manual Delete, reconciliation idempotently kills the
sandbox, deletes all workspace R2 objects, revokes runtime secrets and tickets,
removes checkpoint and launch metadata, and marks the workspace deleted. A
content-free tombstone remains for another 30 days so offline devices can
remove local caches and outbox entries.

There is currently no recovery image, staging restore sandbox, or warm fallback
sandbox. During the archive window the paused E2B sandbox preserves the full
filesystem; R2 preserves the transcript projection only.

## Reconciliation and failure rules

- Every lifecycle write carries an expected revision and lease owner.
- Older runtime generations and summary revisions cannot overwrite newer ones.
- Create, resume, archive, unarchive, and delete commands are idempotent.
- Provider timeouts retry with capped backoff and jitter under one reconciler.
- Webhooks and provider polling can report the same execution; immutable
  finalization keys ensure it is billed once.
- A failed archive or checkpoint never deletes the last authoritative sandbox.
- Revoking beta access blocks new hosted operations and reconnects, while an
  already accepted runtime turn may settle through internal callbacks.
