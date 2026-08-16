# Cloud billing operations

Cloud billing is deliberately fail-safe. Without `CLOUD_BILLING_CUTOVER_AT`,
provider evidence is retained but no execution is charged. Enforcement and Polar
export default to disabled independently.

The Cloud Workspace subscription is $40 monthly and includes $35 of attributable
provider compute. Additional provider cost receives a 5% markup, subject to a
$25 default pre-tax overage cap selected by the user.

## Provider boundary

The ledger, billing periods, reservations, cap enforcement, and Polar export are
provider-neutral. Each sandbox provider owns an adapter that verifies its
webhooks and normalizes lifecycle data into `ProviderExecutionEvidence`. The
shared metering pipeline attributes the internal resource, applies that
provider's immutable price schedule, and atomically finalizes the provider event
with all usage, ledger, and outbox records. E2B is the first adapter; Daytona,
Morph, Box, or another provider should integrate at this boundary rather than
adding a separate billing pipeline. Raw payloads expire after 90 days; the
pseudonymous finalization key remains for seven years so old redeliveries cannot
be billed again.

## Provider setup

1. Apply migration `0010_cloud_billing_ledger`.
2. In Polar, configure the Cloud Workspace product with a fixed USD $40 monthly
   price and a metered price of $0.01 per `zuse_cloud_overage_cent`.
   Configure the meter to sum the numeric `units` metadata field and set its ID
   in `POLAR_CLOUD_OVERAGE_METER_ID` so the relay can reconcile exported cents.
3. Register the relay endpoint `/v1/cloud/billing/webhook/e2b` for all E2B
   lifecycle event types. Store its signature secret with
   `bun run --cwd infra/relay secret:e2b-webhook`.
4. Set `CLOUD_BILLING_CUTOVER_AT` to an explicit ISO-8601 timestamp. Existing
   executions are clipped at this boundary and are never back-billed.

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
bun run --cwd infra/relay cloud-billing:ops import-provider-statement e2b AMOUNT_MICROS START_MS END_MS EXTERNAL_ID
bun run --cwd infra/relay cloud-billing:ops import-platform-cost polar transaction-fee AMOUNT_MICROS START_MS END_MS EXTERNAL_ID
bun run --cwd infra/relay cloud-billing:ops import-platform-cost cloudflare monthly AMOUNT_MICROS START_MS END_MS EXTERNAL_ID
bun run --cwd infra/relay cloud-billing:ops report PERIOD_ID
```

Provider price changes must be inserted as a new immutable
`relay_provider_price_schedule` row with a unique version and effective time.
Never update an existing price row.
