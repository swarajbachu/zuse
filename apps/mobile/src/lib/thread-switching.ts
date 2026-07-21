import type { SessionId } from "@zuse/contracts";

export const activeThreadSelection = (
	activeSessionId: SessionId | null | undefined,
	openingSessionId: SessionId,
): SessionId => activeSessionId ?? openingSessionId;

export const shouldRestoreThreadPosition = (
	openAtLatest: string | undefined,
): boolean => openAtLatest !== "1";

export const switchToThread = (
	sessionId: SessionId,
	showLoading: (sessionId: SessionId) => void,
	activate: (sessionId: SessionId) => Promise<void>,
	navigate: (sessionId: SessionId) => void,
): void => {
	showLoading(sessionId);
	void activate(sessionId).catch(() => {});
	navigate(sessionId);
};
