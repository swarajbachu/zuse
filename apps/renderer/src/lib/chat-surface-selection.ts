export type ChatSurface = "session" | "pending" | "landing";

/**
 * Keep the live session shell mounted once its optimistic entity exists.
 * Creation progress is rendered inside that shell, so independent durable
 * chat/lifecycle emissions cannot remove the composer or remount the message.
 */
export const selectChatSurface = (input: {
	readonly hasSession: boolean;
	readonly hasPendingCreation: boolean;
}): ChatSurface =>
	input.hasSession
		? "session"
		: input.hasPendingCreation
			? "pending"
			: "landing";
