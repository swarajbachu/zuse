import { Effect } from "effect";
import { BillingProviderError } from "./index.ts";
import type { StripeBillingStore } from "./stripe.ts";

/** Durable lease plus Stripe idempotency; ambiguous old writes require reconciliation. */
export const deliverStripeOperation = (
	store: Pick<StripeBillingStore, "claimDelivery" | "finishDelivery">,
	key: string,
	payload: unknown,
	send: () => Promise<void>,
	beforeSend: Effect.Effect<void, BillingProviderError> = Effect.void,
): Effect.Effect<void, BillingProviderError> => {
	const call = <A>(operation: () => Promise<A>) =>
		Effect.tryPromise({
			try: operation,
			catch: () => new BillingProviderError({ code: "provider-unavailable" }),
		});
	return Effect.gen(function* () {
		const claim = yield* call(() =>
			store.claimDelivery(key, JSON.stringify(payload)),
		);
		if (claim === "sent") return;
		if (claim === "expired")
			return yield* new BillingProviderError({
				code: "reconciliation-required",
			});
		if (claim === "busy")
			return yield* new BillingProviderError({ code: "provider-unavailable" });
		const result = yield* beforeSend.pipe(
			Effect.andThen(call(send)),
			Effect.result,
		);
		yield* call(() => store.finishDelivery(key, result._tag === "Success"));
		if (result._tag === "Failure") return yield* result.failure;
	});
};
