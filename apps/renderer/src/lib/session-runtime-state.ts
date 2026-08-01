import type { SessionStatus } from "@zuse/contracts";

export type SessionRuntimeState =
	| "starting"
	| "running"
	| "stopping"
	| "idle"
	| "failed";

export const runtimeStateFromStatus = (
	status: SessionStatus,
): SessionRuntimeState => {
	switch (status) {
		case "booting":
			return "starting";
		case "running":
			return "running";
		case "error":
			return "failed";
		case "closed":
		case "idle":
			return "idle";
	}
};

export const effectiveSessionRuntimeState = (
	state: SessionRuntimeState | undefined,
): SessionRuntimeState => state ?? "idle";

export const isSessionRuntimeBusy = (state: SessionRuntimeState): boolean =>
	state === "starting" || state === "running" || state === "stopping";

export const isSessionTurnActive = (state: SessionRuntimeState): boolean =>
	state === "running" || state === "stopping";
