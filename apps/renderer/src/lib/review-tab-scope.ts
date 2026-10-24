import { useChatsStore } from "../store/chats.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { getActiveEnvironment } from "./rpc-client.ts";

const reviewTabScope = (
	environmentId: string,
	chatId: string | null,
	sessionId: string | null,
): string => JSON.stringify([environmentId, chatId, sessionId]);

export const currentReviewTabScope = (): string =>
	reviewTabScope(
		getActiveEnvironment(),
		useChatsStore.getState().selectedChatId,
		useSessionsStore.getState().selectedSessionId,
	);

export const useReviewTabScope = (environmentId: string): string => {
	const chatId = useChatsStore((s) => s.selectedChatId);
	const sessionId = useSessionsStore((s) => s.selectedSessionId);
	return reviewTabScope(environmentId, chatId, sessionId);
};
