import {
	claudeAuthFailureText,
	claudeResultErrorText,
} from "@zuse/agents/drivers/claude";
import { describe, expect, it } from "vitest";

const assistant = (
	text: string,
	extra: Readonly<Record<string, unknown>> = {},
): never =>
	({
		type: "assistant",
		parent_tool_use_id: null,
		message: { content: [{ type: "text", text }] },
		...extra,
	}) as never;

// The CLI reports missing or expired credentials as a synthetic assistant
// message tagged `error: "authentication_failed"`; that tag, not the prose, is
// what turns it into a typed sign-in failure.
describe("claudeAuthFailureText", () => {
	it("reads the CLI's tagged authentication failures", () => {
		expect(
			claudeAuthFailureText(
				assistant(
					"Failed to authenticate: OAuth session expired and could not be refreshed",
					{ error: "authentication_failed" },
				),
			),
		).toBe(
			"Failed to authenticate: OAuth session expired and could not be refreshed",
		);
		expect(
			claudeAuthFailureText(
				assistant("Not logged in · Please run /login", {
					error: "authentication_failed",
				}),
			),
		).toBe("Not logged in · Please run /login");
	});

	it("ignores assistant prose that only mentions login or a 401", () => {
		expect(
			claudeAuthFailureText(
				assistant("The endpoint returns 401 until you run /login."),
			),
		).toBeNull();
	});

	it("ignores other error tags and sub-agent messages", () => {
		expect(
			claudeAuthFailureText(
				assistant("You've hit your limit", { error: "rate_limit" }),
			),
		).toBeNull();
		expect(
			claudeAuthFailureText(
				assistant("Not logged in", {
					error: "authentication_failed",
					parent_tool_use_id: "toolu_1",
				}),
			),
		).toBeNull();
	});
});

describe("claudeResultErrorText", () => {
	it("returns null for a clean success result", () => {
		expect(
			claudeResultErrorText({
				type: "result",
				subtype: "success",
				is_error: false,
				result: "done",
			} as never),
		).toBeNull();
	});

	it("extracts the 401 from a success-shaped error result", () => {
		const text = claudeResultErrorText({
			type: "result",
			subtype: "success",
			is_error: true,
			result: "Please run /login",
			api_error_status: 401,
		} as never);
		expect(text).not.toBeNull();
		expect(text).toContain("Please run /login");
		expect(text).toContain("401");
	});

	it("joins the errors[] of an error-subtype result", () => {
		const text = claudeResultErrorText({
			type: "result",
			subtype: "error_during_execution",
			is_error: true,
			errors: ["Not logged in", "Please run /login"],
		} as never);
		expect(text).toBe("Not logged in\nPlease run /login");
	});

	it("does not treat answer text on a non-success subtype as a provider error", () => {
		expect(
			claudeResultErrorText({
				type: "result",
				subtype: "error_during_execution",
				result:
					"Two good questions, and the first one has an important gotcha.",
			} as never),
		).toBeNull();
	});

	it("keeps a generic error for an error subtype with no answer text", () => {
		expect(
			claudeResultErrorText({
				type: "result",
				subtype: "error_during_execution",
			} as never),
		).toBe("The agent run ended with an error.");
	});
});
