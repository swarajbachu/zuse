import type { Chat, Session, SessionStatus } from "@zuse/contracts";

export const threadDisplayTitle = (
	session: Session,
	chat: Pick<Chat, "title"> | null,
	index: number,
): string => {
	const title = session.title.trim();
	if (title.length > 0 && title !== chat?.title.trim()) return title;
	if (session.permissionMode === "plan") return "Planning";
	return `Thread ${index + 1}`;
};

export const threadStatusLabel = (status: SessionStatus): string => {
	switch (status) {
		case "booting":
			return "Starting";
		case "running":
			return "Running";
		case "error":
			return "Error";
		case "closed":
			return "Closed";
		default:
			return "Idle";
	}
};

export const hasRunningChatThread = (
	threads: readonly Session[],
	statusOf: (session: Session) => SessionStatus,
): boolean => threads.some((thread) => statusOf(thread) === "running");

export const nearestSurvivingThread = (
	threads: readonly Session[],
	removedSessionId: Session["id"],
): Session | null => {
	const index = threads.findIndex((thread) => thread.id === removedSessionId);
	if (index < 0) return threads[0] ?? null;
	return threads[index + 1] ?? threads[index - 1] ?? null;
};
