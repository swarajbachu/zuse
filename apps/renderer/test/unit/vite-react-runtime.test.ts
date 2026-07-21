import { describe, expect, it } from "vitest";

import config from "../../vite.config.ts";

describe("renderer React runtime bundling", () => {
	it("prebundles lazy React consumers into one deduplicated runtime", () => {
		expect(config.resolve?.dedupe).toEqual(
			expect.arrayContaining(["react", "react-dom"]),
		);
		expect(config.optimizeDeps?.include).toEqual(
			expect.arrayContaining(["@legendapp/list/react", "@pierre/trees/react"]),
		);
	});
});
