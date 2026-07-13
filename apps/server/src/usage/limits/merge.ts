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
		const key =
			event.window.windowMinutes === null
				? `label:${event.window.label}`
				: `window:${event.window.windowMinutes}`;
		const windows = base.windows.filter(
			(item) =>
				(item.windowMinutes === null
					? `label:${item.label}`
					: `window:${item.windowMinutes}`) !== key,
		);
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
