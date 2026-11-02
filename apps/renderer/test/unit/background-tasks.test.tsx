import { runningBackgroundTasks } from "@zuse/client-runtime/background-agent-presentation";
import type { ResourceView } from "@zuse/client-runtime/resource-state";
import {
	AgentTurnId,
	AttemptId,
	CommandId,
	EnvironmentId,
	SessionId,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { stopBackgroundTask } from "../../src/lib/session-actions.ts";

const dispatch = vi.hoisted(() => vi.fn(async () => ({ status: "applied" })));
vi.mock(
	"../../src/lib/session-timeline-client-bus.ts",
	async (importOriginal) => ({
		...(await importOriginal<Record<string, unknown>>()),
		dispatchSessionCommand: dispatch,
	}),
);

import {
	BackgroundTaskRows,
	BackgroundTasks,
} from "../../src/components/background-tasks.tsx";

const ref = {
	environmentId: EnvironmentId.make("remote"),
	sessionId: SessionId.make("session"),
};
const turnId = AgentTurnId.make("turn");
const attemptId = AttemptId.make("attempt");
const projection = SessionTimelineProjection.make({
	messages: [],
	status: "running",
	turnCount: 1,
	queue: { items: [], paused: false },
	interactions: [],
	permissionMode: "default",
	runtimeMode: "full-access",
	activeTurn: {
		id: turnId,
		ordinal: 1,
		status: "running",
		phase: "running",
		requestedAt: new Date(0),
		completedAt: null,
		providerThreadId: null,
		attempt: { id: attemptId, ordinal: 1, reason: "initial" },
	},
	executionSteps: [
		{
			id: "task",
			turnId,
			attemptId,
			itemId: "shell",
			parentItemId: null,
			kind: "background",
			label: "Watch build",
			status: "running",
			childSessionId: null,
			nativeChildId: "native-task",
			rootCompletedAt: 1,
			createdAt: 0,
			updatedAt: 1,
			checkpointCapability: "unsupported",
		},
	],
});
const view: ResourceView<SessionTimelineProjection> = {
	data: projection,
	origin: "runtime",
	connection: "connected",
	sync: "live",
	generation: 1,
	cursor: { epoch: "epoch", version: 1 },
	pendingCommands: [],
	failedCommands: [],
};

describe("background task controls", () => {
	it("folds running tasks behind a count until opened", () => {
		const html = renderToStaticMarkup(
			<BackgroundTasks view={view} sessionRef={ref} providerId="claude" />,
		);
		expect(html).toContain("1 running");
		expect(html).toContain('aria-expanded="false"');
		expect(html).not.toContain("Watch build");
	});
	it("shows a named process with its own stop control", () => {
		const html = renderToStaticMarkup(
			<BackgroundTaskRows view={view} sessionRef={ref} providerId="claude" />,
		);
		expect(html).toContain("Watch build");
		expect(html).toContain("Background process");
		expect(html).toContain('aria-label="Stop Watch build"');
		expect(html).not.toContain("Waiting");
	});
	it("dispatches the exact task, environment and execution identity", async () => {
		const task = runningBackgroundTasks(view).at(0);
		if (task === undefined) throw new Error("Missing task");
		await stopBackgroundTask(ref, task);
		expect(dispatch).toHaveBeenLastCalledWith(
			expect.objectContaining({
				ref,
				kind: "messages.background.stop",
				payload: expect.objectContaining({
					sessionId: ref.sessionId,
					turnId,
					attemptId,
					taskId: "native-task",
				}),
			}),
		);
	});
	it("keeps the process visible after a stop request and disables its pending control", () => {
		const pending = {
			...view,
			pendingCommands: [
				{
					commandId: CommandId.make("stop"),
					kind: "messages.background.stop",
					targetId: "native-task",
					submittedAt: 1,
				},
			],
		};
		const html = renderToStaticMarkup(
			<BackgroundTaskRows
				view={pending}
				sessionRef={ref}
				providerId="claude"
			/>,
		);
		expect(html).toContain("Watch build");
		expect(html).toContain("Stopping");
		expect(html).toContain("disabled");
	});
	it("does not offer a stop control for unsupported providers or a different attempt", () => {
		for (const [data, providerId] of [
			[projection, "codex"],
			[
				{
					...projection,
					activeTurn: {
						...projection.activeTurn,
						attempt: {
							...projection.activeTurn?.attempt,
							id: AttemptId.make("new-attempt"),
						},
					},
				},
				"claude",
			],
		] as const) {
			const html = renderToStaticMarkup(
				<BackgroundTaskRows
					view={{ ...view, data: data as SessionTimelineProjection }}
					sessionRef={ref}
					providerId={providerId}
				/>,
			);
			expect(html).not.toContain("<button");
		}
	});
	it("separates a stopped process from the running ones and keeps stop on each running row", () => {
		const data = {
			...projection,
			executionSteps: [
				...(projection.executionSteps ?? []),
				{
					...(projection.executionSteps ?? [])[0],
					id: "second",
					itemId: "second-shell",
					label: "Run tests",
					nativeChildId: "native-second",
				},
				{
					...(projection.executionSteps ?? [])[0],
					id: "ended",
					itemId: "ended-shell",
					label: "Old server",
					status: "cancelled" as const,
					nativeChildId: "native-ended",
				},
			],
		} as SessionTimelineProjection;
		const html = renderToStaticMarkup(
			<BackgroundTaskRows
				view={{ ...view, data }}
				sessionRef={ref}
				providerId="claude"
			/>,
		);
		expect(html).toContain('aria-label="Running"');
		expect(html).toContain('aria-label="Stopped"');
		expect(html.indexOf("Run tests")).toBeLessThan(html.indexOf("Old server"));
		expect(html).toContain('aria-label="Stop Watch build"');
		expect(html).toContain('aria-label="Stop Run tests"');
		expect(html).toContain("Stop all");
		expect(html).not.toContain('aria-label="Stop Old server"');
	});
	it("moves a process to the stopped group once its native outcome is persisted", () => {
		const data = {
			...projection,
			executionSteps: projection.executionSteps?.map((step) => ({
				...step,
				status: "cancelled" as const,
			})),
		};
		const section = renderToStaticMarkup(
			<BackgroundTasks
				view={{ ...view, data }}
				sessionRef={ref}
				providerId="claude"
			/>,
		);
		expect(section).toContain("Background work");
		expect(section).not.toContain("running");
		const rows = renderToStaticMarkup(
			<BackgroundTaskRows
				view={{ ...view, data }}
				sessionRef={ref}
				providerId="claude"
			/>,
		);
		expect(rows).not.toContain('aria-label="Running"');
		expect(rows).toContain('aria-label="Stopped"');
		expect(rows).toContain("Watch build");
		expect(rows).not.toContain("<button");
	});
});
