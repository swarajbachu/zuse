import type { Chat, ChatId, Session, SessionId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	activeChatId,
	orderedChatSessions,
	resolveActiveChatSession,
} from "../../src/chat-threads.ts";

const session = (
	id: string,
	chatId: string,
	createdAt: string,
	archivedAt: string | null = null,
): Session => ({ id, chatId, createdAt, archivedAt }) as unknown as Session;

describe("chat thread projection", () => {
	const sessions = [
		session("c", "chat-1", "2024-01-03T00:00:00Z"),
		session("a", "chat-1", "2024-01-01T00:00:00Z"),
		session("b", "chat-1", "2024-01-02T00:00:00Z"),
		session("other", "chat-2", "2024-01-01T00:00:00Z"),
		session(
			"archived",
			"chat-1",
			"2024-01-04T00:00:00Z",
			"2024-02-01T00:00:00Z",
		),
	];

	it("orders live sessions oldest first", () => {
		expect(
			orderedChatSessions(sessions, "chat-1" as ChatId).map((item) => item.id),
		).toEqual(["a", "b", "c"]);
	});

	it("resolves the persisted active session", () => {
		const chat = {
			id: "chat-1" as ChatId,
			activeSessionId: "b" as SessionId,
		} as Chat;
		expect(resolveActiveChatSession(chat, sessions)?.id).toBe("b");
	});

	it("falls back to the newest live session", () => {
		const chat = {
			id: "chat-1" as ChatId,
			activeSessionId: "missing" as SessionId,
		} as Chat;
		expect(resolveActiveChatSession(chat, sessions)?.id).toBe("c");
	});

	it("derives the visible chat from the selected session", () => {
		expect(
			activeChatId(sessions, "other" as SessionId, "chat-1" as ChatId),
		).toBe("chat-2");
	});
});
