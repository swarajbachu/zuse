import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getConnectionClient } from "../../../src/rpc/connection";
import { redeemPairingCode } from "../../../src/rpc/pairing-client";

import {
	addConnection,
	connectionsAtom,
	connectionsHydratedAtom,
	hydrateConnections,
} from "../../../src/store/connections";
import { appAtomRegistry } from "../../../src/store/registry";

const secureStore = vi.hoisted(() => ({
	getItemAsync: vi.fn<() => Promise<string | null>>(),
	setItemAsync: vi.fn(async () => undefined),
	deleteItemAsync: vi.fn(async () => undefined),
}));

vi.mock("expo-secure-store", () => secureStore);
vi.mock("~/lib/device-identity", () => ({
	deviceLabel: () => "iPhone",
	getOrCreateDeviceId: vi.fn(async () => "device-1"),
}));
vi.mock("~/lib/media-cache", () => ({
	clearMediaCache: vi.fn(async () => undefined),
}));
vi.mock("~/lib/nearby-pairing", () => ({
	serverKeyPin: vi.fn(() => "pin"),
}));
vi.mock("~/rpc/connection", () => ({
	getConnectionClient: vi.fn(),
}));
vi.mock("~/rpc/pairing-client", () => ({
	redeemPairingCode: vi.fn(),
}));

describe("connection hydration", () => {
	beforeEach(() => {
		secureStore.getItemAsync.mockReset();
		secureStore.setItemAsync.mockClear();
		appAtomRegistry.set(connectionsAtom, []);
		appAtomRegistry.set(connectionsHydratedAtom, false);
	});

	it("settles to an empty hydrated state when secure storage is unavailable", async () => {
		secureStore.getItemAsync.mockRejectedValueOnce(
			new Error("keychain unavailable"),
		);

		await expect(hydrateConnections()).resolves.toBeUndefined();

		expect(appAtomRegistry.get(connectionsHydratedAtom)).toBe(true);
		expect(appAtomRegistry.get(connectionsAtom)).toEqual([]);
	});
});

describe("pairing credential exchange", () => {
	beforeEach(() => {
		vi.mocked(redeemPairingCode).mockReset();
		vi.mocked(redeemPairingCode).mockResolvedValue({ token: "zt_redeemed" });
		vi.mocked(getConnectionClient).mockReset();
		vi.mocked(getConnectionClient).mockReturnValue(
			Effect.die(new Error("stop after credential exchange")),
		);
		appAtomRegistry.set(connectionsAtom, []);
	});

	it.each([
		"ABCD2345",
		"abcd-2345",
		"abcd 2345",
		"zp_legacyCode",
	])("redeems %s before opening the authenticated socket", async (token) => {
		await expect(
			addConnection({
				host: "192.168.1.2",
				port: 47837,
				token,
				source: "paired",
				httpBaseUrl: "https://desktop.example.ts.net",
			}),
		).rejects.toThrow("Could not reach");
		expect(redeemPairingCode).toHaveBeenCalledWith(
			expect.objectContaining({
				code: token.startsWith("zp_") ? token : "ABCD2345",
			}),
		);
		expect(getConnectionClient).toHaveBeenCalledWith(
			expect.objectContaining({ token: "zt_redeemed" }),
		);
	});

	it.each([
		"zt_existing",
		"eyJ.example.signature",
		"ſbcd2345",
	])("preserves existing bearer %s", async (token) => {
		await expect(
			addConnection({
				host: "192.168.1.2",
				port: 47837,
				token,
				source: "paired",
			}),
		).rejects.toThrow("Could not reach");
		expect(redeemPairingCode).not.toHaveBeenCalled();
		expect(getConnectionClient).toHaveBeenCalledWith(
			expect.objectContaining({ token }),
		);
	});
});
