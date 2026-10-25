import {
	DEFAULT_LOCAL_DESKTOP_PORT,
	isShortPairingCodeInput,
	normalizePairingCodeInput,
} from "@zuse/contracts";
import { Effect } from "effect";
import { Atom } from "effect/unstable/reactivity";
import * as SecureStore from "expo-secure-store";
import { connectionErrorMessage } from "~/lib/connection-error-message";
import {
	type ConnectionRecord,
	type ConnectionSource,
	connectionStorageKey,
	decodeConnectionRecords,
	type LocalPathType,
	refreshConnectionDescriptor,
	replaceDiscoveredRoute,
	restorePairedRoute,
} from "~/lib/connection-records";
import { deviceLabel, getOrCreateDeviceId } from "~/lib/device-identity";
import { visibleConnectionLabel } from "~/lib/display-names";
import { clearMediaCache } from "~/lib/media-cache";
import { serverKeyPin as serverKeyPinForPublicKey } from "~/lib/nearby-pairing";
import { getConnectionClient, getConnectionSnapshot } from "~/rpc/connection";
import { redeemPairingCode } from "~/rpc/pairing-client";
import { connectionKey, type WsProtocolOptions } from "~/rpc/ws-protocol";
import { cloudConnectionsAtom } from "./cloud-catalog";
import { appAtomRegistry, batchAtomUpdates } from "./registry";

export type { ConnectionRecord } from "~/lib/connection-records";

export const connectionsAtom = Atom.make<ConnectionRecord[]>([]).pipe(
	Atom.keepAlive,
);
export const connectionsHydratedAtom = Atom.make(false).pipe(Atom.keepAlive);

/** Cloud routes are account-derived, never persisted as paired computers. */
export const allConnectionsAtom = Atom.make((get) => [
	...get(connectionsAtom),
	...get(cloudConnectionsAtom),
]);

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
		return {
			connections:
				raw === null
					? ([] as ConnectionRecord[])
					: decodeConnectionRecords(JSON.parse(raw)),
			storageReadable: true,
		};
	},
	catch: (cause) => cause,
}).pipe(
	Effect.catch(() =>
		Effect.succeed({
			connections: [] as ConnectionRecord[],
			storageReadable: false,
		}),
	),
);

let pendingConnectionWrite: Promise<void> = Promise.resolve();

/** Order mutations of the shared storage entry without poisoning later writes on failure. */
const serializeConnectionWrite = (
	write: () => Promise<void>,
): Promise<void> => {
	const result = pendingConnectionWrite.then(write);
	pendingConnectionWrite = result.catch(() => undefined);
	return result;
};

const saveConnections = (connections: ConnectionRecord[]) =>
	Effect.tryPromise({
		try: () => {
			const snapshot = JSON.stringify(connections);
			return serializeConnectionWrite(() =>
				SecureStore.setItemAsync(STORE_KEY, snapshot),
			);
		},
		catch: (cause) => cause,
	});

export const currentConnections = (): ConnectionRecord[] =>
	appAtomRegistry.get(connectionsAtom);

export const hydrateConnections = async (): Promise<void> => {
	const { connections, storageReadable } =
		await Effect.runPromise(loadConnections);
	batchAtomUpdates(() => {
		appAtomRegistry.set(connectionsAtom, connections);
		appAtomRegistry.set(connectionsHydratedAtom, true);
	});
	if (storageReadable) {
		await Effect.runPromise(saveConnections(connections)).catch(
			() => undefined,
		);
	}
};

/**
 * Save a computer after validating RPC access, or retain an already-approved
 * nearby identity so its credential survives a failed initial connection.
 */
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
	wsBaseUrl,
	httpBaseUrl,
	approvedNearbyEnvironment,
}: {
	host: string;
	port: number;
	token?: string | null;
	source: Exclude<ConnectionSource, "api">;
	serverKeyPin?: string;
	serverPublicKey?: string;
	transportCertificatePin?: string;
	nearbyServiceName?: string;
	pathType?: LocalPathType;
	refreshAccountGrant?: boolean;
	wsBaseUrl?: string;
	httpBaseUrl?: string;
	/** Identity received over the pinned nearby pairing transport after approval. */
	approvedNearbyEnvironment?: {
		readonly environmentId: string;
		readonly label: string;
	};
}): Promise<ConnectionRecord> => {
	const trimmedHost = host.trim();
	const redeemed = await redeemPairingCodeIfNeeded({
		host: trimmedHost,
		port,
		token,
		httpBaseUrl,
	});
	if (
		approvedNearbyEnvironment !== undefined &&
		(source !== "paired" ||
			!redeemed.token ||
			!serverPublicKey ||
			!serverKeyPin ||
			serverKeyPinForPublicKey(serverPublicKey) !== serverKeyPin ||
			!transportCertificatePin ||
			!nearbyServiceName ||
			!approvedNearbyEnvironment.environmentId)
	)
		throw new Error(
			"The approved nearby identity is incomplete. Pair with the Mac again.",
		);
	// Pairing already authenticated this Mac. Persist its trust before opening RPC;
	// a failed disposable route must not discard an approved device credential.
	const descriptor =
		approvedNearbyEnvironment === undefined
			? await describeEnvironment(
					{ host: trimmedHost, port, token: redeemed.token, wsBaseUrl },
					source === "manual" ||
						(source === "paired" && redeemed.token !== null),
				)
			: { ...approvedNearbyEnvironment, capabilities: undefined };
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
		wsBaseUrl,
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
		capabilities: descriptor?.capabilities,
		routeGeneration: 1,
	};
	const next = [record, ...currentConnections().filter((c) => c.key !== key)];
	appAtomRegistry.set(connectionsAtom, next);
	await Effect.runPromise(saveConnections(next));
	return record;
};

/** Upsert a api-discovered environment reached via a managed endpoint. */
export const addApiConnection = async ({
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
				connection.source === "api" &&
				connection.environmentId === environmentId,
		)?.key ?? connectionStorageKey("api", environmentId);
	const record: ConnectionRecord = {
		key,
		environmentId,
		host,
		port,
		wsBaseUrl,
		token,
		label: visibleConnectionLabel(label),
		updatedAt: Date.now(),
		source: "api",
		refreshAccountGrant: true,
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

const descriptorRefreshes = new Map<string, symbol>();

/**
 * Refresh saved metadata only while the request and optional connected generation
 * remain current. Failed or superseded reads leave the saved descriptor intact.
 */
export const refreshConnectionLabel = async (
	key: string,
	options: WsProtocolOptions,
	generation?: number,
): Promise<void> => {
	if (options.cloudWorkspaceId !== undefined) return;
	const original = currentConnections().find(
		(connection) => connection.key === key,
	);
	if (original === undefined) return;
	const request = Symbol();
	descriptorRefreshes.set(key, request);
	try {
		const descriptor = await describeEnvironment(options);
		if (descriptor === null || descriptorRefreshes.get(key) !== request) return;
		const connections = currentConnections();
		const current = connections.find((connection) => connection.key === key);
		if (
			current === undefined ||
			current.token !== original.token ||
			current.host !== original.host ||
			current.port !== original.port ||
			current.wsBaseUrl !== original.wsBaseUrl ||
			current.routeGeneration !== original.routeGeneration
		)
			return;
		if (generation !== undefined) {
			const snapshot = getConnectionSnapshot(options);
			if (snapshot.status !== "connected" || snapshot.generation !== generation)
				return;
		}
		const next = refreshConnectionDescriptor(
			connections,
			key,
			visibleConnectionLabel(descriptor.label, key),
			descriptor.capabilities,
			Date.now(),
			descriptor.environmentId,
		);
		if (next === connections) return;
		appAtomRegistry.set(connectionsAtom, next);
		await Effect.runPromise(saveConnections(next));
	} finally {
		if (descriptorRefreshes.get(key) === request)
			descriptorRefreshes.delete(key);
	}
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

/** Return proxied paired Macs to the address they were paired on. */
export const restorePairedConnectionRoutes = async (
	keys: ReadonlyArray<string>,
): Promise<ReadonlyArray<ConnectionRecord>> => {
	const connections = currentConnections();
	const restored: ConnectionRecord[] = [];
	const next = connections.map((connection) => {
		if (!keys.includes(connection.key)) return connection;
		const updated = restorePairedRoute(connection);
		if (updated !== connection) restored.push(updated);
		return updated;
	});
	if (restored.length === 0) return restored;
	appAtomRegistry.set(connectionsAtom, next);
	await Effect.runPromise(saveConnections(next));
	return restored;
};

export const removeConnection = async (key: string): Promise<void> => {
	descriptorRefreshes.delete(key);
	const next = currentConnections().filter((c) => c.key !== key);
	appAtomRegistry.set(connectionsAtom, next);
	await Effect.runPromise(saveConnections(next));
	await clearMediaCache(key);
};

export const clearConnections = async (): Promise<void> => {
	descriptorRefreshes.clear();
	batchAtomUpdates(() => {
		appAtomRegistry.set(connectionsAtom, []);
		appAtomRegistry.set(connectionsHydratedAtom, true);
	});
	await serializeConnectionWrite(() => SecureStore.deleteItemAsync(STORE_KEY));
	await clearMediaCache();
};

const redeemPairingCodeIfNeeded = async ({
	host,
	port,
	token,
	httpBaseUrl,
}: {
	host: string;
	port: number;
	token?: string | null;
	httpBaseUrl?: string;
}): Promise<{
	readonly token: string | null;
	readonly environmentId?: string;
	readonly environmentPublicKey?: string;
	readonly transportCertificatePin?: string;
}> => {
	const trimmed = token?.trim();
	if (!trimmed) return { token: null };
	if (!trimmed.startsWith("zp_") && !isShortPairingCodeInput(trimmed)) {
		return { token: trimmed };
	}

	return redeemPairingCode({
		host,
		port,
		code: normalizePairingCodeInput(trimmed),
		deviceId: await getOrCreateDeviceId(),
		deviceLabel: deviceLabel(),
		httpBaseUrl,
	});
};

/** Read the live descriptor, preserving connection failures when access is required. */
const describeEnvironment = async (
	options: WsProtocolOptions,
	required = false,
) => {
	try {
		const client = await Effect.runPromise(getConnectionClient(options));
		return await Effect.runPromise(client["connect.describe"]());
	} catch (cause) {
		if (required)
			throw new Error(
				`Could not reach that desktop. ${connectionErrorMessage(cause)}`,
				{ cause },
			);
		return null;
	}
};
