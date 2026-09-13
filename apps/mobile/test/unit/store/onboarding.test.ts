import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	clearOnboarding,
	completeOnboarding,
	hydrateOnboarding,
	onboardingCompleteAtom,
	onboardingHydratedAtom,
} from "../../../src/store/onboarding";
import { appAtomRegistry } from "../../../src/store/registry";

const secureStore = vi.hoisted(() => {
	let stored: string | null = null;
	return {
		getItemAsync: vi.fn(async () => stored),
		setItemAsync: vi.fn(async (_key: string, value: string) => {
			stored = value;
		}),
		deleteItemAsync: vi.fn(async () => {
			stored = null;
		}),
		seed: (value: string | null) => {
			stored = value;
		},
	};
});

vi.mock("expo-secure-store", () => secureStore);

describe("mobile onboarding", () => {
	beforeEach(() => {
		secureStore.seed(null);
		secureStore.getItemAsync.mockClear();
		secureStore.setItemAsync.mockClear();
		secureStore.deleteItemAsync.mockClear();
		appAtomRegistry.set(onboardingHydratedAtom, false);
		appAtomRegistry.set(onboardingCompleteAtom, false);
	});

	it("hydrates a completed first-run flow", async () => {
		secureStore.seed("complete");
		await hydrateOnboarding();
		expect(appAtomRegistry.get(onboardingHydratedAtom)).toBe(true);
		expect(appAtomRegistry.get(onboardingCompleteAtom)).toBe(true);
	});

	it("clears after an in-flight completion write finishes", async () => {
		let finishWrite = () => {};
		secureStore.setItemAsync.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finishWrite = () => {
						secureStore.seed("complete");
						resolve();
					};
				}),
		);
		const completing = completeOnboarding();
		await Promise.resolve();
		const clearing = clearOnboarding();
		expect(secureStore.deleteItemAsync).not.toHaveBeenCalled();
		finishWrite();
		await Promise.all([completing, clearing]);
		await hydrateOnboarding();
		expect(appAtomRegistry.get(onboardingCompleteAtom)).toBe(false);
	});

	it("can clear after a failed completion write", async () => {
		secureStore.setItemAsync.mockRejectedValueOnce(new Error("write failed"));
		await completeOnboarding();
		await expect(clearOnboarding()).resolves.toBeUndefined();
		expect(appAtomRegistry.get(onboardingCompleteAtom)).toBe(false);
	});

	it("settles safely when secure storage is unavailable", async () => {
		secureStore.getItemAsync.mockRejectedValueOnce(new Error("locked"));
		await expect(hydrateOnboarding()).resolves.toBeUndefined();
		expect(appAtomRegistry.get(onboardingHydratedAtom)).toBe(true);
		expect(appAtomRegistry.get(onboardingCompleteAtom)).toBe(false);
	});

	it("persists completion and clears it during an app reset", async () => {
		await completeOnboarding();
		expect(appAtomRegistry.get(onboardingCompleteAtom)).toBe(true);
		expect(secureStore.setItemAsync).toHaveBeenCalledWith(
			"zuse.mobile.onboarding.v1",
			"complete",
		);

		await clearOnboarding();
		expect(appAtomRegistry.get(onboardingCompleteAtom)).toBe(false);
		expect(secureStore.deleteItemAsync).toHaveBeenCalledWith(
			"zuse.mobile.onboarding.v1",
		);
	});
});
