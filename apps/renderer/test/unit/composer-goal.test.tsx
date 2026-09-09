import {
	EnvironmentId,
	FolderId,
	Session,
	SessionId,
	ThreadGoal,
} from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatComposer } from "../../src/components/chat-composer.tsx";
import { useSessionsStore } from "../../src/store/sessions.ts";

// Provider/model inventory is independent of applied access and requires a live client.
vi.mock("../../src/components/model-picker.tsx", () => ({
	ModelPicker: ({ runtimeMode }: { runtimeMode: string }) => (
		<span data-runtime-mode={runtimeMode} />
	),
}));

vi.mock("../../src/lib/session-timeline-hooks.ts", async (original) => ({
	...(await original<
		typeof import("../../src/lib/session-timeline-hooks.ts")
	>()),
	useRendererSessionTimeline: () => ({
		projection: { runtimeMode: "approval-required", queue: { items: [] } },
		view: { data: null, pendingCommands: [], failedCommands: [], sync: "live" },
		messages: [],
		runtime: "idle",
	}),
}));

const activeGoal = ThreadGoal.make({
	threadId: "thread-goal",
	objective: "Count from 1 to 100",
	status: "active",
	tokenBudget: null,
	tokensUsed: 100,
	timeUsedSeconds: 16,
	createdAt: 1,
	updatedAt: 2,
});
let currentGoal: ThreadGoal | null = activeGoal;

vi.mock("../../src/lib/session-goal-client-bus.ts", async (original) => ({
	...(await original<
		typeof import("../../src/lib/session-goal-client-bus.ts")
	>()),
	useSessionGoalResource: (ref: unknown) => ({
		data: ref === null ? null : { goal: currentGoal },
	}),
}));

describe("composer goal visibility", () => {
	beforeEach(() => {
		currentGoal = activeGoal;
	});
	it.each([
		"local-goal-environment",
		"cloud-goal-environment",
	])("shows an active goal before provider inventory is loaded in %s", (environment) => {
		const draft = useSessionsStore.getState().beginDraft({
			projectId: FolderId.make("project-goal"),
			providerId: "codex",
			model: "gpt-5.6-sol",
			runtimeMode: "full-access",
		});
		const session = Session.make({
			...draft,
			id: SessionId.make("goal-session"),
		});
		const html = renderToStaticMarkup(
			<ChatComposer
				session={session}
				environmentId={EnvironmentId.make(environment)}
			/>,
		);
		expect(html).toContain("Pursuing goal");
		expect(html).toContain("Count from 1 to 100");
		expect(html).toContain("Pause goal");
		expect(html).toContain("0m 16s");
	});
	it.each([
		["paused", "Goal paused"],
		["complete", "Goal complete"],
		["blocked", "Goal blocked"],
	] as const)("shows %s without claiming the goal is running", (status, label) => {
		currentGoal = ThreadGoal.make({ ...activeGoal, status });
		const draft = useSessionsStore.getState().beginDraft({
			projectId: FolderId.make("project-goal"),
			providerId: "codex",
			model: "gpt-5.6-sol",
			runtimeMode: "full-access",
		});
		const html = renderToStaticMarkup(
			<ChatComposer
				session={Session.make({ ...draft, id: SessionId.make("goal-session") })}
				environmentId={EnvironmentId.make("local-goal-environment")}
			/>,
		);
		expect(html).toContain(label);
		expect(html).not.toContain("Pursuing goal");
	});
});
