# Stripe billing and Polar migration

Zuse uses standard Stripe Billing and Stripe Tax through the official `stripe`
SDK. Zuse owns provider settlement, allowances, reservations, credits and spend
caps; Stripe owns payment collection, subscriptions and invoices.

## Configuration and prices

Apply `0040_stripe_billing` and `0041_stripe_legacy_outbox_default` before deploying. The latter keeps existing Polar Workers able to write usage during a database-first rollout. Existing periods, queued charges,
and historical entitlements retain their billing owner. Keep Polar credentials
and webhooks installed until its last subscription, usage export and outstanding
invoice have been reconciled.

Install `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` using `secret:stripe` and
`secret:stripe-webhook` (or their `:production` variants). Set:

- `STRIPE_ENVIRONMENT`: `sandbox` or `production`; the key must match.
- `STRIPE_PRICE_CLOUD_WORKSPACE_STANDARD_V1`: a USD $40 licensed monthly price.
- `STRIPE_CLOUD_OVERAGE_PRICE_ID`: a USD $0.01 monthly metered price, using the
  `zuse_cloud_overage_cent` sum meter with `value` and `stripe_customer_id` keys.
- `STRIPE_CLOUD_OVERAGE_METER_ID`: that meter's ID.
- `STRIPE_PRICE_PERSISTENT_STANDARD_V1`: optional separate machine offer price.
- `STRIPE_PORTAL_CONFIGURATION_ID`: the dedicated live customer portal config.
- `BILLING_DEFAULT_PROVIDER`: `stripe` for new checkout, `polar` for checkout
  rollback. Both adapters remain registered when their credentials are supplied.

The checked-in deployments keep `BILLING_DEFAULT_PROVIDER=polar`. Production's
live Stripe catalogue IDs are populated; staging's price IDs remain empty. Missing
Stripe overage configuration disables Stripe Cloud checkout. Checkout, invoice
export, informational usage export and enforcement retain independent gates.

Create unpriced informational meters for `zuse_cloud_runtime_observed_ms` and
`zuse_cloud_provider_cost_micros`. Never attach these to a subscription price.
Stripe only receives the already-rated overage cents for customer invoices:
$35 of included provider cost, 5% markup on additional provider cost, and the
existing customer cap remain in the local ledger. Informational attribution
remains in Zuse's durable export payload; Stripe's standard meter payload receives
only customer, value, event name, identifier and timestamp. Manual accounts with
no commercial period retain legacy Polar telemetry routing during coexistence.

Register `/v1/billing/webhook/stripe` for `customer.subscription.created`,
`updated`, `deleted`, `paused`, `resumed`, `invoice.paid` and
`invoice.payment_failed`. Signatures are checked against the raw body with Web
Crypto, then the current subscription is fetched before updating an entitlement.
Valid unrelated events are acknowledged without changing state. Persistent local
webhook deduplication continues to be owned by the shared entitlement store.

Checkout collects billing location and tax IDs and enables automatic tax. Configure
Stripe Tax registrations before rollout and arrange filing/remittance separately;
this integration does not make Stripe the merchant of record. Configure Stripe's
payment retries, invoice emails and Customer Portal in the Dashboard. Do not
allow portal changes to arbitrary prices or billing anchors during coexistence.

## Production setup

Run `bun run --cwd infra/api billing:stripe:production plan` without credentials
to inspect the production wiring. A sandbox key cannot configure live billing:
live prices, meters and the webhook signing secret belong to the live account.

Supply `STRIPE_SECRET_KEY` (`sk_live_` or permission-scoped `rk_live_`) through the environment, or point
`STRIPE_LIVE_KEY_FILE` at a private file containing the live key. Also set
`STRIPE_PRODUCT_TAX_CODE` to the business-verified Stripe product tax code if
available. It can be omitted while preparing the catalogue, leaving tax
classification explicitly pending before checkout activation. Then:

```sh
bun run --cwd infra/api billing:stripe:production prepare
bun run --cwd infra/api billing:stripe:production install-secrets
```

`prepare` verifies that the account can accept payments, creates/reuses the
$40 monthly base price, one-cent metered overage price and three sum meters,
creates a customer portal with invoice history, payment-method updates and
cancellation at period end, and registers the live webhook at
`https://api.zuse.sh/v1/billing/webhook/stripe` using the pinned SDK API version.
It writes the live IDs into `wrangler.production.jsonc`. Informational meters
have no prices. `install-secrets` verifies those resources and installs the key
and signing secret into the production Worker through Wrangler's stdin. Neither
command changes the checkout default, deploys code, creates subscriptions or
cancels Polar renewals. No tunnel is needed for the production endpoint.

If tax classification was left pending, configure the product's verified tax code
in Stripe before activation. Set the journal's `taxCode` to that same verified code
for subsequent verification; do not change creation-attempt payloads. Tax settings
and registrations require the real business details, never sandbox fixture addresses.

The private journal lives in `.context/stripe-production/state.json` with mode
0600 and contains the webhook signing secret, but not the API key. Keep it until
setup is complete: stable idempotency keys and persisted attempt times protect
interrupted operations. Ambiguous requests older than 23 hours, incompatible
resources and an existing webhook without its journal require reconciliation.
Do not delete the journal to bypass these checks. If a process dies leaving
`setup.lock`, verify that no setup process is running before removing that lock.
Use `STRIPE_PRODUCTION_ARTIFACT_DIR` to place the private journal elsewhere.

Before activation, apply the production database migration with the existing
guarded `db:migrate:production` command and approved production `DATABASE_URL`.
Complete the real business's tax registrations, payment retries, invoice emails,
Customer Portal settings and invoice finalization grace period. Deploy initially
with Polar as the default, then verify an actual live Stripe event reaches the
Worker and its receipt is persisted. Changing the API key is not this verification.

Production currently disables both financial export and admission enforcement,
and boxd settlement is also disabled. Verify provider settlement and its cutover
before enabling `CLOUD_BILLING_EXPORT_ENABLED` and
`CLOUD_BILLING_ENFORCEMENT_ENABLED`. The production deploy script rejects Stripe
as the checkout default unless both billing gates are enabled; its existing
provider checks also reject unverified boxd settlement. Only then switch
`BILLING_DEFAULT_PROVIDER` to `stripe` and deploy. Keep existing Polar subscribers
on Polar until the coordinated transfer below is complete.

## Delivery and reconciliation

Financial outbox rows retain provider, billing period and immutable event time;
changing the checkout default cannot reroute them. Stripe invoice events are
kept inside their original period, with first partial-minute usage timestamped
at the first full minute so adjacent Stripe summary windows remain disjoint.
Original execution times remain in the usage ledger. Period ownership conflicts
fail rather than replacing a period's balance, allowance or cap.

Stripe meter ingestion is asynchronous. An acknowledged request is not invoice
proof: compare ledger totals, remote meter summaries and the finalized invoice.
Mismatched summaries retry every five minutes once pending exports have settled.
Reconciliation batches prioritize the oldest attempt, including missing meters
and failed requests, so persistent failures cannot starve other periods.
Attempt timestamps are separate from authoritative observations; failed requests
never advance the last successful reconciliation timestamp.
Configure Stripe Workbench alerts for `v1.billing.meter.error_report_triggered`
and `v1.billing.meter.no_meter_found`; asynchronous meter rejection must be
investigated before enabling live invoice exports.

Remote usage IDs are SHA-256 hashes of stable ledger IDs. Durable delivery
receipts serialize competing workers and survive an accepted request followed
by a local acknowledgment failure. Never blindly replay an ambiguous request
once 23 hours have passed: Stripe's dedupe guarantee is only at least 24 hours.
The queue then reports `reconciliation-required`. Verify the remote result and
record the outcome through a reviewed database operation before replaying. Do
not delete a delivery receipt or use a fresh identifier to clear a failure.

Stripe accepts meter timestamps only within the preceding 35 days and five
minutes in the future. Out-of-window usage also requires reconciliation. A valid
backdated meter event does not amend a finalized invoice. The adapter checks the
original subscription period and allows late overage only while its metered
invoice remains draft. Configure a finalization grace period in Stripe to cover
provider settlement lag. Reconcile late provider
settlement against its original period; handle finalized invoices through a
reviewed credit note or supplemental invoice, never move costs into a newer
allowance or reset a timestamp to charge them automatically.

For unfinished customer creation older than 23 hours, scheduled billing
maintenance scans Stripe's customer list for exact `account_id` metadata matches.
Each run leases at most five accounts for five minutes and reads one page of
100 customers per account. Successful pages release their lease so the next
maintenance run can claim the saved cursor immediately; failed or interrupted
requests retain the five-minute retry lease. The last attempt time stays intact
for fair scheduling. Cursors and matches persist across failures and
Worker restarts. Checkout makes no lookup requests and returns
`reconciliation-required` until the scan is complete. A sole match is then bound;
an empty completed scan atomically renews the reservation with a fresh generation
and idempotency key. Multiple matches stop the scan and require operator review.
Concurrent renewals reuse the winning generation;
existing generation-zero reservations retain their original key. The original
creation timestamp is preserved so older Workers refuse expired reservations
during deployment rather than replaying an old key. A failed lookup cannot
trigger creation.
The list API is used because Stripe search cannot guarantee immediate consistency.

Apply migrations `0042_billing_recovery`, `0043_stripe_customer_recovery_jobs`
and `0044_stripe_customer_recovery_leases` before deploying these recovery paths.
Use `migrate-database.mjs` so the pending-recovery index is built concurrently
on its autocommit connection after transactional migrations; interrupted invalid
index builds are dropped concurrently and retried. Existing valid indexes remain
in place.
These add reservation generations, recovery cursors and an attempt scheduling
table without changing
existing customer bindings, meter observations, balances or invoice usage.

## Coordinated subscription transfer

The tool currently transfers the Cloud Workspace offer. Other legacy offers must
remain on Polar until a separately verified price mapping is available.

1. Run `bun run --cwd infra/api billing:stripe:migrate audit` with `DATABASE_URL`.
   Save the output securely; it contains internal billing identities, renewal
   dates, caps and outstanding overage. Inventory paid, past-due, pending and
   canceled-but-paid-through subscriptions separately; only active subscriptions
   are eligible for the scheduling command. No provider state changes in audit.
2. Obtain provider-assisted payment-method transfer confirmation from Polar and
   Stripe. This cannot be implemented by copying a customer or subscription ID.
   Unportable methods require customer reauthorization. No automatic cancellation
   may proceed without a working destination payment method.
3. Map imported customers to verified `account_id` metadata, default payment
   methods, billing addresses and tax IDs. Build a JSON manifest:

   ```json
   [{ "accountId": "account", "polarSubscriptionId": "polar_subscription",
      "stripeCustomerId": "cus_imported", "offerId": "cloud-workspace-standard-v1",
      "renewalAtMs": 1794000000000 }]
   ```

4. Run `billing:stripe:migrate plan MANIFEST.json`. The read-only plan checks live
   Polar state, local entitlements, Stripe customer ownership, default payment
   method and exact Stripe prices. It rejects duplicate identities, past renewal
   dates, mismatched paid-through dates and existing Stripe subscriptions.
5. Rehearse in Stripe sandbox with test clocks, including renewal, collection
   failure, duplicate webhook delivery and late Polar usage. Verify actual Stripe
   price and meter configuration before changing live checkout.
6. After payment portability is confirmed, run `billing:stripe:migrate schedule
   MANIFEST.json` with `ZUSE_CONFIRM_STRIPE_MIGRATION=schedule-verified-transfers`.
   Durable migration intent and idempotency prevent duplicated schedules on
   ordinary retries. Each schedule starts at the exact existing paid-through
   boundary with no proration, then releases into an ordinary Stripe subscription.
   The command does not cancel Polar and does not change Zuse balances.
7. Verify each pending schedule and customer binding. Disable the corresponding
   Polar renewal at period end through the provider's controls; do not revoke
   paid access. Finish this before the scheduled renewal to prevent two charges.
   If that step fails, cancel the pending Stripe schedule before its start and
   retain Polar. Track every account's outcome in the migration record.
8. At renewal verify Stripe collection, subscription entitlement, the new period's
   cap, and the old Polar period's final usage. Keep the old provider registered
   for late webhooks, exports and portal/invoice access during the transition.
   New periods inherit the last period's customer cap unless explicitly overridden;
   historical ledger and allowance records must not be rewritten.
9. Remove Polar only after the audit proves there are no remaining live/paid-through
   entitlements, pending exports, unpaid invoices or unresolved transfers.

Never enable two invoice generators for the same usage or replay historical
Polar usage into Stripe. The checkout rollback switch affects only new purchases;
rolling back already-scheduled renewals requires canceling the pending schedule
and verifying Polar renewal separately.

## Future AI and machine credits

Keep one local source of truth for admission, consumption, refunds, reservations
and spend caps. Add provider usage sources to the same settlement pipeline; keep
compute and model attribution in the usage ledger. New AI usage prices, shared
versus separate balances, top-up amounts, expiry and rollover rules are product
choices and are not launched by this migration.

Stripe Checkout can collect prepaid top-ups. Grant local spend only after verified
payment settlement; duplicate webhooks must not grant twice. Stripe Billing credit
grants apply to metered invoice lines at finalization, not live resource admission.
Choose one layer to deduct each allowance/credit: the current migration exports
net billable overage, so issuing the same allowance as a Stripe credit would deduct
it twice. Future credit-grant integration must reconcile this distinction before
being enabled.

## Verification

### Real Stripe sandbox runner

`infra/api/scripts/stripe-sandbox-test.mjs` exercises the production Stripe
adapter, PostgreSQL billing and delivery stores, financial exporter, and actual
`routeMachineRequest` webhook handler against Stripe's test API. It accepts only
`sk_test_` keys and a local PostgreSQL URL; each run creates an isolated schema.
It never changes the checked-in rollout gates or production configuration.

Run from the repository root. Set `STRIPE_SECRET_KEY` through secret injection
or `STRIPE_TEST_KEY_FILE` to a private file; do not put a credential in a shell
argument. Set `ZUSE_TEST_DATABASE_URL` to a disposable local PostgreSQL database
and create `.context/stripe-sandbox` (or set `STRIPE_TEST_ARTIFACT_DIR`).

1. Run `bun infra/api/scripts/stripe-sandbox-test.mjs prepare`.
2. In a separate terminal, run the same script with `serve`. Expose port 4317
   through a temporary HTTPS tunnel accessible without interactive authentication.
3. Set `STRIPE_TEST_PUBLIC_URL` to that origin and run `connect`.
4. Run `checkout`, open its hosted URL, and exercise test-card decline, 3-D Secure
   and successful checkout. `inspect` checks payment, tax and receipt ownership.
5. Run `run`, `faults`, `recovery`, `migration` and `migration-finish` sequentially. Each prints
   verified results and saves IDs and evidence in the artifact directory.
6. Run `cleanup` before stopping the server/tunnel. It removes the temporary
   webhook, cancels this run's subscriptions and schedules, expires the test tax
   registration it created, and retains paid invoices/customers for inspection.

The runner initializes sandbox Tax settings only if missing, using an explicitly
fictional US fixture address. Those sandbox settings and test prices/meters remain
after cleanup; their previous values are recorded in `state.json`. They are not
production business settings. `state.json` contains the signing secret until
cleanup and must remain private and gitignored. A lock prevents two mutating
runner commands from overwriting each other's state; `serve` may run alongside
one command. Interrupted financial scenarios reuse recorded fixture identities;
other interrupted fixture-creation scenarios require inspecting the recorded IDs
before retrying. Never remove the state file to bypass an ambiguous operation.

The tests compare ledger, remote aggregate and paid invoice for $34, $35, $36 and
$100 provider costs; verify a $25 cap and reservation rejection; simulate lost
acknowledgment after real meter ingestion; replay concurrent and stale webhooks;
and verify real failed renewal, billing hold and recovery. Clocks start in the
past so usage timestamps remain valid against Stripe's wall-clock ingestion
window. The migration scenario verifies Stripe schedule parameters and exact
renewal timing; it does not transfer payment methods or run Polar cancellation.

This is core billing integration verification with an isolated local HTTP server,
not a deployed Cloudflare Worker or authenticated desktop UI test. Hosted browser
payment and any desktop/staging checks must be recorded separately. Prepaid
top-ups, rollover and shared AI/machine balances remain unimplemented and are not
claimed as tested by this runner.

Run billing-provider and API unit tests, affected type checks, Biome, migration
planner tests and PostgreSQL integration tests. Local PostgreSQL tests exercise
concurrent delivery claims, restart receipts, legacy backfill, ledger rollback and
provider routing; they do not establish live payment portability or Stripe invoice
correctness. Record a staged provider-to-ledger-to-Stripe invoice example before
switching live checkout or invoice export.
