import type { CloudChatSummary } from "@zuse/contracts";
import type { CloudAttachmentState } from "../store/cloud-chat-registry.ts";

export type CloudConnectionPresentation =
	| "hidden"
	| "paused"
	| "resuming"
	| "reconnecting"
	| "updating"
	| "failed";

export const cloudConnectionPresentation = (
	summary: CloudChatSummary,
	attachment: CloudAttachmentState,
): CloudConnectionPresentation => {
	if (attachment === "failed") return "failed";
	if (attachment === "ready") return "hidden";
	if (summary.statusCode.includes("runtime-update")) return "updating";
	if (attachment === "attaching")
		return summary.state === "ready" && summary.runtimeState === "online"
			? "reconnecting"
			: "resuming";
	if (summary.state === "paused") return "paused";
	return "hidden";
};
