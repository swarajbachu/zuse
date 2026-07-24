import type { AnalyticsEventName, AnalyticsProperties } from "@zuse/analytics";
import type { AnalyticsContext } from "@zuse/contracts";
import { Context, type Effect, type Stream } from "effect";

export interface AnalyticsServiceShape {
	readonly getContext: () => Effect.Effect<AnalyticsContext>;
	readonly contextChanges: () => Stream.Stream<AnalyticsContext>;
	readonly capture: (
		event: AnalyticsEventName,
		properties?: AnalyticsProperties,
	) => Effect.Effect<void>;
	readonly flush: Effect.Effect<void>;
}

export class AnalyticsService extends Context.Service<
	AnalyticsService,
	AnalyticsServiceShape
>()("zuse/AnalyticsService") {}
