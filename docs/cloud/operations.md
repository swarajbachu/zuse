# Cloud operations

This document describes the normal operating model. The exact production
provisioning and cutover checklist lives in the
[private beta production runbook](../../infra/relay/PRIVATE_BETA_PRODUCTION.md),
and billing procedures live in
[cloud billing operations](../../infra/relay/CLOUD_BILLING.md).

## Environments

Staging and production are isolated deployments:

| Resource | Staging | Production |
| --- | --- | --- |
| Relay | `zuse-relay-staging`, `relay-staging.zuse.sh` | guarded production Worker, `relay.stuff.md` |
| Wrangler config | default `infra/relay/wrangler.jsonc` | `infra/relay/wrangler.production.jsonc` |
| Database | approved staging Neon identity | separately approved production identity |
| Runtime channel | `cloud-runtime-staging` | signed `cloud-runtime-production` |
| E2B template | staging immutable version | release-commit production version |
| Polar | sandbox | production |
| PostHog | staging/test cohort | production flag, default false |

Never use a staging command against production by changing an incidental
environment variable. Production migrations, secrets, and deploys have
separate scripts, explicit configs, identity checks, and confirmation phrases.

## Runtime and template release

The template is a credential-free base containing the runtime and supported
toolchain. Its reviewed resource shape is shared by publication and billing
reservation; currently 2 vCPU and 4096 MiB. A deployment test rejects drift.

For a release:

1. Build artifacts from the exact release commit.
2. Publish the immutable runtime archive before its signed manifest.
3. Verify checksum, signature, protocol metadata, native modules, and startup.
4. Publish the E2B template from the same commit and record its immutable
   version in Relay configuration.
5. Boot a fresh template and smoke repository setup, runtime enrollment,
   gateway connection, pause/resume, SSH, and transcript checkpointing.
6. Deploy Relay only after the configured artifact and template are available.

Existing sandboxes keep their filesystem and durable SQLite state. When a
runtime update is supported, the signed runtime channel and lifecycle
reconciler perform it under generation fencing. Incompatible protocol versions
fail explicitly with `update-required`; the client must not invent a fallback
or deploy code directly into a workspace.

## Database changes

Historical migrations are immutable. Add forward migrations and apply them
before deploying code that requires them.

Staging uses the validated staging migration command. Production uses only the
guarded command documented in the production runbook. It validates the exact
approved hostname and database name, rejects known staging identities, and
requires the production confirmation phrase. Worker cold starts never run
migrations.

Hyperdrive SQL response caching must remain disabled. Lifecycle operations
require read-after-write consistency and compare-and-set revisions.

## Configuration and secrets

The production deploy validator must reject empty or placeholder database,
runtime, E2B, PostHog, Polar, R2, and Hyperdrive values. Secret installation
must explicitly use `wrangler.production.jsonc`; audit names with a read-only
secret listing before launch.

Do not log tokens, decrypted transcript keys, credential payloads, repository
URLs containing credentials, raw webhook secrets, or transcript plaintext.
Lifecycle logs should use workspace/account identifiers appropriate to their
existing privacy policy, revisions, generations, provider operation IDs, and
stable error codes.

## Private-beta rollout

The production gate is the PostHog boolean flag `zuse-cloud-beta-access`,
targeted by `zuse_cloud_beta_access=true` on the privacy-preserving `account_…`
identity that Relay derives from verified WorkOS identity. Relay sets this
property after an active checkout-link subscription is claimed; operators may
also set it for selected invitees. Email and `anonymous_…` installation IDs do
not apply. There is no second production allowlist.

Roll out in this order:

1. Deploy with checkout, billing enforcement, and Polar export disabled.
2. Invite one internal account and complete the full paid path.
3. Reconcile an E2B provider statement; require variance at or below 1% and $1.
4. Enable enforcement with export still disabled and validate cap behavior.
5. Enable Polar export and prove Relay outbox totals equal Polar meter totals.
6. Enroll additional PostHog identities gradually.

The independent rollback switches are beta access, checkout, billing export,
and enforcement. Disabling any of them must preserve sandboxes, encrypted
transcripts, customers, and immutable ledger data.

## Health and observability

Monitor at least:

- workspace counts and time spent by lifecycle/startup phase;
- reconciliation attempts, lease conflicts, retry delay, and terminal failure;
- runtime enrollment, credential renewal, generation rejection, and protocol
  mismatch;
- gateway client/runtime attachments and typed close reasons;
- sync mode (delta/snapshot/reset), payload bytes, catch-up latency, and cursor
  gaps;
- R2 checkpoint age, upload lag, size, integrity failure, and stale-pointer
  rejection;
- E2B webhook signature failures, recovery-poll discoveries, provider resource
  mismatch, and duplicate finalization;
- billing reservation pressure, cap denial, outbox age, Polar acknowledgment,
  and statement variance; and
- beta-gate allow, deny, timeout, and unavailable outcomes without logging flag
  payloads or secrets.

Alert on sustained enrollment failure, reconnect loops, checkpoint lag beyond
the operating threshold, gateway generation churn, reconciliation backlog,
billing outbox backlog, or statement variance above the release threshold.

## Required smoke journey

For staging and before a production cohort expansion, verify:

1. An uninvited account retains local/SSH/pairing use and receives the specific
   invite-only cloud response.
2. An invited subscribed account creates a workspace from the current template.
3. Repository setup finishes before the first provider turn starts.
4. Closing the client mid-turn does not stop the runtime.
5. Reopening renders local data immediately, catches up through R2, and attaches
   once without waking a paused workspace.
6. Send, cancel, queue, files, Git, terminal, SSH, pause, and resume operate
   through one environment supervisor.
7. Archive removes the chat immediately, stays archived after catalog refresh,
   and unarchive reads without resuming compute.
8. Manual deletion removes E2B and R2 content exactly once and produces a
   client-visible tombstone.
9. E2B webhook plus recovery poll finalizes one usage record.
10. Relay billing report, export outbox, and Polar meter reconcile.

## Incident guide

### PostHog unavailable

Hosted user operations fail closed with `cloud_beta_access_unavailable`.
Cached transcripts and non-cloud environments remain usable. Do not bypass the
gate with a client flag or temporary second allowlist.

### Runtime online but client cannot attach

Inspect lifecycle generation, gateway epoch, runtime enrollment, ticket issue,
and the typed gateway close in that order. Do not add a feature-specific socket
or repeatedly resume the provider. Cached/R2 state should remain visible while
the single supervisor retries.

### Checkpoint stale or unavailable

SQLite remains authoritative. Do not pause provider output or roll back a turn.
Record checkpoint lag, retry the immutable upload, and allow a later live
bounded sync to repair the client.

### Billing mismatch

Disable Polar export first; keep evidence collection and the immutable ledger
running. Compare normalized provider executions, price-schedule versions,
period attribution, finalization keys, and outbox acknowledgments before
changing enforcement. Never edit finalized ledger rows.

### Bad runtime or template release

Stop cohort expansion and new checkout, preserve existing sandboxes, and roll
Relay back only to a protocol-compatible Worker. Publish a corrected immutable
artifact/version; never overwrite a signed archive, manifest target, or E2B
template version.
