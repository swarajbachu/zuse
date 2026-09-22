import type {
	ConnectionPhase,
	ResourceView,
} from "@zuse/client-runtime/resource-state";
import type {
	CloudChatSummary,
	SessionTimelineProjection,
} from "@zuse/contracts";
import {
	runtimeStateFromTimeline,
	type SessionRuntimeState,
} from "./session-runtime-state.ts";

export type CloudChatActivity =
	| "idle"
	| "paused"
	| "resuming"
	| "attaching"
	| "starting-agent"
	| "running"
	| "stopping"
	| "failed";

export type CloudChatActivityInput = {
	readonly summary: CloudChatSummary;
	readonly connection: ConnectionPhase;
	readonly runtime: SessionRuntimeState;
	readonly timeline?: ResourceView<SessionTimelineProjection>;
};

/** Whether the durable cloud lifecycle still owns the initial chat setup UI. */
export const cloudWorkspaceIsStarting = (summary: CloudChatSummary): boolean =>
	summary.startupPhase === "allocating" ||
	summary.startupPhase === "booting" ||
	summary.startupPhase === "authenticating-runtime" ||
	summary.startupPhase === "syncing-repository";

/** True only after a live runtime owns the turn. Resume, attachment, and
 * durable queueing have their own connection notice and must not render the
 * transcript working row or Stop controls from stale cached session state. */
export const cloudChatShowsWorking = (activity: CloudChatActivity): boolean =>
	activity === "starting-agent" ||
	activity === "running" ||
	activity === "stopping";

/**
 * The only cloud-chat activity projection used by renderer surfaces.
 *
 * It intentionally contains no mutable lifecycle of its own: compute comes
 * from the durable workspace summary, the socket from the shared supervisor,
 * and agent work from the session timeline.
 */
export const deriveCloudChatActivity = ({
	summary,
	connection,
	runtime,
	timeline,
}: CloudChatActivityInput): CloudChatActivity => {
	if (
		summary.state === "failed" ||
		connection === "blocked-auth" ||
		connection === "update-required" ||
		connection === "revoked"
	)
		return "failed";
	if (summary.state === "paused") return "paused";

	const computeReady =
		summary.state === "ready" && summary.runtimeState === "online";

	// A turn observed from this live runtime remains interruptible while its
	// transport reconnects or history synchronizes. Disk/checkpoint state cannot
	// establish liveness, and the durable compute lifecycle still wins above.
	if (
		computeReady &&
		timeline?.origin === "runtime" &&
		timeline.data?.currentTurn != null
	) {
		const observed = runtimeStateFromTimeline(timeline.data);
		if (observed === "running" || observed === "stopping") {
			return timeline.pendingCommands.some(
				(command) => command.kind === "messages.interrupt",
			)
				? "stopping"
				: observed;
		}
	}

	// A paused durable workspace cannot still be executing. Cached session state
	// may describe the turn that completed before the sandbox paused, so the
	// durable compute lifecycle must win once there is no command waiting.
	if (
		!computeReady &&
		connection !== "connected" &&
		(summary.state === "resuming" ||
			summary.runtimeState === "connecting" ||
			summary.statusCode.startsWith("resume-"))
	)
		return "resuming";

	// A retained socket failure is expected while compute wakes. Only surface
	// transport/turn failures after the durable resume lifecycle has finished.
	if (connection === "failed" || runtime === "failed") return "failed";

	// Cached turn state is not evidence that a disconnected runtime is working.
	if (connection !== "connected")
		return computeReady ? "attaching" : "resuming";
	if (!computeReady) {
		return runtime === "starting" && summary.startupPhase === "starting-agent"
			? "starting-agent"
			: "resuming";
	}

	if (runtime === "stopping") return "stopping";
	if (runtime === "running") return "running";
	if (runtime === "starting")
		return summary.startupPhase === "starting-agent"
			? "starting-agent"
			: "running";
	if (
		summary.startupPhase === "starting-agent" &&
		summary.statusCode === "agent-starting"
	)
		return "starting-agent";

	return "idle";
};
