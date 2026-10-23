import { describe, expect, it } from "vitest";
import { createZotOnboardingStore } from "../../src/store/zot-onboarding.ts";

const memoryStorage = () => {
	const items = new Map<string, string>();
	return {
		getItem: (key: string) => items.get(key) ?? null,
		setItem: (key: string, value: string) => {
			items.set(key, value);
		},
	};
};

describe("Zot onboarding progress", () => {
	it("opens for first use and resumes the same step after a reload", () => {
		const storage = memoryStorage();
		const store = createZotOnboardingStore(() => storage);
		expect(store.getState()).toMatchObject({
			step: "welcome",
			status: "new",
			open: true,
		});
		store.getState().next();
		expect(createZotOnboardingStore(() => storage).getState()).toMatchObject({
			step: "repositories",
			status: "in-progress",
			open: true,
		});
	});

	it("remembers a dismissal and supports explicitly replaying the guide", () => {
		const storage = memoryStorage();
		const first = createZotOnboardingStore(() => storage);
		first.getState().next();
		first.getState().next();
		first.getState().dismiss();
		const reloaded = createZotOnboardingStore(() => storage);
		expect(reloaded.getState()).toMatchObject({
			step: "brief",
			status: "dismissed",
			open: false,
		});
		reloaded.getState().start();
		expect(reloaded.getState()).toMatchObject({
			step: "welcome",
			status: "in-progress",
			open: true,
		});
	});

	it("finishes without reopening on reload or stray navigation", () => {
		const storage = memoryStorage();
		const store = createZotOnboardingStore(() => storage);
		for (let index = 0; index < 5; index++) store.getState().next();
		store.getState().next();
		store.getState().back();
		expect(createZotOnboardingStore(() => storage).getState()).toMatchObject({
			step: "continuity",
			status: "completed",
			open: false,
		});
	});

	it("supports going back and never navigates before the first step", () => {
		const storage = memoryStorage();
		const store = createZotOnboardingStore(() => storage);
		store.getState().next();
		store.getState().back();
		store.getState().back();
		expect(createZotOnboardingStore(() => storage).getState()).toMatchObject({
			step: "welcome",
			open: true,
		});
	});

	it.each([
		"not json",
		JSON.stringify({ version: 2, step: "brief", status: "in-progress" }),
		JSON.stringify({ version: 1, step: "unknown", status: "in-progress" }),
		JSON.stringify({ version: 1, step: "brief", status: "unknown" }),
	])("ignores invalid stored progress: %s", (raw) => {
		const store = createZotOnboardingStore(() => ({
			getItem: () => raw,
			setItem: () => {},
		}));
		expect(store.getState()).toMatchObject({
			step: "welcome",
			status: "new",
			open: true,
		});
	});

	it("keeps working when storage access is denied", () => {
		const store = createZotOnboardingStore(() => {
			throw new Error("Storage access denied");
		});
		store.getState().next();
		expect(store.getState().step).toBe("repositories");
		store.getState().dismiss();
		expect(store.getState().open).toBe(false);
		store.getState().start();
		expect(store.getState().open).toBe(true);
	});

	it("allows finishing when storage writes fail", () => {
		const store = createZotOnboardingStore(() => ({
			getItem: () => null,
			setItem: () => {
				throw new Error("Storage quota exceeded");
			},
		}));
		for (let index = 0; index < 5; index++) store.getState().next();
		expect(store.getState()).toMatchObject({
			open: false,
			status: "completed",
		});
	});
	it("jumps to a step from the plan only while the guide is open", () => {
		const storage = memoryStorage();
		const store = createZotOnboardingStore(() => storage);
		store.getState().goTo("slaves");
		expect(createZotOnboardingStore(() => storage).getState()).toMatchObject({
			step: "slaves",
			status: "in-progress",
		});
		store.getState().dismiss();
		store.getState().goTo("brief");
		expect(store.getState()).toMatchObject({
			step: "slaves",
			status: "dismissed",
			open: false,
		});
	});
});
