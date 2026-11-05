# Automation event delivery

Automation definitions belong to the server runtime's persisted automation service.
Cloud runtimes synchronize the ID, revision, enabled state, triggers, and next scheduled
occurrence into an account-scoped Cloudflare Durable Object (`AUTOMATION_SCHEDULER`).
The object owns cloud schedule cursors, trigger delivery and notification receipts.
The runtime owns execution and run history in its existing SQLite database.
PostgreSQL remains the authority for workspace ownership and billing; automation
deadlines and delivery queues are not polled there.

## Deployment and provider configuration

Deploy both the API and runtime from this version. Both Wrangler configurations
include the `AutomationScheduler` SQLite Durable Object migration. Retain
`0048_automation_event_mailbox.sql` and its tables as the legacy import source. The worker
uses the existing cloud data encryption key for subscription configuration, event
payloads, and webhook credentials. No live provider changes or deployments are made
by the implementation.

Slack events use the existing Slack app, signing secret, install/account connection,
queue, and bot token. Configure `reaction_added` and `reactions:read` if reaction
triggers are wanted. Message/mention triggers use the existing channel/history and
mention subscriptions. Workspace reauthorization is required for new OAuth scopes.
Only the linked installer account's automation registrations receive these events;
Slack Connect events and the Zuse bot's own posts are excluded. Completion replies
return to the verified originating thread only if the installation generation and
owner account connection still match. Bot messages require explicit opt-in.

Configured Slack completion notifications can also target a channel ID (`C…`/`G…`),
optionally qualified as `T…/C…`. The API checks the destination against the registered
definition, finds the linked installer account, verifies that installer can still
read the channel, and uses a stable Slack message ID plus a persisted delivery receipt.
Notifications run independently of incoming event delivery so a slow/rate-limited Slack
response cannot stop new triggers. No extra Slack OAuth scopes are required.

GitHub events enter the existing GitHub App webhook endpoint, after raw-body HMAC
verification. Enable the event subscriptions and permissions required by each
configured rule in the GitHub App. Supported ingress events include `push`,
`pull_request`, `issues`, `issue_comment`, `pull_request_review`,
`pull_request_review_comment`, and `check_run`. The installation must be linked to the automation owner's
account and must not be suspended. Repository/action allowlists are matched before
an event is queued.

Email completion delivery uses Resend. Set `ZUSE_AUTOMATION_EMAIL_API_KEY` and
`ZUSE_AUTOMATION_EMAIL_FROM` on the executing runtime, with a verified sender domain.
The persisted outbox retries transient delivery failures with a stable idempotency key.
No email credentials are placed in automation definitions or agent prompts.

## Runtime protocol

All `/runtime/` requests below require the existing renewable workspace runtime
credential, and are scoped to its workspace:

- `POST /v1/cloud/workspaces/:workspaceId/runtime/automations` replaces the subscription
  snapshot atomically. Body: `{ definitions: [{ id, revision, enabled, triggers,
  nextRunAt }] }`. Response includes `{ hooks: [{ automationId, url, token }] }`.
- `GET .../automation-events/connect` upgrades to a hibernating WebSocket using
  protocols `["zuse-automation-events", runtimeCredential]`. It sends only
  `{ "type": "available" }`; event reads and acknowledgements still authenticate
  separately. The runtime reconnects when its credential renews.
- `GET /v1/cloud/workspaces/:workspaceId/runtime/automation-events` reads pending,
  nonexpired events for enabled registrations at the current definition revision.
- `POST .../automation-events/ack` accepts `{ id }` after runtime execution has been
  durably accepted. Receipts remain until expiry to deduplicate redelivery.
- `POST .../automation-notifications` accepts `{ automationId, runId, destination, text }`
  for a configured Slack notification. Runtime and control-plane outboxes retain
  delivery state across failures.
- `POST .../automation-events/result` accepts `{ id, text, status }` and delivers an
  idempotent completion response for the original verified event.

Organization gateway users must pass a fresh organization-administrator check for
automation RPCs; a shared chat edit grant alone cannot read webhook secrets or run
owner automations. The transport installs this authority and never trusts RPC metadata.

The runtime synchronizes registration snapshots on startup and definition changes,
and drains events on socket signals/reconnection. Failed delivery retains work and
arms a retry timer; an empty successful drain waits for a signal without polling. Webhook URLs/tokens are saved through the encrypted runtime
credential vault and appear in the single-automation read result, not list results.

Generic ingress is `POST /v1/cloud/automation-hooks/:workspaceId/:automationId` with
`Authorization: Bearer <token>` and `{ eventId, source, prompt, context }`. Source is
`webhook`, `security_scan`, or `snapshot_build`; it must match an enabled trigger.
Use a stable event ID for retries. Security/snapshot hooks receive completed events;
they do not provision a scanner or build system on their own. Bodies are bounded to
64 KB. Never put the bearer token in the URL.

## Schedules, recovery, and bounds

Each Durable Object arms one alarm at its earliest schedule, pending-delivery retry,
or receipt expiry. Alarm execution atomically queues due events and advances cursors
before waking the runtime. No automation work runs in the periodic Worker cron.
Empty objects with no deadlines have no alarm. Pending work retries after failures;
workspace wakes still check current ownership, entitlement and billing capacity.

Cron calculations share `@zuse/utils/automation-schedule` with the runtime, including
timezone and run-once handling. Cloud runtimes do not run a competing local schedule
loop. Missed occurrences retain their scheduled identity, with up to 100 registrations
advanced per alarm. Desktop-only schedules use the next local deadline and require
the runtime to stay running. Local run completion uses domain events. Retries for
unfinished admission/cancellation and delivery remain timers while work is pending.

Events and notification receipts expire after seven days, with cleanup driven by their
expiry alarm. Permanent missing-definition rejection is recorded on the mailbox receipt;
transient failures retain the event. Alarm and transport redelivery are deduplicated.
Cloud execution latency still includes sandbox startup and provider latency.
Retained owner state is bounded to 8 MiB/2,000 records, with reserved space for
receipts. Admission returns retryable backpressure before reaching that limit;
blocked schedule cursors remain unchanged and retry after capacity becomes available.
This includes seven-day deduplication receipts, so capacity is not released by ACK
alone. Oversized legacy imports fail without marking the import complete.
Revision changes suppress old queued work; deleting a registration
makes its queued events ineligible until their receipts expire. Provider disconnection prevents completion replies from
using a new owner's credentials. External content is event evidence, never authority
to change the configured automation instructions.

## Verification

Follow [the automation verification checklist](automation-verification.md) for
repeatable local checks, UI/CLI smoke tests, and real staging Slack delivery.

`infra/api/test/unit/automation-mailbox.test.ts` covers account routing, hook
authentication, legacy import and delivery receipts. `automation-durable-object.test.ts`
unit tests cover alarm replay, restart, cursor preservation, expiry, idle objects and
wake failures. The integration test with the same name runs real SQLite-backed Durable
Objects in Miniflare, including alarms, WebSocket delivery and restart after ACK.
`infra/api/test/integration/automation-mailbox.pg.test.ts` exercises the real legacy
Postgres migration/import using an isolated `ZUSE_TEST_DATABASE_URL`.

## Existing deployment cutover

Stop routing traffic to the old API version (including its cron and queue consumers)
before importing: old code must not keep writing the legacy tables after import.
Deploy the new API binding/migration and runtime together. Each owner's first request
imports legacy registrations, unchanged encrypted hook tokens, cursors, pending events,
ACK/completion state and Slack receipts exactly once. The DO marks that import in the
same durable transaction. Retrying an interrupted import is safe.

Dormant owners need an explicit bootstrap so their deadlines are armed without waiting
for a runtime reconnect. With Cloudflare operator credentials, run after deployment:

```sh
node infra/api/scripts/migrate-automation-scheduler.mjs staging --apply
# Use production instead of staging for the production cutover.
```

This calls the operations-only `AutomationMigration` service entrypoint through a
remote service binding; there is no public HTTP migration endpoint. It pages owners
in batches of 25 and prints only count/cursor progress. A failed run can resume with
`--apply <last-successful-next-cursor>` or restart safely. It is never called by cron.
Confirm the final page has `next: null`, then verify a paused workspace's scheduled
run and a Slack-triggered run before declaring cutover complete.

Legacy tables are retained unchanged. They are not a current rollback target after
DO writes begin: reverting to the old polling implementation would replay stale cursors
and lose new queue state. Roll forward fixes, or stop writers and reconcile DO state
before any coordinated rollback. No runtime data paths or run-history databases move.

Provider protocol references: [Slack signatures](https://docs.slack.dev/authentication/verifying-requests-from-slack/),
[Slack Events API](https://docs.slack.dev/apis/events-api/), and
[GitHub webhook practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks).
