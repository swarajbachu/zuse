import { AgentItemId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import { applyExecutionMessage } from "../../../src/projectors/execution-steps.ts";

const identity = (at: number) => ({
	sessionId: "session",
	turnId: "turn",
	attemptId: "attempt",
	at,
});
const itemId = AgentItemId.make("shell");
const launched = applyExecutionMessage([], identity(1), {
	_tag: "tool_use",
	itemId,
	tool: "Bash",
	input: { description: "Start dev server" },
	backgroundTask: { taskId: "native-shell" },
});

describe("background process steps", () => {
	it("records a stopped process as cancelled rather than failed", () => {
		const [step] = applyExecutionMessage(launched, identity(2), {
			_tag: "tool_result",
			itemId,
			output: "Stopped",
			isError: true,
			backgroundOutcome: "stopped",
		});
		expect(step).toMatchObject({ kind: "background", status: "cancelled" });
	});

	it("keeps an unclassified error result as a failure", () => {
		const [step] = applyExecutionMessage(launched, identity(2), {
			_tag: "tool_result",
			itemId,
			output: "Exited 1",
			isError: true,
		});
		expect(step).toMatchObject({ status: "failed", updatedAt: 2 });
	});
});
