import { describe, expect, test } from "vitest";

import {
	registerPushTokenForAccount,
	shouldRegisterPushToken,
} from "../../../src/notifications/registration";

const account = {
	id: "user_1",
	email: "user@example.com",
};

describe("mobile push registration", () => {
	test("only registers when signed in with api URL on native platforms", () => {
		expect(
			shouldRegisterPushToken({
				signedIn: true,
				apiUrl: "https://api.test",
				platform: "ios",
			}),
		).toBe(true);
		expect(
			shouldRegisterPushToken({
				signedIn: false,
				apiUrl: "https://api.test",
				platform: "ios",
			}),
		).toBe(false);
		expect(
			shouldRegisterPushToken({
				signedIn: true,
				apiUrl: "",
				platform: "ios",
			}),
		).toBe(false);
		expect(
			shouldRegisterPushToken({
				signedIn: true,
				apiUrl: "https://api.test",
				platform: "web",
			}),
		).toBe(false);
	});

	test("registers the Expo token with the existing api device endpoint", async () => {
		const calls: unknown[] = [];
		const registered = await registerPushTokenForAccount(account, {
			apiUrl: () => "https://api.test",
			platform: "ios",
			getDeviceId: async () => "mobile_1",
			getPushToken: async () => "ExponentPushToken[test]",
			registerDevice: async (input) => {
				calls.push(input);
			},
		});

		expect(registered).toBe(true);
		expect(calls).toEqual([
			{
				deviceId: "mobile_1",
				platform: "ios",
				pushToken: "ExponentPushToken[test]",
			},
		]);
	});

	test("skips registration when signed out or api URL is missing", async () => {
		const calls: unknown[] = [];
		const deps = {
			apiUrl: () => "",
			platform: "ios" as const,
			getDeviceId: async () => "mobile_1",
			getPushToken: async () => "ExponentPushToken[test]",
			registerDevice: async (input: unknown) => {
				calls.push(input);
			},
		};

		expect(await registerPushTokenForAccount(null, deps)).toBe(false);
		expect(await registerPushTokenForAccount(account, deps)).toBe(false);
		expect(calls).toEqual([]);
	});
});
