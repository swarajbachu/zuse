import type {
	AnalyticsEventName,
	AnalyticsIdentityKind,
	AnalyticsProperties,
} from "./events.ts";

export interface AnalyticsClient {
	readonly capture: (
		event: AnalyticsEventName,
		properties?: AnalyticsProperties,
	) => void;
	readonly setIdentity: (
		distinctId: string,
		kind: AnalyticsIdentityKind,
	) => void;
	readonly setEnabled: (enabled: boolean) => void;
	readonly flush: () => Promise<void>;
}

export const noopAnalyticsClient: AnalyticsClient = {
	capture: () => {},
	setIdentity: () => {},
	setEnabled: () => {},
	flush: async () => {},
};
