import {
	AgentItemId,
	AgentSessionId,
	AgentTurnId,
	CommandId,
	Message,
	MessageId,
	QueueState,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import {
	countRunningBackgroundAgents,
	runningBackgroundAgents,
} from "../../src/background-agent-presentation.ts";
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
		currentTurn: turn
			? { turnId: AgentTurnId.make("turn-presentation"), phase: "running" }
			: null,
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
