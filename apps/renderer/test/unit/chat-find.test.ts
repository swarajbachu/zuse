import type { Message, SessionId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import {
	chatFindMatcher,
	chatFindRowText,
	countMatches,
	findChatMatches,
	firstChatFindIndexFromRow,
	locateSegmentMatches,
	normalizeChatFindQuery,
	resolveActiveChatFindIndex,
	wrapChatFindIndex,
} from "../../src/lib/chat-find.ts";
import type { ChatTimelineRow } from "../../src/lib/chat-timeline-rows.ts";

const sessionId = "session-find" as SessionId;

function message(id: string, content: Message["content"]): Message {
	return {
		id,
		sessionId,
		role:
			content._tag === "user" || content._tag === "user_rich"
				? "user"
				: "assistant",
		content,
		createdAt: new Date("2026-07-22T00:00:00.000Z"),
	} as Message;
}

const messageRow = (
	id: string,
	content: Message["content"],
): ChatTimelineRow => ({
	kind: "message",
	id: `message:${id}`,
	message: message(id, content),
	enterUser: false,
	showAssistantCommands: false,
});

const rows: ChatTimelineRow[] = [
	messageRow("u1", { _tag: "user", text: "Fix the Build error please" }),
	{
		kind: "tool-activity",
		id: "tools:1",
		messages: [
			message("t1", {
				_tag: "tool_use",
				itemId: "item-1" as never,
				tool: "Bash",
				input: { command: "bun run build" },
			}),
		],
	},
	{
		kind: "turn-summary",
		id: "summary:u1",
		body: [
			message("th", {
				_tag: "thinking",
				itemId: "item-2" as never,
				text: "build build build",
				redacted: false,
			}),
			message("a1", { _tag: "assistant", text: "The build failed; rebuild." }),
		],
		showAssistantCommands: true,
	},
	messageRow("e1", { _tag: "error", message: "BUILD timed out" }),
];

describe("chat find matching", () => {
	it("normalizes and escapes queries", () => {
		expect(normalizeChatFindQuery("  hi  ")).toBe("hi");
		expect(chatFindMatcher("   ")).toBeNull();
		const matcher = chatFindMatcher("a.b");
		expect(matcher).not.toBeNull();
		expect(countMatches("a.b axb A.B", matcher as RegExp)).toBe(2);
	});

	it("counts case-insensitive, non-overlapping occurrences", () => {
		const matcher = chatFindMatcher("aa") as RegExp;
		expect(countMatches("aaaa", matcher)).toBe(2);
		expect(countMatches("AaxAA", matcher)).toBe(2);
		expect(countMatches("", matcher)).toBe(0);
	});

	it("searches only the prose a row shows by default", () => {
		expect(chatFindRowText(rows[0] as ChatTimelineRow)).toBe(
			"Fix the Build error please",
		);
		expect(chatFindRowText(rows[1] as ChatTimelineRow)).toBe("");
		expect(chatFindRowText(rows[2] as ChatTimelineRow)).toBe(
			"The build failed; rebuild.",
		);
		expect(chatFindRowText(rows[3] as ChatTimelineRow)).toBe("BUILD timed out");
	});

	it("addresses matches as row plus ordinal, skipping hidden content", () => {
		expect(findChatMatches(rows, "build")).toEqual([
			{ rowIndex: 0, rowId: "message:u1", ordinal: 0 },
			{ rowIndex: 2, rowId: "summary:u1", ordinal: 0 },
			{ rowIndex: 2, rowId: "summary:u1", ordinal: 1 },
			{ rowIndex: 3, rowId: "message:e1", ordinal: 0 },
		]);
		expect(findChatMatches(rows, "")).toEqual([]);
		expect(findChatMatches(rows, "nothing here")).toEqual([]);
	});

	it("reuses cached counts when the same message is searched again", () => {
		const first = findChatMatches(rows, "build");
		const second = findChatMatches([...rows], "build");
		expect(second).toEqual(first);
		expect(findChatMatches(rows, "rebuild")).toEqual([
			{ rowIndex: 2, rowId: "summary:u1", ordinal: 0 },
		]);
	});
});

describe("chat find navigation", () => {
	it("wraps in both directions", () => {
		expect(wrapChatFindIndex(3, 3)).toBe(0);
		expect(wrapChatFindIndex(-1, 3)).toBe(2);
		expect(wrapChatFindIndex(1, 3)).toBe(1);
		expect(wrapChatFindIndex(0, 0)).toBe(-1);
	});

	it("starts a fresh query at the first match at or below the visible row", () => {
		const matches = findChatMatches(rows, "build");
		expect(firstChatFindIndexFromRow(0, matches)).toBe(0);
		expect(firstChatFindIndexFromRow(2, matches)).toBe(1);
		expect(firstChatFindIndexFromRow(3, matches)).toBe(3);
		expect(firstChatFindIndexFromRow(99, matches)).toBe(0);
		expect(firstChatFindIndexFromRow(0, [])).toBe(-1);
	});

	it("follows the same match when the transcript changes", () => {
		const before = findChatMatches(rows, "build");
		const active = before[2] as (typeof before)[number];
		const after = findChatMatches(
			[messageRow("u0", { _tag: "user", text: "build it" }), ...rows],
			"build",
		);
		expect(resolveActiveChatFindIndex(active, 2, after)).toBe(3);
	});

	it("stays as close as possible when the active match disappears", () => {
		const matches = findChatMatches(rows, "build");
		const gone = { rowIndex: 7, rowId: "message:missing", ordinal: 0 };
		expect(resolveActiveChatFindIndex(gone, 9, matches)).toBe(3);
		expect(resolveActiveChatFindIndex(gone, -1, matches)).toBe(0);
		expect(resolveActiveChatFindIndex(gone, 1, [])).toBe(-1);
	});
});

describe("chat find segment mapping", () => {
	const matcher = () => chatFindMatcher("build error") as RegExp;

	it("locates matches inside a single segment", () => {
		expect(locateSegmentMatches(["a Build Error here"], matcher())).toEqual([
			{ startSegment: 0, startOffset: 2, endSegment: 0, endOffset: 13 },
		]);
	});

	it("locates matches that span segment boundaries", () => {
		expect(
			locateSegmentMatches(["the bui", "ld", " error", " again"], matcher()),
		).toEqual([
			{ startSegment: 0, startOffset: 4, endSegment: 2, endOffset: 6 },
		]);
	});

	it("keeps a match ending on a boundary inside the earlier segment", () => {
		expect(
			locateSegmentMatches(["build error", "", "build error"], matcher()),
		).toEqual([
			{ startSegment: 0, startOffset: 0, endSegment: 0, endOffset: 11 },
			{ startSegment: 2, startOffset: 0, endSegment: 2, endOffset: 11 },
		]);
	});

	it("returns nothing for empty input", () => {
		expect(locateSegmentMatches([], matcher())).toEqual([]);
		expect(locateSegmentMatches(["", ""], matcher())).toEqual([]);
	});
});
