import type { AgentItemId, Message, SessionId } from "@zuse/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deriveChatLookups } from "../../src/components/chat-lookups.tsx";
import { SubagentWaitRow } from "../../src/components/tool-row.tsx";
import { groupMessages } from "../../src/lib/group-messages.ts";
import {
	deriveSubagentWaitView,
	formatSubagentWaitDuration,
	subagentWaitAccessibleTiming,
} from "../../src/lib/subagent-wait.ts";

const sessionId = "session-subagent-wait" as SessionId;

afterEach(() => vi.useRealTimers());

function message(
	id: string,
	content: Message["content"],
	createdAt: string,
): Message {
	return {
		id,
		sessionId,
		role: "assistant",
		content,
		createdAt: new Date(createdAt),
	} as Message;
}

describe("subagent waiting", () => {
	it("links a blocking task wait to its named subagent", () => {
		const messages = [
			message(
				"agent-started",
				{
					_tag: "tool_use",
					itemId: "agent-tool-1" as AgentItemId,
					tool: "Agent",
					input: {
						description: "Design revamp implementation plan",
						prompt: "Design the implementation",
						subagent_type: "Plan",
						task_id: "task-1",
					},
					subagent: {
						childSessionId: "task-1",
						presentation: "detached",
					},
				},
				"2026-08-09T10:00:00.000Z",
			),
			message(
				"wait",
				{
					_tag: "tool_use",
					itemId: "wait-tool-1" as AgentItemId,
					tool: "TaskOutput",
					input: { task_id: "task-1", block: true, timeout: 180_000 },
				},
				"2026-08-09T10:00:01.000Z",
			),
		];

		const lookups = deriveChatLookups(messages);
		expect(lookups.subagentsByTaskId.get("task-1")).toEqual({
			agentName: "Design revamp implementation plan",
		});

		expect(
			deriveSubagentWaitView({
				input:
					messages[1]?.content._tag === "tool_use"
						? messages[1].content.input
						: null,
				result: undefined,
				startedAt: messages[1]?.createdAt ?? new Date(0),
				now: new Date("2026-08-09T10:00:02.900Z"),
				subagentsByTaskId: lookups.subagentsByTaskId,
			}),
		).toEqual({
			agentName: "Design revamp implementation plan",
			status: "waiting",
			elapsedMs: 1_900,
			timeoutMs: 180_000,
		});
	});

	it("links concurrent waits to their own subagents", () => {
		const first = message(
			"first-agent",
			{
				_tag: "tool_use",
				itemId: "agent-tool-1" as AgentItemId,
				tool: "Agent",
				input: {
					description: "Review API design",
					prompt: "Review the API",
					task_id: "task-1",
				},
				subagent: {
					childSessionId: "task-1",
					presentation: "detached",
				},
			},
			"2026-08-09T10:00:00.000Z",
		);
		const second = message(
			"second-agent",
			{
				_tag: "tool_use",
				itemId: "agent-tool-2" as AgentItemId,
				tool: "Agent",
				input: {
					description: "Check test coverage",
					prompt: "Review the tests",
					task_id: "task-2",
				},
				subagent: {
					childSessionId: "task-2",
					presentation: "detached",
				},
			},
			"2026-08-09T10:00:00.100Z",
		);

		const references = deriveChatLookups([first, second]).subagentsByTaskId;
		const startedAt = new Date("2026-08-09T10:00:01.000Z");
		const now = new Date("2026-08-09T10:00:02.000Z");
		expect(
			deriveSubagentWaitView({
				input: { task_id: "task-1", block: true, timeout: 10_000 },
				result: undefined,
				startedAt,
				now,
				subagentsByTaskId: references,
			})?.agentName,
		).toBe("Review API design");
		expect(
			deriveSubagentWaitView({
				input: { task_id: "task-2", block: true, timeout: 10_000 },
				result: undefined,
				startedAt,
				now,
				subagentsByTaskId: references,
			})?.agentName,
		).toBe("Check test coverage");
	});

	it("keeps a resolved wait without claiming the subagent completed", () => {
		const view = deriveSubagentWaitView({
			input: { task_id: "task-1", block: true, timeout: 180_000 },
			result: {
				output: "Task is still running after the wait timed out",
				isError: false,
				completedAt: new Date("2026-08-09T10:00:04.250Z"),
			},
			startedAt: new Date("2026-08-09T10:00:01.000Z"),
			now: new Date("2026-08-09T10:00:10.000Z"),
			subagentsByTaskId: new Map([
				["task-1", { agentName: "Plan implementation" }],
			]),
		});

		expect(view).toEqual({
			agentName: "Plan implementation",
			status: "finished",
			elapsedMs: 3_250,
			timeoutMs: 180_000,
		});
	});

	it("marks failed waits and freezes their elapsed duration", () => {
		expect(
			deriveSubagentWaitView({
				input: { task_id: "task-1", block: true, timeout: 10_000 },
				result: {
					output: "Unable to read task output",
					isError: true,
					completedAt: new Date("2026-08-09T10:00:03.000Z"),
				},
				startedAt: new Date("2026-08-09T10:00:01.000Z"),
				now: new Date("2026-08-09T10:01:00.000Z"),
				subagentsByTaskId: new Map([
					["task-1", { agentName: "Plan implementation" }],
				]),
			}),
		).toMatchObject({ status: "error", elapsedMs: 2_000 });
	});

	it("leaves non-blocking task output on the generic tool path", () => {
		expect(
			deriveSubagentWaitView({
				input: { task_id: "task-1", block: false, timeout: 1_000 },
				result: undefined,
				startedAt: new Date(0),
				now: new Date(1_000),
				subagentsByTaskId: new Map(),
			}),
		).toBeNull();
	});

	it("leaves an unknown task on the generic tool path", () => {
		expect(
			deriveSubagentWaitView({
				input: { task_id: "missing", block: true, timeout: 1_000 },
				result: undefined,
				startedAt: new Date(0),
				now: new Date(1_000),
				subagentsByTaskId: new Map(),
			}),
		).toBeNull();
	});

	it("formats stable compact timing metadata", () => {
		expect(formatSubagentWaitDuration(1_900)).toBe("1.9s");
		expect(formatSubagentWaitDuration(180_000)).toBe("3m");
		expect(formatSubagentWaitDuration(184_000)).toBe("3m 4s");
	});

	it("renders resolved and failed waits with accessible timing", () => {
		const subagentsByTaskId = new Map([
			["task-1", { agentName: "Plan implementation" }],
		]);
		const finished = renderToStaticMarkup(
			createElement(SubagentWaitRow, {
				input: { task_id: "task-1", block: true, timeout: 10_000 },
				result: {
					output: "Still running",
					isError: false,
					completedAt: new Date("2026-08-09T10:00:03.000Z"),
				},
				startedAt: new Date("2026-08-09T10:00:01.000Z"),
				subagentsByTaskId,
			}),
		);
		expect(finished).toContain("Finished waiting for subagent");
		expect(finished).toContain("Wait duration 2.0s.");

		const failed = renderToStaticMarkup(
			createElement(SubagentWaitRow, {
				input: { task_id: "task-1", block: true, timeout: 10_000 },
				result: {
					output: "",
					isError: true,
					completedAt: new Date("2026-08-09T10:00:03.000Z"),
				},
				startedAt: new Date("2026-08-09T10:00:01.000Z"),
				subagentsByTaskId,
			}),
		);
		expect(failed).toContain("Couldn’t wait for subagent");
		expect(failed).toContain("cursor-pointer");
	});

	it("renders the active wait name, maximum, and current elapsed time", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-09T10:00:02.900Z"));
		const active = renderToStaticMarkup(
			createElement(SubagentWaitRow, {
				input: { task_id: "task-1", block: true, timeout: 180_000 },
				result: undefined,
				startedAt: new Date("2026-08-09T10:00:01.000Z"),
				subagentsByTaskId: new Map([
					["task-1", { agentName: "Plan implementation" }],
				]),
			}),
		);

		expect(active).toContain("Waiting for subagent");
		expect(active).toContain("Plan implementation");
		expect(active).toContain("3m max · ");
		expect(active).toContain("1.9s");
		expect(active).toContain("Maximum wait 3m.");
	});

	it("keeps ticking elapsed time out of screen-reader announcements", () => {
		const base = {
			agentName: "Plan implementation",
			status: "waiting" as const,
			timeoutMs: 180_000,
		};
		expect(subagentWaitAccessibleTiming({ ...base, elapsedMs: 1_000 })).toBe(
			"Maximum wait 3m.",
		);
		expect(subagentWaitAccessibleTiming({ ...base, elapsedMs: 9_000 })).toBe(
			"Maximum wait 3m.",
		);
	});

	it("renders one enriched subagent row for repeated lifecycle records", () => {
		const itemId = "agent-tool-1" as AgentItemId;
		const groups = groupMessages([
			message(
				"agent-request",
				{
					_tag: "tool_use",
					itemId,
					tool: "Agent",
					input: {
						prompt: "Design the implementation",
						subagent_type: "Plan",
						run_in_background: true,
					},
				},
				"2026-08-09T10:00:00.000Z",
			),
			message(
				"agent-started",
				{
					_tag: "tool_use",
					itemId,
					tool: "Agent",
					input: {
						description: "Design revamp implementation plan",
						prompt: "Design the implementation",
						subagent_type: "Plan",
						run_in_background: true,
						task_id: "task-1",
					},
					subagent: {
						childSessionId: "task-1",
						presentation: "detached",
					},
				},
				"2026-08-09T10:00:00.100Z",
			),
		]);

		expect(groups).toHaveLength(1);
		expect(groups[0]).toMatchObject({
			kind: "subagent",
			parent: { id: "agent-request" },
			agentName: "Design revamp implementation plan",
			childSessionId: "task-1",
			presentation: "detached",
		});
	});
});
