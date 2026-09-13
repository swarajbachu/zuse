# Slack conversation app staging deployment

Status: deployed; HTTP smoke checks passed. Live Slack conversation execution is
not yet verified. Production was not deployed, and no database migration ran.

- Worker: `zuse-relay-staging`
- Public origin: `https://api-staging.zuse.sh`
- Version: `0f7c2994-f825-40cf-a56c-a806da7f2888`
- Previous version: `818b2bb2-996a-4640-a228-cc98c23c1060`
- Branch: `swarajbachu/untitled-v7`, including its uncommitted Slack changes.
- HEAD: `268324dd739f6b7e9a5bde26fb6f588c88aeed24`
- Source SHA-256: `a3134f26d749b38949ffd4bbc8c5c69166727e6bd1a381016594ee0fee6919f6`
  (sorted paths and contents under `apps/slack/src` and `infra/api/src`, plus both
  package manifests, staging Wrangler config, and lockfile). Matched between the
  tested sandbox checkout and the Mac deployment mirror.
- Deploy command: `bunx wrangler deploy --config wrangler.jsonc --env=` from `infra/api`.
- Deployment platform: authenticated Mac Cloudflare session; frozen lockfile install.
- Slack remains enabled with the staging jobs producer/consumer and dead-letter queue.

## Verification

- Fresh Biome and TypeScript checks passed for the app and API changes.
- 411 tests passed: 392 API tests and 19 Slack client tests.
- Mac bundle dry-run passed before upload.
- `GET /slack`: 200, contains the app landing page.
- `GET /slack/install`: 303 to Slack OAuth with the expected client ID, staging
  callback, and added `app_mentions:read` / `im:history` scopes.
- Unauthenticated `GET /slack/setup`: 401.
- Unsigned `POST /slack/events` and `/slack/interactions`: 401, invalid signature.
- These checks verify routing and authentication guards, not a real signed Slack
  event, browser sign-in, or agent execution.

## Remaining Slack-side setup

Apply the new events/scopes, enable writable Messages, configure the interaction
URL, and reauthorize the installation as its original installer. Then test a
greeting, bounded repository task, image, and follow-up through completion. See
[upgrade instructions](../slack-app-operations.md#upgrading-an-existing-staging-installation).

Rollback, if needed and authorized, targets the previous Worker version above.
No merge, branch deletion, or desktop release was performed.
