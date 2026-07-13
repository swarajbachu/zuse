import { loadPricedUsage, type PricedUsage } from "tokenmaxer";

const PRICED_CACHE_TTL_MS = 60_000;

let pricedCache: { readonly at: number; readonly value: PricedUsage } | null =
	null;
let pricedInFlight: {
	readonly forceRefresh: boolean;
	readonly promise: Promise<PricedUsage>;
} | null = null;

export const resetUsageReportCacheForTest = (): void => {
	pricedCache = null;
	pricedInFlight = null;
};

export const loadPricedUsageCached = (
	zuseDbPath: string,
	cacheDir: string,
	opts: {
		readonly forceRefresh?: boolean;
		readonly load?: typeof loadPricedUsage;
		readonly now?: () => number;
	} = {},
): Promise<PricedUsage> => {
	const forceRefresh = opts.forceRefresh === true;
	const now = (opts.now ?? Date.now)();
	if (
		!forceRefresh &&
		pricedCache !== null &&
		now - pricedCache.at < PRICED_CACHE_TTL_MS
	) {
		return Promise.resolve(pricedCache.value);
	}
	if (
		pricedInFlight !== null &&
		(!forceRefresh || pricedInFlight.forceRefresh)
	) {
		return pricedInFlight.promise;
	}
	const load = opts.load ?? loadPricedUsage;
	const promise = load({
		readOptions: { zuseDbPath },
		pricing: { cacheDir },
	})
		.then((value) => {
			pricedCache = { at: (opts.now ?? Date.now)(), value };
			return value;
		})
		.finally(() => {
			if (pricedInFlight?.promise === promise) pricedInFlight = null;
		});
	pricedInFlight = { forceRefresh, promise };
	return promise;
};
