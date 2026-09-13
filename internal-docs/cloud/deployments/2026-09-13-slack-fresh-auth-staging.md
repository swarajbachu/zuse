# Slack fresh authentication staging deployment

Status: DONE_WITH_CONCERNS. Staging deployment and HTTP smoke checks passed; authenticated provider account switching still needs a live user check.

- Target: `zuse-relay-staging`, `https://api-staging.zuse.sh`.
- Active version: `9985fd0e-2f8a-48d7-809a-1790327044ed`, 100% traffic.
- Activated: `2026-09-13T20:02:55.619Z`.
- Previous version: `33ab5996-1ee0-42e2-89f3-aa8cc150b6c1`.
- Source fingerprint: `1e479f45fd73cfee3285e47e163b36c0320e84d041d622f93dc09a8c5f0dbb97` across 221 deployment input files, matching sandbox and Mac mirror before deployment.
- Published using `bunx wrangler deploy --config infra/api/wrangler.jsonc --env=` after a successful dry run.
- Bundle: 4374.25 KiB, gzip 720.66 KiB; Worker startup: 356 ms.
- No database migration, production deployment, merge, or push performed.

## Change

The shared Slack account sign-in flow now requests `prompt=login`, `max_age=0`, and `screen_hint=sign-in` for every new account authorization. This includes reconnecting after disconnecting in Slack Home, not only browser logout.

## Verification

Before this deployment, the fix passed Biome (31 files), Slack and API type checks, 34 Slack tests, and 431 API tests. `git diff --check` passed again before publishing.

All nine post-deploy HTTP smoke checks passed:

- `GET /slack`: 200, Zuse content, `Referrer-Policy: same-origin`.
- `GET /slack/install`: 303 to Slack with the staging callback origin.
- `GET /slack/setup`: 401, `Referrer-Policy: same-origin`.
- `GET /slack/account/connect?token=invalid`: 401.
- `GET /slack/account/logout`: 405.
- Unauthenticated same-origin `POST /slack/account/logout`: 401.
- Unsigned `POST /slack/events` and `POST /slack/interactions`: 401.
- Unauthenticated `GET /v1/api/projects`: 401.

## Remaining live verification

Disconnect from Zuse in Slack Home and open a new connection link. Verify fresh authentication and complete sign-in with the intended account. Upstream identity-provider account selection was not exercised during deployment; HTTP checks do not establish authenticated end-to-end Slack agent execution.
