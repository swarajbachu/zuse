import type { CloudChatSummary } from "@zuse/contracts";
import type { CloudAttachmentState } from "../store/cloud-chat-registry.ts";
import type { SessionRuntimeState } from "./session-runtime-state.ts";

export type CloudCommandState =
	| "queued"
	| "claimed"
	| "acknowledged"
	| "failed"
	| null;

export type CloudChatActivity =
	| "idle"
	| "paused"
	| "queued"
	| "resuming"
	| "attaching"
	| "starting-agent"
	| "running"
	| "stopping"
	| "failed";

export type CloudChatActivityInput = {
	readonly summary: CloudChatSummary;
	readonly attachment: CloudAttachmentState;
	readonly runtime: SessionRuntimeState;
	readonly command: CloudCommandState;
};

/**
 * The only cloud-chat activity projection used by renderer surfaces.
 *
 * It intentionally contains no mutable lifecycle of its own: compute comes
 * from the durable workspace summary, delivery from the durable command, the
 * socket from the shared supervisor, and agent work from the session timeline.
 */
export const deriveCloudChatActivity = ({
	summary,
	attachment,
	runtime,
	command,
}: CloudChatActivityInput): CloudChatActivity => {
	if (
		summary.state === "failed" ||
		attachment === "failed" ||
		command === "failed"
	)
		return "failed";

	const pendingCommand = command === "queued" || command === "claimed";
	const computeReady =
		summary.state === "ready" && summary.runtimeState === "online";
	if (pendingCommand) {
		if (!computeReady) return "resuming";
		if (attachment !== "ready") return "attaching";
		return "queued";
	}
	// A paused durable workspace cannot still be executing. Cached session state
	// may describe the turn that completed before the sandbox paused, so the
	// durable compute lifecycle must win once there is no command waiting.
	if (summary.state === "paused") return "paused";
	if (runtime === "failed") return "failed";
	if (
		!computeReady &&
		attachment !== "ready" &&
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

	if (attachment === "attaching")
		return computeReady ? "attaching" : "resuming";
	if (
		summary.state === "resuming" ||
		summary.runtimeState === "connecting" ||
		summary.statusCode.startsWith("resume-")
	)
		return computeReady ? "idle" : "resuming";
	if (summary.startupPhase === "starting-agent" && command !== "acknowledged")
		return "starting-agent";
	return "idle";
};
