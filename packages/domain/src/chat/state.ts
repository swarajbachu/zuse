import type { ChatEvent } from "./events.js";

export type ChatState = {
	readonly exists: boolean;
	readonly deleted: boolean;
	readonly archived: boolean;
	readonly chatId: string | null;
	readonly projectId: string | null;
	readonly worktreeId: string | null;
	readonly title: string | null;
	readonly activeSessionId: string | null;
	readonly originSessionId: string | null;
	readonly lastReadAt: number | null;
	readonly archivedWorktreeJson: string | null;
	readonly version: number;
};

export const initialChatState: ChatState = {
	exists: false,
	deleted: false,
	archived: false,
	chatId: null,
	projectId: null,
	worktreeId: null,
	title: null,
	activeSessionId: null,
	originSessionId: null,
	lastReadAt: null,
	archivedWorktreeJson: null,
	version: 0,
};

export const evolveChat = (state: ChatState, event: ChatEvent): ChatState => {
	const version = state.version + 1;
	switch (event._tag) {
		case "ChatCreated":
			return {
				...state,
				exists: true,
				chatId: event.chatId,
				projectId: event.projectId,
				worktreeId: event.worktreeId,
				title: event.title,
				originSessionId: event.originSessionId,
				lastReadAt: event.lastReadAt,
				version,
			};
		case "ChatRenamed":
			return { ...state, title: event.title, version };
		case "ChatRead":
			return { ...state, lastReadAt: event.readAt, version };
		case "ChatWorktreeSet":
			return { ...state, worktreeId: event.worktreeId, version };
		case "ChatActiveSessionSet":
			return { ...state, activeSessionId: event.sessionId, version };
		case "ChatArchived":
			return {
				...state,
				archived: true,
				archivedWorktreeJson: event.archivedWorktreeJson,
				version,
			};
		case "ChatUnarchived":
			return {
				...state,
				archived: false,
				worktreeId: event.worktreeId,
				archivedWorktreeJson: null,
				version,
			};
		case "ChatDeleted":
			return { ...state, deleted: true, version };
	}
};

export const evolveChats = (
	state: ChatState,
	events: readonly ChatEvent[],
): ChatState => events.reduce(evolveChat, state);
