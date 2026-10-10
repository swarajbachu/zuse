import { AgentItemId, type Message, type SessionId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	createCloudTimelineRows,
	deriveChatTimelineRows,
	deriveChatTurnNavigationEntries,
	deriveChatTurnRailEntries,
	normalizeTimelineMessages,
	resolveLatestUserMessageId,
	rowAnchorMessageId,
} from "../../src/lib/chat-timeline-rows.ts";

const sessionId = "session-timeline" as SessionId;

function message(
	id: string,
	content: Message["content"],
	createdAt = new Date("2026-07-06T00:00:00.000Z"),
): Message {
	return {
		id,
		sessionId,
		role:
			content._tag === "user" || content._tag === "user_rich"
				? "user"
				: "assistant",
		content,
		createdAt,
	} as Message;
}

describe("chat timeline rows", () => {
	it("returns no anchor for an empty timeline", () => {
		expect(resolveLatestUserMessageId([])).toBe(null);
	});

	it("resolves the latest user message anchor", () => {
		const rows = deriveChatTimelineRows({
			messages: [
				message("u1", { _tag: "user", text: "first" }),
				message("a1", { _tag: "assistant", text: "reply" }),
				message("u2", { _tag: "user", text: "second" }),
			],
			inFlight: true,
			awaitingPlanApproval: false,
		});

		expect(resolveLatestUserMessageId(rows)).toBe("u2");
		expect(rows.map((row) => rowAnchorMessageId(row))).toContain("u2");
	});

	it("derives one navigable entry for each user turn", () => {
		const rows = deriveChatTimelineRows({
			messages: [
				message("u1", { _tag: "user", text: "first prompt" }),
				message("a1", { _tag: "assistant", text: "reply" }),
				message("u2", {
					_tag: "user_rich",
					text: "second prompt",
					attachments: [],
					fileRefs: [],
					skillRefs: [],
					annotations: [],
				}),
			],
			inFlight: false,
			awaitingPlanApproval: false,
		});

		expect(deriveChatTurnNavigationEntries(rows)).toEqual([
			{ messageId: "u1", rowIndex: 0, turnNumber: 1, text: "first prompt" },
			{ messageId: "u2", rowIndex: 2, turnNumber: 2, text: "second prompt" },
		]);
	});

	it("samples the whole conversation proportionally for the compact rail", () => {
		const turns = Array.from({ length: 100 }, (_, index) => ({
			messageId: `u${index + 1}`,
			rowIndex: index * 2,
			turnNumber: index + 1,
			text: `turn ${index + 1}`,
		}));
		const rail = deriveChatTurnRailEntries(turns, 10);

		expect(rail).toHaveLength(10);
		expect(rail[0]?.turnNumber).toBe(1);
		expect(rail.at(-1)?.turnNumber).toBe(100);
		expect(rail.map((turn) => turn.turnNumber)).toEqual([
			1, 12, 23, 34, 45, 56, 67, 78, 89, 100,
		]);
	});

	it("keeps the active turn visible in a sampled compact rail", () => {
		const turns = Array.from({ length: 100 }, (_, index) => ({
			messageId: `u${index + 1}`,
			rowIndex: index * 2,
			turnNumber: index + 1,
			text: `turn ${index + 1}`,
		}));
		const rail = deriveChatTurnRailEntries(turns, 10, "u51");

		expect(rail).toHaveLength(10);
		expect(rail.map((turn) => turn.messageId)).toContain("u51");
		expect(rail[0]?.messageId).toBe("u1");
		expect(rail.at(-1)?.messageId).toBe("u100");
	});

	it("resolves the first optimistic user message as the new-chat anchor", () => {
		const rows = deriveChatTimelineRows({
			messages: [message("u1", { _tag: "user", text: "first prompt" })],
			inFlight: true,
			awaitingPlanApproval: false,
		});

		expect(resolveLatestUserMessageId(rows)).toBe("u1");
		const firstRow = rows[0];
		expect(firstRow).toBeDefined();
		expect(firstRow === undefined ? null : rowAnchorMessageId(firstRow)).toBe(
			"u1",
		);
	});

	it("moves the anchor when a later user message appears before assistant output", () => {
		const first = deriveChatTimelineRows({
			messages: [
				message("u1", { _tag: "user", text: "first prompt" }),
				message("a1", { _tag: "assistant", text: "first reply" }),
			],
			inFlight: false,
			awaitingPlanApproval: false,
		});
		const second = deriveChatTimelineRows({
			messages: [
				message("u1", { _tag: "user", text: "first prompt" }),
				message("a1", { _tag: "assistant", text: "first reply" }),
				message("u2", { _tag: "user", text: "second prompt" }),
			],
			inFlight: true,
			awaitingPlanApproval: false,
		});

		expect(resolveLatestUserMessageId(first)).toBe("u1");
		expect(resolveLatestUserMessageId(second)).toBe("u2");
		expect(second.map((row) => rowAnchorMessageId(row))).toContain("u2");
	});

	it("preserves stable row ids for unchanged messages", () => {
		const messages = [
			message("u1", { _tag: "user", text: "first" }),
			message("a1", { _tag: "assistant", text: "reply" }),
		];
		const first = deriveChatTimelineRows({
			messages,
			inFlight: false,
			awaitingPlanApproval: false,
		});
		const second = deriveChatTimelineRows({
			messages,
			inFlight: false,
			awaitingPlanApproval: false,
		});

		expect(second.map((row) => row.id)).toEqual(first.map((row) => row.id));
	});

	it("enables assistant commands on every completed response", () => {
		const rows = deriveChatTimelineRows({
			messages: [
				message("u1", { _tag: "user", text: "first" }),
				message("a1", { _tag: "assistant", text: "first reply" }),
				message("u2", { _tag: "user", text: "second" }),
				message("a2", { _tag: "assistant", text: "second reply" }),
			],
			inFlight: false,
			awaitingPlanApproval: false,
		});

		const assistantRows = rows.filter(
			(row) =>
				row.kind === "message" && row.message.content._tag === "assistant",
		);
		expect(
			assistantRows.map((row) =>
				row.kind === "message" ? row.showAssistantCommands : false,
			),
		).toEqual([true, true]);
	});

	it("keeps only the active response commands hidden until its turn completes", () => {
		const rows = deriveChatTimelineRows({
			messages: [
				message("u1", { _tag: "user", text: "first prompt" }),
				message("a1", { _tag: "assistant", text: "completed reply" }),
				message("u2", { _tag: "user", text: "active prompt" }),
				message("a2", { _tag: "assistant", text: "partial reply" }),
			],
			inFlight: true,
			awaitingPlanApproval: false,
		});

		const assistantRows = rows.filter(
			(row) =>
				row.kind === "message" && row.message.content._tag === "assistant",
		);
		expect(
			assistantRows.map((row) =>
				row.kind === "message" ? row.showAssistantCommands : false,
			),
		).toEqual([true, false]);
	});

	it("hides every assistant command while its turn is live", () => {
		const rows = deriveChatTimelineRows({
			messages: [
				message("u1", { _tag: "user", text: "active prompt" }),
				message("a1", { _tag: "assistant", text: "intermediate update" }),
				message("t1", {
					_tag: "tool_use",
					itemId: "call-1" as never,
					tool: "Read",
					input: { file_path: "/repo/a.ts" },
				}),
				message("a2", { _tag: "assistant", text: "partial reply" }),
			],
			inFlight: true,
			awaitingPlanApproval: false,
		});

		const assistantRows = rows.filter(
			(row) =>
				row.kind === "message" && row.message.content._tag === "assistant",
		);
		expect(
			assistantRows.map((row) =>
				row.kind === "message" ? row.showAssistantCommands : false,
			),
		).toEqual([false, false]);
	});

	it("keeps commands only on the final reply of a completed turn", () => {
		const rows = deriveChatTimelineRows({
			messages: [
				message("u1", { _tag: "user", text: "prompt" }),
				message("a1", { _tag: "assistant", text: "intermediate update" }),
				message("a2", { _tag: "assistant", text: "final reply" }),
			],
			inFlight: false,
			awaitingPlanApproval: false,
		});

		expect(
			rows.flatMap((row) =>
				row.kind === "message" && row.message.content._tag === "assistant"
					? [[row.message.id, row.showAssistantCommands]]
					: [],
			),
		).toEqual([
			["a1", false],
			["a2", true],
		]);
	});

	it("collapses duplicate tool_use rows with the same provider item id", () => {
		const messages = [
			message("u1", { _tag: "user", text: "inspect" }),
			message("t1", {
				_tag: "tool_use",
				itemId: "call-1" as never,
				tool: "Read",
				input: { target_file: "/repo/a.ts" },
			}),
			message("t2", {
				_tag: "tool_use",
				itemId: "call-1" as never,
				tool: "Read",
				input: { file_path: "/repo/a.ts", limit: 80 },
			}),
			message("r1", {
				_tag: "tool_result",
				itemId: "call-1" as never,
				output: "body",
				isError: false,
			}),
			message("a1", { _tag: "assistant", text: "done" }),
		];

		const normalized = normalizeTimelineMessages(messages);
		expect(
			normalized.filter((m) => m.content._tag === "tool_use"),
		).toHaveLength(1);
		expect(
			normalized.find((m) => m.content._tag === "tool_use")?.content,
		).toMatchObject({
			_tag: "tool_use",
			input: { file_path: "/repo/a.ts", limit: 80 },
		});

		const rows = deriveChatTimelineRows({
			messages,
			inFlight: false,
			awaitingPlanApproval: false,
		});
		const summary = rows.find((row) => row.kind === "turn-summary");
		expect(summary?.kind).toBe("turn-summary");
		expect(
			summary?.kind === "turn-summary" ? summary.showAssistantCommands : false,
		).toBe(true);
		expect(
			summary?.kind === "turn-summary"
				? summary.body.filter((m) => m.content._tag === "tool_use")
				: [],
		).toHaveLength(1);
	});

	it("keeps large tool-heavy turns in a stable summary row", () => {
		const toolMessages = Array.from({ length: 5 }, (_, index) => {
			const itemId = `large-call-${index}` as never;
			return [
				message(`tool-${index}`, {
					_tag: "tool_use",
					itemId,
					tool: "Read",
					input: { file_path: `/repo/large-${index}.txt` },
				}),
				message(`result-${index}`, {
					_tag: "tool_result",
					itemId,
					output: "x".repeat(40_000),
					isError: false,
				}),
			];
		}).flat();
		const rows = deriveChatTimelineRows({
			messages: [
				message("u-large", { _tag: "user", text: "inspect the repository" }),
				...toolMessages,
				message("a-large", {
					_tag: "assistant",
					text: "A tall final answer\n\n".repeat(300),
				}),
			],
			inFlight: false,
			awaitingPlanApproval: false,
		});

		expect(rows.map((row) => row.kind)).toEqual(["message", "turn-summary"]);
		expect(rows.at(-1)?.id).toBe("summary:u-large");
	});
});

it("cloud derivation reuses settled turns and matches uncached rows while streaming", () => {
	const derive = createCloudTimelineRows();
	const messages = [
		message("u1", { _tag: "user", text: "first" }),
		message("a1", { _tag: "assistant", text: "done" }),
		message("u2", { _tag: "user", text: "next" }),
		message("a2", { _tag: "assistant", text: "part" }),
	];
	const first = derive({
		messages,
		inFlight: true,
		awaitingPlanApproval: false,
	});
	const next = [
		...messages.slice(0, 3),
		message("a2", { _tag: "assistant", text: "part two" }),
	];
	const updated = derive({
		messages: next,
		inFlight: true,
		awaitingPlanApproval: false,
	});
	expect(updated).toEqual(
		deriveChatTimelineRows({
			messages: next,
			inFlight: true,
			awaitingPlanApproval: false,
		}),
	);
	expect(updated[0]).toBe(first[0]);
	expect(updated[1]).toBe(first[1]);
	expect(
		derive({ messages: next, inFlight: false, awaitingPlanApproval: false }),
	).toEqual(
		deriveChatTimelineRows({
			messages: next,
			inFlight: false,
			awaitingPlanApproval: false,
		}),
	);
});

it("keeps all consecutive tools in one tree and preserves results in order", () => {
	const messages = Array.from({ length: 25 }, (_, i) => [
		message(`tool-${i}`, {
			_tag: "tool_use",
			itemId: `item-${i}`,
			tool: "Read",
			input: { file_path: `file-${i}.ts` },
		} as Message["content"]),
		message(`result-${i}`, {
			_tag: "tool_result",
			itemId: `item-${i}`,
			output: "content",
			isError: i === 4,
		} as Message["content"]),
	]).flat();
	const rows = deriveChatTimelineRows({
		messages,
		inFlight: true,
		awaitingPlanApproval: false,
	});
	const groups = rows.filter((row) => row.kind === "tool-activity");
	expect(groups.map((group) => group.messages.length)).toEqual([50]);
	expect(groups.flatMap((group) => group.messages)).toEqual(messages);
	const first = deriveChatTimelineRows({
		messages: messages.slice(0, 2),
		inFlight: true,
		awaitingPlanApproval: false,
	});
	expect(groups[0]?.id).toBe(first[0]?.id);
});

it("does not group across text or hide an unpaired tool error", () => {
	const messages = [
		message("orphan", {
			_tag: "tool_result",
			itemId: "missing",
			output: "error",
			isError: true,
		} as Message["content"]),
		message("tool", {
			_tag: "tool_use",
			itemId: "read",
			tool: "Read",
			input: {},
		} as Message["content"]),
		message("text", { _tag: "assistant", text: "Checking the file." }),
		message("tool2", {
			_tag: "tool_use",
			itemId: "read2",
			tool: "Read",
			input: {},
		} as Message["content"]),
	];
	const rows = deriveChatTimelineRows({
		messages,
		inFlight: true,
		awaitingPlanApproval: false,
	});
	expect(rows.map((row) => row.kind)).toEqual([
		"message",
		"tool-activity",
		"message",
		"tool-activity",
		"working",
	]);
});

it("pulls thinking that leads into tools into the tree, but not before text", () => {
	const thinking = (id: string) =>
		message(id, {
			_tag: "thinking",
			itemId: id,
			text: "Weighing options.",
			redacted: false,
		} as Message["content"]);
	const messages = [
		thinking("think-1"),
		message("tool", {
			_tag: "tool_use",
			itemId: "read",
			tool: "Read",
			input: {},
		} as Message["content"]),
		thinking("think-2"),
		message("text", { _tag: "assistant", text: "Done." }),
		thinking("think-3"),
		message("reply", { _tag: "assistant", text: "Answer." }),
	];
	const rows = deriveChatTimelineRows({
		messages,
		inFlight: true,
		awaitingPlanApproval: false,
	});
	expect(rows.map((row) => row.kind)).toEqual([
		"tool-activity",
		"message",
		"message",
		"message",
		"working",
	]);
	expect(rows[0]?.id).toBe("tools:message:think-1");
	expect(rows[0]?.kind === "tool-activity" && rows[0].messages).toEqual(
		messages.slice(0, 3),
	);
	expect(
		rows.slice(1, 4).map((row) => row.kind === "message" && row.message.id),
	).toEqual(["text", "think-3", "reply"]);
});

it("keeps tools together across invisible status and empty assistant rows", () => {
	const tool = (id: string) =>
		message(id, {
			_tag: "tool_use",
			itemId: id,
			tool: "WebSearch",
			input: {},
		} as Message["content"]);
	const messages = [
		tool("one"),
		message("status", { _tag: "context_usage" } as Message["content"]),
		tool("two"),
		message("empty", { _tag: "assistant", text: "" }),
		tool("three"),
	];
	const rows = deriveChatTimelineRows({
		messages,
		inFlight: true,
		awaitingPlanApproval: false,
	});
	expect(rows.map((row) => row.kind)).toEqual(["tool-activity", "working"]);
	expect(rows[0]?.kind === "tool-activity" && rows[0].messages).toEqual(
		messages,
	);
});

it("keeps inline visuals outside collapsed activity with stable identities after settling", () => {
	const content = (itemId: string, tool: string) =>
		({ _tag: "tool_use", itemId, tool, input: {} }) as Message["content"];
	const messages = [
		message("u", { _tag: "user", text: "Compare" }),
		message("tool", content("shell", "Bash")),
		message("visual", content("visual", "mcp__zuse__html_render")),
		message("a", { _tag: "assistant", text: "Analysis" }),
	];
	for (const inFlight of [true, false]) {
		const rows = deriveChatTimelineRows({
			messages,
			inFlight,
			awaitingPlanApproval: false,
		});
		expect(rows.find((row) => row.id === "message:visual")?.kind).toBe(
			"message",
		);
		expect(rows.some((row) => row.kind === "tool-activity")).toBe(true);
		expect(rows.some((row) => row.kind === "turn-summary")).toBe(false);
	}
});

it("draws orchestration spawns and subagents as one delegation group, outside tool trees", () => {
	const spawn = (id: string) => [
		message(id, {
			_tag: "tool_use",
			itemId: id,
			tool: "mcp__zuse-orchestration__create_thread",
			input: { task: id },
		} as Message["content"]),
		message(`${id}-result`, {
			_tag: "tool_result",
			itemId: id,
			output: JSON.stringify({ chatId: `chat-${id}`, sessionId: `s-${id}` }),
			isError: false,
		} as Message["content"]),
	];
	const messages = [
		message("u", { _tag: "user", text: "Split this up" }),
		message("read", {
			_tag: "tool_use",
			itemId: "read",
			tool: "Read",
			input: {},
		} as Message["content"]),
		...spawn("one"),
		...spawn("two"),
		message("agent", {
			_tag: "tool_use",
			itemId: "agent",
			tool: "Agent",
			input: { description: "Audit", prompt: "Inspect" },
		} as Message["content"]),
		message("a", { _tag: "assistant", text: "Delegated." }),
	];
	const live = deriveChatTimelineRows({
		messages,
		inFlight: true,
		awaitingPlanApproval: false,
	});
	expect(live.map((row) => row.kind)).toEqual([
		"message",
		"tool-activity",
		"delegation",
		"message",
		"working",
	]);
	const fleet = live[2];
	expect(
		fleet?.kind === "delegation" && fleet.members.map((member) => member.id),
	).toEqual(["one", "two", "agent"]);

	// Settled turns keep delegations visible and out of the summary counts.
	const settled = deriveChatTimelineRows({
		messages,
		inFlight: false,
		awaitingPlanApproval: false,
	});
	expect(settled.map((row) => row.kind)).toEqual([
		"message",
		"delegation",
		"turn-summary",
	]);
	expect(settled[1]?.id).toBe(fleet?.id);
	const summary = settled[2];
	expect(
		summary?.kind === "turn-summary" &&
			summary.body.map((message) => message.id),
	).toEqual(["read", "a"]);
});

it("does not summarize a turn whose only tools were delegations", () => {
	const rows = deriveChatTimelineRows({
		messages: [
			message("u", { _tag: "user", text: "Go" }),
			message("agent", {
				_tag: "tool_use",
				itemId: "agent",
				tool: "Agent",
				input: { description: "Audit", prompt: "Inspect" },
			} as Message["content"]),
			message("a", { _tag: "assistant", text: "Started." }),
		],
		inFlight: false,
		awaitingPlanApproval: false,
	});
	expect(rows.map((row) => row.kind)).toEqual([
		"message",
		"delegation",
		"message",
	]);
});

it("keeps generated UI visible through turn completion and replay", () => {
	const messages = [
		message("u-ui", { _tag: "user", text: "Show build health" }),
		message("tool-ui", {
			_tag: "tool_use",
			itemId: AgentItemId.make("emit-ui"),
			tool: "emit_ui",
			input: {},
		}),
		message("ui", {
			_tag: "ui_spec",
			version: 1,
			spec: 'root = Stat("Tests", "428")',
		}),
		message("a-ui", { _tag: "assistant", text: "All checks passed." }),
	];
	for (const inFlight of [true, false]) {
		const rows = deriveChatTimelineRows({
			messages,
			inFlight,
			awaitingPlanApproval: false,
		});
		expect(rows.find((row) => row.id === "message:ui")?.kind).toBe("message");
		expect(rows.some((row) => row.kind === "turn-summary")).toBe(false);
	}
	const replay = createCloudTimelineRows();
	expect(
		replay({ messages, inFlight: false, awaitingPlanApproval: false }).some(
			(row) => row.id === "message:ui",
		),
	).toBe(true);
});

it("shows generated UI inline instead of under its tool call", () => {
	const emitUi = (id: string, isError: boolean) => [
		message(`tool-${id}`, {
			_tag: "tool_use",
			itemId: AgentItemId.make(id),
			tool: "mcp__zuse__emit_ui",
			input: {},
		}),
		message(`result-${id}`, {
			_tag: "tool_result",
			itemId: AgentItemId.make(id),
			output: isError ? "Unknown component Chart." : "{}",
			isError,
		}),
	];
	const rows = deriveChatTimelineRows({
		messages: [
			message("u1", { _tag: "user", text: "Ask me" }),
			...emitUi("bad", true),
			...emitUi("good", false),
			message("ui-1", {
				_tag: "ui_spec",
				version: 1,
				spec: 'root = Text("old")',
			}),
			message("u2", { _tag: "user", text: "Again" }),
			message("ui-2", {
				_tag: "ui_spec",
				version: 1,
				spec: 'root = Text("new")',
			}),
		],
		inFlight: false,
		awaitingPlanApproval: false,
	});
	const tools = rows.flatMap((row) =>
		row.kind === "tool-activity" ? row.messages.map((m) => m.id) : [],
	);
	// The failed call stays visible; the successful one is the block itself.
	expect(tools).toEqual(["tool-bad", "result-bad"]);
	const interactive = (id: string) => {
		const row = rows.find((candidate) => candidate.id === `message:${id}`);
		return row?.kind === "message" ? row.interactive === true : undefined;
	};
	expect(interactive("ui-1")).toBe(false);
	expect(interactive("ui-2")).toBe(true);
});
