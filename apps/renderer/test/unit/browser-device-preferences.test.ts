import { afterEach, beforeEach, expect, it, vi } from "vitest";

const entries = new Map<string, string>();
const storage = {
	getItem: (key: string) => entries.get(key) ?? null,
	setItem: vi.fn((key: string, value: string) => {
		entries.set(key, value);
	}),
};
const key = "zuse.browser.device-preferences.v1";
const addEventListener =
	vi.fn<(type: string, listener: EventListenerOrEventListenerObject) => void>();

beforeEach(() => {
	vi.resetModules();
	entries.clear();
	storage.setItem.mockClear();
	addEventListener.mockClear();
	vi.stubGlobal("window", { localStorage: storage, addEventListener });
});
afterEach(() => vi.unstubAllGlobals());

it("hydrates only device fields and safely ignores corrupt saved preferences", async () => {
	entries.set(key, "not json");
	const corrupt = await import("../../src/lib/browser-device-preferences.ts");
	expect(corrupt.useBrowserDevicePreferences.getState()).toEqual({});
	vi.resetModules();
	entries.set(
		key,
		JSON.stringify({
			appearanceMode: "light",
			defaultProviderId: "codex",
			providerBinaryPaths: { codex: "private" },
		}),
	);
	const restored = await import("../../src/lib/browser-device-preferences.ts");
	expect(restored.useBrowserDevicePreferences.getState()).toEqual({
		appearanceMode: "light",
	});
});

it("persists acknowledged preference updates and preserves them when storage fails", async () => {
	const { updateBrowserDevicePreferences, useBrowserDevicePreferences } =
		await import("../../src/lib/browser-device-preferences.ts");
	updateBrowserDevicePreferences({ appearanceMode: "system" });
	expect(JSON.parse(entries.get(key) ?? "null")).toEqual({
		appearanceMode: "system",
	});
	storage.setItem.mockImplementationOnce(() => {
		throw new Error("quota");
	});
	expect(() =>
		updateBrowserDevicePreferences({ appearanceMode: "dark" }),
	).toThrow("quota");
	expect(useBrowserDevicePreferences.getState()).toEqual({
		appearanceMode: "system",
	});
});

it("synchronizes browser windows without consuming session-storage events", async () => {
	const { useBrowserDevicePreferences } = await import(
		"../../src/lib/browser-device-preferences.ts"
	);
	const onStorage = addEventListener.mock.calls.find(
		([type]) => type === "storage",
	)?.[1];
	if (typeof onStorage !== "function")
		throw new Error("Missing storage listener");
	entries.set(key, JSON.stringify({ appearanceMode: "dark" }));
	const unrelated = new Event("storage");
	Object.defineProperties(unrelated, {
		key: { value: key },
		storageArea: { value: {} },
	});
	onStorage(unrelated);
	expect(useBrowserDevicePreferences.getState()).toEqual({});
	const changed = new Event("storage");
	Object.defineProperties(changed, {
		key: { value: key },
		storageArea: { value: storage },
	});
	onStorage(changed);
	expect(useBrowserDevicePreferences.getState()).toEqual({
		appearanceMode: "dark",
	});
});

it("keeps the thread list sidebar toggle in this app's local storage, off by default", async () => {
	const { setThreadListSidebarEnabled, useBrowserDevicePreferences } =
		await import("../../src/lib/browser-device-preferences.ts");
	expect(
		useBrowserDevicePreferences.getState().experimentalThreadListSidebar,
	).toBeUndefined();
	setThreadListSidebarEnabled(true);
	expect(JSON.parse(entries.get(key) ?? "null")).toEqual({
		experimentalThreadListSidebar: true,
	});
	vi.resetModules();
	const reloaded = await import("../../src/lib/browser-device-preferences.ts");
	expect(
		reloaded.useBrowserDevicePreferences.getState()
			.experimentalThreadListSidebar,
	).toBe(true);
});
