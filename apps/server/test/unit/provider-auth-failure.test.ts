import { describe, expect, test } from "vitest";

import { isProviderAuthenticationRequired } from "../../src/provider/provider-auth-failure.ts";

describe("provider auth failure classification", () => {
	test.each([
		"Authentication required",
		"Auth(AuthorizationRequired)",
		"codex-auth-reconnect-required",
		"Your refresh token was already used",
		"401 Unauthorized",
		"Invalid authentication credentials",
		"Please run /login",
	])("recognizes %s as recoverable before another submission", (reason) => {
		expect(isProviderAuthenticationRequired(reason)).toBe(true);
	});

	test("does not classify an uncertain provider failure as authentication", () => {
		expect(
			isProviderAuthenticationRequired(
				"socket closed after request submission",
			),
		).toBe(false);
	});
});
