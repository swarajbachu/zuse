import type { Session, SessionId } from "@zuse/contracts";

export const selectContextSources = (
	sessionsByProject: Readonly<Record<string, ReadonlyArray<Session>>>,
	sessionId: SessionId,
): ReadonlyArray<Session> => {
	const sessions = Object.values(sessionsByProject).flat();
	const current = sessions.find((row) => row.id === sessionId);
	if (current === undefined) return [];

	return sessions
		.filter(
			(row) =>
				row.id !== sessionId &&
				row.archivedAt === null &&
				row.chatId === current.chatId,
		)
		.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
};
