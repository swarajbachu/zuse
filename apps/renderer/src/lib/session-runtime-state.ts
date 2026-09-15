import type { SessionRuntimeState } from "@zuse/client-runtime/session-presentation";

export type { SessionRuntimeState } from "@zuse/client-runtime/session-presentation";
export {
	hasPendingTurnStart,
	isSessionRuntimeBusy,
	isSessionTurnActive,
	runtimeStateFromStatus,
	runtimeStateFromTimeline,
} from "@zuse/client-runtime/session-presentation";

export const effectiveSessionRuntimeState = (
	state: SessionRuntimeState | undefined,
): SessionRuntimeState => state ?? "idle";
