import { describe, expect, it } from "vitest";

import { selectMediaCacheEvictions } from "../../../src/lib/media-cache-policy";

describe("media cache eviction policy", () => {
	it("expires stale entries and evicts the least recently used globally", () => {
		const evicted = selectMediaCacheEvictions(
			[
				{ key: "expired", sizeBytes: 10, accessedAt: 0 },
				{ key: "old", sizeBytes: 60, accessedAt: 90 },
				{ key: "new", sizeBytes: 60, accessedAt: 100 },
			],
			{ now: 110, maxAgeMs: 100, maxBytes: 100 },
		);
		expect([...evicted]).toEqual(["expired", "old"]);
	});
});
