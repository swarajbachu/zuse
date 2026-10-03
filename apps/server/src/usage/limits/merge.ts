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
	now = Date.now(),
): ProviderUsageLimits[] => {
	const result = new Map(
		fetched.map((provider) => [
			provider.providerId,
			{ ...provider, windows: [...provider.windows] },
		]),
	);
	const seen = new Set<string>();
	for (let event of [...events].sort(
		(a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
	)) {
		if (event.window.id === "seven_day_overage_included") {
			const scoped =
				result
					.get(event.providerId)
					?.windows.filter((w) => w.id.startsWith("weekly-scoped:")) ?? [];
			// The event does not name the model. Only reconcile an unambiguous API bucket.
			if (scoped.length !== 1 || !scoped[0]) continue;
			event = {
				...event,
				window: { ...event.window, id: scoped[0].id, label: scoped[0].label },
			};
		}
		const stamp = Date.parse(event.createdAt);
		const reset =
			event.window.resetsAt === null ? null : Date.parse(event.window.resetsAt);
		if (
			!Number.isFinite(stamp) ||
			(reset !== null
				? !Number.isFinite(reset) || reset <= now
				: now - stamp > 30 * 60_000)
		)
			continue;
		const eventKey = `${event.providerId}:${usageWindowKey(event.window)}`;
		if (seen.has(eventKey)) continue;
		seen.add(eventKey);
		const current = result.get(event.providerId);
		const snapshot = fetched.find(
			(item) => item.providerId === event.providerId,
		);
		if (
			snapshot &&
			(!snapshot.unavailableReason ||
				snapshot.windows.some(
					(window) => usageWindowKey(window) === usageWindowKey(event.window),
				)) &&
			stamp <= Date.parse(snapshot.fetchedAt)
		)
			continue;
		if (
			snapshot?.unavailableReason &&
			["no-credentials", "expired", "scope-missing", "unsupported"].includes(
				snapshot.unavailableReason,
			)
		)
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
		const previous = base.windows.find((item) => usageWindowKey(item) === key);
		windows.push({ ...event.window, id: previous?.id ?? event.window.id });
		// A streamed window cannot confirm the freshness of the other cached
		// windows or credits. Keep their original age until polling recovers.
		const staleSnapshot =
			snapshot?.unavailableReason &&
			(snapshot.windows.length > 0 || snapshot.creditsRemaining !== null);
		result.set(event.providerId, {
			...base,
			windows,
			fetchedAt: staleSnapshot
				? snapshot.fetchedAt
				: current?.windows.length && Date.parse(current.fetchedAt) > stamp
					? current.fetchedAt
					: event.createdAt,
			source: "session-event",
			unavailableReason: staleSnapshot ? snapshot.unavailableReason : undefined,
		});
	}
	return [...result.values()];
};
