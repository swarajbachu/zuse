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
   inspected or imported. Codex and Grok device login run in the E2B setup
   environment. Claude setup tokens/API keys and Cursor API keys are sealed to
   that environment. A successful real CLI status check is required before the
   state is included in the account image.
5. Provider-owned subscription state and the restricted account-image secret
   store may be present in this private snapshot. Provider CLIs own refresh in
   each fork. Zuse does not synchronize refresh files between chats. Terminal
   authentication failure marks the image/provider `auth-broken` and directs
   the user to rebuild; it does not log out WorkOS or reconnect the sandbox.
6. GitHub is the exception: users install the Zuse GitHub App and grant selected
   repositories. Relay retains only installation metadata and mints short-lived
   installation access tokens when needed. These tokens are never baked into
   the image. Image builds receive a transient `GIT_ASKPASS` grant for checkout
   synchronization. The main image permanently preconfigures Git and `gh` with
   a credential broker; chat sandboxes lazily mint and cache a short-lived grant
   only when a GitHub command runs, then refresh it on demand.
7. Normal create/resume has a p95 target below five seconds from user action to
   gateway connected and repository ready. Agent startup and explicit image
   builds are outside that setup SLO. Phase timestamps are retained for pool
   claim/fork, runtime connection, repository readiness, agent start, and first
   message acceptance.
8. Relay placement follows the regional control-plane database. Cloud workspace
   lifecycle requests contain several ordered writes, so running the Worker near
   users or E2B while Postgres is remote compounds network latency. Staging pins
   Relay to the database's AWS Singapore region; each deployment must configure
   the equivalent database-local placement.

## Consequences

- Adding a repository or changing runtime/toolchain/authentication marks the
  account image outdated and requires one update, not another project image.
- Repository freshness is controlled by image update. There is intentionally no
  slow clone/fetch fallback when a repository is absent from the active image.
- Credential duplication can eventually invalidate provider-native state. The
  supported recovery is an explicit clean rebuild with a clear explanation.
- During atomic replacement a candidate snapshot may coexist briefly with the
  active snapshot. This is not a second maintained user image.

## Rejected alternatives

- One image per repository or compute provider.
- Importing local credential files, Keychain values, or refresh tokens.
- Per-chat provider login.
- A cross-sandbox refresh-token synchronization protocol.
- Runtime downloads or network repository fetches on the normal launch path.
