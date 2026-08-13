import type { CloudChatSummary } from "@zuse/contracts";
import type { CloudChatActivity } from "./cloud-chat-activity.ts";

export type CloudConnectionPresentation =
	| "hidden"
	| "paused"
	| "resuming"
	| "reconnecting"
	| "updating"
	| "failed";

export const cloudConnectionPresentation = (
	summary: CloudChatSummary,
	activity: CloudChatActivity,
): CloudConnectionPresentation => {
	if (activity === "failed") return "failed";
	if (summary.statusCode.includes("runtime-update")) return "updating";
	if (activity === "resuming") return "resuming";
	if (activity === "attaching") return "reconnecting";
	if (activity === "paused") return "paused";
	return "hidden";
};
