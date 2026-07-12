import { describe, expect, it } from "vitest";

import {
	deriveChatAttentionState,
	mergeChatAttentionStates,
} from "../../src/lib/chat-attention-state.ts";

type TestMessage = Parameters<typeof deriveChatAttentionState>[0][number];

const question = (itemId: string): TestMessage => ({
	content: {
		_tag: "user_question",
		itemId: itemId as never,
		questions: [{ question: "Pick one", options: ["A"] }],
	},
});

const questionAnswer = (itemId: string): TestMessage => ({
	content: {
		_tag: "user_question_answer",
		itemId: itemId as never,
		answers: [{ questionIndex: 0, selected: [0] }],
	},
});

const exitPlan = (itemId: string): TestMessage => ({
	content: {
		_tag: "tool_use",
		itemId: itemId as never,
		tool: "ExitPlanMode",
		input: { plan: "Do the work" },
	},
});

const toolResult = (itemId: string): TestMessage => ({
	content: {
		_tag: "tool_result",
		itemId: itemId as never,
		output: "ok",
		isError: false,
	},
});

describe("deriveChatAttentionState", () => {
	it("returns idle with no messages and not running", () => {
		expect(deriveChatAttentionState([], false)).toBe("idle");
	});

	it("returns running when only running is true", () => {
		expect(deriveChatAttentionState([], true)).toBe("running");
	});

	it("prioritizes an unanswered question over running", () => {
		expect(deriveChatAttentionState([question("q1")], true)).toBe("question");
	});

	it("clears question state once answered", () => {
		expect(
			deriveChatAttentionState([question("q1"), questionAnswer("q1")], false),
		).toBe("idle");
	});

	it("prioritizes a pending ExitPlanMode plan over running", () => {
		expect(deriveChatAttentionState([exitPlan("p1")], true)).toBe("planReady");
	});

	it("clears plan-ready state once ExitPlanMode has a result", () => {
		expect(
			deriveChatAttentionState([exitPlan("p1"), toolResult("p1")], false),
		).toBe("idle");
	});

	it("prioritizes question over plan when both are pending", () => {
		expect(
			deriveChatAttentionState([exitPlan("p1"), question("q1")], true),
		).toBe("question");
	});
});

describe("mergeChatAttentionStates", () => {
	it("returns the highest-priority state", () => {
		expect(mergeChatAttentionStates(["idle", "running", "planReady"])).toBe(
			"planReady",
		);
	});
});
