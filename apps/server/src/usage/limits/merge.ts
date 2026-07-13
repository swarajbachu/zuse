import type {
	ProviderId,
	ProviderUsageLimits,
	UsageLimitWindow,
} from "@zuse/contracts";

export type SessionUsageWindow = {
	providerId: ProviderId;
	window: UsageLimitWindow;
	createdAt: string;
};

export const usageWindowKey = (window: UsageLimitWindow): string =>
	window.scope === "model"
		? `model:${window.label.trim().toLowerCase()}`
		: window.scope;

export const mergeUsageLimits = (
	fetched: readonly ProviderUsageLimits[],
	events: readonly SessionUsageWindow[],
): ProviderUsageLimits[] => {
	const result = new Map(
		fetched.map((provider) => [
			provider.providerId,
			{ ...provider, windows: [...provider.windows] },
		]),
	);
	for (const event of events) {
		const current = result.get(event.providerId);
		if (current && Date.parse(event.createdAt) <= Date.parse(current.fetchedAt))
			continue;
		const base = current ?? {
			providerId: event.providerId,
			planLabel: null,
			creditsRemaining: null,
			fetchedAt: event.createdAt,
			source: "session-event" as const,
			windows: [],
		};
		const key = usageWindowKey(event.window);
		const windows = base.windows.filter((item) => usageWindowKey(item) !== key);
		windows.push(event.window);
		result.set(event.providerId, {
			...base,
			windows,
			fetchedAt: event.createdAt,
			source: "session-event",
			unavailableReason: undefined,
		});
	}
	return [...result.values()];
};
