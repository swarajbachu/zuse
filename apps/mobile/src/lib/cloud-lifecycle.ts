import { cloudWorkspaceIsStarting } from "@zuse/client-runtime/cloud-startup-presentation";
import type { CloudChatSummary } from "@zuse/contracts";

export type CloudLifecycle = "starting" | "resuming" | "failed" | "paused";

/** Which part of the cloud lifecycle, if any, should own the chat header. */
export const cloudLifecycle = (
	summary: CloudChatSummary | undefined,
): CloudLifecycle | null => {
	if (summary === undefined) return null;
	if (summary.startupPhase === "failed" || summary.state === "failed")
		return "failed";
	// Once the agent is starting, the chat's own working/queued states take
	// over; the workspace is no longer the thing being waited on.
	if (cloudWorkspaceIsStarting(summary)) return "starting";
	if (summary.state === "resuming") return "resuming";
	if (summary.state === "paused") return "paused";
	return null;
};
