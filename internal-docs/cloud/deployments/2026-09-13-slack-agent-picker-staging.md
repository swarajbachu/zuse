# Slack agent picker staging deployment

Status: DONE_WITH_CONCERNS. Deployed and HTTP smoke checks passed. Authenticated
Slack agent execution still needs a live user test. Production was not changed.
The land-and-deploy verification steps and careful safety checks were applied to
the explicit staging-only deployment; no merge, commit, release, or branch deletion.

## Deployment

- Origin: `https://api-staging.zuse.sh`.
- Worker: `zuse-relay-staging`.
- Active version: `f252acaa-2c4a-4aa4-b76b-bddbf82d5e85`, confirmed at 100% traffic.
- Activated: `2026-09-13T15:42:27.555Z`.
- Previous/rollback version: `77457eba-61c1-4e1d-a2da-7556b6407c41`.
- Branch: `swarajbachu/untitled-v7`, including tested uncommitted changes.
- HEAD: `268324dd739f6b7e9a5bde26fb6f588c88aeed24`.
- Source SHA-256: `c98f425d6a9e353b11c5bdf0790f1a509a98b9026db461988f5e6808f28a6b3c`.
  All 201 files matched the authenticated Mac mirror before deployment. Hash covers
  sorted paths and contents in `apps/slack/src`, `infra/api/src`, API migrations,
  `packages/contracts/src`, those three package manifests, `infra/api/wrangler.jsonc`,
  and `bun.lock`, with NUL separators.
- Mac command: `bunx wrangler deploy --config infra/api/wrangler.jsonc --env=`.
- Frozen dependency install and Mac deployment dry-run passed.
- Bundle: 4364.34 KiB, gzip 718.36 KiB; Worker startup 402 ms.
- Existing staging custom domains, schedule, queue producer/consumer, Hyperdrive,
  and Slack credentials were preserved. No new migration was required or applied.

## Included behavior

- Sign-in preserves the original task and attachment metadata, then offers a
  private repository picker without requiring another message.
- Missing agent/model defaults offer a private agent/model picker using the shared
  cloud provider contract and curated catalog. Confirmation resumes the same task,
  repository, and images. Notification retries are independent of task execution.
- Expiry, account replacement, policy changes, and duplicate submissions are checked.

## Verification

- API: 420 tests passed across 44 files.
- Slack: 25 tests passed across 2 files.
- Both TypeScript checks passed; Biome checked 31 files; `git diff --check` passed.
- Live GET `/slack`: 200 with Zuse content.
- Live GET `/slack/install`: 303 to Slack with the staging OAuth callback.
- Live GET `/slack/setup`: 401 without a session.
- Live GET `/slack/account/connect?token=invalid`: 401.
- Unsigned POST `/slack/events` and `/slack/interactions`: 401 each.
- Live GET `/v1/api/projects`: 401 without credentials.
- All seven HTTP checks passed in 1.1–2.0 seconds each.

## Remaining live checks and known limits

Send a new `@Zuse` task. If the account lacks agent defaults, choose an agent/model
from the private button and confirm that the original task reaches the agent and
returns a result. Provider cloud credentials still need to be connected in Zuse.
Test sign-in continuation with an unconnected member and an image attachment.

Existing failure messages are not rewritten by deployment. Plain channel replies
without a mention still require a previously created workspace/thread mapping;
the early-thread registration fix has not been implemented or deployed.
No authenticated Slack interaction or live agent run was performed by this deploy.
