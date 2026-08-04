import { beforeEach, describe, expect, it, vi } from "vitest";

import {
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
