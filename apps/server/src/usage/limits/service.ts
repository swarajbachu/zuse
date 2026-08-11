import type { ProviderId, ProviderUsageLimits } from "@zuse/contracts";

import { fetchClaudeUsage } from "./claude-usage.ts";
import { fetchCodexUsage } from "./codex-usage.ts";
import { fetchGeminiUsage } from "./gemini-usage.ts";
import { fetchGrokUsage } from "./grok-usage.ts";
import { fetchKiroUsage } from "./kiro-usage.ts";

const TTL_MS = 60_000;
/** Auth misses should not stick for a full minute — retry quickly. */
const UNAVAILABLE_TTL_MS = 5_000;
const defaultFetchers = {
	claude: fetchClaudeUsage,
	codex: fetchCodexUsage,
	grok: fetchGrokUsage,
	gemini: fetchGeminiUsage,
	kiro: fetchKiroUsage,
} satisfies Partial<Record<ProviderId, () => Promise<ProviderUsageLimits>>>;
export type PolledProviderId = keyof typeof defaultFetchers;
let fetchers = { ...defaultFetchers };
const cache = new Map<ProviderId, { at: number; value: ProviderUsageLimits }>();
const inFlight = new Map<ProviderId, Promise<ProviderUsageLimits>>();
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
	authSuppressedForPoll.clear();
	fetchers = { ...defaultFetchers };
};

const suppressesBackgroundPoll = (value: ProviderUsageLimits): boolean =>
	value.unavailableReason === "no-credentials" ||
	value.unavailableReason === "expired" ||
	value.unavailableReason === "scope-missing";

const cacheTtlMs = (value: ProviderUsageLimits): number =>
	suppressesBackgroundPoll(value) || value.unavailableReason === "error"
		? UNAVAILABLE_TTL_MS
		: TTL_MS;

const loadProvider = (
	providerId: keyof typeof fetchers,
	force: boolean,
	now: number,
): Promise<ProviderUsageLimits> => {
	if (force) authSuppressedForPoll.delete(providerId);
	const cached = cache.get(providerId);
	// Force always bypasses cache. Soft loads skip only while a *healthy*
	// result is fresh — auth misses / errors re-fetch after a short window
	// so a transient SQLite lock or expired token does not stick.
	if (
		!force &&
		cached !== undefined &&
		now - cached.at < cacheTtlMs(cached.value)
	) {
		return Promise.resolve({ ...cached.value, source: "cache" });
	}
	const pending = inFlight.get(providerId);
	if (pending) return pending;
	const promise = fetchers[providerId]()
		.then((value) => {
			cache.set(providerId, { at: now, value });
			if (process.env.MEMOIZE_DEBUG_USAGE === "1") {
				console.info(
					`[usage.limits] ${providerId}`,
					value.unavailableReason ?? "ok",
					`windows=${value.windows.length}`,
					value.planLabel ?? "",
				);
			}
			return value;
		})
		.finally(() => inFlight.delete(providerId));
	inFlight.set(providerId, promise);
	return promise;
};

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
