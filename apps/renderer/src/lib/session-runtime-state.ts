import type { ResourceView } from "@zuse/client-runtime/resource-state";
import {
	deriveSessionPresentation,
	type SessionRuntimeState,
} from "@zuse/client-runtime/session-presentation";
import type { SessionTimelineProjection } from "@zuse/contracts";

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

export const runtimeStateFromResource = (
	view: ResourceView<SessionTimelineProjection>,
	fallback: SessionRuntimeState,
): SessionRuntimeState =>
	deriveSessionPresentation({ view, catalogRuntime: fallback }).runtime;
