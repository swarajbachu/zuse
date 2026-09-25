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

		await expect(registerPushTokenForAccount(null, deps)).rejects.toThrow(
			"signed-in account",
		);
		await expect(registerPushTokenForAccount(account, deps)).rejects.toThrow(
			"configured API",
		);
		expect(calls).toEqual([]);
	});
});

describe("push registration failures", () => {
	const deps = {
		apiUrl: () => "https://api.test",
		platform: "ios" as const,
		getDeviceId: async () => "mobile_1",
		getPushToken: async (): Promise<string | null> => "ExponentPushToken[test]",
		registerDevice: async () => {},
	};
	test("returns false only when notification permission is denied", async () => {
		let registered = false;
		expect(
			await registerPushTokenForAccount(account, {
				...deps,
				getPushToken: async () => null,
				registerDevice: async () => {
					registered = true;
				},
			}),
		).toBe(false);
		expect(registered).toBe(false);
	});
	test("preserves token errors instead of reporting disabled permission", async () => {
		const error = new Error("push token unavailable");
		await expect(
			registerPushTokenForAccount(account, {
				...deps,
				getPushToken: async () => {
					throw error;
				},
			}),
		).rejects.toBe(error);
	});
	test("preserves server registration errors after permission is granted", async () => {
		const error = new Error("registration failed");
		await expect(
			registerPushTokenForAccount(account, {
				...deps,
				registerDevice: async () => {
					throw error;
				},
			}),
		).rejects.toBe(error);
	});
});
