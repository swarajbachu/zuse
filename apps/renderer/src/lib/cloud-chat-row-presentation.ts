import "@zuse/i18n/english/connections";
import type { CloudChatSummary } from "@zuse/contracts";
import { message as uiMessage } from "@zuse/i18n";
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
		return {
			label: uiMessage(
				"connections:cloud_chat_row_presentation_archive_failed",
			),
			busy: false,
		};
	if (archivePending)
		return {
			label: uiMessage("connections:cloud_chat_row_presentation_archiving"),
			busy: true,
		};
	if (summary.state === "failed")
		return {
			label: uiMessage(
				"connections:cloud_chat_row_presentation_needs_attention",
			),
			busy: false,
		};

	switch (activity) {
		case "failed":
			return {
				label: uiMessage(
					"connections:cloud_chat_row_presentation_needs_attention",
				),
				busy: false,
			};
		case "paused":
			return {
				label: uiMessage("connections:cloud_chat_row_presentation_paused"),
				busy: false,
			};
		case "resuming":
			return {
				label: uiMessage("connections:cloud_chat_row_presentation_resuming"),
				busy: true,
			};
		case "attaching":
			return {
				label: uiMessage("connections:cloud_chat_row_presentation_connecting"),
				busy: true,
			};
		case "starting-agent":
		case "running":
			return {
				label: uiMessage("connections:cloud_chat_row_presentation_working"),
				busy: true,
			};
		case "stopping":
			return {
				label: uiMessage("connections:cloud_chat_row_presentation_stopping"),
				busy: true,
			};
		case "idle":
			return {
				label: uiMessage("connections:cloud_chat_row_presentation_active"),
				busy: false,
			};
	}
};
