import { Message, MessageId, SessionId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	extractFileChanges,
	groupTimelineTurns,
	mergeFileChanges,
	parseUnifiedPatch,
	summarizeFileChanges,
	summarizeTurnActivity,
} from "../../src/timeline.ts";

const sessionId = SessionId.make("session-1");
const message = (
	id: string,
	content: Message["content"],
	seconds = 0,
): Message =>
	Message.make({
		id: MessageId.make(id),
		sessionId,
		role:
			content._tag === "user" || content._tag === "user_rich"
				? "user"
				: "assistant",
		content,
		createdAt: new Date(seconds * 1000),
	});

describe("timeline projection", () => {
	it("groups messages into user turns and deduplicates tool updates", () => {
		const turns = groupTimelineTurns([
			message("u1", { _tag: "user", text: "go", goal: false }),
			message(
				"t1",
				{
					_tag: "tool_use",
					itemId: "item-1" as never,
					tool: "Read",
					input: {},
				},
				1,
			),
			message(
				"t2",
				{
					_tag: "tool_use",
					itemId: "item-1" as never,
					tool: "Read",
					input: { file_path: "src/a.ts" },
				},
				2,
			),
			message("a1", { _tag: "assistant", text: "Done" }, 3),
		]);
		expect(turns).toHaveLength(1);
		expect(turns[0]?.body).toHaveLength(2);
		expect(turns[0]?.durationMs).toBe(3000);
	});

	it("parses unified hunks with line numbers", () => {
		const lines = parseUnifiedPatch("@@ -2,2 +2,2 @@\n-old\n+new\n same");
		expect(lines.map((line) => line.kind)).toEqual([
			"hunk",
			"removed",
			"added",
			"context",
		]);
		expect(lines[1]?.oldLine).toBe(2);
		expect(lines[2]?.newLine).toBe(2);
	});

	it("extracts multi-edit stats and aggregates turn activity", () => {
		const tool = message("t1", {
			_tag: "tool_use",
			itemId: "item-1" as never,
			tool: "MultiEdit",
			input: {
				file_path: "src/a.ts",
				edits: [
					{ old_string: "a", new_string: "b\nc" },
					{ old_string: "d", new_string: "e" },
				],
			},
		});
		expect(
			extractFileChanges(
				"MultiEdit",
				tool.content._tag === "tool_use" ? tool.content.input : null,
			)[0],
		).toMatchObject({
			path: "src/a.ts",
			added: 3,
			removed: 2,
		});
		expect(summarizeTurnActivity([tool])).toMatchObject({
			tools: 1,
			added: 3,
			removed: 2,
		});
	});

	it("merges repeated file edits and totals them once", () => {
		const changes = mergeFileChanges([
			{ path: "src/a.ts", added: 2, removed: 1, lines: [] },
			{ path: "src/b.ts", added: 1, removed: 0, lines: [] },
			{ path: "src/a.ts", added: 3, removed: 2, lines: [] },
		]);
		expect(changes).toMatchObject([
			{ path: "src/a.ts", added: 5, removed: 3 },
			{ path: "src/b.ts", added: 1, removed: 0 },
		]);
		expect(summarizeFileChanges(changes)).toEqual({ added: 6, removed: 3 });
	});

	it("extracts real file paths from apply-patch tool payloads", () => {
		const patch = `*** Begin Patch
*** Update File: src/a.ts
@@
-const value = 1;
+const value = 2;
*** Add File: src/b.ts
+export const added = true;
*** End Patch`;
		const changes = extractFileChanges("Edit", {
			file_path: "(patch)",
			patch,
		});

		expect(changes.map((change) => change.path)).toEqual([
			"src/a.ts",
			"src/b.ts",
		]);
		expect(changes).toMatchObject([
			{ added: 1, removed: 1 },
			{ added: 1, removed: 0 },
		]);
		expect(
			extractFileChanges("Edit", {
				file_path: "(patch)",
				patch: { patch },
			}).map((change) => change.path),
		).toEqual(["src/a.ts", "src/b.ts"]);
	});
});
