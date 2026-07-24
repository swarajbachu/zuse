import { describe, expect, it } from "vitest";
import {
	buildConversationText,
	cleanTitle,
	fallbackTitle,
	MAX_GENERATED_TITLE_LENGTH,
} from "../../src/provider/title-generator.ts";

describe("buildConversationText", () => {
	it("formats ordered turns for the title prompt", () => {
		expect(
			buildConversationText([
				{ role: "user", text: "hi" },
				{ role: "assistant", text: "Hey!" },
				{ role: "user", text: "fix login" },
			]),
		).toBe("User: hi\n\nAssistant: Hey!\n\nUser: fix login");
	});
});

describe("generated title length", () => {
	it.each([
		["model title", (text: string) => cleanTitle(text)],
		["fallback title", (text: string) => fallbackTitle(text)],
	])("caps a %s at 60 characters", (_label, makeTitle) => {
		const title = makeTitle("A".repeat(100));
		expect(title).toHaveLength(MAX_GENERATED_TITLE_LENGTH);
		expect(title).toBe("A".repeat(60));
	});
});
