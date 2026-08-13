import type { SessionStatus, SessionTimelineProjection } from "@zuse/contracts";

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

/** Canonical lifecycle selector shared by every timeline-backed surface. */
export const runtimeStateFromTimeline = (
	projection: SessionTimelineProjection,
): SessionRuntimeState => {
	if (projection.status === "error") return "failed";
	if (projection.status === "booting") return "starting";
	const phase = projection.currentTurn?.phase;
	if (phase === "interrupt-requested" || phase === "interrupt-acknowledged") {
		return "stopping";
	}
	if (projection.currentTurn !== null || projection.status === "running") {
		return "running";
	}
	return "idle";
};
