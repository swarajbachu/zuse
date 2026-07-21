import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import type { StoredEvent } from "../../../src/engine/dispatch.js";
import {
	chatArchiveReactorDefinition,
	providerStartReactorDefinition,
} from "../../../src/reactors/conversation.js";

const record = (event: StoredEvent["event"]): StoredEvent => ({
	eventId: "event-1",
	correlationId: "correlation-1",
	causationEventId: null,
	streamId: "session-1",
	streamVersion: 1,
	sequence: 1,
	event,
});

describe("conversation reactor definitions", () => {
	test("maps a persisted provider start request", async () => {
		const commands = await Effect.runPromise(
			providerStartReactorDefinition.react(
				record({
					_tag: "SessionCreated",
					sessionId: "session-1",
					chatId: "chat-1",
					projectId: "project-1",
					createdAt: 1,
					providerStartJson: "{}",
				}),
			),
		);
		expect(commands).toEqual([
			{
				streamId: "session-1",
				command: { _tag: "StartProvider", providerStartJson: "{}" },
			},
		]);
	});

	test("maps a chat archive request", async () => {
		const commands = await Effect.runPromise(
			chatArchiveReactorDefinition.react({
				...record({ _tag: "SessionDeleted", deletedAt: 1 }),
				streamId: "chat-1",
				event: {
					_tag: "ChatArchiveRequested",
					requestedAt: 2,
					force: false,
				},
			}),
		);
		expect(commands).toEqual([
			{
				streamId: "chat-1",
				command: { _tag: "ArchiveChatWorktree", force: false },
			},
		]);
	});
});
