# Verifying automations

Use three levels of evidence: automated checks, an actual runtime/UI smoke test,
and provider delivery in a staging cloud workspace. Passing mocks does not prove
that deployed Slack subscriptions, runtime credentials, or workspace wake-up work.

## Launch the branch locally

On a desktop machine with this checkout, run from the repository root:

```sh
bun install --frozen-lockfile
bun run dev --instance automation-qa
```

This opens a separate desktop development instance. Its data lives under
`.zuse/dev-instances/automation-qa/user-data`; the runner prints the selected UI
and RPC ports. Keep using that instance when verifying persistence. Add a test
project and connect an agent provider, then open **Automations** in the sidebar.
The normal desktop development launcher requires a graphical desktop; this cloud
VM can run an isolated headless runtime for API checks instead.

## Create through an agent

In a project chat, ask: “Create a paused automation named QA Daily Summary. Every
weekday at 09:00 in America/New_York, summarize open pull requests. Save it so I
can review it in Automations.” Alternatively use **Describe to an agent** in
the Automations page to open a session with creation instructions.

The native `automation_catalog` tool returns the current project, definition
schema, templates, capabilities and existing definitions. `automation_save`
persists the full definition with a stable creation request ID. Updates use the
saved ID and expected revision. Both tools use the UI's registry; packaged apps
require no CLI installation. Mutations follow session permission/plan-mode rules.
Verify that the returned ID appears in the catalog and UI, survives reload, and
replaying a creation request creates no duplicate. Then use Run now with the
harmless prompt described below. Real agent execution requires a connected provider.

## Automated checks

From the repository root, install the locked dependencies with
`bun install --frozen-lockfile`. Typecheck the renderer, server, API and CLI:

```sh
bunx tsc --noEmit -p apps/renderer/tsconfig.json
bunx tsc --noEmit -p apps/server/tsconfig.json
bunx tsc --noEmit -p infra/api/tsconfig.json
bunx tsc --noEmit -p packages/serve/tsconfig.json
```

The source CLI can be checked without connecting an agent or making a paid model call:

```sh
bun packages/serve/src/bin.ts automation schema
```

Expect `ok: true` and definition/event schemas. This checks command loading, not
runtime execution.

Run the automation and migration checks:

```sh
bunx vitest run \
  packages/serve/test/agent-cli.test.ts \
  packages/utils/test/unit/automation-policy.test.ts \
  apps/renderer/test/unit/automation-agent.test.ts \
  apps/renderer/test/unit/automation-client.test.ts \
  apps/renderer/test/unit/automation-format.test.ts \
  apps/renderer/test/unit/session-timeline-client-bus.test.ts \
  apps/server/test/unit/automation-cloud-launcher.test.ts \
  apps/server/test/unit/automation-schedule.test.ts \
  apps/server/test/unit/automation-notification.test.ts \
  apps/server/test/unit/automation-policy.test.ts \
  apps/server/test/integration/automations.test.ts \
  apps/server/test/integration/automation.test.ts \
  apps/server/test/integration/workspace-automation-access.test.ts \
  apps/server/test/integration/migration-engine-main-upgrade.test.ts \
  apps/server/test/integration/scratch-folder-migration.test.ts \
  apps/server/test/unit/cloud-automation-mailbox.test.ts \
  packages/agents/test/unit/drivers/claude-automation-policy.test.ts \
  infra/api/test/unit/automation-mailbox.test.ts \
  infra/api/test/unit/automation-durable-object.test.ts \
  infra/api/test/integration/automation-durable-object.test.ts \
  infra/api/test/unit/cloud-github-webhook.test.ts \
  infra/api/test/slack/app.test.ts \
  apps/slack/test
```

For the actual PostgreSQL legacy migration/import test, set
`ZUSE_TEST_DATABASE_URL` to an isolated test database, then run:

```sh
bunx vitest run infra/api/test/integration/automation-mailbox.pg.test.ts
```

Without that variable the test skips; a skipped test is not database validation.
It creates and removes its own schema. Also run Biome on changed TypeScript/JSON
files, `node scripts/check-architecture-boundaries.mjs`,
`node scripts/check-api-terminology.mjs`, and `git diff --check`.

## Runtime and UI smoke test

Use a build from this branch for both the UI and runtime, an isolated test project,
and a connected agent provider. Select the existing runtime as the machine; a
handoff to a newly created cloud machine is a separate test because its automation
run records launch completion rather than tracking the entire remote agent turn.

1. Create a manual automation with the prompt: “Reply exactly AUTOMATION_QA_OK.
   Do not call tools or change files.” Save it paused. Reload the page and verify
   the name, prompt, project, provider and model persist.
2. Run it manually. Expect one accepted run, a normal session, and eventual
   completion with `AUTOMATION_QA_OK` in its transcript. Open the session from run
   history. A paused definition still permits a manual test run.
3. Verify the CLI sees the same definition and history. With this branch's CLI
   connected to the same runtime, substitute the returned project/automation IDs:

   ```sh
   zuse automation list --project <project-id>
   zuse automation get --project <project-id> --automation <automation-id>
   zuse automation run --project <project-id> --automation <automation-id> --idempotency-key qa-run-1
   zuse automation run --project <project-id> --automation <automation-id> --idempotency-key qa-run-1
   zuse automation runs --project <project-id> --automation <automation-id>
   ```

   Both run calls must return the same run ID and must not create two sessions.
4. Enable a run-once schedule a few minutes ahead. Verify the timezone and next-run
   time, wait for one scheduled run, and confirm no further scheduled occurrence.
   Separately check a recurring schedule, then pause it and confirm no new
   scheduled runs appear. Manual runs remain possible while paused.
5. With a controlled longer task, set concurrency to one and queueing on. Trigger
   two distinct run IDs: only one should execute at a time. Cancel the queued run;
   it must not start. Cancel a running run and verify the matching agent turn stops
   before its concurrency slot is released.
6. Test edit/search/delete and “Describe to an agent.” Confirm generated definitions
   are persisted and visible through the same CLI; a conversational claim alone is
   not evidence of creation. Check that unavailable policies show a clear error.

## Real Slack delivery in staging

First deploy the Durable Object binding/migration, complete any legacy-owner bootstrap, and configure the Slack app as described in
[automation execution](automation-execution.md). The staging API, worker and cloud
runtime must all run this branch. Invite the app to a dedicated test channel and
connect the intended personal account or organization; organization automation
management requires administration access.

| Action | Expected evidence |
| --- | --- |
| Create “Triage Bug Reports” in the cloud workspace, filter to the test channel ID and keyword `AUTOMATION_QA`, and enable it. | Saved definition appears in UI/CLI; cloud registration has synchronized. |
| Post a human message containing `AUTOMATION_QA` and a harmless sample bug. | One matching automation run, one agent session, and a completion reply in the originating Slack thread. Allow time for agent execution and any sandbox startup. |
| Post a message without the keyword or in another channel. | No run for this definition. |
| Post from another bot with bot messages disabled, then enable them and repeat. | First message excluded, second eligible. Zuse's own completion message never triggers another run. |
| Replay the same verified event through the staging event test harness. | Same durable event/run identity; no second agent session. Reposting text in Slack produces a new event and is not a deduplication test. |
| Pause the definition and post another matching message. | No new agent execution. |
| Pause the cloud workspace, then post a matching message. | Workspace wakes through the usual entitlement/billing checks, consumes the pending event, and replies after the run. |
| Disconnect/change the Slack owner connection while an event is queued. | Old queued work/results do not use the replacement connection. |

The template starts an agent for every matching message; there is no separate
pre-run bug classifier. Matching thread replies may start additional runs. Narrow
the channel and keyword filters during testing. Thread-reply delivery and optional
configured-channel notifications are separate paths; test each if enabled. For
organization workspaces, configured-channel notifications currently remain limited
by the personal-account Slack team lookup; do not infer support from a successful
same-thread reply.

## Other triggers and failure recovery

- For webhooks, use the generated bearer-authenticated URL and a stable event ID.
  Repeating the same event must not create another run; an invalid token must be
  rejected. Do not paste webhook tokens into issue reports or screenshots.
- For GitHub, test a signed event from an allowed repository, then a disallowed
  repository/action. Include an installation with restricted repository access.
- For email, configure the runtime sender/API key and verify one actual test
  delivery; mocked HTTP success does not establish sender-domain configuration.
- Restart the test runtime after accepting an event but before acknowledging it.
  Verify the existing run/session is recovered without a second launch. Retain
  the original data directory; recreating the database is not a recovery test.

Record the branch commit, environment, automation/event/run/session IDs, result,
and any failures. The release gate is a successful runtime smoke test plus real
provider delivery and recovery for the integrations being enabled. Source tests
alone do not establish that gate.

## Durable Object scheduling checks

- Observe an idle account: no automation cron scans or runtime ten-second fetches.
- Schedule one future run, restart the object/runtime, and verify the alarm still fires.
- Edit or pause before the deadline; the previous revision must not execute.
- Disconnect the runtime socket with an event pending. Reconnect and confirm one run,
  including an ACK lost after the runtime durably accepted the event.
- Deny billing/entitlement for a paused test workspace. Its event must remain pending
  and wake only after access is restored; no bypass of cloud capacity checks.
- Import populated legacy tables and rerun bootstrap: hook tokens, pending event IDs,
  schedule cursors, completion receipts and Slack receipt IDs remain unchanged.
- Production cutover requires the documented one-time dormant-owner bootstrap; lazy
  import alone cannot arm schedules for owners who never reconnect.
