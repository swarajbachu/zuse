import { Atom } from "effect/unstable/reactivity";
import { AppState } from "react-native";

import { setConnectionSnapshot } from "~/lib/connection-snapshot-state";
import { cloudRuntimeReady } from "~/rpc/cloud-runtime";
import {
	type ConnectionSnapshot,
	checkConnectionsHealth,
	getConnectionSnapshot,
	replaceConnectionSessions,
	retryConnectionNow,
	subscribeConnection,
	supervisedConnectionOptions,
} from "~/rpc/connection";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";
import { recoverLocalRoute } from "./local-route-recovery";
import { retryMobileClientBusConnections } from "./mobile-client-bus";
import { appAtomRegistry } from "./registry";

export const snapshotsByConnectionAtom = Atom.make<
	Record<string, ConnectionSnapshot>
>({}).pipe(Atom.keepAlive);

/** Per-connection snapshot; notifies only when this connection's changes. */
export const connectionSnapshotAtom = Atom.family((connKey: string) =>
	Atom.make((get) => get(snapshotsByConnectionAtom)[connKey]),
);

/**
 * After this long in the background a suspended app has often lost its
 * sockets without a close event, so sessions are replaced instead of probed.
 */
const LONG_BACKGROUND_MS = 10_000;
/** Probe deadline after a short background; a radio can take a moment. */
const RESUME_HEALTH_TIMEOUT_MS = 8_000;

let appStateInstalled = false;

const isLocalProxyRoute = (options: WsProtocolOptions): boolean =>
	options.host === "127.0.0.1" && options.serverKeyPin !== undefined;

/**
 * Sockets stay open in the background. A short trip away probes each
 * session and only replaces dead ones; a long one replaces them at once.
 * Local Bonjour proxies may not survive suspension, so those reopen their
 * route, which reconnects through the fresh proxy in one step.
 */
const resumeConnections = async (backgroundMs: number): Promise<void> => {
	if (backgroundMs >= LONG_BACKGROUND_MS) {
		for (const options of supervisedConnectionOptions()) {
			if (options.key !== undefined && isLocalProxyRoute(options))
				recoverLocalRoute(options.key);
		}
		for (const options of replaceConnectionSessions(
			(candidate) => !isLocalProxyRoute(candidate),
		)) {
			if (options.key !== undefined)
				retryMobileClientBusConnections(options.key);
		}
		return;
	}
	const results = await checkConnectionsHealth(RESUME_HEALTH_TIMEOUT_MS);
	for (const { options, health } of results) {
		if (health === "healthy" || options.key === undefined) continue;
		if (isLocalProxyRoute(options)) recoverLocalRoute(options.key);
		if (health === "replaced") retryMobileClientBusConnections(options.key);
	}
};

const installAppStateResumeBridge = () => {
	if (appStateInstalled) return;
	appStateInstalled = true;
	let backgroundedAt: number | null =
		AppState.currentState === "background" ? Date.now() : null;
	AppState.addEventListener("change", (next) => {
		if (next === "background") {
			backgroundedAt ??= Date.now();
		} else if (next === "active" && backgroundedAt !== null) {
			const backgroundMs = Date.now() - backgroundedAt;
			backgroundedAt = null;
			void resumeConnections(backgroundMs);
		}
	});
};

const patchSnapshot = (connKey: string, snapshot: ConnectionSnapshot): void => {
	appAtomRegistry.update(snapshotsByConnectionAtom, (state) =>
		setConnectionSnapshot(state, connKey, snapshot),
	);
};

export const watchConnection = (
	connKey: string,
	options: WsProtocolOptions,
): (() => void) => {
	if (
		options.cloudWorkspaceId !== undefined &&
		!cloudRuntimeReady(options.cloudWorkspaceId)
	)
		return () => undefined;
	installAppStateResumeBridge();
	patchSnapshot(connKey, getConnectionSnapshot(options));
	return subscribeConnection(options, (snapshot) => {
		patchSnapshot(connKey, snapshot);
	});
};

export const retryConnection = (
	connKey: string,
	options: WsProtocolOptions,
): void => {
	if (isLocalProxyRoute(options) && recoverLocalRoute(connKey)) return;
	retryConnectionNow(options);
	retryMobileClientBusConnections(connKey);
};

export const resetConnectionRuntimeState = (): void => {
	appAtomRegistry.set(snapshotsByConnectionAtom, {});
};

export const connectionStatusLabel = (
	snapshot: ConnectionSnapshot | undefined,
): string => {
	switch (snapshot?.status) {
		case "connected":
			return "Connected";
		case "connecting":
			return "Connecting";
		case "reconnecting":
			return "Reconnecting";
		case "offline":
			return "Offline";
		case "blockedAuth":
			return "Sign in required";
		case "error":
			return "Connection error";
		default:
			return "Not connected";
	}
};
