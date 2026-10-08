import {
	cloudPhaseLabel,
	cloudWorkspaceIsStarting,
} from "@zuse/client-runtime/cloud-startup-presentation";
import type {
	ConnectionPhase,
	PendingCommand,
} from "@zuse/client-runtime/resource-state";
import type { CloudChatSummary } from "@zuse/contracts";
import type { CloudChatActivity } from "./cloud-chat-activity.ts";
import { waitingCloudMessagePresentation } from "./composer-delivery.ts";

export type CloudQueueStatus = Readonly<{
	label: string;
	/** False when the prompt waits on the user (auth, billing, manual retry). */
	busy: boolean;
}>;

export type CloudLifecycleInput = Readonly<{
	/** Null while the control plane has not yet returned the workspace. */
	summary: CloudChatSummary | null;
	activity: CloudChatActivity | null;
	connection: ConnectionPhase;
}>;

const resumingLabel = (
	summary: CloudChatSummary,
	connection: ConnectionPhase,
): string => {
	if (summary.state === "ready" && summary.runtimeState === "online")
		return connection === "connected"
			? "Starting agent…"
			: "Connecting to cloud workspace…";
	if (summary.runtimeState === "connecting")
		return "Connecting to cloud runtime…";
	if (
		summary.statusCode === "resume-runtime-restarting" ||
		summary.statusCode === "resume-runtime-recovery-queued"
	)
		return "Restarting cloud runtime…";
	if (summary.statusCode === "provider-sandbox-replacing")
		return "Restoring cloud workspace…";
	return "Resuming cloud workspace…";
};

/**
 * The one line describing what cloud compute is doing right now. It follows
 * the durable lifecycle (create → boot → repository → agent, or wake →
 * connect) so the label advances with the workspace instead of staying put.
 */
export const cloudLifecycleLabel = ({
	summary,
	activity,
	connection,
}: CloudLifecycleInput): string => {
	if (summary === null) return "Preparing cloud workspace…";
	if (summary.statusCode.includes("runtime-update"))
		return "Updating cloud runtime…";
	if (cloudWorkspaceIsStarting(summary))
		return cloudPhaseLabel(summary.startupPhase, summary.statusCode);
	switch (activity) {
		case "paused":
		case "resuming":
			return resumingLabel(summary, connection);
		case "attaching":
			return "Connecting to cloud workspace…";
		case "starting-agent":
			return "Starting agent…";
		default:
			return "Waiting for cloud";
	}
};

/**
 * Single status for prompts waiting in the cloud mailbox. A command blocked on
 * the user keeps its actionable label; otherwise the compute lifecycle owns it,
 * so the queue never shows a second, contradictory "waiting" state.
 */
export const cloudQueueStatus = (
	input: CloudLifecycleInput & {
		readonly pendingCommands: readonly PendingCommand[];
	},
): CloudQueueStatus => {
	const waiting = waitingCloudMessagePresentation(input.pendingCommands);
	if (waiting?.blocked === true) return { label: waiting.label, busy: false };
	return { label: cloudLifecycleLabel(input), busy: true };
};
