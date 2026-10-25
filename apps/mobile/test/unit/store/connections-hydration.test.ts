import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectionSupports } from "../../../src/lib/connection-records";
import type { ConnectionSnapshot } from "../../../src/rpc/connection";
import { getConnectionClient } from "../../../src/rpc/connection";
import { redeemPairingCode } from "../../../src/rpc/pairing-client";
import { watchConnection } from "../../../src/store/connection-runtime";

import {
	addConnection,
	connectionsAtom,
	connectionsHydratedAtom,
	hydrateConnections,
	refreshConnectionLabel,
} from "../../../src/store/connections";
import { appAtomRegistry } from "../../../src/store/registry";

const secureStore = vi.hoisted(() => ({
	getItemAsync: vi.fn<() => Promise<string | null>>(),
	setItemAsync: vi.fn(async () => undefined),
	deleteItemAsync: vi.fn(async () => undefined),
}));

const transport = vi.hoisted(() => ({
	listener: undefined as ((snapshot: ConnectionSnapshot) => void) | undefined,
}));
vi.mock("react-native", () => ({
	AppState: { currentState: "active", addEventListener: vi.fn() },
}));
vi.mock("~/rpc/cloud-runtime", () => ({ cloudRuntimeReady: () => true }));
vi.mock("~/store/mobile-client-bus", () => ({
	retryMobileClientBusConnections: vi.fn(),
	setMobileClientBusOnline: vi.fn(),
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
	getConnectionSnapshot: () => ({
		key: "paired:mac-1",
		status: "reconnecting",
		generation: 0,
		attempt: 1,
		error: "socket unavailable",
	}),
	subscribeConnection: (
		_options: unknown,
		listener: (snapshot: ConnectionSnapshot) => void,
	) => {
		transport.listener = listener;
		return () => {
			transport.listener = undefined;
		};
	},
	setConnectionOnline: vi.fn(),
	retryConnectionNow: vi.fn(),
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

it("restores saved capabilities after approval and a failed first connection on the same route", async () => {
	appAtomRegistry.set(connectionsAtom, []);
	secureStore.setItemAsync.mockClear();
	const record = await addConnection({
		host: "127.0.0.1",
		port: 45000,
		token: "zt_approved",
		source: "paired",
		serverPublicKey: "mac-key",
		serverKeyPin: "pin",
		transportCertificatePin: "tls-pin",
		nearbyServiceName: "MacBook",
		approvedNearbyEnvironment: { environmentId: "mac-1", label: "MacBook" },
	});
	vi.mocked(getConnectionClient).mockReturnValue(
		Effect.die(new Error("socket unavailable")),
	);
	await refreshConnectionLabel(record.key, record);
	expect(connectionSupports(record, "desktop-handoff-v1")).toBe(false);
	const stop = watchConnection(record.key, record);
	try {
		const describe = vi.fn(() =>
			Effect.succeed({
				environmentId: "mac-1",
				label: "MacBook",
				capabilities: {
					version: 1,
					features: ["desktop-handoff-v1", "mobile-terminal-v1"],
				},
			}),
		);
		vi.mocked(getConnectionClient).mockReturnValue(
			Effect.succeed({ "connect.describe": describe }) as unknown as ReturnType<
				typeof getConnectionClient
			>,
		);
		transport.listener?.({
			key: record.key,
			status: "connected",
			generation: 1,
			attempt: 0,
			error: null,
		});
		await vi.waitFor(() => {
			const saved = appAtomRegistry.get(connectionsAtom)[0];
			expect(connectionSupports(saved, "desktop-handoff-v1")).toBe(true);
			expect(connectionSupports(saved, "mobile-terminal-v1")).toBe(true);
			expect(saved).toMatchObject({
				label: "MacBook",
				port: 45000,
				token: "zt_approved",
			});
			expect(secureStore.setItemAsync).toHaveBeenCalledTimes(2);
		});
		transport.listener?.({
			key: record.key,
			status: "connected",
			generation: 1,
			attempt: 0,
			error: null,
		});
		expect(describe).toHaveBeenCalledTimes(1);
	} finally {
		stop();
	}
});
