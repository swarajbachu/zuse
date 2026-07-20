import type { Chat, ChatId, Session, SessionId } from "@zuse/contracts";

/**
 * The chat whose sessions should be presented. Prefer the session the user is
 * actually viewing; fall back to the selected chat while navigation settles.
 */
export const activeChatId = (
	sessions: readonly Session[],
	selectedSessionId: SessionId | null,
	selectedChatId: ChatId | null,
): ChatId | null => {
	if (selectedSessionId !== null) {
		const session = sessions.find((item) => item.id === selectedSessionId);
		if (session !== undefined) return session.chatId;
	}
	return selectedChatId;
};

/** Non-archived threads in stable creation order. */
export const orderedChatSessions = (
	sessions: readonly Session[],
	chatId: ChatId | null,
): Session[] => {
	if (chatId === null) return [];
	return sessions
		.filter(
			(session) => session.chatId === chatId && session.archivedAt === null,
		)
		.slice()
		.sort(
			(left, right) =>
				timestampOf(left.createdAt) - timestampOf(right.createdAt) ||
				String(left.id).localeCompare(String(right.id)),
		);
};

/**
 * Resolve the thread a chat should open. The persisted active thread wins when
 * it is still live; otherwise the newest live thread is the deterministic
 * recovery target.
 */
export const resolveActiveChatSession = (
	chat: Pick<Chat, "id" | "activeSessionId">,
	sessions: readonly Session[],
): Session | null => {
	const ordered = orderedChatSessions(sessions, chat.id);
	if (ordered.length === 0) return null;
	return (
		ordered.find((session) => session.id === chat.activeSessionId) ??
		ordered.at(-1) ??
		null
	);
};

const timestampOf = (value: Date | string | number): number => {
	const timestamp =
		value instanceof Date ? value.getTime() : new Date(value).getTime();
	return Number.isFinite(timestamp) ? timestamp : 0;
};
