# Billing provider adapters

This package owns the billing-provider seam and registry. Checkout, checkout
lookup, webhook verification, subscription reconciliation, cancellation, and
customer portals are implemented by `BillingProviderAdapter`s.

Each adapter must:

- use a stable, unique `providerId`;
- keep product/price mapping private to the adapter;
- verify webhook signatures before decoding provider events;
- normalize subscriptions to `ReconciledSubscription`;
- normalize checkout sessions to `CheckoutSummary`, resolving `null` for
  unknown ids **and for checkouts owned by another account**, and omitting
  customer identity — a checkout id is browser-visible and it feeds the
  unauthenticated post-purchase page;
- make cancellation idempotent;
- keep credentials and raw provider payloads inside the adapter.

Register every adapter that may own an existing entitlement. Changing
`defaultProviderId` affects new checkout sessions only. Existing entitlements
continue to resolve by their persisted provider ID. Provider webhooks use
`/v1/billing/webhook/:providerId`; the unqualified endpoint is accepted only
while exactly one billing adapter is registered.

## Polar

The `@zuse/billing-providers/polar` adapter uses Polar's server-side SDK. It
maps the internal offer ID to a Polar product ID, creates checkout and customer
portal sessions, validates Standard Webhooks signatures, and reconciles every
event against the current subscription before changing an entitlement.

Configure the webhook endpoint as:

```text
https://<relay-host>/v1/billing/webhook/polar
```

Subscribe it to subscription created, updated, active, past due, canceled,
revoked, and uncanceled events. The relay keeps the manual adapter registered
for existing manual alpha entitlements, so the provider-qualified webhook URL
is required.

Start with a sandbox organization and token. Store the access token and webhook
secret as platform secrets; never place either in `wrangler.jsonc`. Production
checkout remains separately gated by product-category approval.
