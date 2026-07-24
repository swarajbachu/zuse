import type { ChatId, FolderId, Session, SessionId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import { selectContextSources } from "../../src/lib/context-sources.ts";

const projectId = "project-1" as FolderId;
const chatId = "chat-1" as ChatId;
const now = new Date("2026-07-24T00:00:00.000Z");

const session = (id: string, overrides: Partial<Session> = {}): Session =>
	({
		id: id as SessionId,
		projectId,
		title: id,
		titleProvenance: "manual",
		providerId: "codex",
		model: "gpt-5.4",
		status: "idle",
		archivedAt: null,
		cursor: null,
		resumeStrategy: "none",
		runtimeMode: "approval-required",
		worktreeId: null,
		chatId,
		forkedFromSessionId: null,
		forkedFromMessageId: null,
		permissionMode: "default",
		toolSearch: false,
		createdAt: now,
		updatedAt: now,
		...overrides,
	}) as Session;

describe("context sources", () => {
	it("offers prior sessions from the same chat, but never sessions from another chat", () => {
		const current = session("current");
		const sameChat = session("same-chat");
		const otherChat = session("other-chat", {
			chatId: "chat-2" as ChatId,
		});

		expect(
			selectContextSources(
				{ [projectId]: [otherChat, sameChat, current] },
				current.id,
			).map((row) => row.id),
		).toEqual([sameChat.id]);
	});
});
