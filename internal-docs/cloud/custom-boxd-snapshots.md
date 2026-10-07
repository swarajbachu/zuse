# Custom Boxd snapshots

## Scope and rollout

Cloud-provider BYOK remains subscription-free, retaining existing encrypted credentials, actor/organization authorization, resource connection pinning, and BYOK billing exclusions. No fee or markup is introduced. Platform-funded compute still requires paid placement access.

`CLOUD_BOXD_CUSTOM_SNAPSHOTS_ENABLED` defaults to false. It controls new imports and the client settings capability. Disable it to stop new configuration imports without changing retained resource lifecycle. Release order:

1. Build and publish the signed cloud runtime and `zuse-snapshot-installer.tar.gz` using the cloud-runtime workflow. Verify the installer archive, signature validation, runtime metadata `snapshotSupportVersion: 1`, and production download URL.
2. Apply migration `0039_cloud_snapshot_import.sql`, then deploy the backward-compatible API/runtime changes.
3. Ship the client, validate on a disposable Boxd snapshot, then enable the flag. Production deployment and publication are separate operations.

Do not enable before testing a real Boxd snapshot. Local fake-provider and shell tests cannot establish Boxd permissions, snapshot provenance support, or validity of copied OAuth credentials.

## Source generations and repository discovery

The installer only accepts `--user`. Home and group come from the operating system. It installs into `/opt/zuse`, `/etc/zuse`, and `/var/lib/zuse`, uses the existing signed updater in install-only/skip-toolchain mode, and creates no enrolled identity or chat database. The credential-free installation manifest is schema version 1.

`cloud.snapshot.import` accepts a connected Boxd key ID, snapshot ID, development user, optional repository paths, and native/managed authentication preferences. Settings updates never require the API key again. Existing `templateId` meaning is unchanged.

An imported generation is an account build record with `settings.source = custom-snapshot`, a nullable `project_id`, pinned provider connection, snapshot version, and explicit discovered repository mappings. The build ID is the configuration revision. The explicit inspection action uses a timed disposable machine and a durable lifecycle, not a background validation allocation. It neither runs the image builder nor sanitizes the user snapshot. Results are persisted before cleanup so reconciliation can finish after a cleanup crash.

Boxd snapshots are versioned latest-only. The API accepts an actual source ID and pins its version. The adapter checks the restored machine's source ID/version before running Zuse preparation; mismatches terminate the child and fail. Users must create a new immutable source generation instead of overwriting a selected snapshot. Managed images retain their prior template compatibility checks; imported sources remain usable across managed runtime releases only with the same pinned connection.

Discovery is bounded and read-only, canonicalizes GitHub identity without returning URL userinfo, and rejects ambiguous duplicate checkouts. It preserves existing project environment configuration. Each new workspace pins runtime user, derived home, absolute checkout path, auth choices, source build, and connection. Later settings changes do not affect retained workspaces. Source snapshots are excluded from image and account deletion.

## Exception to credential-authority architecture

This is an explicit exception to the managed credential-authority architecture documented in ADR 0001. `snapshot-native` is separate from `legacy-image` and `broker-v1`. Native inspection and launch must not create an account auth authority or copy credentials into a broker. Native Claude configuration and Codex account state are reported as detected, not verified. A successful agent turn establishes verified access. Native token expiration is visible, including copied-refresh-token invalidation. No hidden token synchronization is allowed.

The user can explicitly select managed agent accounts for new workspaces. That requires both managed broker enrollment flags and connected accounts. Managed Git selection applies to agent Git and gh through the existing actor-scoped execution broker; SSH origins are mapped to HTTPS only in the execution environment. Default native Git read failures distinguish authentication from network errors. Native Git credentials and author configuration remain intact.

Last-known per-agent access metadata travels in fenced runtime summaries and contains only provider, state, and check time. It does not contain credentials. Status is historical and does not wake a paused machine.

## Durable state and recovery

`cloud-workspace-paths.ts` owns runtime identity, home, checkout, and Zuse SSH paths. Custom SSH keys/configuration live under `/var/lib/zuse/ssh`; user `~/.ssh` is not cleared. Runtime Node is isolated under `/opt/zuse/node` and is selected explicitly without replacing the user's development Node on PATH.

Fresh allocation validates the installer manifest and runtime capability, rejects an inherited Zuse SQLite database without the expected workspace owner marker, and creates a new identity. Interrupted startup with the same owner keeps its database. Resume/restart/update paths preserve authoritative SQLite, including WAL. See [runtime data recovery](runtime-data-recovery.md).

Machine forks retain their existing quarantine/cgroup-stop path. They move the copied database (including WAL) into the fork import area, import the selected conversation, replace the workspace owner, and clear only Zuse-owned SSH state. A base snapshot launch must not be treated as a conversation fork.

Recovery guidance:

- Missing installer or incompatible runtime: install the published bundle on a clean source and create a new snapshot.
- Wrong user/path: correct the UI configuration and inspect again. Do not chown or reset a user's checkout automatically.
- Native login missing/expired: sign in on the affected workspace and retry the failed turn, or choose managed accounts for a new workspace. Never retry a completed launch prompt as a new prompt.
- Git network failure: preserve native credentials and retry after connectivity returns. Read access never establishes push permission.
- Source version replaced: select a new snapshot ID/generation. Never silently launch the replacement under an old workspace configuration.
- Runtime update failure: retain the authoritative database and previous runtime, follow the signed updater rollback path. Never reinstall the snapshot over populated state.

## Required live acceptance before enablement

Use an unsubscribed test account and its own Boxd key. Verify first agent response without an account-image build; native and managed Git/gh; missing/expired agent access; two concurrent OAuth snapshot copies; explicit queued-turn recovery without duplicate execution; arbitrary paths across terminal/files/Git/SSH/desktop sync; staged/untracked preservation; pause/resume/restart; machine forks; installer reruns; interrupted startup; failed update rollback. Verify key disconnection/replacement, organization permissions, no platform usage invoicing, and external snapshot survival after cleanup.
