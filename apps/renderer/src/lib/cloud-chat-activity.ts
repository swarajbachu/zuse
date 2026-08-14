import type { ConnectionPhase } from "@zuse/client-runtime/resource-state";
import type { CloudChatSummary } from "@zuse/contracts";
import type { SessionRuntimeState } from "./session-runtime-state.ts";

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
};

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
}: CloudChatActivityInput): CloudChatActivity => {
	const computeReady =
		summary.state === "ready" && summary.runtimeState === "online";
	if (
		summary.state === "failed" ||
		connection === "blocked-auth" ||
		connection === "update-required" ||
		connection === "revoked"
	)
		return "failed";
	// A failed socket attach does not mean already-online compute or its cached
	// transcript failed. Keep it in the passive attachment state while the one
	// supervisor retries; only lifecycle/auth failures are user-actionable here.
	if (connection === "failed") return computeReady ? "attaching" : "failed";

	// A paused durable workspace cannot still be executing. Cached session state
	// may describe the turn that completed before the sandbox paused, so the
	// durable compute lifecycle must win once there is no command waiting.
	if (summary.state === "paused") return "paused";
	if (runtime === "failed") return "failed";
	if (
		!computeReady &&
		connection !== "connected" &&
		(summary.state === "resuming" ||
			summary.runtimeState === "connecting" ||
			summary.statusCode.startsWith("resume-"))
	)
		return "resuming";

	if (runtime === "stopping") return "stopping";
	if (runtime === "running") return "running";
	if (runtime === "starting")
		return summary.startupPhase === "starting-agent"
			? "starting-agent"
			: "running";

	if (
		connection === "waking" ||
		connection === "connecting" ||
		connection === "reconnecting"
	)
		return computeReady ? "attaching" : "resuming";
	if (
		summary.state === "resuming" ||
		summary.runtimeState === "connecting" ||
		summary.statusCode.startsWith("resume-")
	)
		return computeReady ? "idle" : "resuming";
	if (summary.startupPhase === "starting-agent") return "starting-agent";
	return "idle";
};
