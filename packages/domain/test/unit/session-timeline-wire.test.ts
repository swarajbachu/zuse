import { AgentItemId, Message, MessageId, SessionId } from "@zuse/contracts";
import { expect, test } from "vitest";
import { makeDeferredToolDetailProjector } from "../../src/queries/session-timeline-wire.ts";

const itemId = AgentItemId.make("tool");
const make = (content: Message["content"]) =>
	Message.make({
		id: MessageId.make("message"),
		sessionId: SessionId.make("session"),
		role: "assistant",
		content,
		createdAt: new Date(0),
	});

test("large display-only results are deferred without changing durable content or status", () => {
	const projector = makeDeferredToolDetailProjector();
	projector.message(
		make({
			_tag: "tool_use",
			itemId,
			tool: "Bash",
			input: { command: "build" },
		}),
	);
	const stored = make({
		_tag: "tool_result",
		itemId,
		output: "界".repeat(100_000),
		isError: true,
	});
	const wire = projector.message(stored);
	expect(JSON.stringify(wire).length).toBeLessThan(1000);
	expect(wire.content).toMatchObject({
		isError: true,
		outputDeferred: expect.any(String),
	});
	expect(stored.content).toMatchObject({ output: "界".repeat(100_000) });
	expect(projector.message(wire)).toBe(wire);
});

test.each([
	"ExitPlanMode",
	"TodoWrite",
	"Agent",
	"html_render",
	"generate_image",
])("preserves semantic results for %s", (tool) => {
	const projector = makeDeferredToolDetailProjector();
	projector.message(make({ _tag: "tool_use", itemId, tool, input: {} }));
	const stored = make({
		_tag: "tool_result",
		itemId,
		output: "x".repeat(50_000),
		isError: false,
	});
	expect(projector.message(stored)).toBe(stored);
});

test("small and unmatched results remain intact", () => {
	const projector = makeDeferredToolDetailProjector();
	const stored = make({
		_tag: "tool_result",
		itemId,
		output: "x".repeat(50_000),
		isError: false,
	});
	expect(projector.message(stored)).toBe(stored);
	projector.message(
		make({ _tag: "tool_use", itemId, tool: "Bash", input: {} }),
	);
	const small = make({
		_tag: "tool_result",
		itemId,
		output: "done",
		isError: false,
	});
	expect(projector.message(small)).toBe(small);
});

test("large edit bodies retain paths on the wire and full content in storage", () => {
	const projector = makeDeferredToolDetailProjector();
	const input = {
		file_path: "file.ts",
		old_string: "old",
		new_string: "界".repeat(20_000),
	};
	const stored = make({ _tag: "tool_use", itemId, tool: "Edit", input });
	const wire = projector.message(stored);
	expect(wire).toBe(stored);
	expect(stored.content).toMatchObject({ input });
});
