import {
	type ChatRef,
	resourceRefKey,
} from "@zuse/client-runtime/resource-ref";
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
	ref: ChatRef,
	controller: BrowserController,
): (() => void) => {
	const key = resourceRefKey(ref);
	controllers.set(key, controller);
	const pending = waiters.get(key);
	if (pending !== undefined) {
		for (const resolve of pending) resolve(controller);
		waiters.delete(key);
	}
	return () => {
		if (controllers.get(key) === controller) controllers.delete(key);
	};
};

export const waitForBrowserController = (
	ref: ChatRef,
	timeoutMs = 5_000,
): Promise<BrowserController | null> => {
	const key = resourceRefKey(ref);
	const existing = controllers.get(key);
	if (existing !== undefined) return Promise.resolve(existing);
	return new Promise((resolve) => {
		const pending = waiters.get(key) ?? new Set();
		let timeout: ReturnType<typeof setTimeout>;
		const wrappedResolve = (controller: BrowserController | null) => {
			clearTimeout(timeout);
			resolve(controller);
		};
		pending.add(wrappedResolve);
		waiters.set(key, pending);
		timeout = setTimeout(() => {
			pending.delete(wrappedResolve);
			if (pending.size === 0) waiters.delete(key);
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
