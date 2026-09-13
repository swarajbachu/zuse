# Zuse Slack app

One first-party installable Slack app, owned by `apps/slack` and currently hosted
by the existing API Worker. Customers install it, connect an account, select a
repository, and start tasks through mentions or DMs. They can also configure alert
automations. No slash commands or customer-hosted backend are required.

## Customer documentation

See the [Slack user guide](slack-app.md) for installation and
customer-managed automations. The sections below are for Zuse operators.

## Shared backend

`apps/slack` owns application behavior. `infra/api/src/slack` is its adapter to the existing WorkOS verifier,
PostgreSQL/Hyperdrive pool, API data-encryption key, workspace operations, attachment
handling, entitlement checks, idempotency, durable webhooks, and startup/mailbox
coordination. No separate Worker backend, D1 database, customer API keys, or API
loopback requests are needed. Cloudflare Queues runs jobs in the same API Worker.
Signed result deliveries use the same durable outbox but invoke Slack's receiver
internally. Public webhook registration still rejects callbacks to the API itself.
Keep `SLACK_PUBLIC_ORIGIN` configured when disabling Slack so pending result
deliveries remain retryable. Disabling is not a queue pause: exhausted jobs still
require dead-letter replay after re-enabling.

Both OAuth flows use short-lived, browser-bound, one-use state. Zuse sign-in uses
PKCE and verifies the exchanged access token before persisting an account ID;
access/refresh tokens are discarded. Credentials, settings, PKCE state, and thread
checkpoints are encrypted with `CLOUD_DATA_ENCRYPTION_KEY`, bound to their rows.
Never log request bodies, cookies, OAuth codes, or tokens.

## Operator setup

Code is disabled by default with `SLACK_ENABLED=false`. This document describes
setup; it does not mean the app, queues, or migration are deployed.

Production URLs:

| Purpose | URL |
| --- | --- |
| Add to Slack | `https://api.zuse.sh/slack/install` |
| Slack OAuth redirect | `https://api.zuse.sh/slack/oauth/callback` |
| Slack Events request URL | `https://api.zuse.sh/slack/events` |
| Slack Interactivity request URL | `https://api.zuse.sh/slack/interactions` |
| WorkOS allowed redirect | `https://api.zuse.sh/slack/auth/callback` |
| Private account connection (one-use link from Slack) | `https://api.zuse.sh/slack/account/connect?token=…` |
| Installer automation settings (authenticated) | `https://api.zuse.sh/slack/setup/automations` |

For staging, replace the host with `api-staging.zuse.sh`. Use separate Slack
registrations, WorkOS environments, databases, secrets, and queues.
`SLACK_PUBLIC_ORIGIN` selects that API host for browser callbacks; it is already
set in both configs. It is separate from `API_ISSUER` because staging still uses
the older `stuff.md` token issuer. Do not change token issuers for Slack setup.

1. Create a Slack app from [the manifest](../../apps/slack/slack-manifest.example.yaml).
   For staging, change all manifest URLs to the staging API host.
2. Register the WorkOS redirect above on the same WorkOS client used by that API.
   This uses [WorkOS AuthKit's PKCE flow](https://workos.com/docs/reference/authkit/authentication/get-authorization-url).
3. Apply API migrations through `0023_slack_members` using the existing guarded
   `db:migrate:staging` / `db:migrate:production` scripts. Migration 0022 adds
   three installation/state tables; 0023 adds encrypted per-member connections;
   no existing account/workspace tables are rewritten.
4. Create a jobs queue and dead-letter queue for each environment:

   ```sh
   cd infra/api
   bunx wrangler queues create zuse-slack-staging-failed
   bunx wrangler queues create zuse-slack-staging-jobs
   ```

5. Add this top-level binding to the intended API Wrangler config. For production,
   create separate `zuse-slack-production-*` queues and change both names:

   ```json
   "queues": {
     "producers": [{ "binding": "SLACK_JOBS", "queue": "zuse-slack-staging-jobs" }],
     "consumers": [{
       "queue": "zuse-slack-staging-jobs",
       "max_batch_size": 1,
       "max_concurrency": 1,
       "max_retries": 5,
       "dead_letter_queue": "zuse-slack-staging-failed"
     }]
   }
   ```

   Staging bindings are configured. Production requires its own queues before enabling Slack.
6. Set `SLACK_APP_ID`, `SLACK_CLIENT_ID`, and `SLACK_ENABLED=true` in that config.
   Store `SLACK_CLIENT_SECRET` and `SLACK_SIGNING_SECRET` with
   `wrangler secret put`, selecting the same config. Reuse the existing API
   `CLOUD_DATA_ENCRYPTION_KEY`; do not generate a separate Slack encryption key.
7. Deploy the API through its normal staging/production workflow. Verify the
   Events URL, then enable Slack distribution and follow its approval/review
   requirements before broad rollout. See [Slack installation](https://docs.slack.dev/authentication/installing-with-oauth/).

## Reliability and limits

- Mentions and DMs respond to help/setup problems without starting an agent.
  Follow-ups require an @mention by default, including DM thread replies. Members
  may opt their own replies into mention-free continuation in known workspace
  threads through Home's **My follow-up replies** setting. New DMs do not require a mention;
  unrelated messages, bots, edits, and Slack Connect events do not start human tasks.
- App Home has a personal default repository selector. A request without a default
  gets a private repository button. Its modal opens a loading view before queued
  catalog loading, lists up to 100 ready cloud projects with search, and can save
  channel/personal defaults before resuming the original request. Signed actions
  check the Slack member, installation revision, connection ID and account's ready
  project catalog. Only the account owner can change defaults. Stale views cannot
  cross an account reconnect or workspace policy change.
- One progress message is updated through preparation and then replaced by the
  actual result. Native Slack loading is best effort, refreshed while work runs.
  Clearing the indicator is retryable: transient failures enqueue an independent
  `status-clear` job, honoring Slack rate limits without restarting the agent or
  reposting the result. A later status supersedes queued cleanup for that thread;
  reinstall generations also invalidate old jobs. Unavailable native-status
  features or revoked permissions are logged and use the durable card as fallback.
  If cleanup cannot be queued, failure notification is retried rather than silently
  acknowledged. This follows Slack's [explicit empty-status cleanup](https://docs.slack.dev/reference/methods/assistant.threads.setStatus/).
  It is not raw model reasoning or token/tool streaming. Webhooks are correlated
  to the submitted user turn; delayed results cannot finalize a different turn.
  Polling recovers missed completion deliveries (30s, reducing to 5min after an hour).
- Every member can link a Zuse account through a private, one-use connection URL.
  Channel connection prompts/success notices use `chat.postEphemeral` for that user;
  App Home is private per user. New installs use individual accounts; legacy installs
  stay installer-only. The installer can explicitly choose whole-team sharing of
  their account. Other members cannot select this policy or change shared defaults.
  Connection rows are encrypted with team/generation/user binding. Disconnect uses
  a tombstone so legacy credentials cannot become active again.
- A task that initiates account connection travels with its attachment metadata
  through encrypted, one-use login and WorkOS sessions. On success it is bound to
  that connection and offered through the existing private repository picker;
  selecting a repository resumes the original task. Login links and OAuth sessions
  last ten minutes; the saved request must reach the picker within an hour. The
  picker then has its normal one-hour lifetime. Expiry, a policy change, or an
  account replacement prevents continuation. Duplicate notifications are
  checkpointed and cannot reset an accepted repository choice.
- Connections reuse the account's most recent cloud workspace agent/model defaults.
  No raw IDs are requested. A workspace-create `agent_and_model_required` response
  queues a private **Choose agent** notice instead of failing the conversation.
  The existing picker keeps the selected repository and original message/files,
  validates a combined agent/model choice, and resumes the same idempotent creation.
  Only missing-default responses trigger this; timeouts and other errors never
  change creation parameters. Notice delivery retries independently of task launch.
  First accepted choices are immutable on redelivery; expiry, reconnects, and policy
  changes invalidate the picker. Options come from `CloudAuthProvider` and the shared
  bundled visible model catalog, capped at the [Slack static-select limit of 100 options](https://docs.slack.dev/reference/block-kit/block-elements/select-menu-element/),
  not live account-specific availability.
  Provider credentials must already be connected in Zuse. Selection does not connect
  or authorize a provider, and the picker is not a GitHub repository import flow.

- Events are signature-verified and queued before acknowledgement. Settings
  revisions invalidate stale queued jobs; tenant/generation/connection-scoped
  checkpoints prevent cross-installation or reconnect reuse.
- Queue concurrency must remain one until a durable per-job lease is introduced.
  Permanent permission failures receive a prompt explanation when posting is still
  allowed. Transient failures get five retries honoring Slack rate limits; exhausted jobs go to the dead-letter queue
  and attempt a thread notification. Monitor backlog and dead letters.
- Uninstall/token revocation removes local credentials, sessions, and state.
  Account deletion revokes the affected member connection, retaining unrelated
  members; legacy-only linked installations are removed. Webhook cleanup after
  uninstall is best effort. Removing a rule does not cancel an already-running
  agent, and jobs already executing may finish.
- Workspace writes are idempotent; Slack posting is not guaranteed exactly once.
  Webhook creation and connection persistence are separate writes, so an ambiguous
  failure can leave an orphan subscription requiring operator cleanup.
- Ephemeral notices are not persistent and may not arrive while the user is offline.
  Reopening App Home always reflects the saved connection. Connection success does
  not depend on Slack notification availability. A failed enqueue is logged and
  the browser shows a private retry link for the saved request without another
  sign-in. That retry remains bound to the completed connection, so reconnecting
  a different account cannot transfer the original task. This does not guarantee
  delivery of ephemeral notices while the Slack user is offline.
- Thread pagination is checkpointed across retries. Context is bounded to the
  latest 500 messages/60,000 text characters and eight supported files ≤20 MiB each.
  Files use the existing workspace attachment pipeline, without a separate R2
  staging-upload system. Long rate-limited threads may need operator replay.
- Temporary checkpoints expire after 24 hours; mappings/import markers after 30
  days. Expired rows are pruned on later writes.
- Results include a workspace ID. A one-click authenticated web session landing
  route is not implemented here.
- Live agents are instructed to investigate, prepare minimal fixes, test, and
  request review—not merge/deploy. Prompts are not a security boundary. Restrict
  account/repository credentials; never supply production deployment secrets.
  There is no automation spend cap or cross-post incident grouping.

## Verification before rollout

From `infra/api`, run `bun run test` and `bun run check-types`; run Biome on
changed files, run `apps/slack` tests/type checks, and Wrangler dry-runs for both API configurations. Behavior tests
execute the migration SQL against isolated SQLite and use the production cipher;
they do not substitute for a PostgreSQL staging migration smoke test.

On staging, verify two independent Slack workspace installations, WorkOS sign-in,
App Home ownership, dry-run positive/negative alerts, a controlled live image
thread, workspace startup, result delivery, replay/retry, disconnect/reconnect,
and uninstall. Automated tests mock Slack and agent execution, so they do not
establish live distribution readiness.

### Upgrading an existing staging installation

1. Apply `0023_slack_members` to the staging PostgreSQL database, then deploy the
   updated API bundle (it includes the `@zuse/slack` workspace). Never deploy the
   new bundle against a database that only has migration 0022.
2. In Slack **OAuth & Permissions**, add `app_mentions:read` and `im:history`.
3. In **Event Subscriptions**, keep existing events and add `app_mention` and `message.im`.
4. In **App Home**, enable the Messages tab and allow users to send messages.
5. In **Interactivity & Shortcuts**, enable interactivity with
   `https://api-staging.zuse.sh/slack/interactions`. No shortcut is needed.
6. Reauthorize via `https://api-staging.zuse.sh/slack/install` using the original
   installing Slack user. Deploying code does not grant additional OAuth scopes.
7. Open Zuse Home, connect Zuse if needed, and select an account access mode.
   Existing installs stay installer-only until changed explicitly.
8. Invite Zuse to a test channel. Send `@Zuse help` (help reply, no cloud spend),
   then a bounded task such as `@Zuse list the repository's test commands; do not modify files`.
   Verify progress becomes an actual result. Follow up in the thread, then repeat
   in a DM and with an image. Verify private connection prompts with two Slack users;
   connect separate Zuse accounts and verify repository isolation. Check both default
   checkboxes, modal cancellation/retry, connection success, and disconnected actions.
   Test team sharing only with explicit installer consent, then restore individual
   mode and verify other members no longer execute against the installer account.

No additional Slack scopes or callback URL changes are needed for the per-member
upgrade if the earlier conversation manifest is already authorized. Native loading
must still be checked in the real Slack client; mock tests cannot prove its rendering.
