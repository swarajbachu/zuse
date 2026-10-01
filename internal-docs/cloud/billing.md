# Cloud billing operations

Cloud billing is deliberately fail-safe. Without `CLOUD_BILLING_CUTOVER_AT`,
provider evidence is retained but no execution is charged. Enforcement and Polar
export default to disabled independently.

The Cloud Workspace subscription is $40 monthly and includes $35 of attributable
provider compute. Additional provider cost receives a 5% markup, subject to a
$25 default pre-tax overage cap selected by the user.

## Provider boundary

New integrations must satisfy the [sandbox provider usage and billing checklist](adding-sandbox-providers.md) before rollout.

The ledger, billing periods, reservations, cap enforcement, and Polar export are
provider-neutral. Each sandbox provider owns an adapter that verifies its
webhooks and normalizes lifecycle data into `ProviderExecutionEvidence`. The
shared metering pipeline attributes the internal resource, applies that
provider's immutable price schedule or reported period cost, and atomically
finalizes the provider event with all usage, ledger, and outbox records. E2B uses
the price schedule; Boat uses provider-reported cost. boxd has no actual-cost
settlement source yet: it offers no lifecycle webhook or event log, and its
machine records carry only `createdAt` and `hibernatedAt`. The optional
[interim estimate policy](#interim-boxd-balance-deductions) deducts estimated usage
from available balance and enforces caps without mislabeling it as confirmed
cost. Other providers should integrate at this boundary rather than adding a
separate billing pipeline. Raw payloads expire after 90 days; the
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

Boxd still has no actual-cost settlement feed. As checked on September 29, 2026, its
[published API](https://docs.boxd.sh/reference/grpc-proto.md) exposes an
organization credit balance and optional `accruing_micro_eur`. That pending
amount is explicitly a display-only approximation. Its per-VM listing supplies
identity and state, not attributable cost or historical execution intervals.
An organization balance delta cannot be assigned to customer workspaces or
converted into finalized USD charges. Actual-cost settlement needs durable
per-machine usage/cost evidence and an explicit EUR-to-USD conversion policy.
A Zuse-defined runtime rate would instead be a separate billing-policy decision;
do not finalize existing reservations as if they were provider-reported costs.

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

## Interim Boxd balance deductions

Boxd can provisionally consume an account's included allowance and overage cap
before its attributable cost feed exists. This is an explicit estimate policy,
not actual-cost settlement. `CLOUD_BOXD_ESTIMATES_CUTOVER_AT` opts in at a
prospective timestamp. It enables durable estimated deductions and cap enforcement
independently of the global invoice-export and usage-export switches. Existing
estimates remain deducted if collection is later disabled; disabling the switch
is not a refund. No workspace-start pricing dialog is added.

Apply `0029_boxd_estimated_balance` before deploying. Install a separately
versioned **USD, before-markup** rate schedule using the existing operations CLI:

```sh
bun run --cwd infra/api cloud-billing:ops add-boxd-estimate-price VERSION EFFECTIVE_AT_ISO CPU_NANO_USD_PER_SECOND MEMORY_NANO_USD_PER_GIB_SECOND
```

The schedule uses provider key `boxd-estimate`, not `boxd`. Values are integer
nano-USD per vCPU-second and allocated GiB-second. New versions must take effect
in the future; retries with the same version must match all values. Rate changes
must not rewrite existing versions or earlier deductions. No numeric production
rate is seeded: the published Boxd rate card uses EUR, while the observed account
CLI reported USD. Confirm the account's USD rates or explicitly approve and record
a conversion rule before installing a schedule. Do not treat EUR values as USD.
The existing period policy applies its 5% markup **once, on overage**; do not add
markup to the installed schedule. The $35 allowance and customer cap are unchanged.

The first observation seeds a checkpoint. Consecutive running observations no
more than two minutes apart produce an estimate, clipped at cutover and split at
billing-period and rate-version boundaries. Paused/hibernated, missing, failed,
stale, replacement, and changed-size observations do not invent usage. This uses
allocated CPU/RAM, not Boxd's actual RAM/disk integrals; it can miss short runs,
unsampled transitions and long outages. Storage and suspended memory are not
estimated. Sampling is deliberately visible as an estimate, and is never exported
as confirmed provider cost. A missing price, missing billing period, failed
inspection, or failed durable write prevents additional Boxd execution at the
next reconciler pass. The normal cap path pauses workspaces and blocks starts or
resumes; builds follow the existing billing-hold cleanup path.

Estimated usage is stored in `api_cloud_billing_usage` with
`measurement='estimated'`, `status='provisional'`, machine ID and price version.
The observation checkpoint and estimate insertion commit in one transaction.
Entries survive pause, deletion, restarts, and reservation expiry. Short forward
reservations cover only the next minute, avoiding counting the accrued run twice.
The balance summary and usage page include outstanding estimates; settings label
them estimated. The operator `report` also includes
`estimated_balance_deductions_micros`. These are balance deductions and projected
overage, not Polar invoice events. Actual invoices continue to use confirmed
settlement through the existing invoice outbox.

The future Boxd adapter must provide `providerSandboxId` on confirmed execution
records, in addition to stable event/execution IDs. The
`api_cloud_billing_estimate_balances` view subtracts the union of confirmed time
windows for the same account, period, resource and machine from each estimate.
Partial windows release only the covered estimate; machine replacements cannot
release another machine's deductions. Original estimates remain for audit.
Confirmed records, ledger amounts and exports still commit together. As confirmed
cost replaces the estimate, available balance can rise or fall; no estimate is
also sent as a second provider charge. The provider feed itself is not implemented
until Boxd publishes its contract.

Rollout: verify the migration, approved USD schedule, prospective cutover, a
running workspace and image build, pause/resume, cap hold, and estimate visibility
in staging before enabling production. Read-only local tests do not activate
production billing. Reconcile sampled estimates against the forthcoming provider
feed before changing the invoice policy.
