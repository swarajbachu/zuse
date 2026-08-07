import { describe, expect, it } from "vitest";

import { resolveMachineRelayUrl } from "../../src/machine/machine-control-service.ts";

describe("machine control relay URL", () => {
	it("uses staging outside packaged production", () => {
		expect(resolveMachineRelayUrl({ NODE_ENV: "development" })).toBe(
			"https://relay-staging.stuff.md",
		);
	});

	it("uses production only for production or an explicit override", () => {
		expect(resolveMachineRelayUrl({ NODE_ENV: "production" })).toBe(
			"https://relay.stuff.md",
		);
		expect(
			resolveMachineRelayUrl({
				NODE_ENV: "development",
				ZUSE_RELAY_URL: "https://relay.example/",
			}),
		).toBe("https://relay.example");
	});
});
