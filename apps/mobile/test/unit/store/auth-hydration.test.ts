import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	authAccountAtom,
	authBusyAtom,
	authErrorAtom,
	authHydratedAtom,
	deleteAccount,
	hydrateAuth,
} from "../../../src/store/auth";
import { appAtomRegistry } from "../../../src/store/registry";

const workos = vi.hoisted(() => ({
	currentAccount: vi.fn(),
	signIn: vi.fn(),
	signOut: vi.fn(),
}));
const deletion = vi.hoisted(() => ({ api: vi.fn(), local: vi.fn() }));

vi.mock("../../../src/auth/workos", () => workos);
vi.mock("../../../src/lib/mobile-data", () => ({
	resetLocalMobileData: deletion.local,
}));
vi.mock("../../../src/rpc/api-client", () => ({
	deleteAccount: deletion.api,
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

describe("account deletion", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		deletion.api.mockReset().mockResolvedValue({ cleanupPending: false });
		deletion.local.mockReset().mockResolvedValue(undefined);
		appAtomRegistry.set(authAccountAtom, {
			id: "test-account",
			email: "test@example.com",
		});
		appAtomRegistry.set(authBusyAtom, false);
		appAtomRegistry.set(authErrorAtom, null);
	});
	it("clears the local account after confirmed server deletion", async () => {
		await expect(deleteAccount()).resolves.toEqual({
			cleanupPending: false,
			localCleanupFailed: false,
		});
		expect(deletion.api).toHaveBeenCalledOnce();
		expect(deletion.local).toHaveBeenCalledOnce();
		expect(appAtomRegistry.get(authAccountAtom)).toBeNull();
		expect(appAtomRegistry.get(authBusyAtom)).toBe(false);
	});
	it("reports deferred cloud cleanup without claiming completion", async () => {
		deletion.api.mockResolvedValue({ cleanupPending: true });
		await expect(deleteAccount()).resolves.toEqual({
			cleanupPending: true,
			localCleanupFailed: false,
		});
	});
	it("keeps the session and data available when the server rejects deletion", async () => {
		deletion.api.mockRejectedValue(new Error("Please retry"));
		await expect(deleteAccount()).rejects.toThrow("Please retry");
		expect(deletion.local).not.toHaveBeenCalled();
		expect(appAtomRegistry.get(authAccountAtom)?.id).toBe("test-account");
		expect(appAtomRegistry.get(authBusyAtom)).toBe(false);
	});
	it("reports local cleanup failures separately after server acceptance", async () => {
		deletion.local.mockRejectedValue(new Error("Storage unavailable"));
		await expect(deleteAccount()).resolves.toEqual({
			cleanupPending: false,
			localCleanupFailed: true,
		});
		expect(appAtomRegistry.get(authAccountAtom)).toBeNull();
	});
	it("does not submit a second deletion while an account action is running", async () => {
		appAtomRegistry.set(authBusyAtom, true);
		await expect(deleteAccount()).rejects.toThrow("already in progress");
		expect(deletion.api).not.toHaveBeenCalled();
	});
});
