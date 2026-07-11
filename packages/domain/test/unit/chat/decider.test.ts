import { Result } from "effect";
import { describe, expect, test } from "vitest";

import type { ChatCommand } from "../../../src/chat/commands.js";
import {
	ChatAlreadyExists,
	ChatValidationFailed,
	decideChat,
} from "../../../src/chat/decider.js";
import { evolveChats, initialChatState } from "../../../src/chat/state.js";

const created: ChatCommand = {
	_tag: "CreateChat",
	chatId: "chat-1",
	projectId: "project-1",
	worktreeId: null,
	title: " Chat title ",
	originSessionId: null,
	lastReadAt: 10,
	createdAt: 10,
};

describe("chat decider", () => {
	test("creates and evolves a complete chat", () => {
		const result = decideChat(initialChatState, created);
		expect(Result.isSuccess(result)).toBe(true);
		if (Result.isFailure(result)) return;

		const state = evolveChats(initialChatState, result.success);
		expect(state).toMatchObject({
			exists: true,
			chatId: "chat-1",
			projectId: "project-1",
			title: "Chat title",
			lastReadAt: 10,
			version: 1,
		});
	});

	test("rejects duplicate creation and blank titles", () => {
		const first = decideChat(initialChatState, created);
		if (Result.isFailure(first)) throw first.failure;
		const state = evolveChats(initialChatState, first.success);

		const duplicate = decideChat(state, created);
		expect(Result.isFailure(duplicate) && duplicate.failure).toBeInstanceOf(
			ChatAlreadyExists,
		);
		const blank = decideChat(state, {
			_tag: "RenameChat",
			title: "   ",
			updatedAt: 20,
		});
		expect(Result.isFailure(blank) && blank.failure).toBeInstanceOf(
			ChatValidationFailed,
		);
	});

	test("makes repeated archive and unarchive commands idempotent", () => {
		const first = decideChat(initialChatState, created);
		if (Result.isFailure(first)) throw first.failure;
		let state = evolveChats(initialChatState, first.success);
		const archive: ChatCommand = {
			_tag: "ArchiveChat",
			archivedAt: 20,
			archivedWorktreeJson: null,
		};
		const archived = decideChat(state, archive);
		if (Result.isFailure(archived)) throw archived.failure;
		state = evolveChats(state, archived.success);
		expect(Result.getOrThrow(decideChat(state, archive))).toEqual([]);

		const unarchive: ChatCommand = {
			_tag: "UnarchiveChat",
			unarchivedAt: 30,
			worktreeId: null,
		};
		const unarchived = decideChat(state, unarchive);
		if (Result.isFailure(unarchived)) throw unarchived.failure;
		state = evolveChats(state, unarchived.success);
		expect(Result.getOrThrow(decideChat(state, unarchive))).toEqual([]);
	});

	test("emits one durable archive request until the archive settles", () => {
		const first = decideChat(initialChatState, created);
		if (Result.isFailure(first)) throw first.failure;
		let state = evolveChats(initialChatState, first.success);
		const request: ChatCommand = {
			_tag: "RequestArchiveChat",
			force: false,
			requestedAt: 20,
		};
		const requested = Result.getOrThrow(decideChat(state, request));
		expect(requested).toEqual([
			{ _tag: "ChatArchiveRequested", force: false, requestedAt: 20 },
		]);
		state = evolveChats(state, requested);
		expect(Result.getOrThrow(decideChat(state, request))).toEqual([]);
	});

	test("emits one durable deletion request", () => {
		const first = decideChat(initialChatState, created);
		if (Result.isFailure(first)) throw first.failure;
		let state = evolveChats(initialChatState, first.success);
		const request: ChatCommand = {
			_tag: "RequestDeleteChat",
			requestedAt: 20,
		};
		const requested = Result.getOrThrow(decideChat(state, request));
		expect(requested).toEqual([
			{ _tag: "ChatDeleteRequested", requestedAt: 20 },
		]);
		state = evolveChats(state, requested);
		expect(Result.getOrThrow(decideChat(state, request))).toEqual([]);
	});
});
