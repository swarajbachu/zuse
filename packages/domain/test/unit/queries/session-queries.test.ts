import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import type { StoredEvent } from "../../../src/engine/dispatch.js";
import { InMemorySessionReadModel } from "../../../src/projectors/read-model.js";
import { SessionQueries } from "../../../src/queries/session-queries.js";

const stored = (
	sequence: number,
	streamId: string,
	event: StoredEvent["event"],
): StoredEvent => ({
	eventId: `event-${sequence}`,
	correlationId: "request-1",
	causationEventId: null,
	streamId,
	streamVersion: sequence,
	sequence,
	event,
});

describe("SessionQueries", () => {
	test("lists active sessions by latest activity and pages messages", async () => {
		const model = new InMemorySessionReadModel();
		for (const event of [
			stored(1, "session-1", {
				_tag: "SessionCreated",
				sessionId: "session-1",
				chatId: "chat-1",
				projectId: "project-1",
				createdAt: 10,
			}),
			stored(2, "session-2", {
				_tag: "SessionCreated",
				sessionId: "session-2",
				chatId: "chat-2",
				projectId: "project-1",
				createdAt: 20,
			}),
			stored(3, "session-1", {
				_tag: "MessagePersisted",
				messageId: "message-1",
				turnId: null,
				role: "user",
				kind: "text",
				contentJson: "one",
				parentItemId: null,
				createdAt: 30,
			}),
			stored(4, "session-1", {
				_tag: "MessagePersisted",
				messageId: "message-2",
				turnId: null,
				role: "assistant",
				kind: "text",
				contentJson: "two",
				parentItemId: "message-1",
				createdAt: 40,
			}),
			stored(5, "session-2", {
				_tag: "SessionArchived",
				archivedAt: 50,
			}),
		]) {
			await Effect.runPromise(model.apply(event));
		}
		const queries = new SessionQueries(model);

		expect(await queries.list({ projectId: "project-1" })).toEqual([
			expect.objectContaining({ sessionId: "session-1" }),
		]);
		expect(
			await queries.list({ projectId: "project-1", includeArchived: true }),
		).toEqual([
			expect.objectContaining({ sessionId: "session-2" }),
			expect.objectContaining({ sessionId: "session-1" }),
		]);

		const page = await queries.messagePage({
			sessionId: "session-1",
			limit: 1,
		});
		expect(page.items.map((message) => message.messageId)).toEqual([
			"message-1",
		]);
		expect(page.nextSequence).toBe(3);
		expect(
			await queries.messagePage({
				sessionId: "session-1",
				afterSequence: page.nextSequence,
				limit: 1,
			}),
		).toMatchObject({
			items: [expect.objectContaining({ messageId: "message-2" })],
			nextSequence: null,
		});
	});

	test("returns a transcript in event order", async () => {
		const model = new InMemorySessionReadModel();
		await Effect.runPromise(
			model.apply(
				stored(1, "session-1", {
					_tag: "SessionCreated",
					sessionId: "session-1",
					chatId: "chat-1",
					projectId: "project-1",
					createdAt: 10,
				}),
			),
		);
		await Effect.runPromise(
			model.apply(
				stored(2, "session-1", {
					_tag: "MessagePersisted",
					messageId: "message-1",
					turnId: null,
					role: "user",
					kind: "text",
					contentJson: "payload",
					parentItemId: null,
					createdAt: 20,
				}),
			),
		);

		await expect(
			new SessionQueries(model).transcript("session-1"),
		).resolves.toEqual({
			session: expect.objectContaining({ sessionId: "session-1" }),
			messages: [expect.objectContaining({ contentJson: "payload" })],
		});
	});
});
