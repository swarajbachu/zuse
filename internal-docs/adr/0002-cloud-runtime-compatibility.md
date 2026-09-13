# ADR 0002: Runtime updates preserve existing cloud sandboxes

- Status: Accepted
- Date: 2026-08-21

## Context

An account-image update changes the starting point for new E2B sandboxes. It
must not replace an existing chat sandbox: that sandbox owns the chat's live
filesystem, provider-native authentication state, and authoritative SQLite
database. Relay and the desktop can also be released while older paused
sandboxes still contain an earlier runtime and gateway protocol.

Treating an image-generation mismatch as a failed workspace previously risked
destroying that state. Requiring every old sandbox to run the newest protocol
would instead turn an ordinary desktop or Relay release into a reconnect loop.

## Decision

1. **Images affect new chats only.** An account-image promotion is atomic, and
   new sandboxes use the promoted generation. Existing sandboxes retain their
   original image generation and sandbox ID until explicit deletion.
2. **Resume is always in place.** Pause, resume, runtime recovery, archive, and
   unarchive operate on the existing E2B sandbox. Relay may allocate a new
   sandbox only after the provider confirms that the recorded sandbox no longer
   exists. A timeout, stale gateway socket, protocol difference, or outdated
   account image is not proof that the sandbox is gone.
3. **Gateway framing and runtime RPC compatibility are distinct.** Relay accepts
   `zuse-workspace-v2` plus legacy `zuse-workspace-v1` gateway envelopes, but it
   does not translate Effect RPC schemas. When a retained sandbox has an
   incompatible runtime wire version, resume installs the signed compatible
   runtime in place before attaching the desktop. Normal resumes read local
   runtime metadata and skip the updater entirely.
4. **Compatible runtime updates are transactional.** Before an in-place update,
   the runtime commits SQLite and attempts an encrypted transcript checkpoint.
   It downloads a signed, checksummed artifact into a versioned release
   directory, keeps the previous release, atomically changes
   `/opt/zuse/current`, increments the fenced runtime generation, and restarts.
   Relay marks the update successful only after enrollment and a health
   handshake. Failure swaps the previous release back and restarts it; chat
   state and the sandbox remain intact.
5. **Incompatible updates are not automatic.** A major protocol or storage
   migration needs its own tested durable migration before the compatibility
   bridge can be removed. Until then Relay continues supporting the old runtime
   or reports one explicit update-required state. It never rebuilds an existing
   chat from the current account image.
6. **Release order protects the window.** Publish and verify the immutable
   runtime artifact first, deploy backward-compatible Relay second, publish the
   account image third, and remove old-protocol support only after telemetry
   shows no retained sandbox requires it and the migration window has ended.

## Performance and failure rules

- A normal resume does not download a runtime, fetch Git, change image
  generation, or create a checkout. It resumes E2B, starts the installed
  runtime if its socket was not preserved, and attaches the gateway.
- The resume SLO is p95 below five seconds; create/open from a ready account
  image is p95 below ten seconds while the cold-fork path is being optimized.
- A browser's pre-handshake `1006` may represent Relay's private
  runtime-unavailable close. Before a connection has ever become healthy, the
  renderer enters the one idempotent in-place runtime-recovery command
  immediately. Established connections retain one retry for transient network
  loss.
- Auth failure, runtime failure, WorkOS session failure, provider lifecycle,
  and gateway connectivity remain independent states.

## Required verification

- Exercise create, pause, resume, archive, unarchive, and delete against E2B.
- Resume both current and previous protocol runtimes through the same current
  desktop and Relay.
- Prove failed update health checks roll back the binary without changing the
  sandbox ID, image generation, SQLite database, or transcript checkpoint.
- Assert that generation mismatch and runtime timeout never call provider kill.
- Retain phase timestamps for E2B allocation/resume, runtime connection,
  repository readiness, gateway attachment, and message acceptance.

## Rejected alternatives

- Replacing old chat sandboxes when the account image changes.
- Downloading or installing a runtime on every resume.
- Retrying an unavailable gateway indefinitely.
- Removing a protocol bridge before existing sandboxes have a durable migration.
