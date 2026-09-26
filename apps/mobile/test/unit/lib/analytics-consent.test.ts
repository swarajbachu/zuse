import { analyticsAccountId } from "@zuse/analytics";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	storage: new Map<string, string>(),
	capture: vi.fn(),
	identify: vi.fn(),
	optOut: vi.fn(),
	optIn: vi.fn(),
	clear: vi.fn(),
	created: vi.fn(),
	ready: vi.fn(),
	remove: vi.fn(),
}));
vi.mock("expo-secure-store", () => ({
	getItemAsync: async (key: string) => mocks.storage.get(key) ?? null,
	setItemAsync: async (key: string, value: string) => {
		mocks.storage.set(key, value);
	},
}));
vi.mock("expo-application", () => ({ nativeApplicationVersion: "1" }));
vi.mock("expo-constants", () => ({ default: { expoConfig: {} } }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "test-id" }));
vi.mock("expo-localization", () => ({ getCalendars: () => [] }));
vi.mock("react-native", () => ({
	Platform: { OS: "ios", Version: 18 },
	AppState: {
		currentState: "active",
		addEventListener: () => ({ remove: mocks.remove }),
	},
}));
vi.mock("posthog-react-native", () => ({
	PostHogPersistedProperty: { Queue: "queue" },
	default: class {
		constructor(_key: string, options: unknown) {
			mocks.created(options);
		}
		capture = mocks.capture;
		identify = mocks.identify;
		optOut = mocks.optOut;
		optIn = mocks.optIn;
		ready = mocks.ready;
		setPersistedProperty = mocks.clear;
		reset() {}
	},
}));

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	mocks.storage.clear();
	vi.stubGlobal("__DEV__", false);
	vi.stubEnv("EXPO_PUBLIC_POSTHOG_KEY", "test-project");
	vi.useFakeTimers();
});

describe("mobile analytics consent", () => {
	it("does not construct a client or capture events before opt-in", async () => {
		const analytics = await import("../../../src/lib/analytics");
		analytics.captureMobileAnalytics("screen viewed", { screen: "inbox" });
		expect(await analytics.hydrateMobileAnalytics(null)).toBe(false);
		analytics.captureMobileControl("test");
		expect(mocks.created).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("persists consent, stops capture immediately and discards queued events on withdrawal", async () => {
		const analytics = await import("../../../src/lib/analytics");
		await analytics.setMobileAnalyticsEnabled(true, null);
		expect(mocks.created).toHaveBeenCalledWith(
			expect.objectContaining({ persistence: "memory" }),
		);
		expect(mocks.capture).toHaveBeenCalled();
		mocks.capture.mockClear();
		const off = analytics.setMobileAnalyticsEnabled(false, null);
		analytics.captureMobileControl("after-opt-out");
		await off;
		expect(mocks.capture).not.toHaveBeenCalled();
		expect(mocks.optOut).toHaveBeenCalledOnce();
		expect(mocks.clear).toHaveBeenCalledWith("queue", []);
		expect(vi.getTimerCount()).toBe(0);
		expect(await analytics.hydrateMobileAnalytics(null)).toBe(false);
	});
	it("restores explicit opt-in and keeps opt-out after identity changes", async () => {
		mocks.storage.set("zuse.mobile.analytics.consent.v1", "true");
		const analytics = await import("../../../src/lib/analytics");
		expect(await analytics.hydrateMobileAnalytics("account-a")).toBe(true);
		await analytics.setMobileAnalyticsEnabled(false, "account-a");
		await analytics.setMobileAnalyticsAccount("account-b");
		expect(await analytics.hydrateMobileAnalytics("account-b")).toBe(false);
		mocks.identify.mockClear();
		await analytics.setMobileAnalyticsEnabled(true, "account-b");
		expect(mocks.identify).toHaveBeenCalledWith(
			analyticsAccountId("account-b"),
		);
	});
});

it("keeps capture disabled when withdrawal overtakes a queued opt-in", async () => {
	const analytics = await import("../../../src/lib/analytics");
	const on = analytics.setMobileAnalyticsEnabled(true, null);
	const off = analytics.setMobileAnalyticsEnabled(false, null);
	await Promise.all([on, off]);
	expect(mocks.created).not.toHaveBeenCalled();
	expect(await analytics.hydrateMobileAnalytics(null)).toBe(false);
});
