import type {
	BrowserCommandRequest,
	ChatId,
	Session,
	SessionId,
} from "@zuse/contracts";

export type BrowserController = (
	request: BrowserCommandRequest,
) => Promise<void>;

const controllers = new Map<string, BrowserController>();
const waiters = new Map<
	string,
	Set<(controller: BrowserController | null) => void>
>();

export const registerBrowserController = (
	chatId: ChatId,
	controller: BrowserController,
): (() => void) => {
	controllers.set(chatId, controller);
	const pending = waiters.get(chatId);
	if (pending !== undefined) {
		for (const resolve of pending) resolve(controller);
		waiters.delete(chatId);
	}
	return () => {
		if (controllers.get(chatId) === controller) controllers.delete(chatId);
	};
};

export const waitForBrowserController = (
	chatId: ChatId,
	timeoutMs = 5_000,
): Promise<BrowserController | null> => {
	const existing = controllers.get(chatId);
	if (existing !== undefined) return Promise.resolve(existing);
	return new Promise((resolve) => {
		const pending = waiters.get(chatId) ?? new Set();
		let timeout: ReturnType<typeof setTimeout>;
		const wrappedResolve = (controller: BrowserController | null) => {
			clearTimeout(timeout);
			resolve(controller);
		};
		pending.add(wrappedResolve);
		waiters.set(chatId, pending);
		timeout = setTimeout(() => {
			pending.delete(wrappedResolve);
			if (pending.size === 0) waiters.delete(chatId);
			resolve(null);
		}, timeoutMs);
	});
};

export const browserChatIdForSession = (
	sessionsByProject: Record<string, ReadonlyArray<Session>>,
	sessionId: SessionId,
): ChatId | null => {
	for (const sessions of Object.values(sessionsByProject)) {
		const session = sessions.find((candidate) => candidate.id === sessionId);
		if (session !== undefined) return session.chatId;
	}
	return null;
};
