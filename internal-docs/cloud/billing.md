# Cloud billing operations

Cloud billing is deliberately fail-safe. Without `CLOUD_BILLING_CUTOVER_AT`,
provider evidence is retained but no execution is charged. Enforcement and Polar
export default to disabled independently.

The Cloud Workspace subscription is $40 monthly and includes $35 of attributable
provider usage (compute and retained Boat images). Additional provider cost receives a 5% markup, subject to a
$25 default pre-tax overage cap selected by the user.

## Provider boundary

New integrations must satisfy the [sandbox provider usage and billing checklist](adding-sandbox-providers.md) before rollout.

The ledger, billing periods, reservations, cap enforcement, and Polar export are
provider-neutral. Each sandbox provider owns an adapter that verifies its
webhooks and normalizes lifecycle data into `ProviderExecutionEvidence`. The
shared metering pipeline attributes the internal resource, applies that
provider's immutable price schedule or reported period cost, and atomically
finalizes the provider event with all usage, ledger, and outbox records. E2B uses
the price schedule; Boat uses provider-reported cost. Boxd can opt into completed
per-machine USD cost estimates through `BOXD_BILLING_ENABLED=true`. Other providers should
integrate at this boundary rather than adding a separate billing pipeline. Raw payloads expire after 90 days; the
pseudonymous finalization key remains for seven years so old redeliveries cannot
be billed again.

## Provider setup

1. Apply migration `0010_cloud_billing_ledger`.
2. In Polar, configure the Cloud Workspace product with a fixed USD $40 monthly
   price and a metered price of $0.01 per `zuse_cloud_overage_cent`.
   Configure the meter to sum the numeric `units` metadata field and set its ID
   in `POLAR_CLOUD_OVERAGE_METER_ID` so the api can reconcile exported cents.
3. Register the api endpoint `/v1/cloud/billing/webhook/e2b` for all E2B
   lifecycle event types. Store its signature secret with
   `bun run --cwd infra/api secret:e2b-webhook`.
4. Set `CLOUD_BILLING_CUTOVER_AT` to an explicit ISO-8601 timestamp. Existing
   executions are clipped at this boundary and are never back-billed.
5. For Boat, register `/v1/cloud/billing/webhook/box` for `sandbox.ready`,
   `sandbox.archived`, and `sandbox.error`, and install `BOAT_WEBHOOK_SECRET`.
   The internal provider ID remains `box`. Recovery polling can synthesize a
   close for an archived sandbox, but cannot reconstruct a missing opening
   event. Verify a complete opening/closing pair reaches the ledger.

## Missing usage in Polar

Polar's `zuse_cloud_overage_cent` meter receives customer overage cents, not
total provider compute. Usage within the included allowance, manual entitlement
credits, and amounts absorbed above the cap do not produce billable meter
events. Confirmed compute cost is also exported as `zuse_cloud_provider_cost_micros`,
independently of invoice export. Observed runtime is exported as
`zuse_cloud_runtime_observed_ms` for all sandbox providers, including boxd.

The checked-in production configuration has `CLOUD_BILLING_EXPORT_ENABLED=false`
and `CLOUD_BILLING_ENFORCEMENT_ENABLED=false`. The September 28 Boxd deployment
record also confirms those values. These switches govern invoice settlement, not usage visibility.
`CLOUD_USAGE_EXPORT_ENABLED=true` in the production configuration enables the
separate usage stream. Before enabling export, inspect and reconcile
the pending outbox as well as current usage: enabling it also releases previously
queued overage events. These repository settings are not a live deployment audit.

For Boat, check opening evidence, provider-resource attribution, billing-period
coverage, and the exact-window usage response before investigating Polar. A
failed execution in a recovery batch is logged with its provider, event ID, and
error code; it remains unfinalized while later events can settle. Subsequent
polls can retry it while the provider still lists the archived/error sandbox.

Boxd SDK 0.2.14 adds historical `orgs.usage`, `machines.usage`, and
`orgs.billingActivity`. Deleted machines retain their usage identity. See the
[usage API](https://docs.boxd.sh/reference/typescript-sdk#usage-and-cost).

`BOXD_BILLING_ENABLED=true` explicitly opts into charging completed per-machine
USD estimates against the same $35 allowance, 5% markup and overage cap. The
checked-in staging configuration enables settlement from `2026-10-06T17:15:42Z`;
production keeps settlement disabled and its cutover empty. Invoice export and
enforcement remain disabled pending staging reconciliation. On October 6, 2026, the
product owner approved using completed per-machine costs at boxd's current rates,
with the existing allowance, markup and cap. Fetch rates and costs from the
provider for each settlement; no manually maintained boxd price table is needed.
Billing-enforced placement requires this flag and an explicit
`BOXD_BILLING_CUTOVER_AT` (whole-second ISO timestamp). Production keeps this opt-in
disabled and its cutover empty until staging provider-to-ledger-to-Polar reconciliation
is verified; select the production cutover when enabling it. An explicit cutover prevents
retroactive charges when Boat's shared cutover is older. The shared settlement
path uses boxd's provider cutover independently of other providers' cutovers.
EUR reports remain unbillable;
there is no implicit exchange rate. This applies to machine compute, resident
RAM and used disk in every state; Boat's $1.70 saved-image rate does not apply.

The minute cron discovers complete machines in fixed UTC daily windows, including
deleted machines. It always checks the latest closed day after 30 minutes of
metering lag and rotates seven historical days per pass. Cutover must have whole
second precision. Provider windows and period/cutover splits use the documented
15-minute bucket-start attribution, rather than elapsed-time proration. Customer
settlement can lag by about a day; provisional reservations remain necessary for
admission/cap checks. Failed/incomplete evidence stays retryable. Costs are queried
separately for each billing period, and original responses are retained for audit.
Runtime observations preserve ownership when a machine is replaced; unknown
machines are excluded. Stable window identities prevent repeat charges.

Boxd costs use its **current** rates and round each component up to micro-units.
`complete` means metering has finished, not that a historical invoice is exact.
Polar metadata labels these `completed-provider-estimate` / `provider-current-rates`.
`ListBillingActivity` gives actual organization-wide charges; use it for operator
reconciliation, never assign its balance changes to individual users. Reconcile
completed USD usage against `boxd manage billing activity` before enabling invoice
export. Provider rate changes can change unsettled historical estimates; committed
usage is never repriced. Keep export disabled if this policy is unsuitable.

## Rollout

Keep both flags false during shadow metering:

- `CLOUD_BILLING_ENFORCEMENT_ENABLED=false`
- `CLOUD_BILLING_EXPORT_ENABLED=false`

Use the operator report until E2B statement variance is within the rollout
threshold, then enable enforcement. Enable Polar export only after a complete
statement reconciles. The minute cron polls E2B for missed pause/kill events,
refreshes reservations, purges expired raw payloads, and retries the Polar
outbox with backoff.

## Reconciliation and overhead imports

Commands require `DATABASE_URL` and accept integer USD micro-units:

```sh
bun run --cwd infra/api cloud-billing:ops import-provider-statement e2b AMOUNT_MICROS START_MS END_MS EXTERNAL_ID
bun run --cwd infra/api cloud-billing:ops import-platform-cost polar transaction-fee AMOUNT_MICROS START_MS END_MS EXTERNAL_ID
bun run --cwd infra/api cloud-billing:ops import-platform-cost cloudflare monthly AMOUNT_MICROS START_MS END_MS EXTERNAL_ID
bun run --cwd infra/api cloud-billing:ops report PERIOD_ID
```

Provider price changes must be inserted as a new immutable
`api_provider_price_schedule` row with a unique version and effective time.
Never update an existing price row.


## Box reported usage and cost

Boat settlement queries [Get Sandbox Usage](https://docs.boat.dev/api/reference/sandboxes/get-sandbox-usage)
using `BOAT_API_KEY` (with `BOX_API_KEY` as a legacy fallback). Each matched ready-to-archived/error execution is clipped to
`CLOUD_BILLING_CUTOVER_AT` and split at account billing-period boundaries. The API
queries `since` and `until` for each exact segment and records `dollars` in integer
micro-USD. Box already applies machine-size multipliers to `seconds`; do not apply
them again. These amounts are Box list-price compute, not the provider account's
net invoice after plans, gifts, or trial credits. Zuse's allowance, markup, and
cap policy are unchanged.

All segment requests must succeed before any confirmed usage is committed.
Invalid responses and provider outages leave the execution retryable; estimated
rates never become confirmed Box charges. Webhook redeliveries and polling
closes share the existing execution finalization key. Already finalized historical
executions are not repriced. Unmatched resources and missing opening evidence
remain uncharged pending reconciliation.

When billing enforcement or export is enabled, running-resource reconciliation
refreshes provisional usage from the same endpoint, adding a short forward
reservation at Box's reported current rate only while its meter is running.
If the endpoint is unavailable, existing catalog estimates remain a provisional
fallback. The existing billing usage API and Cloud settings expose these amounts;
no additional user credentials are required. Requests use a 30-second deadline.
Validate provider statement reconciliation in staging before enabling invoice
export; reporting list-price usage does not reconcile plan discounts automatically.


## Usage visibility independent of invoices

### Authentication idle-cost guard

Apply `0031_cloud_auth_status` before deploying the API. Public auth status is
stored on the existing authority row, fenced by its revision; credentials and
private keys stay on the authority disk. Settings/image reads return this status
without contacting the provider, waking or extending sandbox compute. For an older authority,
the explicit **Try again** action in Agent Authentication reads the saved setup;
no new credentials or disk replacement are required. Never backfill by waking all
accounts automatically.

Real auth operations use a 15-minute pause timeout (previously one hour). Device
login polling does not renew it, and a paused login operation expires rather than
resuming compute. This policy uses the shared provider interface for E2B and Boxd.
It does not establish that unrelated Boxd workspace charges have the same cause.

`0032_classify_legacy_lifecycle_usage` relabels historical `runtime-seconds` rows
as `lifecycle-elapsed-seconds`, preserving quantities, timestamps and event IDs.
These counters can include time spent paused before reconciliation. They must not
be summed as provider compute or used for invoice corrections. The migration does
not touch confirmed settlement, Polar exports or balances. Actual historical cost
corrections require provider execution/statement evidence; missing evidence must
remain unknown, not zero.

Retired pool cleanup must cross-check exact sandbox IDs against both staging and
production workspace, build and authority references before deletion. Pool labels
alone are insufficient: claimed machines can contain real chat data. Do not remove
authentication authorities or paused user workspaces as pool cleanup.

Apply `0027_cloud_usage` before deploying the Worker. Runtime observations and
confirmed provider-cost exports share a durable `api_cloud_usage_outbox`.
Confirmed cost is queued in the same database transaction as settlement,
including costs covered by the allowance or a manual entitlement. Runtime
observation checkpoints and their exports are also committed atomically.
Concurrent observations serialize by provider and sandbox ID. Exports run with five concurrent requests and a ten-second per-event deadline.
Failed exports retry with backoff and stable Polar external IDs; timestamps remain the time
of usage rather than retry time. Acknowledged queue rows expire after seven
days, idle observation checkpoints after 90 days; unacknowledged exports remain.

`CLOUD_USAGE_EXPORT_ENABLED` enables runtime sampling and drains this usage queue
without enabling invoice charges or changing placement eligibility. It requires
Polar configuration, but does not require a new metered price. Existing finalized
history is not backfilled. Newly confirmed costs accumulate in the queue even
while usage export is disabled. Turning it back on resumes those exports.

Polar's Events view shows both event names. To aggregate them, create separate
meters filtering on the exact event names and summing numeric `metadata.units`:

- `zuse_cloud_runtime_observed_ms`: milliseconds between consecutive running
  observations, tagged with provider, workspace/build, sandbox, and size.
- `zuse_cloud_provider_cost_micros`: confirmed USD micro-units, tagged with
  provider, workspace/build, and billing period.

These are informational events (`billable=false` metadata). Do not attach them
to the existing overage price: that price must continue to match only
`zuse_cloud_overage_cent`. The metadata flag alone does not prevent Polar from
charging an event if an operator attaches its meter to a price.

Runtime sampling checks provider state during reconciliation with a two-second
request budget. The first observation seeds a checkpoint; only successive
running observations up to two minutes apart produce duration. Pauses, missing
machines, failed inspections, account/resource changes, and longer gaps break
the interval. Resume clips the next interval to the new run's start. This is
sampled activity, not an exact billable runtime or Boxd invoice reconstruction;
short runs and unsampled transitions can be missed. It cannot recover historical
Boxd costs. Provider-reported cost remains the settlement source for Boat.

Deployment verification: observe a running Boat and Boxd workspace across two
cron passes, check provider/resource metadata in Polar Events, retry an export
with the same external ID, and confirm the overage meter did not move from
informational events. Invoice export remains a separate reconciled rollout.

## Boat named-image storage

Apply `0038_cloud_snapshot_storage` before deploying this change. Boat's public
[List named snapshots](https://docs.boat.dev/api/reference/snapshots/list-named-snapshots.md)
API now documents ten free snapshots per wallet and $1.70 per extra snapshot per
month, deducted daily from credits. Zuse's free slots are already occupied.
Snapshot charges are not reconstructed from wallet balances or sandbox usage.

Zuse charges only the retained account image: $1.70 per fixed 30 days, prorated
by elapsed milliseconds. It consumes the existing $35 allowance and receives the
existing 5% overage markup and cap. Temporary rebuild overlap, creation intents,
and failed cleanup are platform overhead. The versioned approved price is
`boat-snapshot-2026-10-v1`; insert a new schedule/version for future changes rather
than updating this rate. Stored usage has `resourceKind=snapshot`; usage API responses expose
`resourceKind=other` plus `usageKind=snapshot-storage` so older clients can still
decode billing history. The named snapshot is the `resourceId`, and `cost_source=approved-storage-schedule` in the
informational Polar export. The existing overage meter remains the sole invoice
meter. Billing summaries expose `storageCostMicros` for the full period.

Set `CLOUD_SNAPSHOT_BILLING_CUTOVER_AT` explicitly to enable accrual; it defaults
to absent independently of the compute cutover. Existing retained images start
at migration time or the storage cutover, whichever is later. There is no
historical back-billing. Minute maintenance checkpoints storage at most hourly,
with immediate final settlement on replacement/deletion. Integer rational
arithmetic carries fractional micro-USD across checkpoints and period boundaries.
Storage without a valid subscription period is absorbed by the platform. An unsettled
suffix remains pending when period evidence is late and can settle after that evidence
arrives. Checkpoints, ledger and both Polar queues
commit in one account-serialized transaction.

Snapshot-consuming restores and rebuilds hold shared durable account leases, allowing
concurrent allocations. Promotion, deletion, account cleanup and reconciliation require
an exclusive lease and wait for all readers. Leases last five minutes, renewed every 30 seconds,
without keeping a database transaction open; crashes release them through expiry. Lease acquisition
waits at most 15 seconds before returning a retryable conflict. Settlement and reference
updates remain atomic in short SQL transactions, with the live owner checked under
a lease-row lock. Provider side effects also recheck ownership immediately before
execution so a resumed stale worker is rejected.

Creation intents persist the exact name before Boat publication. Promotion
atomically starts the new image and stops the old one. Deletion keeps the
identity/reference until Boat confirms success or absence. Inspection failures
leave presence unknown and do not block other settlement or cleanup. Settings/image reads use the stored inventory without waking
machines. `cloud.image.delete` queues authenticated, account-scoped deletion of a
specific named image, making retries safe even after a replacement. Existing
workspace disks and authentication authorities are preserved.

With billing enforcement enabled, an ended subscription or billing hold starts
a persisted seven-day deadline. Recovery before deletion begins cancels it;
expiry fences new image restores and queues cleanup. An in-flight workspace
replacement delays cleanup so its existing disk remains protected. Cap overflow is absorbed by
the existing ledger policy. With enforcement disabled, shadow metering never
expires user images. This is Zuse's user retention policy, independent of Boat's
wallet-level grace. Account deletion also waits for tracked snapshot cleanup.

Operator tools (require `DATABASE_URL`):

```sh
bun run --cwd infra/api cloud-snapshots:ops report
bun run --cwd infra/api cloud-snapshots:ops cleanup-orphan EXACT_NAME
```

`report` shows retained images, creation/rebuild overlap, pending cleanup, retry
errors and untracked provider names. Set `BOAT_API_KEY` (or legacy `BOX_API_KEY`)
to query the provider list, or `SNAPSHOT_INVENTORY_FILE` to inspect a captured
list offline. Provider credentials are never printed. Set
`SNAPSHOT_REFERENCE_DATABASE_URL` to the other environment's database to compare
staging and production. `cleanup-orphan` requires both databases, locks both
account domains, rechecks build/workspace references and verifies the exact
provider source sandbox. Unknown ownership, missing source evidence, in-flight
publication, and any remaining cross-environment references block removal.
Only failed builds or verified superseded images qualify for orphan removal.
Tracked images use the durable reconciler instead. Successfully removed orphans
receive an inventory tombstone.

Before rollout, inspect the backfilled inventory and shadow usage in staging.
Verify allowance/cap behavior, replacement cleanup, seven-day recovery/expiry,
and a complete snapshot-to-ledger-to-Polar example with stable retry IDs. Set
cutover before enabling storage settlement; enable invoice export only through
the existing reconciled rollout. Local PostgreSQL tests do not verify live Polar
delivery or deploy the migration to staging/production.

For boxd machine costs, a machine's initial metering bucket belongs to the segment
in which that machine was created, including fractional creation timestamps. Only
that segment queries back to the bucket start: the machine has no earlier usage.
Later billing-period and cutover boundaries use half-open bucket-start attribution;
rounding these boundaries up to integral seconds preserves membership without
double-counting or importing pre-cutover usage.
