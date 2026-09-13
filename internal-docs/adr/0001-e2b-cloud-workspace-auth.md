# ADR 0001: Private account image for E2B Cloud Workspaces

- Status: Accepted
- Date: 2026-08-19

## Context

Cloud Workspaces are isolated E2B sandboxes. The previous implementation built
and selected snapshots per repository, imported authentication from the Mac,
and performed runtime updates, credential delivery, repository cloning, and
several Relay/E2B round trips while a user waited for every chat. That model was
slow, made authentication ownership unclear, and multiplied images as users
added projects.

## Decision

1. Each account has one logical private E2B image. It contains the pinned Zuse
   runtime and agent CLIs, shared toolchains, every selected repository as a
   normal checkout under `/home/repos/<owner>/<repository>`, and agent
   authentication created through setup inside E2B.
2. A chat still owns an isolated sandbox. It claims a prewarmed fork of the
   active account image when available, otherwise it forks the same image
   directly. Because the sandbox is already the isolation boundary, it resets
   the requested branch in the included checkout and does not move, copy,
   clone, fetch, or update the runtime on the launch path. The runtime itself
   starts from `/home/zuse` and registers the selected checkout as the project.
3. One active image generation is addressable at a time. Update forks the
   current image; clean rebuild starts from the base/auth setup environment.
   Promotion is atomic. Old snapshots and unclaimed pool sandboxes are deleted;
   already-running chats continue independently.
4. Local Mac and persistent-machine authentication are unrelated and are never
   inspected or imported. Codex and Grok device login run in the account-owned
   E2B authentication authority. Claude setup tokens/API keys and Cursor API
   keys are sealed to that environment. A successful managed-account read is
   required for Codex subscription authentication; `codex login status` alone
   is not considered proof that the token can be used.
5. The authentication authority is the sole owner of reusable provider
   credentials. Broker-capable account images prove that `.codex/auth.json`,
   `.grok/auth.json`, and the legacy provider-secret bundle are absent before
   promotion. A workspace receives only a short-lived grant sealed directly to
   its runtime key. Codex uses app-server external authentication; Grok uses its
   external-provider protocol with the CLI cache isolated in `/dev/shm`; Claude,
   Cursor, and static API-key flows resolve through the same process-memory
   credential seam. API routes only ciphertext. Rotating Codex and Grok refresh
   tokens never leave the authority, refreshes serialize per provider, and
   account-image freshness ignores brokered auth rotation.
6. Existing workspaces retain their immutable `legacy-image` authentication
   mode. New workspaces opt into `broker-v1` only from an image advertising
   `providerAuthDeliveryVersion: 1`; the separate Codex marker remains for
   wire compatibility with retained Codex-broker runtimes. Lost authority
   storage requires one account-level reconnect; it never triggers per-chat
   login or a silent migration.
7. GitHub is the exception: users install the Zuse GitHub App and grant selected
   repositories. Relay retains only installation metadata and mints short-lived
   installation access tokens when needed. These tokens are never baked into
   the image. Image builds receive a transient `GIT_ASKPASS` grant for checkout
   synchronization. The main image permanently preconfigures Git and `gh` with
   a credential broker; chat sandboxes lazily mint and cache a short-lived grant
   only when a GitHub command runs, then refresh it on demand.
8. Normal create/resume has a p95 target below five seconds from user action to
   gateway connected and repository ready. Agent startup and explicit image
   builds are outside that setup SLO. Phase timestamps are retained for pool
   claim/fork, runtime connection, repository readiness, agent start, and first
   message acceptance.
9. Relay placement follows the regional control-plane database. Cloud workspace
   lifecycle requests contain several ordered writes, so running the Worker near
   users or E2B while Postgres is remote compounds network latency. Staging pins
   Relay to the database's AWS Singapore region; each deployment must configure
   the equivalent database-local placement.

## Consequences

- Adding a repository or changing runtime/toolchain/authentication marks the
  account image outdated and requires one update, not another project image.
- Repository freshness is controlled by image update. There is intentionally no
  slow clone/fetch fallback when a repository is absent from the active image.
- Provider-native credentials can still become stale in retained legacy
  images. Brokered recovery is one account reconnect; a legacy chat offers
  creation of a replacement chat.
- During atomic replacement a candidate snapshot may coexist briefly with the
  active snapshot. This is not a second maintained user image.

## Rejected alternatives

- One image per repository or compute provider.
- Importing local credential files, Keychain values, or refresh tokens.
- Per-chat provider login.
- A cross-sandbox refresh-token synchronization protocol.
- Runtime downloads or network repository fetches on the normal launch path.
