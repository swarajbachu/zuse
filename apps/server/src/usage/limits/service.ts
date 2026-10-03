import {
	type AgentAvailability,
	type ProviderId,
	ProviderUsageLimits,
} from "@zuse/contracts";
import { Schema } from "effect";
import { fetchGeminiUsage } from "./gemini-usage.ts";
import { fetchGrokUsage } from "./grok-usage.ts";
import { fetchKiroUsage } from "./kiro-usage.ts";
import { unavailable } from "./shared.ts";

const TTL_MS = 60_000;
const UNAVAILABLE_TTL_MS = 5_000;
const AUTH_RETRY_MS = 5 * 60_000;
export const USAGE_FETCH_TIMEOUT_MS = 30_000;
export type UsageLimitFetcher = (
	signal: AbortSignal,
) => Promise<ProviderUsageLimits>;
const defaultFetchers = {
	claude: async () => unavailable("claude", "cli-unavailable"),
	codex: async () => unavailable("codex", "cli-unavailable"),
	grok: fetchGrokUsage,
	gemini: fetchGeminiUsage,
	kiro: fetchKiroUsage,
} satisfies Partial<Record<ProviderId, UsageLimitFetcher>>;
export type PolledProviderId = keyof typeof defaultFetchers;
export type UsageLimitFetchers = Partial<
	Record<PolledProviderId, UsageLimitFetcher>
>;
let fetchers: Record<PolledProviderId, UsageLimitFetcher> = {
	...defaultFetchers,
};
const cache = new Map<ProviderId, { at: number; value: ProviderUsageLimits }>();
const inFlight = new Map<ProviderId, Promise<ProviderUsageLimits>>();
const authRetryAt = new Map<ProviderId, number>();
const accountIdentity = new Map<ProviderId, string>();
const accountChangedAt = new Map<ProviderId, number>();
export const usageEventBelongsToCurrentAccount = (event: {
	providerId: ProviderId;
	createdAt: string;
}): boolean =>
	Date.parse(event.createdAt) >
	(accountChangedAt.get(event.providerId) ?? -Infinity);
export const observeUsageAccounts = (
	providers: ReadonlyArray<AgentAvailability>,
): void => {
	for (const provider of providers) {
		if (
			provider.authStatus !== "authenticated" &&
			provider.authStatus !== "unauthenticated"
		)
			continue;
		const identity = JSON.stringify([
			provider.authStatus,
			provider.authType,
			provider.authEmail,
		]);
		const previous = accountIdentity.get(provider.providerId);
		accountIdentity.set(provider.providerId, identity);
		if (previous !== undefined && previous !== identity)
			invalidateUsageLimits(provider.providerId);
	}
};
const generation = new Map<ProviderId, number>();

export const invalidateUsageLimits = (providerId: ProviderId): void => {
	accountChangedAt.set(providerId, Date.now());
	generation.set(providerId, (generation.get(providerId) ?? 0) + 1);
	cache.delete(providerId);
	inFlight.delete(providerId);
	authRetryAt.delete(providerId);
};
export const setUsageLimitFetcherForTest = (
	id: PolledProviderId,
	fetcher: UsageLimitFetcher,
): void => {
	fetchers[id] = fetcher;
};
export const resetUsageLimitsCacheForTest = () => {
	cache.clear();
	inFlight.clear();
	authRetryAt.clear();
	generation.clear();
	accountIdentity.clear();
	accountChangedAt.clear();
	fetchers = { ...defaultFetchers };
};
const authFailure = (value: ProviderUsageLimits): boolean =>
	value.unavailableReason === "no-credentials" ||
	value.unavailableReason === "expired" ||
	value.unavailableReason === "scope-missing";
const transientFailure = (value: ProviderUsageLimits): boolean =>
	value.unavailableReason === "error" ||
	value.unavailableReason === "timeout" ||
	value.unavailableReason === "invalid-response" ||
	value.unavailableReason === "cli-unavailable";

const loadProvider = (
	id: PolledProviderId,
	force: boolean,
	now: number,
	overrides: UsageLimitFetchers,
): Promise<ProviderUsageLimits> => {
	if (force) authRetryAt.delete(id);
	const cached = cache.get(id);
	const pending = inFlight.get(id);
	if (pending) return pending;
	if (
		!force &&
		cached &&
		now - cached.at <
			(cached.value.unavailableReason ? UNAVAILABLE_TTL_MS : TTL_MS)
	)
		return Promise.resolve({ ...cached.value, source: "cache" });
	const version = generation.get(id) ?? 0;
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout>;
	const timedOut = new Promise<ProviderUsageLimits>((resolve) => {
		timer = setTimeout(() => {
			resolve(unavailable(id, "timeout"));
			controller.abort();
		}, USAGE_FETCH_TIMEOUT_MS);
	});
	const operation = Promise.resolve()
		.then(() => (overrides[id] ?? fetchers[id])(controller.signal))
		.then((raw) => {
			try {
				const value = Schema.decodeUnknownSync(ProviderUsageLimits)(raw);
				if (
					value.providerId !== id ||
					!Number.isFinite(Date.parse(value.fetchedAt)) ||
					value.windows.some(
						(w) => w.usedPercent !== null && !Number.isFinite(w.usedPercent),
					)
				)
					return unavailable(id, "invalid-response");
				return value;
			} catch {
				return unavailable(id, "invalid-response");
			}
		})
		.catch((error: unknown) =>
			unavailable(
				id,
				error instanceof Error &&
					(error.name === "TimeoutError" || error.name === "AbortError")
					? "timeout"
					: "error",
			),
		);
	const promise = Promise.race([operation, timedOut])
		.then((value) => {
			if ((generation.get(id) ?? 0) !== version)
				return unavailable(id, "no-credentials");
			const result =
				transientFailure(value) &&
				cached &&
				(cached.value.windows.length > 0 ||
					cached.value.creditsRemaining !== null)
					? {
							...cached.value,
							source: "cache" as const,
							unavailableReason: value.unavailableReason,
						}
					: value;
			if (
				value.unavailableReason &&
				value.unavailableReason !== cached?.value.unavailableReason &&
				process.env.MEMOIZE_DEBUG_USAGE === "1"
			)
				console.info("[usage.limits]", id, value.unavailableReason);
			cache.set(id, { at: now, value: result });
			if (authFailure(value)) authRetryAt.set(id, now + AUTH_RETRY_MS);
			else authRetryAt.delete(id);
			return result;
		})
		.finally(() => {
			clearTimeout(timer);
			if (inFlight.get(id) === promise) inFlight.delete(id);
		});
	inFlight.set(id, promise);
	return promise;
};

export const loadUsageLimitsForPoll = (
	providerIds: ReadonlyArray<PolledProviderId>,
	now = Date.now(),
	overrides: UsageLimitFetchers = {},
): Promise<ProviderUsageLimits[]> =>
	Promise.all(
		providerIds
			.filter((id) => now >= (authRetryAt.get(id) ?? 0))
			.map((id) => loadProvider(id, false, now, overrides)),
	);

export const loadUsageLimitsCached = (
	force = false,
	providerId?: ProviderId,
	now = Date.now(),
	overrides: UsageLimitFetchers = {},
): Promise<ProviderUsageLimits[]> => {
	if (providerId)
		return providerId in fetchers
			? loadProvider(
					providerId as PolledProviderId,
					force,
					now,
					overrides,
				).then((value) => [value])
			: Promise.resolve([unavailable(providerId, "unsupported")]);
	return Promise.all(
		(Object.keys(fetchers) as PolledProviderId[]).map((id) =>
			loadProvider(id, force, now, overrides),
		),
	);
};
