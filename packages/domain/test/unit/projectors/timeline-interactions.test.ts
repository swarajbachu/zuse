import { Message, MessageId, SessionId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import { timelineEventFromDomain } from "../../../src/projectors/timeline-projection.ts";
import {
	applyTimelineEvent,
	emptyTimelineProjection,
} from "../../../src/projectors/timeline-reducer.ts";

const sessionId = SessionId.make("session-interactions");

describe("durable session interactions", () => {
	it("restores an unanswered question from the timeline and settles it only on its answer", () => {
		const questions = [{ question: "Choose", options: ["A", "B"] }];
		const question = Message.make({
			id: MessageId.make("message-question"),
			sessionId,
			role: "assistant",
			content: {
				_tag: "user_question",
				itemId: "question-1" as never,
				questions,
			},
			createdAt: new Date("2026-08-23T00:00:00.000Z"),
		});
		const requested = applyTimelineEvent(emptyTimelineProjection(), {
			_tag: "MessagePersisted",
			message: question,
		});

		expect(requested.interactions).toEqual([
			expect.objectContaining({
				_tag: "Question",
				id: "question-1",
				questions,
			}),
		]);

		const answer = Message.make({
			id: MessageId.make("message-answer"),
			sessionId,
			role: "user",
			content: {
				_tag: "user_question_answer",
				itemId: "question-1" as never,
				answers: [{ questionIndex: 0, selected: [1] }],
			},
			createdAt: new Date("2026-08-23T00:00:01.000Z"),
		});
		const resolved = applyTimelineEvent(requested, {
			_tag: "MessagePersisted",
			message: answer,
		});

		expect(resolved.interactions).toEqual([]);
	});

	it("settles a cancelled question without inventing an answer message", () => {
		const requestedAt = Date.parse("2026-08-23T00:00:00.000Z");
		const question = Message.make({
			id: MessageId.make("message-cancelled-question"),
			sessionId,
			role: "assistant",
			content: {
				_tag: "user_question",
				itemId: "question-cancelled" as never,
				questions: [{ question: "Continue?", options: ["Yes", "No"] }],
			},
			createdAt: new Date(requestedAt),
		});
		const requested = applyTimelineEvent(emptyTimelineProjection(), {
			_tag: "MessagePersisted",
			message: question,
		});
		const resolution = timelineEventFromDomain(sessionId, {
			_tag: "QuestionResolved",
			itemId: "question-cancelled",
			resolution: "cancelled",
			resolvedAt: requestedAt + 1,
		});
		const resolved = applyTimelineEvent(requested, resolution);

		expect(resolution).toEqual({
			_tag: "QuestionResolved",
			itemId: "question-cancelled",
			resolution: "cancelled",
		});
		expect(resolved.interactions).toEqual([]);
		expect(resolved.messages).toEqual([question]);
	});

	it("projects permission request and durable resolution events", () => {
		const requestedAt = Date.parse("2026-08-23T00:00:00.000Z");
		const request = {
			id: "permission-1",
			sessionId,
			kind: { _tag: "Bash", command: "git status" },
			requestedAt: new Date(requestedAt),
			forcePrompt: false,
		};
		const requestedEvent = timelineEventFromDomain(sessionId, {
			_tag: "PermissionRequested",
			requestId: request.id,
			turnId: "turn-1",
			payloadJson: JSON.stringify(request),
			requestedAt,
		});
		const requested = applyTimelineEvent(
			emptyTimelineProjection(),
			requestedEvent,
		);

		expect(requested.interactions).toEqual([
			expect.objectContaining({
				_tag: "Permission",
				id: request.id,
				request: expect.objectContaining({ kind: request.kind }),
			}),
		]);

		const resolvedEvent = timelineEventFromDomain(sessionId, {
			_tag: "PermissionResolved",
			requestId: request.id,
			decision: "AllowOnce",
			decisionJson: JSON.stringify({ _tag: "AllowOnce" }),
			resolvedAt: requestedAt + 1,
		});
		const resolved = applyTimelineEvent(requested, resolvedEvent);

		expect(resolved.interactions).toEqual([]);
	});
});
