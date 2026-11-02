import {
	AgentItemId,
	AgentSessionId,
	AgentTurnId,
	AttemptId,
	CommandId,
	Message,
	MessageId,
	QueueState,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import {
	countRunningBackgroundAgents,
	endedBackgroundProcesses,
	runningBackgroundAgents,
	runningBackgroundProcesses,
	runningBackgroundTasks,
} from "../../src/background-agent-presentation.ts";
import { clientCommandTargetId } from "../../src/client-command-target.ts";
import type { ResourceView } from "../../src/resource-state.ts";
import {
	deriveSessionPresentation,
	type SessionPresentation,
} from "../../src/session-presentation.ts";

const projection = (
	status: "idle" | "running",
	turn: boolean,
	messages: ReadonlyArray<Message> = [],
	interactions: SessionTimelineProjection["interactions"] = [],
): SessionTimelineProjection =>
	SessionTimelineProjection.make({
		messages: [...messages],
		status,
		activeTurn: turn
			? {
					id: AgentTurnId.make("turn-presentation"),
					ordinal: 1,
					status: "running",
					phase: "running",
					attempt: {
						id: AttemptId.make("attempt-presentation"),
						ordinal: 1,
						reason: "initial",
					},
					providerThreadId: null,
					requestedAt: new Date(0),
					completedAt: null,
				}
			: null,
		turnCount: turn ? 1 : 0,
		queue: QueueState.make({ items: [], paused: false }),
		permissionMode: "default",
		runtimeMode: "approval-required",
		interactions: [...interactions],
	});

const view = (
	data: SessionTimelineProjection | null,
	overrides: Partial<ResourceView<SessionTimelineProjection>> = {},
): ResourceView<SessionTimelineProjection> => ({
	data,
	origin: data === null ? "none" : "runtime",
	connection: "connected",
	sync: data === null ? "empty" : "live",
	generation: 1,
	cursor: data === null ? null : { epoch: "epoch-1", version: 10 },
	pendingCommands: [],
	failedCommands: [],
	...overrides,
});

const runtime = (presentation: SessionPresentation): string =>
	presentation.runtime;

const assistantMessage = Message.make({
	id: MessageId.make("settled-assistant"),
	sessionId: AgentSessionId.make("presentation-session"),
	role: "assistant",
	content: { _tag: "assistant", text: "Done" },
	createdAt: new Date("2026-08-23T00:00:01.000Z"),
});

describe("session presentation authority", () => {
	it.each([
		"persisting",
		"reserved",
		"accepted",
		"waiting-for-runtime",
		"blocked",
	] as const)("does not start a turn for a mailbox command still %s", (deliveryPhase) => {
		const presentation = deriveSessionPresentation({
			view: view(projection("idle", false), {
				pendingCommands: [
					{
						commandId: CommandId.make("mailbox-send"),
						kind: "messages.send",
						targetId: null,
						submittedAt: 1,
						deliveryPhase,
					},
				],
			}),
		});
		expect(presentation.runtime).toBe("idle");
		expect(presentation.turnInFlight).toBe(false);
	});
	it("does not let a stale running catalog hint revive a settled timeline", () => {
		expect(
			runtime(
				deriveSessionPresentation({
					view: view(projection("idle", false)),
					catalogStatus: "running",
				}),
			),
		).toBe("idle");
	});

	it("bridges submit to durable start, then settles from the timeline", () => {
		const submitted = deriveSessionPresentation({
			view: view(projection("idle", false), {
				pendingCommands: [
					{
						commandId: CommandId.make("send-1"),
						kind: "messages.send",
						targetId: null,
						submittedAt: 1,
					},
				],
			}),
			catalogStatus: "idle",
		});
		const started = deriveSessionPresentation({
			view: view(projection("running", true)),
			catalogStatus: "idle",
		});
		const settled = deriveSessionPresentation({
			view: view(projection("idle", false)),
			catalogStatus: "running",
		});

		expect([runtime(submitted), runtime(started), runtime(settled)]).toEqual([
			"starting",
			"running",
			"idle",
		]);
		expect([
			submitted.turnInFlight,
			started.turnInFlight,
			settled.turnInFlight,
		]).toEqual([true, true, false]);
	});

	it("lets a settled timeline end stale start and interrupt overlays", () => {
		const settledProjection = projection("idle", false, [assistantMessage]);
		const stillAwaitingSendReceipt = deriveSessionPresentation({
			view: view(settledProjection, {
				pendingCommands: [
					{
						commandId: CommandId.make("send-stale"),
						kind: "messages.send",
						targetId: null,
						submittedAt: 1,
					},
				],
			}),
		});
		const stillAwaitingInterruptReceipt = deriveSessionPresentation({
			view: view(settledProjection, {
				pendingCommands: [
					{
						commandId: CommandId.make("interrupt-stale"),
						kind: "messages.interrupt",
						targetId: null,
						submittedAt: 1,
					},
				],
			}),
		});

		expect(runtime(stillAwaitingSendReceipt)).toBe("idle");
		expect(runtime(stillAwaitingInterruptReceipt)).toBe("idle");
		expect(stillAwaitingSendReceipt.turnInFlight).toBe(false);
		expect(stillAwaitingInterruptReceipt.turnInFlight).toBe(false);
	});

	it("uses a catalog hint only before a qualified timeline cursor exists", () => {
		expect(
			runtime(
				deriveSessionPresentation({
					view: view(null),
					catalogStatus: "booting",
				}),
			),
		).toBe("starting");
		expect(
			runtime(
				deriveSessionPresentation({
					view: view(null, {
						origin: "checkpoint",
						cursor: { epoch: "epoch-1", version: 10 },
						sync: "synchronizing",
					}),
					catalogStatus: "running",
				}),
			),
		).toBe("idle");
	});

	it("keeps question submission as a client overlay over durable existence", () => {
		const interaction = {
			_tag: "Question" as const,
			id: AgentItemId.make("question-overlay"),
			questions: [{ question: "Choose", options: ["A"] }],
			requestedAt: new Date("2026-08-23T00:00:00.000Z"),
		};
		const durable = projection("running", true, [], [interaction]);
		const pending = deriveSessionPresentation({ view: view(durable) });
		const submitting = deriveSessionPresentation({
			view: view(durable, {
				pendingCommands: [
					{
						commandId: CommandId.make("question-submit"),
						kind: "session.answerQuestion",
						targetId: interaction.id,
						submittedAt: 1,
					},
				],
			}),
		});
		const failed = deriveSessionPresentation({
			view: view(durable, {
				failedCommands: [
					{
						commandId: CommandId.make("question-failed"),
						kind: "session.answerQuestion",
						targetId: interaction.id,
						failedAt: 2,
						error: "offline",
						retryable: false,
					},
				],
			}),
		});

		expect(pending.interactions[0]?.submission).toBe("pending");
		expect(submitting.interactions[0]?.submission).toBe("submitting");
		expect(failed.interactions[0]).toMatchObject({
			submission: "failed",
			error: "offline",
		});
	});

	it("uses a question cancellation overlay with the same authoritative identity", () => {
		const interaction = {
			_tag: "Question" as const,
			id: AgentItemId.make("question-cancel-overlay"),
			questions: [{ question: "Choose", options: ["A"] }],
			requestedAt: new Date("2026-08-23T00:00:00.000Z"),
		};
		const durable = projection("running", true, [], [interaction]);
		const submitting = deriveSessionPresentation({
			view: view(durable, {
				pendingCommands: [
					{
						commandId: CommandId.make("question-cancel"),
						kind: "session.cancelQuestion",
						targetId: interaction.id,
						submittedAt: 1,
					},
				],
			}),
		});
		const failed = deriveSessionPresentation({
			view: view(durable, {
				failedCommands: [
					{
						commandId: CommandId.make("question-cancel-failed"),
						kind: "session.cancelQuestion",
						targetId: interaction.id,
						failedAt: 2,
						error: "lost acknowledgement",
						retryable: true,
					},
				],
			}),
		});

		expect(submitting.interactions[0]?.submission).toBe("submitting");
		expect(failed.interactions[0]).toMatchObject({
			submission: "failed",
			error: "lost acknowledgement",
		});
	});

	it("matches a submission overlay to its interaction identity", () => {
		const first = {
			_tag: "Question" as const,
			id: AgentItemId.make("question-first"),
			questions: [{ question: "First", options: ["A"] }],
			requestedAt: new Date("2026-08-23T00:00:00.000Z"),
		};
		const second = {
			_tag: "Question" as const,
			id: AgentItemId.make("question-second"),
			questions: [{ question: "Second", options: ["B"] }],
			requestedAt: new Date("2026-08-23T00:00:01.000Z"),
		};
		const presented = deriveSessionPresentation({
			view: view(projection("running", true, [], [first, second]), {
				pendingCommands: [
					{
						commandId: CommandId.make("question-second-submit"),
						kind: "session.answerQuestion",
						targetId: second.id,
						submittedAt: 1,
					},
				],
				failedCommands: [
					{
						commandId: CommandId.make("question-first-failed"),
						kind: "session.answerQuestion",
						targetId: first.id,
						failedAt: 2,
						error: "first failed",
						retryable: false,
					},
				],
			}),
		});

		expect(
			presented.interactions.map(({ interaction, submission }) => ({
				id: interaction.id,
				submission,
			})),
		).toEqual([
			{ id: first.id, submission: "failed" },
			{ id: second.id, submission: "submitting" },
		]);
	});
});

describe("background agent activity between parent turns", () => {
	const agent = (id: string) =>
		Message.make({
			id: MessageId.make(id),
			sessionId: AgentSessionId.make("presentation-session"),
			role: "assistant",
			createdAt: new Date(0),
			content: {
				_tag: "tool_use",
				itemId: AgentItemId.make(id),
				tool: "Agent",
				input: {},
				subagent: { childSessionId: id, presentation: "detached" },
			},
		});
	const finished = (id: string) =>
		Message.make({
			id: MessageId.make(`${id}-done`),
			sessionId: AgentSessionId.make("presentation-session"),
			role: "assistant",
			createdAt: new Date(1),
			content: {
				_tag: "subagent_summary",
				itemId: AgentItemId.make(id),
				agentName: "reviewer",
				model: "inherit",
				turns: 1,
				durationMs: 1000,
				summary: "Done",
				isError: false,
			},
		});
	it("keeps unfinished reviewers visible after the parent's reply, then settles each completion", () => {
		const messages = [agent("one"), agent("two"), assistantMessage];
		expect(
			runningBackgroundAgents(view(projection("idle", false, messages))),
		).toEqual([
			{ id: "one", description: "", startedAtMs: 0 },
			{ id: "two", description: "", startedAtMs: 0 },
		]);
		expect(
			countRunningBackgroundAgents(view(projection("idle", false, messages))),
		).toBe(2);
		expect(
			countRunningBackgroundAgents(
				view(projection("idle", false, [...messages, finished("one")])),
			),
		).toBe(1);
		expect(
			countRunningBackgroundAgents(
				view(
					projection("idle", false, [
						...messages,
						finished("one"),
						finished("two"),
					]),
				),
			),
		).toBe(0);
	});
	it("does not treat cached or disconnected history as live activity", () => {
		const data = projection("idle", false, [agent("one")]);
		expect(
			countRunningBackgroundAgents(view(data, { origin: "checkpoint" })),
		).toBe(0);
		expect(
			countRunningBackgroundAgents(view(data, { connection: "offline" })),
		).toBe(0);
	});
	it("does not count an acknowledgement as a background agent's completion", () => {
		const acknowledgement = Message.make({
			id: MessageId.make("ack"),
			sessionId: AgentSessionId.make("presentation-session"),
			role: "assistant",
			createdAt: new Date(1),
			content: {
				_tag: "tool_result",
				itemId: AgentItemId.make("one"),
				output: "Launched",
				isError: false,
			},
		});
		expect(
			countRunningBackgroundAgents(
				view(projection("idle", false, [agent("one"), acknowledgement])),
			),
		).toBe(1);
	});
});

it("shows the known provider failure without a recovery banner or spinner after fresh idle evidence", () => {
	const failed = { ...projection("running", true), status: "error" as const };
	const stale = deriveSessionPresentation({
		view: view({
			...failed,
			runtimeObservation: {
				state: "unavailable",
				observedAt: 30_000,
				attemptId: "attempt-presentation",
				lastProviderActivityAt: null,
			},
		}),
	});
	expect(stale.health).toBe("unavailable");
	const current = deriveSessionPresentation({
		view: view({
			...failed,
			runtimeObservation: {
				state: "idle",
				observedAt: 31_000,
				attemptId: "attempt-presentation",
				lastProviderActivityAt: null,
			},
		}),
	});
	expect(current.runtime).toBe("failed");
	expect(current.health).toBe("healthy");
	expect(current.busy).toBe(false);
	expect(current.turnInFlight).toBe(false);
});

it.each([
	["turn-presentation", "stopping"],
	["previous-goal-turn", "running"],
])("scopes pending interruption of %s to that turn", (expectedTurnId, expectedRuntime) => {
	const pending = {
		commandId: CommandId.make("old-stop-awaiting-receipt"),
		kind: "messages.interrupt",
		targetId: clientCommandTargetId({
			kind: "messages.interrupt",
			payload: { expectedTurnId },
		}),
		submittedAt: 1,
	};
	const presentation = deriveSessionPresentation({
		view: view(projection("running", true), { pendingCommands: [pending] }),
	});
	expect(presentation.runtime).toBe(expectedRuntime);
	expect(pending.targetId).toBe(expectedTurnId);
});

it("presents quiet background execution separately from a stalled foreground agent", () => {
	const data = {
		...projection("running", true),
		executionSteps: [
			{
				id: "background",
				turnId: "turn-presentation",
				attemptId: "attempt-presentation",
				itemId: "launch",
				parentItemId: null,
				kind: "subagent" as const,
				label: "Review",
				status: "running" as const,
				childSessionId: null,
				nativeChildId: "native",
				rootCompletedAt: 1,
				createdAt: 0,
				updatedAt: 1,
				checkpointCapability: "unsupported" as const,
			},
		] as const,
		runtimeObservation: {
			state: "stalled" as const,
			observedAt: 120000,
			attemptId: "attempt-presentation",
			lastProviderActivityAt: 0,
		},
	};
	const background = deriveSessionPresentation({ view: view(data) });
	expect(background).toMatchObject({ backgroundOnly: true, health: "healthy" });
	expect(runningBackgroundAgents(view(data))).toEqual([
		{ id: "launch", description: "Review", startedAtMs: 0 },
	]);
	expect(
		runningBackgroundAgents(
			view({
				...data,
				executionSteps: data.executionSteps.map((step) => ({
					...step,
					status: "completed" as const,
				})),
			}),
		),
	).toEqual([]);
	for (const step of [
		{ ...data.executionSteps[0], rootCompletedAt: null },
		{ ...data.executionSteps[0], attemptId: "older-attempt" },
		{ ...data.executionSteps[0], turnId: "older-turn" },
		{ ...data.executionSteps[0], status: "completed" as const },
	]) {
		expect(
			deriveSessionPresentation({
				view: view({ ...data, executionSteps: [step] }),
			}),
		).toMatchObject({ backgroundOnly: false, health: "stalled" });
	}
	expect(
		deriveSessionPresentation({
			view: view({
				...data,
				runtimeObservation: {
					...data.runtimeObservation,
					state: "unavailable",
				},
			}),
		}).health,
	).toBe("unavailable");
});

it("classifies a durable background shell as a process, separate from the agent count", () => {
	const data = {
		...projection("running", true),
		executionSteps: [
			{
				id: "shell",
				turnId: "turn-presentation",
				attemptId: "attempt-presentation",
				itemId: "shell",
				parentItemId: null,
				kind: "background" as const,
				label: "Watch build",
				status: "running" as const,
				childSessionId: null,
				nativeChildId: "native-shell",
				rootCompletedAt: 1,
				createdAt: 0,
				updatedAt: 1,
				checkpointCapability: "unsupported" as const,
			},
		],
	};
	expect(runningBackgroundTasks(view(data))).toEqual([
		{
			id: "shell",
			taskId: "native-shell",
			kind: "process",
			description: "Watch build",
			startedAtMs: 0,
			turnId: "turn-presentation",
			attemptId: "attempt-presentation",
		},
	]);
	expect(countRunningBackgroundAgents(view(data))).toBe(0);
	expect(
		runningBackgroundTasks(
			view({
				...data,
				executionSteps: data.executionSteps.map((step) => ({
					...step,
					status: "cancelled" as const,
				})),
			}),
		),
	).toEqual([]);
});

it("needs a running execution step to show a background process", () => {
	const shell = Message.make({
		id: MessageId.make("shell-launch"),
		sessionId: AgentSessionId.make("presentation-session"),
		role: "assistant",
		createdAt: new Date(1),
		content: {
			_tag: "tool_use",
			itemId: AgentItemId.make("shell"),
			tool: "Bash",
			input: { description: "Start dev server" },
			backgroundTask: { taskId: "native-shell" },
		},
	});
	const historical = projection("idle", false, [shell]);
	expect(runningBackgroundProcesses(view(historical))).toEqual([]);
	expect(
		runningBackgroundProcesses(
			view({ ...historical, executionStepsTruncated: true }),
		).map((task) => task.description),
	).toEqual(["Start dev server"]);
	expect(
		runningBackgroundProcesses(
			view({
				...projection("running", true, [shell]),
				executionSteps: [
					{
						id: "shell",
						turnId: "turn-presentation",
						attemptId: "attempt-presentation",
						itemId: "shell",
						parentItemId: null,
						kind: "background",
						label: "Bash",
						status: "running",
						childSessionId: null,
						nativeChildId: "native-shell",
						rootCompletedAt: null,
						createdAt: 1,
						updatedAt: 1,
						checkpointCapability: "unsupported",
					},
				],
			}),
		).map((task) => task.description),
	).toEqual(["Start dev server"]);
});

it("lists ended processes, newest first, with their native outcome", () => {
	const at = (ms: number) => new Date(ms);
	const message = (
		id: string,
		ms: number,
		content: Message["content"],
	): Message =>
		Message.make({
			id: MessageId.make(id),
			sessionId: AgentSessionId.make("presentation-session"),
			role: "assistant",
			createdAt: at(ms),
			content,
		});
	const launch = (id: string, ms: number, description: string) =>
		message(`${id}-launch`, ms, {
			_tag: "tool_use",
			itemId: AgentItemId.make(id),
			tool: "Bash",
			input: { description },
			backgroundTask: { taskId: `native-${id}` },
		});
	const data = projection("idle", false, [
		launch("built", 1, "Build docs"),
		message("built-result", 5, {
			_tag: "tool_result",
			itemId: AgentItemId.make("built"),
			output: "done",
			isError: false,
		}),
		launch("server", 2, "Start dev server"),
		message("server-result", 9, {
			_tag: "tool_result",
			itemId: AgentItemId.make("server"),
			output: "Stopped",
			isError: true,
			backgroundOutcome: "stopped",
		}),
		launch("orphan", 3, "Tail logs"),
	]);
	expect(endedBackgroundProcesses(view(data))).toEqual([
		{
			id: "server",
			description: "Start dev server",
			startedAtMs: 2,
			endedAtMs: 9,
			outcome: "stopped",
		},
		{
			id: "built",
			description: "Build docs",
			startedAtMs: 1,
			endedAtMs: 5,
			outcome: "completed",
		},
		{
			id: "orphan",
			description: "Tail logs",
			startedAtMs: 3,
			endedAtMs: null,
			outcome: "stopped",
		},
	]);
});
