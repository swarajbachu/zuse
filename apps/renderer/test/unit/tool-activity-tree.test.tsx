import {
	AgentItemId,
	type Message,
	MessageId,
	SessionId,
} from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { DelegationGroup } from "../../src/components/delegation-group.tsx";
import { ToolActivityTree } from "../../src/components/tool-activity-tree.tsx";
import { TurnSummary } from "../../src/components/turn-summary.tsx";
import type { DelegationMember } from "../../src/lib/delegation-display.ts";

vi.mock("../../src/components/message-row.tsx", () => ({
	MessageRow: ({ message }: { message: Message }) => (
		<div>
			{message.content._tag === "ui_spec" ? "Visual result" : "Tool detail"}
		</div>
	),
}));
const messages: Message[] = [
	{
		id: MessageId.make("disclosure-tool"),
		sessionId: SessionId.make("disclosure-session"),
		role: "assistant",
		content: {
			_tag: "tool_use",
			itemId: AgentItemId.make("read"),
			tool: "Read",
			input: {},
		},
		createdAt: new Date(0),
	},
];
it("starts settled tool groups collapsed", () => {
	const html = renderToStaticMarkup(<ToolActivityTree messages={messages} />);
	expect(html).toContain('aria-expanded="false"');
	expect(html).not.toContain("Tool detail");
});

it("never renders visual output as part of the turn summary", () => {
	const tool = messages[0];
	if (!tool) throw new Error("Missing tool fixture");
	const visual: Message = {
		...tool,
		id: MessageId.make("disclosure-visual"),
		content: { _tag: "ui_spec", spec: 'root = Text("result")', version: 1 },
	};
	const final: Message = {
		...tool,
		id: MessageId.make("disclosure-final"),
		content: { _tag: "assistant", text: "Final reply" },
	};
	const html = renderToStaticMarkup(
		<TurnSummary body={[tool, visual, final]} />,
	);
	expect(html).toContain('aria-expanded="false"');
	expect(html).not.toContain("Visual result");
	expect(html).toContain("Final reply");
	expect(html).not.toContain("Tool detail");
});

it("keeps live and settled tool groups collapsed by default", () => {
	expect(
		renderToStaticMarkup(<ToolActivityTree messages={messages} live />),
	).toContain('aria-expanded="false"');
	expect(
		renderToStaticMarkup(<ToolActivityTree messages={messages} live={false} />),
	).toContain('aria-expanded="false"');
});
it("opens working delegation groups and collapses them once the parent finishes", () => {
	const parent = messages[0];
	if (!parent) throw new Error("Missing tool fixture");
	const members: DelegationMember[] = ["child-a", "child-b"].map((id) => ({
		kind: "subagent",
		id,
		group: {
			kind: "subagent",
			parent: { ...parent, id: MessageId.make(id) },
			parentItemId: AgentItemId.make(id),
			agentName: id,
			prompt: "Inspect",
			modelRequested: undefined,
			childSessionId: undefined,
			presentation: "inline",
			children: [],
			summary: null,
		},
	}));
	const render = (parentLive: boolean) =>
		renderToStaticMarkup(
			<DelegationGroup
				members={members}
				providerId={null}
				parentLive={parentLive}
				chatRef={null}
				environmentId={undefined}
				readOnly
			/>,
		);
	expect(render(true)).toContain('aria-expanded="true"');
	expect(render(false)).toContain('aria-expanded="false"');
});

it("shows the latest running tool without mounting its details", () => {
	const html = renderToStaticMarkup(
		<ToolActivityTree messages={messages} live />,
	);
	expect(html).toContain('role="status"');
	expect(html).toContain("Reading files…");
	expect(html).not.toContain("Tool detail");
});

it("stops showing running progress when the tool result arrives", () => {
	const tool = messages[0];
	if (tool?.content._tag !== "tool_use") throw new Error("Missing tool");
	const result: Message = {
		...tool,
		id: MessageId.make("done"),
		content: {
			_tag: "tool_result",
			itemId: tool.content.itemId,
			output: "done",
			isError: false,
		},
	};
	const html = renderToStaticMarkup(
		<ToolActivityTree messages={[tool, result]} live />,
	);
	expect(html).toContain('aria-expanded="false"');
	expect(html).not.toContain("Reading files…");
	expect(html).not.toContain("animate-spin");
	expect(html).not.toContain("Tool detail");
});

it("replaces the count with the latest tool activity", () => {
	const first = messages[0];
	if (!first) throw new Error("Missing tool");
	const bash: Message = {
		...first,
		id: MessageId.make("latest-bash"),
		content: {
			_tag: "tool_use",
			itemId: AgentItemId.make("bash"),
			tool: "Bash",
			input: { command: "pwd" },
		},
	};
	const html = renderToStaticMarkup(
		<ToolActivityTree messages={[first, bash]} live />,
	);
	expect(html).toContain("Running Bash…");
	expect(html).not.toContain("Reading files…");
	expect(html).not.toContain("tool calls");
	expect(html).not.toContain("Tool detail");
});

it("does not inspect edit payloads while a group is collapsed", () => {
	const first = messages[0];
	if (!first) throw new Error("Missing fixture");
	const input = {
		get edits(): never {
			throw new Error("Closed groups must not compute edit details");
		},
	};
	const edit: Message = {
		...first,
		content: {
			_tag: "tool_use",
			itemId: AgentItemId.make("large-edit"),
			tool: "MultiEdit",
			input,
		},
	};
	expect(
		renderToStaticMarkup(<ToolActivityTree messages={[edit]} live />),
	).toContain("Editing files…");
	expect(
		renderToStaticMarkup(<ToolActivityTree messages={[edit]} />),
	).toContain("Last activity: MultiEdit");
});
