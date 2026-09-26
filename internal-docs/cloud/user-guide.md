# Cloud workspace user guide

Zuse Cloud lets a signed-in user run a coding agent in a hosted workspace that
continues independently of the app. It is available as a public beta.

## Before you start

You need:

- a Zuse account authenticated through WorkOS;
- an active Cloud Workspace subscription;
- GitHub access to the repository you want to use; and
- credentials for at least one supported coding agent.

Zuse shows repository choices from the connected GitHub account. Selecting or
changing repositories may require Zuse to prepare a new sanitized project
snapshot. That preparation is separate from creating a chat and can take
longer than opening a workspace from an existing compatible snapshot.

Agent credentials are transferred through the cloud credential flow and stored
encrypted. Do not paste them into a chat or commit them to a repository.

## Create a cloud chat

1. Choose Cloud when selecting where the agent should run.
2. Select a connected GitHub repository and branch.
3. Select the coding-agent provider.
4. Send the first message.

Zuse shows the workspace startup steps in the chat body. It allocates compute,
boots the runtime, authenticates it, prepares the repository/worktree, and only
then starts the agent. Closing the app after the command is accepted does not
stop that turn.

The cloud icon indicates workspace location. Provider identity remains in the
chat header and composer. A healthy online workspace is green, a real
provisioning/resume/reconnect is amber, a paused or cached workspace is neutral,
and an actionable failure is red.

## Return after being offline

When the app opens, Zuse first renders its local transcript copy. It then checks
for a newer encrypted cloud checkpoint without waking a paused workspace. If
the runtime is already online, Zuse attaches in the background and applies the
latest bounded snapshot rather than replaying every missed token visually.

This means a large chat should become readable immediately and reach its latest
state quickly. Older messages load only when you scroll upward.

The following labels have distinct meanings:

- Cached or offline means the displayed transcript is valid but may not be the
  newest cloud version.
- Synchronizing means Zuse is applying a newer durable projection.
- Reconnecting means an online runtime lost its live transport and the shared
  supervisor is retrying.
- Resuming means an action required paused compute to start again.

Simply reading a paused chat does not resume compute. Sending a message or
using files, Git, review, terminal, or SSH does.

## Files and terminals

The cloud terminal runs inside the hosted workspace. A local terminal uses the
local synced checkout, normally under `~/.zuse/cloud/<repository>/<branch>`.
File sync follows Git: tracked files and non-ignored untracked files are included,
with nested `.gitignore`, ignore exceptions, and repository-local excludes honored.
Tracked build artifacts are included even if an ignore pattern matches them.
Ignored dependencies, build outputs, and logs stay local to each machine; there is
no framework-specific directory blacklist.

The checkout is a one-way, remote-authoritative mirror. Local edits to managed
files are overwritten. Sync only deletes paths recorded in its ownership manifest;
it preserves unrelated local files, including locally installed dependencies.

An initial scan starts immediately after access is prepared. Subsequent scans run
30 seconds after completion (requests can accelerate this, with a 15-second minimum
between batches). Filesystem activity cannot postpone a scan. Downloads are
content-verified in private staging; only changed files are published. Unchanged
files retain their inode and timestamp, avoiding unnecessary dev-server reloads.
The update is a batch of per-file renames, not a repository-wide atomic snapshot;
watchers may still produce multiple reloads. A persistent ownership journal lets
the next scan repair interrupted publication. Transfer failures leave the live
checkout unchanged and surface an error with bounded retry backoff.

The remote workspace needs Git and Python 3. SSH starts a short-lived helper;
compressed file data downloads through the authenticated workspace gateway.
The Mac needs SSH, not rsync.
See [file sync](file-sync.md) for protocol and recovery details.

Open via SSH uses the managed `ssh zuse-<workspace>` host alias and does not
publish an SSH listener. Dev-server previews open through a private forward on
Mac `localhost`; copying a public E2B preview URL remains a separate action.

Transcript checkpoints do not back up the repository filesystem. While a chat
is active or archived, the E2B sandbox holds its complete workspace. R2 holds
only the encrypted transcript projection.

## Archive and delete

Archive acts like 30-day trash:

- The chat disappears from Active immediately.
- Its transcript remains readable from the local or encrypted cloud copy.
- The same hosted sandbox is paused, not cloned into a recovery image.
- Unarchive cancels deletion and restores the chat without starting compute.
- The first new interactive action resumes the same sandbox.
- After 30 days, Zuse permanently deletes the sandbox and transcript objects.

Delete from Archives skips the remaining retention period and is permanent.
Once deletion finishes, offline devices remove their cached copies when they
receive the deletion tombstone.

## Billing

Cloud Workspace costs $40 per month and includes $35 of attributable sandbox
provider compute cost. Additional provider cost is charged with a 5% markup,
subject to the configured overage cap; the default pre-tax cap is $25.

The cap prevents new billable compute reservations once reached. It does not
disable local, SSH, pairing, or user-managed remote environments. Usage can lag
briefly while provider evidence settles; Zuse reconciles signed lifecycle
events with provider polling so duplicate evidence is not charged twice.

## Common failures

### Cached chat available, connection failed

The transcript cache is intact but the runtime, gateway, ticket, or network is
not currently attached. Retry once after checking connectivity. Repeatedly
opening surfaces should not create additional resume attempts.

### Update required

The app and cloud runtime protocol are incompatible. Update Zuse rather than
retrying or creating another workspace.

### Provider temporarily unavailable

E2B could not complete the requested lifecycle operation. The reconciler
retries safe operations. Existing cached transcripts and non-cloud environments
remain available.
