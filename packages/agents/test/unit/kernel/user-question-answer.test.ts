import {
	makeBoundedQuestionCallbackRegistry,
	validateUserQuestionAnswers,
} from "@zuse/agents/kernel/user-question-answer";
import { describe, expect, it } from "vitest";

describe("bounded question callback registry", () => {
	it("rejects overflow and duplicates, then releases capacity on drain", () => {
		const registry = makeBoundedQuestionCallbackRegistry<number>(2);
		expect(registry.register("first", 1)).toBe("accepted");
		expect(registry.register("first", 99)).toBe("duplicate");
		expect(registry.register("second", 2)).toBe("accepted");
		expect(registry.register("overflow", 3)).toBe("full");
		expect(registry.get("first")).toBe(1);
		expect(() => registry.take("missing")).toThrow(
			"No pending user question: missing",
		);
		expect(registry.take("first")).toBe(1);
		expect(registry.register("replacement", 5)).toBe("accepted");
		expect(registry.drain()).toEqual([
			["second", 2],
			["replacement", 5],
		]);
		expect(registry.register("after-release", 4)).toBe("accepted");
	});
});

describe("user question answer validation", () => {
	const single = [
		{
			question: "Keep the changes?",
			options: ["Keep", "Discard"],
			multiSelect: false,
		},
	];
	const multi = [
		{
			question: "Which checks should run?",
			options: ["Unit", "Integration", "System"],
			multiSelect: true,
		},
	];

	it("accepts one preset, free text, and multiple selections only when allowed", () => {
		expect(
			validateUserQuestionAnswers(single, [
				{ questionIndex: 0, selected: [1] },
			]),
		).toBeUndefined();
		expect(
			validateUserQuestionAnswers(single, [
				{ questionIndex: 0, selected: [], other: "  Keep both variants  " },
			]),
		).toBeUndefined();
		expect(
			validateUserQuestionAnswers(multi, [
				{ questionIndex: 0, selected: [2, 0], other: "Also run smoke" },
			]),
		).toBeUndefined();
	});

	it.each([
		["no live questions", [], [], "question_count"],
		["missing answers", [...single, ...multi], [], "answer_count"],
		[
			"one missing answer",
			[...single, ...multi],
			[{ questionIndex: 0, selected: [0] }],
			"answer_count",
		],
		[
			"negative question index",
			single,
			[{ questionIndex: -1, selected: [0] }],
			"question_index",
		],
		[
			"fractional question index",
			single,
			[{ questionIndex: 0.5, selected: [0] }],
			"question_index",
		],
		[
			"out-of-range question index",
			single,
			[{ questionIndex: 1, selected: [0] }],
			"question_index",
		],
		[
			"duplicate question index",
			[...single, ...multi],
			[
				{ questionIndex: 0, selected: [0] },
				{ questionIndex: 0, selected: [1] },
			],
			"duplicate_question",
		],
		[
			"negative option index",
			single,
			[{ questionIndex: 0, selected: [-1] }],
			"selection_index",
		],
		[
			"fractional option index",
			single,
			[{ questionIndex: 0, selected: [0.5] }],
			"selection_index",
		],
		[
			"out-of-range option index",
			single,
			[{ questionIndex: 0, selected: [2] }],
			"selection_index",
		],
		[
			"duplicate option index",
			multi,
			[{ questionIndex: 0, selected: [1, 1] }],
			"duplicate_selection",
		],
		[
			"multiple selections for a single-select question",
			single,
			[{ questionIndex: 0, selected: [0, 1] }],
			"selection_count",
		],
		[
			"preset plus free text for a single-select question",
			single,
			[{ questionIndex: 0, selected: [0], other: "A third choice" }],
			"selection_count",
		],
		[
			"blank free text alongside a selection",
			single,
			[{ questionIndex: 0, selected: [0], other: "   " }],
			"other_text",
		],
		[
			"empty answer",
			single,
			[{ questionIndex: 0, selected: [] }],
			"empty_answer",
		],
		[
			"blank free text",
			single,
			[{ questionIndex: 0, selected: [], other: "   " }],
			"other_text",
		],
	] as const)("rejects %s", (_label, questions, answers, code) => {
		expect(validateUserQuestionAnswers(questions, answers)).toMatchObject({
			code,
		});
	});
});
