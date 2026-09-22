import { AgentItemId, SessionId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import {
	makeQuestionAnswerDeliveryPayload,
	parseQuestionAnswerDeliveryPayload,
	questionAnswerMessageId,
} from "../../src/conversation/core/question-delivery.ts";

describe("question delivery identity", () => {
	it("does not alias delimiter-bearing session and item tuples", () => {
		const first = questionAnswerMessageId(
			SessionId.make("session:alpha\u0000question"),
			AgentItemId.make("omega"),
		);
		const second = questionAnswerMessageId(
			SessionId.make("session"),
			AgentItemId.make("alpha\u0000question:omega"),
		);

		expect(first).not.toBe(second);
	});

	it("compares retries canonically while preserving the first payload", () => {
		const original = [
			{ questionIndex: 1, selected: [2, 0], other: " custom " },
			{ questionIndex: 0, selected: [1] },
		];
		const retry = [
			{ questionIndex: 0, selected: [1] },
			{ questionIndex: 1, selected: [0, 2], other: "custom" },
		];
		const durable = parseQuestionAnswerDeliveryPayload(
			JSON.stringify(original),
		);
		const requested = makeQuestionAnswerDeliveryPayload(retry);

		expect(durable?.answerKey).toBe(requested.answerKey);
		expect(durable?.answers).toEqual(original);
		expect(parseQuestionAnswerDeliveryPayload("not-json")).toBeNull();
	});
});
