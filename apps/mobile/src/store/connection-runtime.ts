import { AppState } from "react-native";
import { create } from "zustand";

import {
	type ConnectionSnapshot,
	getConnectionSnapshot,
	retryConnectionNow,
	setConnectionOnline,
	subscribeConnection,
} from "~/rpc/connection";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";

type RuntimeState = {
	snapshotsByConnection: Record<string, ConnectionSnapshot>;
	watch: (connKey: string, options: WsProtocolOptions) => () => void;
	retry: (connKey: string, options: WsProtocolOptions) => void;
};

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

export const useConnectionRuntimeStore = create<RuntimeState>((set) => ({
	snapshotsByConnection: {},
	watch: (connKey, options) => {
		installAppStateOnlineBridge();
		set((state) => ({
			snapshotsByConnection: {
				...state.snapshotsByConnection,
				[connKey]: getConnectionSnapshot(options),
			},
		}));
		return subscribeConnection(options, (snapshot) => {
			set((state) => ({
				snapshotsByConnection: {
					...state.snapshotsByConnection,
					[connKey]: snapshot,
				},
			}));
		});
	},
	retry: (_connKey, options) => retryConnectionNow(options),
}));

export const resetConnectionRuntimeState = (): void => {
	useConnectionRuntimeStore.setState({ snapshotsByConnection: {} });
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
