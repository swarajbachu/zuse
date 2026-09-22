# Cloud runtime data recovery

Read this before changing `ZUSE_USER_DATA`, bootstrap scripts, or cloud resume
and recovery behavior. Applies to existing Boat and E2B workspaces. See also
[ADR 0002](../adr/0002-cloud-runtime-compatibility.md).

## Incident: an existing chat looked missing

On 2026-09-22, a runtime path change selected `/var/lib/zuse/user-data` while
an existing Boat chat's authoritative database remained at
`/srv/zuse/home/.zuse-data/zuse.sqlite`. The runtime initialized an empty
database at the new location and reported `runtime-storage-replaced`.
The original chat and session were still present. Reconnecting the runtime
to the original data restored the queued message without recreating the chat.

Machine readiness, a successful resume response, and a database file's existence
do not establish that the correct chat has resumed.

## Required checks before changing a data path

1. Identify the workspace, sandbox, chat ID, and session ID. Inspect the
   effective runtime environment, launch scripts, symlinks, ownership, and
   mounted filesystems. Do not print tokens or entire process environments.
2. Locate the existing authoritative database. Known locations include
   `/home/zuse/.zuse-data/zuse.sqlite`, its Boat backing path
   `/srv/zuse/home/.zuse-data/zuse.sqlite`, and
   `/var/lib/zuse/user-data/zuse.sqlite`. These are investigation candidates,
   not a rule to pick the first file or the largest file.
3. Open candidates read-only. Verify the expected IDs in `chats` and `sessions`
   and run SQLite integrity checks. An empty new database does not prove the
   original data was lost. Check provider session state and related files too.
4. If both locations contain distinct user data, stop automatic migration.
   Preserve both and investigate; never overwrite one with the other.
5. Define migration and rollback before deploying a path change. A fresh
   sandbox test alone is insufficient: test upgrading and resuming an existing
   sandbox containing chats, queued messages, and provider sessions.

## Recovery rules

- Coordinate with lifecycle recovery so there is only one writer. Stop the
  affected runtime before switching its storage. Do not interrupt unrelated
  running workspaces.
- Preserve the original database and destination as recoverable backups.
  Include WAL state: use SQLite's backup mechanism for live copies, or a
  verified stopped-writer copy including the necessary sidecars. Never copy
  only a live `.sqlite` file and discard its WAL.
- Restore the whole required runtime state, not just message rows. Preserve
  provider session files, repository changes, and credential-file permissions.
- A verified path alias can recover a specific existing workspace; it is not
  a substitute for a tested migration policy for all deployments.
- Do not delete/recreate the sandbox, reset SQLite, force-stop without saving,
  or resend a queued prompt to hide a recovery failure.
- Use the provider's shared disk-readiness and path-restoration logic before
  starting the runtime. Boat may have started its host before the required
  paths are usable.

## Verification before saying “resumed”

Verify the original chat/session IDs are still present, the API reports the
current runtime online, and the runtime accepted the existing queued command.
Check actual session progress and client delivery, not just a green cloud icon.
Check that old failure diagnostics no longer block sending or mislead the UI.
Report any remaining warning or unverified step explicitly.

For code changes, run applicable Biome checks, types, and behavior tests. Cover
fresh startup, an older populated data directory, interrupted migration,
pause/resume, and retry without duplicate prompt execution.

This runbook is an agent/operator check, not an automatic migration or a
guarantee against recurrence.
