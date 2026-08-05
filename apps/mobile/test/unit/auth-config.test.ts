import { describe, expect, it } from "vitest";

import { defaultRelayBaseUrl } from "../../src/auth/config";

describe("mobile relay configuration", () => {
	it("keeps development on staging and release builds on production", () => {
		expect(defaultRelayBaseUrl(true)).toBe("https://relay-staging.stuff.md");
		expect(defaultRelayBaseUrl(false)).toBe("https://relay.stuff.md");
	});
});
