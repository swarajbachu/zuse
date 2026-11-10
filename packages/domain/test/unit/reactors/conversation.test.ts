import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import type { StoredEvent } from "../../../src/engine/dispatch.js";
import {
	autoNameReactorDefinition,
	chatArchiveReactorDefinition,
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

	test("does not name from a stored message alone", async () => {
		const commands = await Effect.runPromise(
			autoNameReactorDefinition.react(
				record({
					_tag: "MessagePersisted",
					messageId: "message-1",
					turnId: "turn-1",
					role: "user",
					kind: "user",
					contentJson: JSON.stringify({
						_tag: "user",
						text: "Fix reconnect handling",
						goal: false,
					}),
					parentItemId: null,
					createdAt: 1,
				}),
			),
		);

		expect(commands).toEqual([]);
	});

	test("requests naming after a completed turn", async () => {
		const commands = await Effect.runPromise(
			autoNameReactorDefinition.react(
				record({
					_tag: "TurnSettled",
					turnId: "turn-1",
					outcome: "completed",
					settledAt: 2,
				}),
			),
		);

		expect(commands).toEqual([
			{
				streamId: "session-1",
				command: {
					_tag: "AutoNameChat",
					turnId: "turn-1",
					trigger: "turn-completed",
				},
			},
		]);
	});

	test("names as soon as a turn starts unless startup is still held", async () => {
		const commands = await Effect.runPromise(
			autoNameReactorDefinition.react(
				record({ _tag: "TurnStarted", turnId: "turn-1", startedAt: 1 }),
			),
		);

		expect(commands).toEqual([
			{
				streamId: "session-1",
				command: {
					_tag: "AutoNameChat",
					turnId: "turn-1",
					trigger: "turn-started",
				},
			},
		]);
	});

	test("names the first turn when a held startup is released", async () => {
		const released = await Effect.runPromise(
			autoNameReactorDefinition.react(
				record({ _tag: "SessionQueuePausedSet", paused: false, updatedAt: 2 }),
			),
		);
		const paused = await Effect.runPromise(
			autoNameReactorDefinition.react(
				record({ _tag: "SessionQueuePausedSet", paused: true, updatedAt: 2 }),
			),
		);

		expect(released).toEqual([
			{
				streamId: "session-1",
				command: {
					_tag: "AutoNameChat",
					turnId: null,
					trigger: "startup-released",
				},
			},
		]);
		expect(paused).toEqual([]);
	});

	test("does not request naming after an errored turn", async () => {
		const commands = await Effect.runPromise(
			autoNameReactorDefinition.react(
				record({
					_tag: "TurnSettled",
					turnId: "turn-1",
					outcome: "error",
					settledAt: 2,
				}),
			),
		);

		expect(commands).toEqual([]);
	});
});
