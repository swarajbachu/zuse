import {
	MessageContent,
	SessionDomainEventEnvelope,
	SessionId,
} from "@zuse/contracts";
import { Schema } from "effect";
import { describe, expect, test } from "vitest";

import {
	projectSessionEvent,
	sessionEventCursors,
} from "../../src/session-events.js";

const envelope = (type: string, payload: unknown) =>
	SessionDomainEventEnvelope.make({
		sequence: 1,
		eventId: "event-1",
		correlationId: "command-1",
		causationEventId: null,
		sessionId: SessionId.make("session-1"),
		streamVersion: 1,
		type,
		payloadJson: JSON.stringify(payload),
	});

describe("projectSessionEvent", () => {
	test("decodes persisted messages at the wire boundary", () => {
		const content = Schema.encodeSync(MessageContent)({
			_tag: "assistant",
			text: "hello",
		});
		const projected = projectSessionEvent(
			envelope("MessagePersisted", {
				_tag: "MessagePersisted",
				messageId: "message-1",
				role: "assistant",
				contentJson: JSON.stringify(content),
				createdAt: 123,
			}),
		);

		expect(projected._tag).toBe("message");
		if (projected._tag === "message") {
			expect(projected.message.content).toEqual({
				_tag: "assistant",
				text: "hello",
			});
			expect(projected.message.createdAt).toEqual(new Date(123));
		}
	});

	test("decodes status changes and safely ignores unknown events", () => {
		expect(
			projectSessionEvent(
				envelope("SessionStatusSet", {
					_tag: "SessionStatusSet",
					status: "running",
				}),
			),
		).toEqual({ _tag: "status", status: "running" });
		expect(projectSessionEvent(envelope("TurnStarted", {}))).toEqual({
			_tag: "other",
		});
	});

	test("keeps resume cursors monotonic per consumer key", () => {
		sessionEventCursors.delete("test:a");
		sessionEventCursors.delete("test:b");
		sessionEventCursors.set("test:a", 5);
		sessionEventCursors.set("test:a", 3);
		sessionEventCursors.set("test:b", 2);

		expect(sessionEventCursors.get("test:a")).toBe(5);
		expect(sessionEventCursors.get("test:b")).toBe(2);
	});
});
