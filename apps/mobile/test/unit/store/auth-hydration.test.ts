import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	authAccountAtom,
	authHydratedAtom,
	hydrateAuth,
} from "../../../src/store/auth";
import { appAtomRegistry } from "../../../src/store/registry";

const workos = vi.hoisted(() => ({
	currentAccount: vi.fn(),
	signIn: vi.fn(),
	signOut: vi.fn(),
}));

vi.mock("../../../src/auth/workos", () => workos);
vi.mock("../../../src/lib/mobile-data", () => ({
	resetLocalMobileData: vi.fn(),
}));
vi.mock("../../../src/rpc/api-client", () => ({
	deleteAccount: vi.fn(),
	resetApiAccessToken: vi.fn(),
}));

describe("auth hydration", () => {
	beforeEach(() => {
		workos.currentAccount.mockReset();
		appAtomRegistry.set(authAccountAtom, null);
		appAtomRegistry.set(authHydratedAtom, false);
	});

	it("settles signed out when secure storage is unavailable", async () => {
		workos.currentAccount.mockRejectedValueOnce(
			new Error("keychain unavailable"),
		);

		await expect(hydrateAuth()).resolves.toBeUndefined();

		expect(appAtomRegistry.get(authHydratedAtom)).toBe(true);
		expect(appAtomRegistry.get(authAccountAtom)).toBeNull();
	});
});
