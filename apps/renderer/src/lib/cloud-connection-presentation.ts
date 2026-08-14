import type { CloudChatSummary } from "@zuse/contracts";
import type { CloudChatActivity } from "./cloud-chat-activity.ts";

export type CloudConnectionPresentation =
	| "hidden"
	| "paused"
	| "resuming"
	| "updating"
	| "failed";

export const cloudConnectionPresentation = (
	summary: CloudChatSummary,
	activity: CloudChatActivity,
): CloudConnectionPresentation => {
	if (activity === "failed") return "failed";
	if (summary.statusCode.includes("runtime-update")) return "updating";
	if (activity === "resuming") return "resuming";
	// Attaching already-online compute is a passive refresh over cached data,
	// not a user-blocking lifecycle state.
	if (activity === "attaching") return "hidden";
	if (activity === "paused") return "paused";
	return "hidden";
};
