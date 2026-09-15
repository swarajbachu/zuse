import { Atom } from "effect/unstable/reactivity";
import { AppState } from "react-native";

import { setConnectionSnapshot } from "~/lib/connection-snapshot-state";
import { cloudRuntimeReady } from "~/rpc/cloud-runtime";
import {
	type ConnectionSnapshot,
	getConnectionSnapshot,
	retryConnectionNow,
	setConnectionOnline,
	subscribeConnection,
} from "~/rpc/connection";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";
import { recoverLocalRoute } from "./local-route-recovery";
import { retryMobileClientBusConnections, setMobileClientBusOnline } from "./mobile-client-bus";
import { appAtomRegistry } from "./registry";

export const snapshotsByConnectionAtom = Atom.make<
	Record<string, ConnectionSnapshot>
>({}).pipe(Atom.keepAlive);

/** Per-connection snapshot; notifies only when this connection's changes. */
export const connectionSnapshotAtom = Atom.family((connKey: string) =>
	Atom.make((get) => get(snapshotsByConnectionAtom)[connKey]),
);

let appStateInstalled = false;

const installAppStateOnlineBridge = () => {
	if (appStateInstalled) return;
	appStateInstalled = true;
	let wasBackgrounded = AppState.currentState === "background";
	if (wasBackgrounded) {
		setConnectionOnline(false);
		setMobileClientBusOnline(false);
	}
	AppState.addEventListener("change", (next) => {
		// Treat background as offline for transport ownership: active screens keep
		// cached data, and the supervisor reconnects when the app wakes.
		if (next === "background") {
			wasBackgrounded = true;
			setConnectionOnline(false);
			setMobileClientBusOnline(false);
		} else if (next === "active" && wasBackgrounded) {
			wasBackgrounded = false;
			setConnectionOnline(true);
			setMobileClientBusOnline(true);
			retryMobileClientBusConnections();
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
	installAppStateOnlineBridge();
	patchSnapshot(connKey, getConnectionSnapshot(options));
	return subscribeConnection(options, (snapshot) => {
		patchSnapshot(connKey, snapshot);
	});
};

export const retryConnection = (
	connKey: string,
	options: WsProtocolOptions,
): void => {
	if (
		options.host === "127.0.0.1" &&
		options.serverKeyPin !== undefined &&
		recoverLocalRoute(connKey)
	)
		return;
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
