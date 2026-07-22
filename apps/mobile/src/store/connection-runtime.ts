import { Atom } from "effect/unstable/reactivity";
import { AppState } from "react-native";

import {
	type ConnectionSnapshot,
	getConnectionSnapshot,
	retryConnectionNow,
	setConnectionOnline,
	subscribeConnection,
} from "~/rpc/connection";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";

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
	AppState.addEventListener("change", (next) => {
		// Treat background as offline for transport ownership: active screens keep
		// cached data, and the supervisor reconnects when the app wakes.
		setConnectionOnline(next !== "background");
	});
};

const patchSnapshot = (connKey: string, snapshot: ConnectionSnapshot): void => {
	appAtomRegistry.update(snapshotsByConnectionAtom, (state) => ({
		...state,
		[connKey]: snapshot,
	}));
};

export const watchConnection = (
	connKey: string,
	options: WsProtocolOptions,
): (() => void) => {
	installAppStateOnlineBridge();
	patchSnapshot(connKey, getConnectionSnapshot(options));
	return subscribeConnection(options, (snapshot) => {
		patchSnapshot(connKey, snapshot);
	});
};

export const retryConnection = (
	_connKey: string,
	options: WsProtocolOptions,
): void => retryConnectionNow(options);

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
