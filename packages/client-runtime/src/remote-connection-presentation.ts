import type { ConnectionPhase } from "./resource-state";

/** Presence and saved registrations are not observations of a client connection. */
export const remoteConnectionPresentation = (phase: ConnectionPhase) => {
	switch (phase) {
		case "dormant":
			return { label: "Not connected", action: "Connect" };
		case "connected":
			return { label: "Connected", action: null };
		case "connecting":
			return { label: "Connecting…", action: null };
		case "waking":
			return { label: "Starting…", action: null };
		case "reconnecting":
			return { label: "Reconnecting…", action: null };
		case "offline":
			return { label: "Connection lost", action: "Retry" };
		case "blocked-auth":
			return { label: "Sign-in required", action: "Sign in" };
		case "update-required":
			return { label: "Update required", action: "Update" };
		case "revoked":
			return { label: "Access revoked", action: "Pair again" };
		case "failed":
			return { label: "Couldn’t connect", action: "Retry" };
	}
};
