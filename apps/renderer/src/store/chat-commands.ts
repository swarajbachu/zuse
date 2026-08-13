import type { Chat, Session, SessionId } from "@zuse/contracts";

type ChatCommands = {
	readonly upsertFork: (chat: Chat, session: Session) => void;
	readonly setActiveSession: (chatId: Chat["id"], sessionId: SessionId) => void;
};

let commands: ChatCommands | null = null;

export const registerChatCommands = (next: ChatCommands): void => {
	commands = next;
};

export const upsertForkedChat = (chat: Chat, session: Session): void => {
	commands?.upsertFork(chat, session);
};

export const selectChatSession = (
	chatId: Chat["id"],
	sessionId: SessionId,
): void => {
	commands?.setActiveSession(chatId, sessionId);
};
