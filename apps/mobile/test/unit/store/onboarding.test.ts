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
