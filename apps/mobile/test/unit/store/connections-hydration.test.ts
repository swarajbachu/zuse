import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectionSupports } from "../../../src/lib/connection-records";
import type { ConnectionSnapshot } from "../../../src/rpc/connection";
import { getConnectionClient } from "../../../src/rpc/connection";
import { redeemPairingCode } from "../../../src/rpc/pairing-client";
import { watchConnection } from "../../../src/store/connection-runtime";

import {
	addConnection,
	clearConnections,
	connectionsAtom,
	connectionsHydratedAtom,
	hydrateConnections,
	refreshConnectionLabel,
} from "../../../src/store/connections";
import { appAtomRegistry } from "../../../src/store/registry";

const secureStore = vi.hoisted(() => ({
	getItemAsync: vi.fn<() => Promise<string | null>>(),
	setItemAsync: vi.fn<(key: string, value: string) => Promise<void>>(
		async () => undefined,
	),
	deleteItemAsync: vi.fn(async () => undefined),
}));

const transport = vi.hoisted(() => ({
	snapshot: {
		key: "paired:mac-1",
		status: "reconnecting",
		generation: 0,
		attempt: 1,
		error: "socket unavailable",
	} as ConnectionSnapshot,
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
	getConnectionSnapshot: () => transport.snapshot,
	subscribeConnection: (
		_options: unknown,
		listener: (snapshot: ConnectionSnapshot) => void,
	) => {
		transport.listener = (snapshot) => {
			transport.snapshot = snapshot;
			listener(snapshot);
		};
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

describe("descriptor refresh races", () => {
	const record = {
		key: "paired:mac-1",
		environmentId: "mac-1",
		host: "127.0.0.1",
		port: 45000,
		token: "zt_approved",
		source: "paired" as const,
		label: "MacBook",
		updatedAt: 0,
	};
	const descriptor = (label: string) => ({
		environmentId: "mac-1",
		label,
		capabilities: { version: 1, features: ["desktop-handoff-v1"] },
	});
	const useDescriptor = (
		read: () => Promise<ReturnType<typeof descriptor>>,
	) => {
		vi.mocked(getConnectionClient).mockReturnValue(
			Effect.succeed({
				"connect.describe": () =>
					Effect.tryPromise({ try: read, catch: (cause) => cause }),
			}) as unknown as ReturnType<typeof getConnectionClient>,
		);
	};
	beforeEach(() => {
		appAtomRegistry.set(connectionsAtom, [record]);
		secureStore.setItemAsync.mockReset();
		secureStore.setItemAsync.mockResolvedValue(undefined);
		transport.snapshot = {
			key: record.key,
			status: "connected",
			generation: 1,
			attempt: 0,
			error: null,
		};
	});
	it("ignores an older descriptor that completes after the newer generation", async () => {
		const old = Promise.withResolvers<ReturnType<typeof descriptor>>();
		useDescriptor(() => old.promise);
		const first = refreshConnectionLabel(record.key, record, 1);
		await vi.waitFor(() => expect(getConnectionClient).toHaveBeenCalled());
		transport.snapshot = { ...transport.snapshot, generation: 2 };
		useDescriptor(async () => descriptor("New Mac"));
		await refreshConnectionLabel(record.key, record, 2);
		old.resolve(descriptor("Old Mac"));
		await first;
		expect(appAtomRegistry.get(connectionsAtom)[0]?.label).toBe("New Mac");
		expect(secureStore.setItemAsync).toHaveBeenCalledTimes(1);
	});
	it("ignores a descriptor after its connection generation stops being current", async () => {
		const old = Promise.withResolvers<ReturnType<typeof descriptor>>();
		useDescriptor(() => old.promise);
		const refresh = refreshConnectionLabel(record.key, record, 1);
		transport.snapshot = { ...transport.snapshot, status: "reconnecting" };
		old.resolve(descriptor("Old Mac"));
		await refresh;
		expect(appAtomRegistry.get(connectionsAtom)[0]?.label).toBe("MacBook");
		expect(secureStore.setItemAsync).not.toHaveBeenCalled();
	});

	it("ignores a descriptor after its saved route changes", async () => {
		const old = Promise.withResolvers<ReturnType<typeof descriptor>>();
		useDescriptor(() => old.promise);
		const refresh = refreshConnectionLabel(record.key, record, 1);
		appAtomRegistry.set(connectionsAtom, [
			{ ...record, port: 46000, routeGeneration: 2 },
		]);
		old.resolve(descriptor("Old Mac"));
		await refresh;
		expect(appAtomRegistry.get(connectionsAtom)[0]).toMatchObject({
			label: "MacBook",
			port: 46000,
		});
		expect(secureStore.setItemAsync).not.toHaveBeenCalled();
	});
	it("finishes an older storage write before starting the newer write", async () => {
		const firstWrite = Promise.withResolvers<void>();
		let persisted = "";
		secureStore.setItemAsync.mockImplementationOnce(async (_key, value) => {
			await firstWrite.promise;
			persisted = value;
		});
		secureStore.setItemAsync.mockImplementation(async (_key, value) => {
			persisted = value;
		});
		useDescriptor(async () => descriptor("First Mac"));
		const first = refreshConnectionLabel(record.key, record, 1);
		await vi.waitFor(() =>
			expect(secureStore.setItemAsync).toHaveBeenCalledTimes(1),
		);
		transport.snapshot = { ...transport.snapshot, generation: 2 };
		useDescriptor(async () => descriptor("New Mac"));
		const second = refreshConnectionLabel(record.key, record, 2);
		try {
			await vi.waitFor(() =>
				expect(appAtomRegistry.get(connectionsAtom)[0]?.label).toBe("New Mac"),
			);
			expect(secureStore.setItemAsync).toHaveBeenCalledTimes(1);
		} finally {
			firstWrite.resolve();
			await Promise.all([first, second]);
		}
		expect(JSON.parse(persisted)[0].label).toBe("New Mac");
	});
	it("does not resurrect saved credentials when clearing during an in-flight write", async () => {
		const write = Promise.withResolvers<void>();
		secureStore.setItemAsync.mockImplementationOnce(() => write.promise);
		secureStore.deleteItemAsync.mockClear();
		useDescriptor(async () => descriptor("New Mac"));
		const refresh = refreshConnectionLabel(record.key, record, 1);
		await vi.waitFor(() =>
			expect(secureStore.setItemAsync).toHaveBeenCalledTimes(1),
		);
		const clear = clearConnections();
		try {
			expect(secureStore.deleteItemAsync).not.toHaveBeenCalled();
		} finally {
			write.resolve();
			await Promise.all([refresh, clear]);
		}
		expect(secureStore.deleteItemAsync).toHaveBeenCalledTimes(1);
		expect(appAtomRegistry.get(connectionsAtom)).toEqual([]);
	});
	it("allows later saves after a storage failure", async () => {
		secureStore.setItemAsync.mockRejectedValueOnce(
			new Error("storage unavailable"),
		);
		useDescriptor(async () => descriptor("First Mac"));
		await expect(refreshConnectionLabel(record.key, record, 1)).rejects.toThrow(
			"storage unavailable",
		);
		transport.snapshot = { ...transport.snapshot, generation: 2 };
		useDescriptor(async () => descriptor("New Mac"));
		await refreshConnectionLabel(record.key, record, 2);
		expect(secureStore.setItemAsync).toHaveBeenCalledTimes(2);
		expect(appAtomRegistry.get(connectionsAtom)[0]?.label).toBe("New Mac");
	});
});
