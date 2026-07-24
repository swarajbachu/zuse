import type { Message, SessionId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import {
	agentActivityStateForTool,
	deriveAgentActivityState,
} from "../../src/lib/agent-activity-state.ts";

const sessionId = "session-activity" as SessionId;

function message(id: string, content: Message["content"]): Message {
	return {
		id,
		sessionId,
		role:
			content._tag === "user" ||
			content._tag === "user_rich" ||
			content._tag === "user_question_answer"
				? "user"
				: "assistant",
		content,
		createdAt: new Date("2026-07-22T00:00:00.000Z"),
	} as Message;
}

describe("agent activity state", () => {
	it.each([
		["Read", "searching"],
		["Grep", "searching"],
		["WebSearch", "searching"],
		["mcp__zuse__browser_navigate", "searching"],
		["Edit", "shaping"],
		["WriteFile", "shaping"],
		["apply_patch", "shaping"],
		["Bash", "solving"],
		["exec_command", "solving"],
		["run_tests", "solving"],
		["AskUserQuestion", "listening"],
		["Task", "working"],
		["future_unknown_tool", "working"],
	] as const)("maps %s to %s", (tool, expected) => {
		expect(agentActivityStateForTool(tool)).toBe(expected);
	});

	it("uses working for an empty live turn", () => {
		expect(deriveAgentActivityState([])).toBe("working");
	});

	it("uses the latest unmatched tool call", () => {
		expect(
			deriveAgentActivityState([
				message("u1", { _tag: "user", text: "Find the config" }),
				message("t1", {
					_tag: "tool_use",
					itemId: "tool-1" as never,
					tool: "Glob",
					input: {},
				}),
			]),
		).toBe("searching");
	});

	it("falls back to working after a tool completes", () => {
		expect(
			deriveAgentActivityState([
				message("u1", { _tag: "user", text: "Run the tests" }),
				message("t1", {
					_tag: "tool_use",
					itemId: "tool-1" as never,
					tool: "Bash",
					input: {},
				}),
				message("r1", {
					_tag: "tool_result",
					itemId: "tool-1" as never,
					output: "passed",
					isError: false,
				}),
			]),
		).toBe("working");
	});

	it("uses composing for live assistant text", () => {
		expect(
			deriveAgentActivityState([
				message("u1", { _tag: "user", text: "Explain it" }),
				message("a1", { _tag: "assistant", text: "The issue is" }),
			]),
		).toBe("composing");
	});

	it("uses listening for an unanswered question", () => {
		expect(
			deriveAgentActivityState([
				message("u1", { _tag: "user", text: "Set this up" }),
				message("q1", {
					_tag: "user_question",
					itemId: "question-1" as never,
					questions: [],
				}),
			]),
		).toBe("listening");
	});

	it("returns to working after a question is answered", () => {
		expect(
			deriveAgentActivityState([
				message("u1", { _tag: "user", text: "Set this up" }),
				message("q1", {
					_tag: "user_question",
					itemId: "question-1" as never,
					questions: [],
				}),
				message("a1", {
					_tag: "user_question_answer",
					itemId: "question-1" as never,
					answers: [],
				}),
			]),
		).toBe("working");
	});
});
