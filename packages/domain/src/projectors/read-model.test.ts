import { describe, expect, test } from "vitest";

import type { StoredEvent } from "../engine/dispatch.js";
import { InMemorySessionReadModel } from "./read-model.js";

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

describe("session read-model projector", () => {
	test("projects lifecycle and preserves message payload bytes", async () => {
		const model = new InMemorySessionReadModel();
		const contentJson = '{"role":"user", "content":[{"text":"hello"}]}';
		const events: StoredEvent[] = [
			stored(1, "session-1", {
				_tag: "SessionCreated",
				sessionId: "session-1",
				chatId: "chat-1",
				projectId: "project-1",
				createdAt: 10,
			}),
			stored(2, "session-1", {
				_tag: "SessionTitleSet",
				title: "Projected title",
			}),
			stored(3, "session-1", {
				_tag: "ProviderAttached",
				providerId: "provider-1",
				attachedAt: 20,
			}),
			stored(4, "session-1", {
				_tag: "TurnStarted",
				turnId: "turn-1",
				startedAt: 30,
			}),
			stored(5, "session-1", {
				_tag: "MessagePersisted",
				messageId: "message-1",
				turnId: "turn-1",
				role: "user",
				kind: "text",
				contentJson,
				parentItemId: null,
				createdAt: 40,
			}),
			stored(6, "session-1", {
				_tag: "TurnSettled",
				turnId: "turn-1",
				outcome: "completed",
				settledAt: 50,
			}),
		];

		for (const event of events) await model.apply(event);

		expect(model.session("session-1")).toMatchObject({
			title: "Projected title",
			providerId: "provider-1",
			status: "idle",
			lastMessageAt: 40,
			updatedAt: 50,
		});
		expect(model.messages("session-1")).toEqual([
			expect.objectContaining({ contentJson, sequence: 5 }),
		]);
	});

	test("is idempotent when an event is applied again", async () => {
		const model = new InMemorySessionReadModel();
		const created = stored(1, "session-1", {
			_tag: "SessionCreated",
			sessionId: "session-1",
			chatId: "chat-1",
			projectId: "project-1",
			createdAt: 10,
		});
		const message = stored(2, "session-1", {
			_tag: "MessagePersisted",
			messageId: "message-1",
			turnId: null,
			role: "assistant",
			kind: "text",
			contentJson: "{}",
			parentItemId: null,
			createdAt: 20,
		});

		await model.apply(created);
		await model.apply(message);
		await model.apply(message);

		expect(model.messages("session-1")).toHaveLength(1);
	});
});
