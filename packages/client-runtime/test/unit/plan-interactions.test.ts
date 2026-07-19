import type { Message, SessionId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	findPendingNativePlanApproval,
	findPendingPlanInteraction,
} from "../../src/plan-interactions";

const sessionId = "session-plan" as SessionId;
const message = (id: string, content: Message["content"]): Message =>
	({
		id,
		sessionId,
		role: content._tag === "user" ? "user" : "assistant",
		content,
		createdAt: new Date(),
	}) as Message;

describe("pending plan interactions", () => {
	it("selects only the newest unresolved exact plan", () => {
		const old = message("old", {
			_tag: "tool_use",
			itemId: "old-tool" as never,
			tool: "ExitPlanMode",
			input: { plan: "Old" },
		});
		const settled = message("settled", {
			_tag: "tool_result",
			itemId: "old-tool" as never,
			output: "approved",
			isError: false,
		});
		const current = message("current", {
			_tag: "tool_use",
			itemId: "new-tool" as never,
			tool: "ExitPlanMode",
			input: { plan: "Current" },
		});
		expect(
			findPendingNativePlanApproval([old, settled, current]),
		).toMatchObject({ messageId: "current", plan: "Current" });
	});

	it("does not classify unrelated Markdown as an emulated plan", () => {
		const messages = [
			message("assistant", {
				_tag: "assistant",
				text: "## Summary\nOrdinary answer",
			}),
		];
		expect(
			findPendingPlanInteraction({
				messages,
				requests: [],
				sessionId,
				providerId: "codex",
				permissionMode: "plan",
				isRunning: false,
			}),
		).toBeNull();
	});

	it("accepts an explicit provider plan and preserves its identity", () => {
		const messages = [
			message("assistant", {
				_tag: "assistant",
				text: "# Exact plan",
				isPlan: true,
			}),
		];
		expect(
			findPendingPlanInteraction({
				messages,
				requests: [],
				sessionId,
				providerId: "codex",
				permissionMode: "plan",
				isRunning: false,
			}),
		).toMatchObject({
			kind: "emulated",
			plan: "# Exact plan",
			sourceMessageId: "assistant",
		});
	});
});
