import { describe, expect, it } from "vitest";

import { resolveRendererApiUrl } from "../../src/lib/api-url.ts";

describe("renderer api URL", () => {
	it("defaults development to staging and production to the live api", () => {
		expect(resolveRendererApiUrl(undefined, true)).toBe(
			"https://api-staging.stuff.md",
		);
		expect(resolveRendererApiUrl(undefined, false)).toBe("https://api.zuse.sh");
	});

	it("honors an explicit api override", () => {
		expect(resolveRendererApiUrl("https://api.example/", true)).toBe(
			"https://api.example",
		);
	});
});
