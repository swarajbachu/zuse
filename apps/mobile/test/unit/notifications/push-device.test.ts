import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	setNotificationHandler: vi.fn(),
	getLastNotificationResponseAsync: vi.fn(),
	addNotificationResponseReceivedListener: vi.fn(),
	getPermissionsAsync: vi.fn(),
	requestPermissionsAsync: vi.fn(),
	getExpoPushTokenAsync: vi.fn(),
	getDevicePushTokenAsync: vi.fn(),
	logConnectionDiagnostic: vi.fn(),
	registerDevice: vi.fn(),
	logConnectionProblem: vi.fn(),
}));
vi.mock("expo-notifications", () => mocks);
vi.mock("expo-router", () => ({ router: {} }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("../../../src/auth/config.ts", () => ({
	apiBaseUrl: () => "https://api.test",
}));
vi.mock("../../../src/lib/analytics.ts", () => ({
	captureMobileAnalytics: vi.fn(),
}));
vi.mock("../../../src/lib/device-identity.ts", () => ({
	getOrCreateDeviceId: async () => "mobile_1",
	clearDeviceIdentity: vi.fn(),
	existingDeviceId: vi.fn(),
}));
vi.mock("../../../src/rpc/api-client.ts", () => ({
	registerDevice: mocks.registerDevice,
	revokeMobileDevice: vi.fn(),
}));
vi.mock("../../../src/rpc/connection-diagnostics", () => ({
	logConnectionProblem: mocks.logConnectionProblem,
	logConnectionDiagnostic: mocks.logConnectionDiagnostic,
}));

import {
	installNotificationResponseHandler,
	registerCurrentDeviceForPush,
} from "../../../src/notifications/push.ts";

const account = { id: "user_1", email: "user@example.com" };

beforeEach(() => {
	vi.resetAllMocks();
	mocks.getPermissionsAsync.mockResolvedValue({ status: "granted" });
	mocks.getDevicePushTokenAsync.mockResolvedValue({
		type: "ios",
		data: "native-token",
	});
	mocks.getExpoPushTokenAsync.mockResolvedValue({
		data: "ExponentPushToken[test]",
	});
	mocks.registerDevice.mockResolvedValue(undefined);
});

describe("device push registration", () => {
	test("registers with existing permission without asking again", async () => {
		expect(await registerCurrentDeviceForPush(account)).toBe(true);
		expect(mocks.requestPermissionsAsync).not.toHaveBeenCalled();
		expect(mocks.registerDevice).toHaveBeenCalledWith({
			deviceId: "mobile_1",
			platform: "ios",
			pushToken: "ExponentPushToken[test]",
		});
	});
	test("reports denied permission without attempting registration", async () => {
		mocks.getPermissionsAsync.mockResolvedValue({ status: "denied" });
		mocks.requestPermissionsAsync.mockResolvedValue({ status: "denied" });
		expect(await registerCurrentDeviceForPush(account)).toBe(false);
		expect(mocks.getExpoPushTokenAsync).not.toHaveBeenCalled();
		expect(mocks.registerDevice).not.toHaveBeenCalled();
	});
	test.each([
		"getExpoPushTokenAsync",
		"getDevicePushTokenAsync",
		"registerDevice",
	] as const)("preserves and records %s failures instead of reporting permission denied", async (operation) => {
		const error = new Error("service unavailable");
		mocks[operation].mockRejectedValue(error);
		await expect(registerCurrentDeviceForPush(account)).rejects.toBe(error);
		expect(mocks.logConnectionProblem).toHaveBeenCalledWith(
			"push.registration.fail",
			{ error },
		);
	});
});

test("shows delivered notifications while the app is foregrounded", async () => {
	mocks.getLastNotificationResponseAsync.mockResolvedValue(null);
	const remove = vi.fn();
	mocks.addNotificationResponseReceivedListener.mockReturnValue({ remove });
	const cleanup = installNotificationResponseHandler();
	const handler = mocks.setNotificationHandler.mock.calls[0]?.[0];
	expect(await handler.handleNotification()).toMatchObject({
		shouldShowBanner: true,
		shouldShowList: true,
		shouldPlaySound: true,
	});
	cleanup();
	expect(remove).toHaveBeenCalledOnce();
});

test("times out a stalled native token request without registering a device", async () => {
	vi.useFakeTimers();
	try {
		mocks.getDevicePushTokenAsync.mockReturnValue(new Promise(() => {}));
		const assertion = expect(
			registerCurrentDeviceForPush(account),
		).rejects.toThrow("did not return a device token");
		await vi.advanceTimersByTimeAsync(25_000);
		await assertion;
		expect(mocks.registerDevice).not.toHaveBeenCalled();
	} finally {
		vi.useRealTimers();
	}
});
