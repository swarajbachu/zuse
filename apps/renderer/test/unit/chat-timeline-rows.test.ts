import type { Message, SessionId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
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

	it("keeps earlier assistant messages actionable during a live turn", () => {
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
		).toEqual([true, false]);
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
