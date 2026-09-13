# Slack account switching and picker staging deployment

Status: DONE_WITH_CONCERNS. Staging deployed and nine HTTP checks passed.
Authenticated account switching and actual agent execution still need a live user
test. Production was untouched. Applied the deployment and careful safety skills
to staging only, without merging or publishing a release.

## Deployment

- Origin: `https://api-staging.zuse.sh`; Worker: `zuse-relay-staging`.
- Version: `6291a485-9ffe-4a2f-b6d3-6bf87f90cb65`, confirmed at 100% traffic.
- Activated: `2026-09-13T19:44:23.856Z`.
- Previous version: `ea24b28e-574e-4ac6-a4f6-c60b5a1aa9e6`.
- Source SHA-256: `7ab61391d7c3cc42d9bceb8b183878360a0492bbb5a4cbb81104a34940e4256c`.
  All 221 files matched the authenticated Mac mirror. Fingerprint covers sorted
  paths and contents in Slack source, API source and migrations, contracts source,
  utils source, their four package manifests, API Wrangler config and bun.lock,
  with NUL separators.
- Frozen install and Wrangler dry-run passed.
- Bundle: 4374.03 KiB, gzip 720.55 KiB; startup: 376 ms.
- No database migration required or applied.

## Included

- Unified Configure request modal with repository and agent/model controls.
- Native-first loading, text fallback, and removal of obsolete preparation cards.
- Shared callback stamp renderer and protected member logout/account switching.
- Existing error diagnostics retained; the underlying live agent failure remains
  unconfirmed. Selecting an agent does not authenticate its provider.

## Verification

- API: 430 tests; Slack: 34 tests; utils: 45 tests. All passed.
- All three type checks, Biome (34 files), and diff whitespace check passed.
- HTTP GET Slack landing: 200; install: 303 with staging callback.
- GET setup, invalid connect token and unauthenticated projects: 401.
- Unsigned events and interactions: 401.
- GET logout: 405; same-origin unauthenticated POST logout: 401.
- Prior local desktop/mobile visual checks passed with 28px controls and no
  horizontal overflow. Browser audit reported zero violations, with two decorative
  microtext contrast checks requiring manual review. No authenticated live browser
  connection was used during deployment, and no user was logged out.

Old consumed callback URLs cannot mint new logout controls. Start from a fresh
private Slack connection link, or disconnect directly in Zuse's Slack Home tab.
Test switching accounts, then send a fresh request and choose a ready repository
and an agent whose provider credentials are connected to that account.
