# Cloud workspace user guide

Zuse Cloud lets an invited user run a coding agent in a hosted workspace that
continues independently of the app. It is a private beta; installing Zuse does
not automatically grant cloud access.

## Before you start

You need:

- a Zuse account authenticated through WorkOS;
- an invitation to the Zuse Cloud beta;
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
Generated dependency and cache directories such as `node_modules` are not
copied from cloud; install or generate them locally when needed.

The local checkout is a one-way, remote-authoritative mirror. Local edits are
not uploaded and may be overwritten by the next sync. Zuse stops the transfer
when the environment disconnects, keeps the enabled preference, and prepares
fresh access before syncing again after reconnect.

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

### Invite required

The signed-in account is not currently in the private beta. Local and remote
features remain available. Changing a client flag cannot grant access.

### Access verification unavailable

Zuse could not verify the server-side beta flag. Cached cloud transcripts
remain readable, but new hosted actions fail closed until verification returns.
This should not sign the account out.

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
