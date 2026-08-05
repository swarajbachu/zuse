import { BillingProviders } from "@zuse/billing-providers";
import { Effect } from "effect";

export const cancelProviderSubscription = Effect.fn(
	"cancelProviderSubscription",
)(function* (input: {
	readonly providerId: string;
	readonly providerSubscriptionId: string;
}) {
	const providers = yield* BillingProviders;
	const provider = yield* providers.get(input.providerId);
	yield* provider.cancel(input.providerSubscriptionId);
});
