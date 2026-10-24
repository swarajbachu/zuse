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

describe("approved nearby pairing handoff", () => {
	beforeEach(() => {
		vi.mocked(getConnectionClient).mockReset();
		vi.mocked(getConnectionClient).mockReturnValue(
			Effect.die(new Error("socket unavailable")),
		);
		secureStore.setItemAsync.mockClear();
		appAtomRegistry.set(connectionsAtom, []);
	});

	it("retains an approved credential without requiring another socket handshake", async () => {
		const record = await addConnection({
			host: "127.0.0.1",
			port: 45000,
			token: "zt_approved",
			source: "paired",
			serverPublicKey: "mac-key",
			serverKeyPin: "pin",
			transportCertificatePin: "tls-pin",
			nearbyServiceName: "MacBook",
			pathType: "lan",
			approvedNearbyEnvironment: { environmentId: "mac-1", label: "MacBook" },
		});
		expect(record).toMatchObject({
			key: "paired:mac-1",
			environmentId: "mac-1",
			token: "zt_approved",
			label: "MacBook",
			serverPublicKey: "mac-key",
		});
		expect(getConnectionClient).not.toHaveBeenCalled();
		expect(secureStore.setItemAsync).toHaveBeenCalled();
		expect(appAtomRegistry.get(connectionsAtom)).toEqual([record]);
	});

	it("does not bypass validation for an unpinned nearby identity", async () => {
		await expect(
			addConnection({
				host: "127.0.0.1",
				port: 45000,
				token: "zt_approved",
				source: "paired",
				approvedNearbyEnvironment: { environmentId: "mac-1", label: "MacBook" },
			}),
		).rejects.toThrow("approved nearby identity");
		expect(appAtomRegistry.get(connectionsAtom)).toEqual([]);
	});

	it("rejects an approved identity whose public key does not match its pin", async () => {
		await expect(
			addConnection({
				host: "127.0.0.1",
				port: 45000,
				token: "zt_approved",
				source: "paired",
				serverPublicKey: "mac-key",
				serverKeyPin: "wrong-pin",
				transportCertificatePin: "tls-pin",
				nearbyServiceName: "MacBook",
				approvedNearbyEnvironment: { environmentId: "mac-1", label: "MacBook" },
			}),
		).rejects.toThrow("approved nearby identity");
		expect(appAtomRegistry.get(connectionsAtom)).toEqual([]);
		expect(secureStore.setItemAsync).not.toHaveBeenCalled();
	});

	it("preserves a failed manual connection's actual reason", async () => {
		await expect(
			addConnection({
				host: "127.0.0.1",
				port: 45000,
				token: "zt_approved",
				source: "manual",
			}),
		).rejects.toThrow("socket unavailable");
	});
});
