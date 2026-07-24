import { describe, expect, it } from "vitest";
import { qualifyNamingMessage } from "../../src/conversation/core/auto-name-operations.ts";

describe("qualifyNamingMessage", () => {
	it("uses the submitted user message before provider output exists", () => {
		expect(
			qualifyNamingMessage(
				JSON.stringify({
					_tag: "user",
					text: "Fix reconnect handling",
					goal: false,
				}),
			),
		).toEqual({
			userText: "Fix reconnect handling",
			conversationText: "User: Fix reconnect handling",
		});
	});

	it("uses the text from a rich user message", () => {
		expect(
			qualifyNamingMessage(
				JSON.stringify({
					_tag: "user_rich",
					text: "Review the auth flow",
					attachments: [],
					goal: false,
				}),
			),
		).toMatchObject({ userText: "Review the auth flow" });
	});

	it.each([
		["empty text", JSON.stringify({ _tag: "user", text: "   " })],
		[
			"assistant content",
			JSON.stringify({ _tag: "assistant", text: "Not a user request" }),
		],
		["malformed JSON", "{"],
	])("rejects %s", (_label, contentJson) => {
		expect(qualifyNamingMessage(contentJson)).toBeNull();
	});
});
