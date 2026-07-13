import type { ProviderId, ProviderUsageLimits } from "@zuse/contracts";

import { fetchClaudeUsage } from "./claude-usage.ts";
import { fetchCodexUsage } from "./codex-usage.ts";
import { fetchGeminiUsage } from "./gemini-usage.ts";
import { fetchGrokUsage } from "./grok-usage.ts";

const TTL = 60_000;
const FORCE_FLOOR = 10_000;
const defaultFetchers = {
	claude: fetchClaudeUsage,
	codex: fetchCodexUsage,
	grok: fetchGrokUsage,
	gemini: fetchGeminiUsage,
} satisfies Partial<Record<ProviderId, () => Promise<ProviderUsageLimits>>>;
export type PolledProviderId = keyof typeof defaultFetchers;
let fetchers = { ...defaultFetchers };
const cache = new Map<ProviderId, { at: number; value: ProviderUsageLimits }>();
const inFlight = new Map<ProviderId, Promise<ProviderUsageLimits>>();
const lastForcedAt = new Map<ProviderId, number>();
const authSuppressedForPoll = new Set<ProviderId>();

export const setUsageLimitFetcherForTest = (
	providerId: PolledProviderId,
	fetcher: () => Promise<ProviderUsageLimits>,
): void => {
	fetchers[providerId] = fetcher;
};

export const resetUsageLimitsCacheForTest = () => {
	cache.clear();
	inFlight.clear();
	lastForcedAt.clear();
	authSuppressedForPoll.clear();
	fetchers = { ...defaultFetchers };
};

const loadProvider = (
	providerId: keyof typeof fetchers,
	force: boolean,
	now: number,
): Promise<ProviderUsageLimits> => {
	const effectiveForce =
		force && now - (lastForcedAt.get(providerId) ?? 0) >= FORCE_FLOOR;
	if (force) authSuppressedForPoll.delete(providerId);
	const cached = cache.get(providerId);
	if (!effectiveForce && cached && now - cached.at < TTL)
		return Promise.resolve({ ...cached.value, source: "cache" });
	const pending = inFlight.get(providerId);
	if (pending) return pending;
	if (effectiveForce) lastForcedAt.set(providerId, now);
	const promise = fetchers[providerId]()
		.then((value) => {
			cache.set(providerId, { at: now, value });
			return value;
		})
		.finally(() => inFlight.delete(providerId));
	inFlight.set(providerId, promise);
	return promise;
};

const suppressesBackgroundPoll = (value: ProviderUsageLimits): boolean =>
	value.unavailableReason === "no-credentials" ||
	value.unavailableReason === "expired" ||
	value.unavailableReason === "scope-missing";

export const loadUsageLimitsForPoll = async (
	providerIds: ReadonlyArray<PolledProviderId>,
	now = Date.now(),
): Promise<ProviderUsageLimits[]> =>
	Promise.all(
		providerIds
			.filter((providerId) => !authSuppressedForPoll.has(providerId))
			.map(async (providerId) => {
				const value = await loadProvider(providerId, false, now);
				if (suppressesBackgroundPoll(value))
					authSuppressedForPoll.add(providerId);
				return value;
			}),
	);

export const loadUsageLimitsCached = (
	force = false,
	providerId?: ProviderId,
	now = Date.now(),
): Promise<ProviderUsageLimits[]> => {
	if (providerId && providerId in fetchers)
		return loadProvider(providerId as keyof typeof fetchers, force, now).then(
			(value) => {
				if (!suppressesBackgroundPoll(value))
					authSuppressedForPoll.delete(providerId);
				return [value];
			},
		);
	return Promise.all(
		(Object.keys(fetchers) as Array<keyof typeof fetchers>).map((id) =>
			loadProvider(id, force, now),
		),
	).then((values) => {
		for (const value of values)
			if (!suppressesBackgroundPoll(value))
				authSuppressedForPoll.delete(value.providerId);
		return values;
	});
};
