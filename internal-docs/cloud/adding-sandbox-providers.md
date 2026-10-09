# Adding a sandbox provider: usage and billing requirements

Usage reporting is a required part of every new sandbox provider integration.
An adapter that can create, pause, and resume machines is not complete until its
workspace and image-build usage reaches the owning billing processor with the correct account and
resource attribution. This applies even when usage is covered by the included
allowance or invoice export is disabled.

This is a release checklist for contributors and agents. The implementation and
rollout details remain in [Cloud billing operations](billing.md); reuse that
pipeline rather than implementing provider-specific payment-processor calls.

## Required integration

1. **Preserve attribution.** Persist the stable provider ID, provider sandbox ID,
   owning account, and workspace or build ID. Resolve resources through
   provider-keyed store lookups; machine names are not financial identities.
   Record the actual placement's compute dimensions, including size overrides.
2. **Support runtime observations.** Implement the provider adapter's `inspect`
   operation with accurate running/paused/missing state. Inspection must read
   state without waking a machine. Workspace and build reconciliation must use
   the shared observation path, including pause, resume, replacement, and
   deletion transitions. Document provider states that cannot be distinguished.
3. **Provide settlement evidence.** For billable placement, supply durable
   execution boundaries and an attributable cost source: exact-window reported
   cost or an explicitly approved immutable price schedule. Normalize evidence
   into the existing provider-neutral metering pipeline. Register lifecycle
   ingestion and recovery through `BillingUsageSourceModule` where applicable.
   Verify webhook signatures and reject invalid financial evidence.
4. **Use the shared ledger and queue.** Confirmed usage, financial ledger entries,
   event finalization, and export records must commit atomically. Preserve
   stable execution identities across redelivery and polling. Split costs at
   billing-period boundaries and honor the configured cutover. Provider failures
   must remain retryable without blocking unrelated resources.
5. **Verify billing delivery.** Runtime and confirmed-cost records must flow through
   the shared durable usage outbox. Preserve original timestamps and stable
   external IDs on retries. Check both workspace and build attribution in the billing processor;
   a successful provider request or a local reservation is not delivery proof.

## Keep visibility separate from charges

The shared pipeline has three distinct event types:

| Usage event | Meaning | Invoice use |
| --- | --- | --- |
| `zuse_cloud_runtime_observed_ms` | Sampled runtime, including providers without exact cost feeds | Informational only |
| `zuse_cloud_provider_cost_micros` | Confirmed compute cost in USD micro-units, including allowance-covered usage | Informational only |
| `zuse_cloud_overage_cent` | Customer overage after allowance, markup, credits, and cap policy | Existing overage price only |

`CLOUD_USAGE_EXPORT_ENABLED` controls usage visibility independently of
`CLOUD_BILLING_EXPORT_ENABLED` and `CLOUD_BILLING_ENFORCEMENT_ENABLED`.
Informational meters must filter on their exact event names and must not be
attached to the overage price. `billable=false` metadata alone is not a payment-processor
pricing safeguard.

If the provider cannot supply reliable settlement evidence, runtime visibility
is still mandatory. Document the limitation and exclude that provider from
billing-enforced placement using the shared availability/deployment policy.
Runtime observations, reservations, organization balance changes, and approximate
cost displays must not become confirmed customer charges. Any new retail rate
or currency-conversion policy requires an explicit product decision. Boxd supports completed USD per-machine estimates behind an explicit pricing-policy
opt-in; these are labeled separately from actual organization charges. Boat's
integration exports confirmed provider cost.

## Required verification before rollout

- Exercise workspace and image-build usage, multiple sizes, pause/resume,
  provider auto-suspension, missing machines, and sandbox replacement. Paused or
  unknown state must not silently become running usage.
- Test duplicate and out-of-order observations, webhook/poll redelivery,
  concurrent workers, transaction rollback, process restart, provider outages,
  and billing-processor timeouts. Retrying an accepted export must reuse its external ID.
- For settlement, test cutover clipping, billing-period boundaries, missing
  evidence, invalid costs, and partial provider responses. No partial execution
  may be charged when required evidence is unavailable.
- Verify usage export with invoice export disabled and with zero overage.
  Confirm that informational events do not move the overage meter.
- Run applicable Biome checks, type checks, unit tests, and PostgreSQL integration
  tests. Record skipped checks and reasons; mocks alone do not establish durable
  concurrency or live billing delivery.
- Apply required migrations before deploying the Worker. In staging, record a
  complete provider-to-ledger-to-billing-processor example, including account/resource IDs,
  event names, timestamps, units, retry behavior, and any measurement gaps.
  Reconcile settlement against provider evidence before enabling invoice export.

The integration's rollout record must state whether it supports observed runtime,
confirmed cost settlement, and invoice export, with verification for each.
Configuration changes and passing local tests are not a production deployment.

## Implementation entry points

- [Sandbox adapter contract](../../packages/sandbox-providers/src/index.ts)
- [Workspace and build reconciliation](../../infra/api/src/cloud-workspace-reconciler.ts)
- [Shared usage observation and export](../../infra/api/src/cloud-usage.ts)
- [Usage checkpoints and durable outbox](../../infra/api/src/cloud-usage-store.ts)
- [Provider usage-source contract](../../infra/api/src/cloud-billing-usage-source.ts)
- [Usage-source registration](../../infra/api/src/cloud-billing-usage-source-config.ts)
- [Provider-neutral settlement](../../infra/api/src/cloud-billing-provider.ts)
- [Billing ledger store](../../infra/api/src/cloud-billing-store.ts)
- [Placement billing eligibility](../../infra/api/src/sandbox-provider-availability.ts)
