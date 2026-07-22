import { describe, expect, it } from "vitest";
import {
	qualifyNamingMessages,
	type NamingMessageRow,
} from "../../src/conversation/core/auto-name-operations.ts";

const row = (
	role: string,
	content: Record<string, unknown>,
	kind = "message",
): NamingMessageRow => ({
	role,
	kind,
	content_json: JSON.stringify(content),
});

const user = row("user", { _tag: "user", text: "Fix reconnect handling" });
const assistant = row("assistant", {
	_tag: "assistant",
	text: "Implemented reconnect handling and verified it.",
});

describe("qualifyNamingMessages", () => {
	it("accepts a settled turn with substantive assistant output", () => {
		expect(qualifyNamingMessages("idle", [user, assistant])).toMatchObject({
			userText: "Fix reconnect handling",
			assistantText: "Implemented reconnect handling and verified it.",
		});
	});

	it.each([
		[
			"provider error before output",
			[user, row("assistant", { _tag: "error", message: "offline" }, "error")],
		],
		[
			"error after partial output",
			[
				user,
				assistant,
				row("assistant", { _tag: "error", message: "failed" }, "error"),
			],
		],
		[
			"interrupted turn",
			[user, row("assistant", { _tag: "interrupted" }, "interrupted")],
		],
		["permission-blocked turn", [user]],
		[
			"plan-blocked turn",
			[
				user,
				row("assistant", {
					_tag: "assistant",
					text: "Proposed plan",
					isPlan: true,
				}),
			],
		],
	] as const)("rejects a %s", (_label, rows) => {
		expect(qualifyNamingMessages("idle", rows)).toBeNull();
	});

	it.each([
		"error",
		"booting",
		"running",
	])("rejects output while the session is %s", (status) => {
		expect(qualifyNamingMessages(status, [user, assistant])).toBeNull();
	});

	it("allows a later successful retry after an earlier failed turn", () => {
		expect(
			qualifyNamingMessages("idle", [
				user,
				row("assistant", { _tag: "error", message: "failed" }, "error"),
			]),
		).toBeNull();
		expect(qualifyNamingMessages("idle", [user, assistant])).not.toBeNull();
	});
});
