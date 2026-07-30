import { describe, expect, it } from "vitest";

import { hostedAuthTokenEndpoint } from "../../src/lib/hosted-connect.ts";

describe("hosted authentication", () => {
	it("exchanges browser tokens through the configured relay", () => {
		expect(hostedAuthTokenEndpoint("http://127.0.0.1:8790/")).toBe(
			"http://127.0.0.1:8790/v1/auth/token",
		);
	});
});
