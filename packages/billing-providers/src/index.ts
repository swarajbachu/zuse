import {
	makeProviderRegistry,
	type ProviderRegistry,
	type ProviderRegistryConfigError,
} from "@zuse/provider-registry";
import { Context, Effect, Layer, Schema } from "effect";

export class BillingProviderError extends Schema.TaggedErrorClass<BillingProviderError>()(
	"BillingProviderError",
	{
		code: Schema.Literals([
			"checkout-disabled",
			"invalid-event",
			"provider-unavailable",
		]),
	},
) {}

export interface ReconciledSubscription {
	readonly accountId: string;
	readonly providerSubscriptionId: string;
	readonly status: "pending" | "active" | "grace" | "ended";
	readonly offerId: string;
	readonly fulfillmentMetadata?: Readonly<Record<string, string>>;
	readonly periodStart?: number;
	readonly paidThrough?: number;
}

export interface BillingProviderAdapter {
	readonly providerId: string;
	readonly checkout: (input: {
		readonly accountId: string;
		readonly offerId: string;
		readonly successUrl: string;
		readonly fulfillmentMetadata?: Readonly<Record<string, string>>;
	}) => Effect.Effect<string, BillingProviderError>;
	readonly verifyEvent: (
		request: Request,
	) => Effect.Effect<
		{ readonly eventId: string; readonly subscriptionId: string },
		BillingProviderError
	>;
	readonly reconcileSubscription: (
		subscriptionId: string,
	) => Effect.Effect<ReconciledSubscription, BillingProviderError>;
	readonly cancel: (
		subscriptionId: string,
	) => Effect.Effect<void, BillingProviderError>;
	readonly customerPortal: (
		accountId: string,
	) => Effect.Effect<string, BillingProviderError>;
	readonly reportMeterEvent?: (input: {
		readonly accountId: string;
		readonly eventName: string;
		readonly units: number;
		readonly idempotencyKey: string;
		readonly metadata?: Readonly<Record<string, string>>;
	}) => Effect.Effect<void, BillingProviderError>;
	readonly reconcileMeter?: (input: {
		readonly accountId: string;
		readonly meterId: string;
	}) => Effect.Effect<number, BillingProviderError>;
}

export interface BillingProvidersApi
	extends ProviderRegistry<BillingProviderAdapter> {}

export class BillingProviders extends Context.Service<
	BillingProviders,
	BillingProvidersApi
>()("@zuse/billing-providers/BillingProviders") {
	static readonly layer = (input: {
		readonly adapters: ReadonlyArray<BillingProviderAdapter>;
		readonly defaultProviderId: string;
	}): Layer.Layer<BillingProviders, ProviderRegistryConfigError> =>
		Layer.effect(
			BillingProviders,
			makeProviderRegistry(input).pipe(Effect.map(BillingProviders.of)),
		);
}

export const BillingProviderManual: BillingProviderAdapter = {
	providerId: "manual",
	checkout: () => new BillingProviderError({ code: "checkout-disabled" }),
	verifyEvent: () => new BillingProviderError({ code: "checkout-disabled" }),
	reconcileSubscription: () =>
		new BillingProviderError({ code: "checkout-disabled" }),
	cancel: () => Effect.void,
	customerPortal: () => new BillingProviderError({ code: "checkout-disabled" }),
	reportMeterEvent: () =>
		new BillingProviderError({ code: "checkout-disabled" }),
	reconcileMeter: () => new BillingProviderError({ code: "checkout-disabled" }),
};

export const BillingProvidersManual = BillingProviders.layer({
	adapters: [BillingProviderManual],
	defaultProviderId: BillingProviderManual.providerId,
}).pipe(Layer.orDie);
