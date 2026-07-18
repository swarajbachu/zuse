import { describe, expect, test } from "vitest";

import {
	buildToolResultsByItemId,
	summarizeValue,
} from "../../../src/lib/message-presentation";

describe("message presentation helpers", () => {
	test("pairs tool results by item id", () => {
		const results = buildToolResultsByItemId([
			{
				id: "message-1",
				createdAt: new Date(),
				content: {
					_tag: "tool_result",
					itemId: "tool-1",
					output: "done",
					isError: false,
				},
			},
		] as never);

		expect(results.get("tool-1")?.output).toBe("done");
	});

	test("summarizes long values", () => {
		const value = summarizeValue({ message: "x".repeat(500) }, 40);
		expect(value.length).toBe(40);
		expect(value.endsWith("…")).toBe(true);
	});
});
