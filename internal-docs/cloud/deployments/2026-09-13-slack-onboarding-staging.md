# Slack onboarding staging deployment

Status: deployed; database and HTTP smoke checks verified. A live two-user Slack
sign-in, repository-modal and agent-result test is still required. Production was
not changed. No merge, commit, branch deletion or desktop release was performed.

## Deployment

- Origin: `https://api-staging.zuse.sh`
- Worker: `zuse-relay-staging`
- Active version: `77457eba-61c1-4e1d-a2da-7556b6407c41`, confirmed at 100% traffic.
- Activated: `2026-09-13T14:18:14.435Z`.
- Previous version: `0f7c2994-f825-40cf-a56c-a806da7f2888`.
- Branch: `swarajbachu/untitled-v7`, including the reviewed uncommitted changes.
- HEAD: `268324dd739f6b7e9a5bde26fb6f588c88aeed24`.
- Tested source SHA-256: `38d3360ec171239e7662d20ae8a35c940c6a71cbe5f96a172445fbb308bf55f8`.
  Includes sorted paths and contents of `apps/slack/src`, `infra/api/src`, API
  migration files, both package manifests, staging Wrangler config and lockfile,
  with NUL separators. All 130 files matched the Mac mirror before deployment.
- Command: `bunx wrangler deploy --config infra/api/wrangler.jsonc --env=` from
  the repository root on the authenticated Mac. Frozen dependency install passed.
- Bundle: 4354.45 KiB, gzip 715.93 KiB; reported Worker startup 380 ms.
- Slack enabled; existing staging queue producer/consumer bindings preserved.

## Database

Verified staging Hyperdrive `dfc67e0586ff4c288cb645ed63c65d9a` points to
`db.yzawvredrbpcwbzdnxsu.supabase.co/postgres`. No database password was exported.

Applied only additive migration `0023_slack_members` through a five-minute,
authenticated temporary Worker. Transaction guarded by exact 0022 ledger
hash/timestamp, exclusive migration-ledger lock, 5-second lock timeout and
20-second statement timeout. Verified all six member-table columns and the final
ledger entry after commit. No existing application data was deleted.

- Baseline hash: `211b7b0e349c24e75e2ad4d9da1c64bea6d4c3d3b2678b37c41c65258d74d5e3`.
- 0023 hash: `a2c422b788c3b62bf50cf4e26dd1ac95a0a67a95251ec26e2bf82cb3d193ddb1`.
- 0023 ledger timestamp: `1789304400000`.
- Temporary helper `zuse-slack-members-migrate-20260913` deleted in cleanup;
  Cloudflare lookup confirmed 404. Local temporary helper source was removed too.

## Verification

- Fresh 406 API tests and 19 Slack client tests passed (425 total).
- Both TypeScript checks passed; Biome passed across 33 applicable files.
- `git diff --check` passed.
- `GET /slack`: 200, app landing page.
- `GET /slack/install`: 303, Slack OAuth with the correct staging callback.
- Unauthenticated `GET /slack/setup`: 401, new Connect from Slack page.
- Invalid one-use token on `GET /slack/account/connect`: 401, connection expired.
- Unsigned `POST /slack/events` and `/slack/interactions`: 401.
- Unauthenticated `GET /v1/api/projects`: 401, missing API key.
- HTTP checks took 0.3–2.4 seconds each. These are endpoint smoke checks, not proof
  of authenticated Slack execution or native loading-animation rendering.

Reopen App Home for new controls. Legacy installations stay installer-only until
the installer explicitly selects another mode. See the
[operator checklist](../slack-app-operations.md#upgrading-an-existing-staging-installation).

Rollback, if authorized, restores the previous Worker version above. Retain the
additive member table and migration ledger; do not drop them during rollback.
