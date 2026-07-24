import { describe, expect, it } from "vitest";

import { makeClaudeUserMessage } from "../../../src/drivers/claude.ts";

describe("Claude streaming input protocol", () => {
	it("does not expose an application session id as a provider conversation id", () => {
		const message = makeClaudeUserMessage("hello");

		expect(message).not.toHaveProperty("session_id");
	});
});
