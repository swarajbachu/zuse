import { describe, expect, it } from "vitest";

import { resolveRendererRelayUrl } from "../../src/lib/relay-url.ts";

describe("renderer relay URL", () => {
	it("defaults development to staging and production to the live relay", () => {
		expect(resolveRendererRelayUrl(undefined, true)).toBe(
			"https://relay-staging.stuff.md",
		);
		expect(resolveRendererRelayUrl(undefined, false)).toBe(
			"https://api.zuse.sh",
		);
	});

	it("honors an explicit relay override", () => {
		expect(resolveRendererRelayUrl("https://relay.example/", true)).toBe(
			"https://relay.example",
		);
	});
});
