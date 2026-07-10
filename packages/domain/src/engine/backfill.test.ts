import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import { InMemorySessionReadModel } from "../projectors/read-model.js";
import { synthesizeBackfill } from "./backfill.js";
import type { StoredEvent } from "./dispatch.js";

describe("synthesizeBackfill", () => {
	test("creates deterministic lifecycle and message events per session", () => {
		const contentJson = '{"text":"kept byte-for-byte"}';
		const events = synthesizeBackfill({
			sessions: [
				{
					sessionId: "session-1",
					chatId: "chat-1",
					projectId: "project-1",
					title: "Existing title",
					createdAt: 10,
					archivedAt: 50,
					deletedAt: null,
				},
			],
			messages: [
				{
					rowId: 2,
					messageId: "message-2",
					sessionId: "session-1",
					role: "assistant",
					kind: "text",
					contentJson,
					parentItemId: "message-1",
					createdAt: 30,
				},
				{
					rowId: 1,
					messageId: "message-1",
					sessionId: "session-1",
					role: "user",
					kind: "text",
					contentJson: "{}",
					parentItemId: null,
					createdAt: 30,
				},
			],
			existingEventIds: new Set(),
			existingMessageIds: new Set(["message-1"]),
		});

		expect(events.map((event) => event.event._tag)).toEqual([
			"SessionCreated",
			"SessionTitleSet",
			"MessagePersisted",
			"SessionArchived",
		]);
		expect(events.map((event) => event.eventId)).toEqual([
			"backfill:session-created:session-1",
			"backfill:session-title:session-1",
			"backfill:message:message-2",
			"backfill:session-archived:session-1",
		]);
		expect(events[2]?.event).toMatchObject({
			_tag: "MessagePersisted",
			contentJson,
			parentItemId: "message-1",
		});
	});

	test("skips deterministic events already appended by a partial attempt", () => {
		const events = synthesizeBackfill({
			sessions: [
				{
					sessionId: "session-1",
					chatId: "chat-1",
					projectId: "project-1",
					title: "Title",
					createdAt: 10,
					archivedAt: null,
					deletedAt: 20,
				},
			],
			messages: [],
			existingEventIds: new Set(["backfill:session-created:session-1"]),
			existingMessageIds: new Set(),
		});

		expect(events.map((event) => event.event._tag)).toEqual([
			"SessionTitleSet",
			"SessionDeleted",
		]);
	});

	test("rebuilds an equivalent read model from synthesized events", async () => {
		const contentJson = '{"spacing":  "is stable"}';
		const events = synthesizeBackfill({
			sessions: [
				{
					sessionId: "session-1",
					chatId: "chat-1",
					projectId: "project-1",
					title: "Title",
					createdAt: 10,
					archivedAt: null,
					deletedAt: null,
				},
			],
			messages: [
				{
					rowId: 1,
					messageId: "message-1",
					sessionId: "session-1",
					role: "user",
					kind: "text",
					contentJson,
					parentItemId: null,
					createdAt: 20,
				},
			],
			existingEventIds: new Set(),
			existingMessageIds: new Set(),
		});
		const model = new InMemorySessionReadModel();
		for (const [index, event] of events.entries()) {
			await Effect.runPromise(
				model.apply({
					...event,
					causationEventId: null,
					streamVersion: index + 1,
					sequence: index + 1,
				} satisfies StoredEvent),
			);
		}

		expect(model.session("session-1")).toMatchObject({ title: "Title" });
		expect(model.messages("session-1")[0]?.contentJson).toBe(contentJson);
	});
});
