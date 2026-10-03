import { describe, expect, test } from "vitest";

import {
	isProviderAuthenticationError,
	isProviderAuthenticationRequired,
} from "../../src/provider/provider-auth-failure.ts";

describe("provider auth failure classification", () => {
	test.each([
		"Authentication required",
		"Auth(AuthorizationRequired)",
		"codex-auth-reconnect-required",
		"claude-auth-reconnect-required",
		"grok-auth-reconnecting",
		"Your refresh token was already used",
		"401 Unauthorized",
		"Invalid authentication credentials",
		"Please run /login",
		"OAuth token has expired",
		"Failed to authenticate: OAuth session expired and could not be refreshed",
		"authentication_error",
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

	test("trusts a typed auth error before its text", () => {
		expect(
			isProviderAuthenticationError({
				_tag: "error",
				message: "Something unrecognised",
				kind: "auth",
			}),
		).toBe(true);
		expect(
			isProviderAuthenticationError({ _tag: "error", message: "Boom" }),
		).toBe(false);
		expect(isProviderAuthenticationError(undefined)).toBe(false);
	});
});
