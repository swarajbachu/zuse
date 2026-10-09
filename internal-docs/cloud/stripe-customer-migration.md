# Customer transfer and communication

The last production audit found four active Polar subscriptions. None have been
transferred. Switch new purchases to Stripe only after deployment and live
verification; existing subscriptions can remain on Polar during preparation.

## Preserve the existing records

Keep the Zuse account ID, credits, spend cap, paid-through date, usage ledger and
historical invoice references. Create a Stripe customer mapped to that account;
do not replace the account or reset its current allowance. Historical Polar
invoices and outstanding usage retain their original billing owner. New monthly
allowances follow the normal renewal policy.

Run the audit and per-customer plan in [the billing runbook](stripe-billing.md#coordinated-subscription-transfer).
Verify the actual price and offer before promising unchanged pricing. The
current migration command supports the Cloud Workspace offer only.

## Establish a payment method

Ask Polar and Stripe whether a provider-assisted transfer is supported for these
accounts and payment methods. Stripe requires an approved payment-data import;
the Zuse database cannot export usable cards or move subscriptions automatically.
Do not tell customers that no action is required until transfer is confirmed.

If transfer is unavailable, collect customer authorization and a payment method
using an authenticated, account-bound Stripe Checkout **setup-mode** session.
The setup flow must verify successful completion server-side, bind the payment
method to the expected customer, and set it as the default for future renewals.
This migration setup flow is not implemented yet. Ordinary Zuse purchase checkout
starts a paid subscription immediately and must not be used as a replacement.

Create and verify a Stripe subscription schedule starting at the exact current
paid-through date. Then stop that customer's Polar renewal at period end,
preserving paid access. If Polar renewal cannot be stopped, cancel the pending
Stripe schedule before it starts. Keep an outcome record for every customer.

Tax settings must be consistent across ordinary checkout and migration schedules.
Both currently enable automatic tax; a launch without Stripe Tax requires changing
both paths. Do not promise unchanged taxes or an identical final invoice amount.

## Notify customers

Send each customer an email and show the same notice in authenticated billing
settings before the transfer. With four subscriptions, handle each customer
individually and confirm receipt. Choose the date only after the secure payment
setup flow and subscription scheduling are ready. Leave nonresponders on Polar
while their current renewal continues to work; do not silently cancel them.

For customers who must reauthorize payment, use this draft after the flow is ready:

> Subject: Update your payment details for Zuse
>
> We're moving Zuse billing from Polar to Stripe. Your Zuse account, workspaces,
> existing credits, plan price and renewal date will stay the same.
>
> Before [deadline], open Zuse's billing settings and select [migration action]
> to securely confirm your payment details with Stripe. Confirming your payment
> details won't charge you; Stripe billing starts on your existing renewal date,
> [renewal date]. We will stop your Polar renewal before the transfer so the same
> subscription period is not charged twice.
>
> Your previous invoices remain available from Polar. If you need help, reply
> to this email.

Use the price-preservation sentence only after the customer's actual plan has
been validated. Before sending, fill the action, dates and support details, and
disclose any actual changes to taxes, seller details or invoice/payment descriptors.
For approved automatic transfers, replace the payment-action paragraph with the
verified transfer date and whether any customer action is required.

Send one reminder to customers still missing authorization before the deadline,
and send confirmation after the transfer succeeds. Do not request card details
over email. This document is a draft; no customer messages have been sent.

Sources: [Stripe subscription migration](https://docs.stripe.com/billing/subscriptions/import-subscriptions),
[payment-data imports](https://docs.stripe.com/get-started/data-migrations/pan-import),
[saving payment methods with Checkout](https://docs.stripe.com/payments/checkout/set-up-future-payments).
