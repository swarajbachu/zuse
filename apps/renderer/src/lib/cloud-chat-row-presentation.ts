import type { CloudChatSummary } from "@zuse/contracts";
import type { CloudChatActivity } from "./cloud-chat-activity.ts";

export type CloudChatRowPresentation = {
	readonly label: string;
	readonly busy: boolean;
};

/** One presentation for the durable workspace lifecycle and its current turn. */
export const cloudChatRowPresentation = (
	summary: CloudChatSummary,
	activity: CloudChatActivity,
): CloudChatRowPresentation => {
	const archivePending =
		summary.desiredState === "archived" && summary.state !== "failed";
	if (summary.desiredState === "archived" && summary.state === "failed")
		return { label: "Archive failed", busy: false };
	if (archivePending) return { label: "Archiving…", busy: true };
	if (summary.state === "failed")
		return { label: "Needs attention", busy: false };

	switch (activity) {
		case "failed":
			return { label: "Needs attention", busy: false };
		case "paused":
			return { label: "Paused", busy: false };
		case "queued":
			return { label: "Queued", busy: true };
		case "resuming":
			return { label: "Resuming", busy: true };
		case "attaching":
			return { label: "Connecting", busy: true };
		case "starting-agent":
		case "running":
			return { label: "Working", busy: true };
		case "stopping":
			return { label: "Stopping", busy: true };
		case "idle":
			return { label: "Active", busy: false };
	}
};
