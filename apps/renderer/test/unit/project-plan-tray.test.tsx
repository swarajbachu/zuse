import {
	AgentItemId,
	EnvironmentId,
	Message,
	MessageId,
	SessionId,
} from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const timeline = vi.hoisted(() => ({ messages: [] as Message[] }));
vi.mock("../../src/lib/session-timeline-hooks.ts", () => ({
	useRendererSessionTimeline: () => timeline,
}));

import {
	ProjectPlanTray,
	projectPlanFromMessages,
} from "../../src/components/composer/project-plan-tray.tsx";

const sessionId = SessionId.make("session");
const message = (content: Message["content"]) =>
	Message.make({
		id: MessageId.make(crypto.randomUUID()),
		sessionId,
		role: "assistant",
		content,
		createdAt: new Date(0),
	});
const snapshot = (todos: unknown[], parentItemId?: AgentItemId) =>
	message({
		_tag: "tool_use",
		itemId: AgentItemId.make("plan"),
		tool: "TodoWrite",
		input: { todos },
		parentItemId,
	});

describe("composer task plan", () => {
	it.each([
		"taskId",
		"id",
		"task_id",
	])("tracks current Claude tasks through completion and deletion (%s)", (idField) => {
		const create = message({
			_tag: "tool_use",
			itemId: AgentItemId.make("create"),
			tool: "TaskCreate",
			input: { subject: "Inspect" },
		});
		const result = message({
			_tag: "tool_result",
			itemId: AgentItemId.make("create"),
			output: { task: { id: "7", subject: "Inspect" } },
			isError: false,
		});
		const update = (status: string) =>
			message({
				_tag: "tool_use",
				itemId: AgentItemId.make(`update-${status}`),
				tool: "TaskUpdate",
				input: { [idField]: "7", status },
			});
		expect(projectPlanFromMessages([create, result])).toEqual([
			{ text: "Inspect", status: "pending" },
		]);
		expect(
			projectPlanFromMessages([create, result, update("in_progress")]),
		).toEqual([{ text: "Inspect", status: "in_progress" }]);
		expect(
			projectPlanFromMessages([create, result, update("completed")]),
		).toEqual([{ text: "Inspect", status: "completed" }]);
		expect(
			projectPlanFromMessages([create, result, update("deleted")]),
		).toEqual([]);
	});
	it("reads legacy task confirmations from text blocks without JSON artifacts", () => {
		expect(
			projectPlanFromMessages([
				message({
					_tag: "tool_use",
					itemId: AgentItemId.make("create"),
					tool: "TaskCreate",
					input: { subject: "Inspect" },
				}),
				message({
					_tag: "tool_result",
					itemId: AgentItemId.make("create"),
					output: [
						{ type: "text", text: "Task #7 created successfully: Inspect" },
					],
					isError: false,
				}),
			]),
		).toEqual([{ text: "Inspect", status: "pending" }]);
	});
	it("uses the latest snapshot for progress and accepts an empty list", () => {
		const initial = snapshot([{ content: "Inspect", status: "in_progress" }]);
		const completed = snapshot([{ content: "Inspect", status: "completed" }]);
		expect(projectPlanFromMessages([initial, completed])).toEqual([
			{ text: "Inspect", status: "completed" },
		]);
		expect(projectPlanFromMessages([initial, completed, snapshot([])])).toEqual(
			[],
		);
	});
	it("ignores nested agent plans", () => {
		expect(
			projectPlanFromMessages([
				snapshot([{ content: "Parent", status: "pending" }]),
				snapshot(
					[{ content: "Child", status: "completed" }],
					AgentItemId.make("child"),
				),
			]),
		).toEqual([{ text: "Parent", status: "pending" }]);
	});
	it("allows a fresh snapshot to replace historical incremental tasks", () => {
		expect(
			projectPlanFromMessages([
				message({
					_tag: "tool_use",
					itemId: AgentItemId.make("update"),
					tool: "TaskUpdate",
					input: { taskId: "1", subject: "Old", status: "pending" },
				}),
				snapshot([{ content: "New", status: "inProgress" }]),
			]),
		).toEqual([{ text: "New", status: "in_progress" }]);
	});
	it("renders the expand chevron as a real accessible button", () => {
		timeline.messages = [
			snapshot([{ content: "Inspect", status: "completed" }]),
		];
		const html = renderToStaticMarkup(
			<ProjectPlanTray
				sessionId={sessionId}
				environmentId={EnvironmentId.make("local")}
			/>,
		);
		expect(html).toContain("1 of 1 Done");
		expect(html.match(/<button[^>]*aria-expanded="false"/g)).toHaveLength(2);
	});
});
