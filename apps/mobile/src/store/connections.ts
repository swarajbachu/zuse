import { DEFAULT_LOCAL_DESKTOP_PORT } from "@zuse/contracts";
import { Effect } from "effect";
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import {
	type ConnectionRecord,
	type ConnectionSource,
	connectionStorageKey,
	decodeConnectionRecords,
} from "~/lib/connection-records";
import { deviceLabel, getOrCreateDeviceId } from "~/lib/device-identity";
import { visibleConnectionLabel } from "~/lib/display-names";
import { getConnectionClient } from "~/rpc/connection";
import { connectionKey, type WsProtocolOptions } from "~/rpc/ws-protocol";

export type { ConnectionRecord } from "~/lib/connection-records";

type ConnectionsState = {
	connections: ConnectionRecord[];
	hydrated: boolean;
	hydrate: () => Promise<void>;
	add: (input: {
		host: string;
		port: number;
		token?: string | null;
		source: Exclude<ConnectionSource, "relay">;
	}) => Promise<ConnectionRecord>;
	/** Upsert a relay-discovered environment reached via a managed endpoint. */
	addRelay: (input: {
		environmentId: string;
		label: string;
		wsBaseUrl: string;
		token: string;
	}) => Promise<ConnectionRecord>;
	/** Persist a new human label for an already-stored connection. */
	updateLabel: (key: string, label: string) => Promise<void>;
	/**
	 * Re-describe an already-paired environment and adopt its human label if the
	 * server now reports a nicer one (e.g. after the Phase 1 machine-naming
	 * change lands on desktop). No-op when the label is unchanged.
	 */
	refreshLabel: (key: string, options: WsProtocolOptions) => Promise<void>;
	remove: (key: string) => Promise<void>;
	clear: () => Promise<void>;
};

const parseHostPort = (wsBaseUrl: string): { host: string; port: number } => {
	try {
		const url = new URL(wsBaseUrl);
		return {
			host: url.hostname,
			port: Number(url.port) || (url.protocol === "wss:" ? 443 : 80),
		};
	} catch {
		return { host: "127.0.0.1", port: DEFAULT_LOCAL_DESKTOP_PORT };
	}
};

const STORE_KEY = "zuse.mobile.connections.v1";

const loadConnections = Effect.tryPromise({
	try: async () => {
		const raw = await SecureStore.getItemAsync(STORE_KEY);
		if (raw === null) return [] as ConnectionRecord[];
		return decodeConnectionRecords(JSON.parse(raw));
	},
	catch: () => [] as ConnectionRecord[],
});

const saveConnections = (connections: ConnectionRecord[]) =>
	Effect.tryPromise({
		try: () => SecureStore.setItemAsync(STORE_KEY, JSON.stringify(connections)),
		catch: (cause) => cause,
	});

export const useConnectionsStore = create<ConnectionsState>((set, get) => ({
	connections: [],
	hydrated: false,
	hydrate: async () => {
		const connections = await Effect.runPromise(loadConnections);
		set({ connections, hydrated: true });
		await Effect.runPromise(saveConnections(connections));
	},
	add: async ({ host, port, token, source }) => {
		const trimmedHost = host.trim();
		const redeemed = await redeemPairingCodeIfNeeded({
			host: trimmedHost,
			port,
			token,
		});
		const descriptor = await describeEnvironment({
			host: trimmedHost,
			port,
			token: redeemed,
		});
		if (source === "manual" && descriptor === null) {
			throw new Error(
				"Could not reach that desktop. Check the address, token, and network, then try again.",
			);
		}
		const identity =
			descriptor?.environmentId ?? connectionKey(trimmedHost, port);
		const key =
			get().connections.find(
				(connection) =>
					connection.source === source &&
					((descriptor !== null &&
						connection.environmentId === descriptor.environmentId) ||
						connection.key === connectionStorageKey(source, identity)),
			)?.key ?? connectionStorageKey(source, identity);
		const record: ConnectionRecord = {
			key,
			environmentId: descriptor?.environmentId,
			host: trimmedHost,
			port,
			token: redeemed,
			label: visibleConnectionLabel(descriptor?.label, identity),
			updatedAt: Date.now(),
			source,
		};
		const next = [record, ...get().connections.filter((c) => c.key !== key)];
		set({ connections: next });
		await Effect.runPromise(saveConnections(next));
		return record;
	},
	addRelay: async ({ environmentId, label, wsBaseUrl, token }) => {
		const { host, port } = parseHostPort(wsBaseUrl);
		const key =
			get().connections.find(
				(connection) =>
					connection.source === "relay" &&
					connection.environmentId === environmentId,
			)?.key ?? connectionStorageKey("relay", environmentId);
		const record: ConnectionRecord = {
			key,
			environmentId,
			host,
			port,
			wsBaseUrl,
			token,
			label: visibleConnectionLabel(label),
			updatedAt: Date.now(),
			source: "relay",
		};
		const next = [
			record,
			...get().connections.filter((connection) => connection.key !== key),
		];
		set({ connections: next });
		await Effect.runPromise(saveConnections(next));
		return record;
	},
	updateLabel: async (key, label) => {
		const next = get().connections.map((c) =>
			c.key === key ? { ...c, label } : c,
		);
		set({ connections: next });
		await Effect.runPromise(saveConnections(next));
	},
	refreshLabel: async (key, options) => {
		const descriptor = await describeEnvironment(options);
		if (descriptor === null) return;
		const nextLabel = visibleConnectionLabel(descriptor.label, key);
		const current = get().connections.find((c) => c.key === key);
		if (current === undefined || current.label === nextLabel) return;
		await get().updateLabel(key, nextLabel);
	},
	remove: async (key) => {
		const next = get().connections.filter((c) => c.key !== key);
		set({ connections: next });
		await Effect.runPromise(saveConnections(next));
	},
	clear: async () => {
		set({ connections: [], hydrated: true });
		await SecureStore.deleteItemAsync(STORE_KEY);
	},
}));

const redeemPairingCodeIfNeeded = async ({
	host,
	port,
	token,
}: {
	host: string;
	port: number;
	token?: string | null;
}): Promise<string | null> => {
	const trimmed = token?.trim();
	if (!trimmed) return null;
	if (!trimmed.startsWith("zp_")) return trimmed;

	let response: Response;
	try {
		const deviceId = await getOrCreateDeviceId();
		response = await fetch(`http://${host}:${port}/pair`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				code: trimmed,
				deviceId,
				deviceLabel: deviceLabel(),
			}),
		});
	} catch {
		throw new Error(
			"Could not reach the desktop. Check that both devices are on the same network, then try again.",
		);
	}
	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as {
			error?: string;
		} | null;
		if (response.status === 410 || body?.error === "expired_code") {
			throw new Error(
				"This pairing code expired. Generate a new code on the desktop.",
			);
		}
		if (response.status === 401 || body?.error === "invalid_code") {
			throw new Error("This pairing code is invalid or has already been used.");
		}
		throw new Error(
			"Could not pair with the desktop. Check that both devices are on the same network.",
		);
	}
	const body = (await response.json()) as { token?: string };
	if (typeof body.token !== "string" || !body.token.startsWith("zt_")) {
		throw new Error("Pairing response did not include a bearer token");
	}
	return body.token;
};

const describeEnvironment = async (options: WsProtocolOptions) => {
	try {
		const client = await Effect.runPromise(getConnectionClient(options));
		return await Effect.runPromise(client["connect.describe"]());
	} catch {
		return null;
	}
};
