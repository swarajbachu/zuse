import { DEFAULT_LOCAL_DESKTOP_PORT } from "@zuse/contracts";
import { Effect } from "effect";
import { Atom } from "effect/unstable/reactivity";
import * as SecureStore from "expo-secure-store";

import {
	type ConnectionRecord,
	type ConnectionSource,
	connectionStorageKey,
	decodeConnectionRecords,
	type LocalPathType,
	replaceDiscoveredRoute,
} from "~/lib/connection-records";
import { deviceLabel, getOrCreateDeviceId } from "~/lib/device-identity";
import { visibleConnectionLabel } from "~/lib/display-names";
import { serverKeyPin as serverKeyPinForPublicKey } from "~/lib/nearby-pairing";
import { getConnectionClient } from "~/rpc/connection";
import { redeemPairingCode } from "~/rpc/pairing-client";
import { connectionKey, type WsProtocolOptions } from "~/rpc/ws-protocol";

import { appAtomRegistry, batchAtomUpdates } from "./registry";

export type { ConnectionRecord } from "~/lib/connection-records";

export const connectionsAtom = Atom.make<ConnectionRecord[]>([]).pipe(
	Atom.keepAlive,
);
export const connectionsHydratedAtom = Atom.make(false).pipe(Atom.keepAlive);

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

export const currentConnections = (): ConnectionRecord[] =>
	appAtomRegistry.get(connectionsAtom);

export const hydrateConnections = async (): Promise<void> => {
	const connections = await Effect.runPromise(loadConnections);
	batchAtomUpdates(() => {
		appAtomRegistry.set(connectionsAtom, connections);
		appAtomRegistry.set(connectionsHydratedAtom, true);
	});
	await Effect.runPromise(saveConnections(connections));
};

export const addConnection = async ({
	host,
	port,
	token,
	source,
	serverKeyPin,
	serverPublicKey,
	transportCertificatePin,
	nearbyServiceName,
	pathType,
	refreshAccountGrant,
}: {
	host: string;
	port: number;
	token?: string | null;
	source: Exclude<ConnectionSource, "relay">;
	serverKeyPin?: string;
	serverPublicKey?: string;
	transportCertificatePin?: string;
	nearbyServiceName?: string;
	pathType?: LocalPathType;
	refreshAccountGrant?: boolean;
}): Promise<ConnectionRecord> => {
	const trimmedHost = host.trim();
	const redeemed = await redeemPairingCodeIfNeeded({
		host: trimmedHost,
		port,
		token,
	});
	const descriptor = await describeEnvironment({
		host: trimmedHost,
		port,
		token: redeemed.token,
	});
	if (
		descriptor === null &&
		(source === "manual" || (source === "paired" && redeemed.token !== null))
	) {
		throw new Error(
			"Could not reach that desktop. Check the address, token, and network, then try again.",
		);
	}
	const identity =
		descriptor?.environmentId ??
		redeemed.environmentId ??
		connectionKey(trimmedHost, port);
	const key =
		currentConnections().find(
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
		token: redeemed.token,
		label: visibleConnectionLabel(descriptor?.label, identity),
		updatedAt: Date.now(),
		source,
		serverKeyPin:
			serverKeyPin ??
			(redeemed.environmentPublicKey === undefined
				? undefined
				: serverKeyPinForPublicKey(redeemed.environmentPublicKey)),
		serverPublicKey: serverPublicKey ?? redeemed.environmentPublicKey,
		transportCertificatePin:
			transportCertificatePin ?? redeemed.transportCertificatePin,
		nearbyServiceName,
		pathType,
		refreshAccountGrant,
		routeGeneration: 1,
	};
	const next = [record, ...currentConnections().filter((c) => c.key !== key)];
	appAtomRegistry.set(connectionsAtom, next);
	await Effect.runPromise(saveConnections(next));
	return record;
};

/** Upsert a relay-discovered environment reached via a managed endpoint. */
export const addRelayConnection = async ({
	environmentId,
	label,
	wsBaseUrl,
	token,
}: {
	environmentId: string;
	label: string;
	wsBaseUrl: string;
	token: string;
}): Promise<ConnectionRecord> => {
	const { host, port } = parseHostPort(wsBaseUrl);
	const key =
		currentConnections().find(
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
		...currentConnections().filter((connection) => connection.key !== key),
	];
	appAtomRegistry.set(connectionsAtom, next);
	await Effect.runPromise(saveConnections(next));
	return record;
};

/** Persist a new human label for an already-stored connection. */
export const updateConnectionLabel = async (
	key: string,
	label: string,
): Promise<void> => {
	const next = currentConnections().map((c) =>
		c.key === key ? { ...c, label } : c,
	);
	appAtomRegistry.set(connectionsAtom, next);
	await Effect.runPromise(saveConnections(next));
};

/**
 * Re-describe an already-paired environment and adopt its human label if the
 * server now reports a nicer one (e.g. after the Phase 1 machine-naming
 * change lands on desktop). No-op when the label is unchanged.
 */
export const refreshConnectionLabel = async (
	key: string,
	options: WsProtocolOptions,
): Promise<void> => {
	const descriptor = await describeEnvironment(options);
	if (descriptor === null) return;
	const nextLabel = visibleConnectionLabel(descriptor.label, key);
	const current = currentConnections().find((c) => c.key === key);
	if (current === undefined || current.label === nextLabel) return;
	await updateConnectionLabel(key, nextLabel);
};

/** Replace only the disposable network route for a stable paired Mac. */
export const updateDiscoveredConnectionRoute = async ({
	key,
	host,
	port,
	pathType,
	nearbyServiceName,
	transportCertificatePin,
}: {
	key: string;
	host: string;
	port: number;
	pathType: LocalPathType;
	nearbyServiceName?: string;
	transportCertificatePin?: string;
}): Promise<void> => {
	const next = currentConnections().map((connection) =>
		connection.key === key
			? replaceDiscoveredRoute(connection, {
					host,
					port,
					pathType,
					nearbyServiceName,
					transportCertificatePin,
				})
			: connection,
	);
	appAtomRegistry.set(connectionsAtom, next);
	await Effect.runPromise(saveConnections(next));
};

export const removeConnection = async (key: string): Promise<void> => {
	const next = currentConnections().filter((c) => c.key !== key);
	appAtomRegistry.set(connectionsAtom, next);
	await Effect.runPromise(saveConnections(next));
};

export const clearConnections = async (): Promise<void> => {
	batchAtomUpdates(() => {
		appAtomRegistry.set(connectionsAtom, []);
		appAtomRegistry.set(connectionsHydratedAtom, true);
	});
	await SecureStore.deleteItemAsync(STORE_KEY);
};

const redeemPairingCodeIfNeeded = async ({
	host,
	port,
	token,
}: {
	host: string;
	port: number;
	token?: string | null;
}): Promise<{
	readonly token: string | null;
	readonly environmentId?: string;
	readonly environmentPublicKey?: string;
	readonly transportCertificatePin?: string;
}> => {
	const trimmed = token?.trim();
	if (!trimmed) return { token: null };
	if (!trimmed.startsWith("zp_")) return { token: trimmed };

	return redeemPairingCode({
		host,
		port,
		code: trimmed,
		deviceId: await getOrCreateDeviceId(),
		deviceLabel: deviceLabel(),
	});
};

const describeEnvironment = async (options: WsProtocolOptions) => {
	try {
		const client = await Effect.runPromise(getConnectionClient(options));
		return await Effect.runPromise(client["connect.describe"]());
	} catch {
		return null;
	}
};
