import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	alert: vi.fn(),
	settings: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("react-native", () => ({
	Alert: { alert: mocks.alert },
	Linking: { openSettings: mocks.settings },
}));

import { requestFeaturePermission } from "../../../src/lib/device-permissions";

beforeEach(() => vi.clearAllMocks());
it("continues granted access without extra UI", async () => {
	expect(
		await requestFeaturePermission(
			async () => ({ granted: true, canAskAgain: true }),
			"camera",
		),
	).toBe(true);
	expect(mocks.alert).not.toHaveBeenCalled();
});
it.each([
	"camera",
	"microphone",
] as const)("offers Settings and an alternative after denied %s access", async (feature) => {
	expect(
		await requestFeaturePermission(
			async () => ({ granted: false, canAskAgain: false }),
			feature,
		),
	).toBe(false);
	expect(mocks.alert.mock.lastCall?.[1]).toContain(
		feature === "camera" ? "existing image" : "type your message",
	);
	mocks.alert.mock.lastCall?.[2][1].onPress();
	expect(mocks.settings).toHaveBeenCalledOnce();
});
