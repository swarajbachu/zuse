export type MediaCachePolicyEntry = {
	readonly key: string;
	readonly sizeBytes: number;
	readonly accessedAt: number;
};

export const selectMediaCacheEvictions = (
	entries: readonly MediaCachePolicyEntry[],
	options: {
		readonly now: number;
		readonly maxBytes: number;
		readonly maxAgeMs: number;
	},
): ReadonlySet<string> => {
	const evicted = new Set(
		entries
			.filter((entry) => options.now - entry.accessedAt > options.maxAgeMs)
			.map((entry) => entry.key),
	);
	let total = entries
		.filter((entry) => !evicted.has(entry.key))
		.reduce((sum, entry) => sum + entry.sizeBytes, 0);
	for (const entry of [...entries].sort(
		(left, right) => left.accessedAt - right.accessedAt,
	)) {
		if (total <= options.maxBytes) break;
		if (evicted.has(entry.key)) continue;
		evicted.add(entry.key);
		total -= entry.sizeBytes;
	}
	return evicted;
};
