# Slack diagnostics staging deployment

Status: DONE_WITH_CONCERNS. Deployment and HTTP checks passed; the actual
selected-agent failure still requires a live reproduction. Production untouched.
Applied the land-and-deploy verification and careful safety workflow to staging
only, without merging or creating a release.

## Deployment

- Worker: `zuse-relay-staging`, origin `https://api-staging.zuse.sh`.
- Active version: `ea24b28e-574e-4ac6-a4f6-c60b5a1aa9e6`, 100% traffic.
- Activated: `2026-09-13T16:30:08.658Z`.
- Previous version: `f252acaa-2c4a-4aa4-b76b-bddbf82d5e85`.
- Source SHA-256: `bf11c4b02393a4d52b3d20930d06ef7e363f5aaf26e0721cb4ae61bc84ecb730`.
  All 203 deployment source files matched the authenticated Mac mirror, using
  the fingerprint scope documented in the agent-picker deployment record.
- Frozen install and Wrangler dry-run passed; bundle 4368.75 KiB, gzip 719.39 KiB.
- No database migration required or applied.

## Changes and verification

Structured failure diagnostics include operation, HTTP status, validated error
code and retry classification. They exclude raw error messages, stacks, response
bodies, prompts, headers and URLs. Unrecognized code formats fall back to an
unclassified marker. Existing job identifiers remain available for correlation.

Also includes the pending thread-status cleanup fix: transient failures clearing
the native working indicator are retried, with version checks preventing old
cleanup jobs from clearing a newer task's status.

- Slack: 34 tests passed; API: 425 tests passed.
- Both TypeScript checks, Biome and `git diff --check` passed.
- GET `/slack`: 200 with Zuse content.
- GET `/slack/install`: 303 to Slack with the staging callback origin.
- GET `/slack/setup`, invalid account-connect token, and unauthenticated
  GET `/v1/api/projects`: 401 each.
- Unsigned POST `/slack/events` and `/slack/interactions`: 401 each.

## Remaining verification

Reproduce the original request with the same agent/model while capturing live
Worker logs. Historical Observability queries were denied by the current token;
do not claim the agent failure is fixed based on unit tests or HTTP checks.
Existing failure cards are not rewritten. An unmentioned channel reply still
requires an existing workspace/thread mapping.
