import {
	AgentTurnId,
	ChatId,
	FolderId,
	Session,
	SessionId,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { effectiveSessionRuntimeState } from "../../src/lib/session-runtime-state.ts";
import {
	resetSessionRuntimeForTest,
	subscribeSessionTerminals,
	useSessionRuntimeStore,
} from "../../src/store/session-runtime.ts";
import { useSessionsStore } from "../../src/store/sessions.ts";

const sessionId = SessionId.make("session-runtime");
const turnId = AgentTurnId.make("turn-runtime");
const projectId = FolderId.make("project-runtime");
const runtimeState = () =>
	effectiveSessionRuntimeState(
		useSessionRuntimeStore.getState().bySession[sessionId],
	);

const projection = (
	status: "booting" | "idle" | "running" | "closed" | "error",
	phase:
		| "requested"
		| "starting"
		| "running"
		| "interrupt-requested"
		| "interrupt-acknowledged"
		| null,
	projectionTurnId = turnId,
) =>
	SessionTimelineProjection.make({
		messages: [],
		status,
		currentTurn: phase === null ? null : { turnId: projectionTurnId, phase },
		queue: { items: [], paused: false },
		permissionMode: "default",
		runtimeMode: "approval-required",
	});

describe("session runtime projector", () => {
	beforeEach(() => {
		useSessionsStore.setState({ sessionsByProject: {} });
		resetSessionRuntimeForTest();
	});

	it("projects every session-catalog writer through the lifecycle seam", () => {
		const session = Session.make({
			id: sessionId,
			projectId,
			title: "New chat",
			titleProvenance: "pending",
			providerId: "codex",
			model: "gpt-5.4",
			status: "booting",
			archivedAt: null,
			cursor: null,
			resumeStrategy: "none",
			runtimeMode: "approval-required",
			worktreeId: null,
			chatId: ChatId.make("chat-runtime"),
			forkedFromSessionId: null,
			forkedFromMessageId: null,
			permissionMode: "default",
			toolSearch: false,
			createdAt: new Date("2026-07-31T00:00:00.000Z"),
			updatedAt: new Date("2026-07-31T00:00:00.000Z"),
		});
		useSessionsStore.setState({
			sessionsByProject: { [projectId]: [session] },
		});
		expect(runtimeState()).toBe("starting");

		useSessionsStore.getState().setSessionStatus(sessionId, "idle");
		expect(runtimeState()).toBe("idle");
	});

	it("batches project summaries and skips unchanged projections", () => {
		let updates = 0;
		const unsubscribe = useSessionRuntimeStore.subscribe(() => {
			updates += 1;
		});
		const secondSessionId = SessionId.make("session-runtime-2");

		useSessionRuntimeStore.getState().observeSummaries([
			{ sessionId, status: "booting" },
			{ sessionId: secondSessionId, status: "idle" },
		]);
		expect(updates).toBe(1);

		useSessionRuntimeStore.getState().observeSummaries([
			{ sessionId, status: "booting" },
			{ sessionId: secondSessionId, status: "idle" },
		]);
		expect(updates).toBe(1);
		unsubscribe();
	});

	it("projects the durable timeline turn phase through one runtime state", () => {
		const runtime = useSessionRuntimeStore.getState();

		runtime.observeTimeline(sessionId, projection("running", "running"), 4);
		expect(runtimeState()).toBe("running");

		runtime.observeTimeline(
			sessionId,
			projection("running", "interrupt-requested"),
			5,
		);
		expect(runtimeState()).toBe("stopping");

		runtime.observeTimeline(sessionId, projection("idle", null), 6);
		expect(runtimeState()).toBe("idle");
	});

	it("rejects stale timeline frames after a terminal projection", () => {
		const runtime = useSessionRuntimeStore.getState();
		runtime.observeTimeline(sessionId, projection("idle", null), 8);
		runtime.observeTimeline(sessionId, projection("running", "running"), 7);

		expect(runtimeState()).toBe("idle");
	});

	it("does not let a project summary override an owned timeline", () => {
		const runtime = useSessionRuntimeStore.getState();
		runtime.observeTimeline(sessionId, projection("idle", null), 8);
		runtime.observeSummary(sessionId, "error");

		expect(runtimeState()).toBe("idle");
	});

	it("does not let a project summary erase an optimistic command", () => {
		const runtime = useSessionRuntimeStore.getState();
		runtime.observeSummary(sessionId, "idle");
		runtime.beginOptimisticTurn(sessionId);
		runtime.observeSummary(sessionId, "error");

		expect(runtimeState()).toBe("starting");
	});

	it("keeps a queued send visible through an initial idle snapshot", () => {
		const runtime = useSessionRuntimeStore.getState();
		runtime.observeTimeline(sessionId, projection("idle", null), 8);
		runtime.beginOptimisticTurn(sessionId);
		runtime.observeTimeline(sessionId, projection("idle", null), 9);

		expect(runtimeState()).toBe("starting");

		runtime.observeTimeline(sessionId, projection("running", "running"), 10);
		expect(runtimeState()).toBe("running");
	});

	it("accepts summaries again after the live timeline releases ownership", () => {
		const runtime = useSessionRuntimeStore.getState();
		runtime.observeTimeline(sessionId, projection("idle", null), 8);
		runtime.releaseTimeline(sessionId);
		runtime.observeSummary(sessionId, "running");

		expect(runtimeState()).toBe("running");
	});

	it("settles optimistic activity when a send fails before durable events", () => {
		const runtime = useSessionRuntimeStore.getState();
		runtime.beginOptimisticTurn(sessionId);
		expect(runtimeState()).toBe("starting");

		runtime.settleOptimisticTurn(sessionId, "failed");
		expect(runtimeState()).toBe("failed");
	});

	it("does not let a late command acknowledgement overwrite a newer timeline", () => {
		const runtime = useSessionRuntimeStore.getState();
		runtime.observeTimeline(sessionId, projection("running", "running"), 4);
		runtime.beginOptimisticStop(sessionId);
		runtime.observeTimeline(sessionId, projection("idle", null), 5);

		runtime.rollbackOptimisticStop(sessionId);
		runtime.settleOptimisticTurn(sessionId, "idle");

		expect(runtimeState()).toBe("idle");
	});

	it("keeps stop intent through a nonterminal timeline frame until acknowledgement", () => {
		const runtime = useSessionRuntimeStore.getState();
		runtime.observeTimeline(sessionId, projection("running", "running"), 4);
		runtime.beginOptimisticStop(sessionId);
		runtime.observeTimeline(
			sessionId,
			projection("running", "interrupt-requested"),
			5,
		);
		expect(runtimeState()).toBe("stopping");

		runtime.settleOptimisticTurn(sessionId, "idle");
		expect(runtimeState()).toBe("idle");
	});

	it("does not let a delayed summary undo a durable command acknowledgement", () => {
		const runtime = useSessionRuntimeStore.getState();
		runtime.beginOptimisticTurn(sessionId);
		runtime.beginOptimisticStop(sessionId);
		runtime.settleOptimisticTurn(sessionId, "idle");
		runtime.observeSummary(sessionId, "running");

		expect(runtimeState()).toBe("idle");
	});

	it("lets a newer durable turn supersede an acknowledged stop", () => {
		const runtime = useSessionRuntimeStore.getState();
		const nextTurnId = AgentTurnId.make("turn-runtime-next");
		runtime.observeTimeline(sessionId, projection("running", "running"), 4);
		runtime.beginOptimisticStop(sessionId);
		runtime.observeTimeline(
			sessionId,
			projection("running", "interrupt-requested"),
			5,
		);
		runtime.settleOptimisticTurn(sessionId, "idle");
		expect(runtimeState()).toBe("idle");

		runtime.observeTimeline(
			sessionId,
			projection("running", "running", nextTurnId),
			6,
		);
		expect(runtimeState()).toBe("running");
	});

	it("lets durable acceptance supersede an ambiguous send failure", () => {
		const runtime = useSessionRuntimeStore.getState();
		runtime.beginOptimisticTurn(sessionId);
		runtime.settleOptimisticTurn(sessionId, "failed");
		expect(runtimeState()).toBe("failed");

		runtime.observeTimeline(sessionId, projection("running", "running"), 1);
		expect(runtimeState()).toBe("running");
	});

	it("falls back to the retained summary when a stream dies mid-command", () => {
		const runtime = useSessionRuntimeStore.getState();
		runtime.observeSummary(sessionId, "idle");
		runtime.observeTimeline(sessionId, projection("running", "running"), 8);
		runtime.beginOptimisticTurn(sessionId);
		expect(runtimeState()).toBe("starting");

		runtime.releaseTimeline(sessionId);
		runtime.observeSummary(sessionId, "idle");

		expect(runtimeState()).toBe("idle");
	});

	it("emits completion only for accepted durable terminal evidence", () => {
		const runtime = useSessionRuntimeStore.getState();
		const completed: SessionId[] = [];
		const unsubscribe = subscribeSessionTerminals((completedSessionId) => {
			completed.push(completedSessionId);
		});

		runtime.observeSummary(sessionId, "running");
		runtime.beginOptimisticTurn(sessionId);
		runtime.settleOptimisticTurn(sessionId, "failed");
		runtime.releaseTimeline(sessionId);
		expect(completed).toEqual([]);

		runtime.observeTimeline(sessionId, projection("running", "running"), 4);
		runtime.observeTimeline(sessionId, projection("idle", null), 5);
		expect(completed).toEqual([sessionId]);

		runtime.releaseTimeline(sessionId);
		runtime.observeSummary(sessionId, "idle");
		expect(completed).toEqual([sessionId]);

		runtime.observeSummary(sessionId, "running");
		runtime.observeSummary(sessionId, "idle");
		expect(completed).toEqual([sessionId, sessionId]);
		unsubscribe();
	});

	it("emits completion when stream release exposes a retained idle summary", () => {
		const runtime = useSessionRuntimeStore.getState();
		const completed: SessionId[] = [];
		const unsubscribe = subscribeSessionTerminals((completedSessionId) => {
			completed.push(completedSessionId);
		});

		runtime.observeTimeline(sessionId, projection("running", "running"), 4);
		runtime.observeSummary(sessionId, "idle");
		expect(completed).toEqual([]);

		runtime.releaseTimeline(sessionId);
		runtime.observeSummary(sessionId, "idle");
		expect(completed).toEqual([sessionId]);
		unsubscribe();
	});

	it("emits once when durable activity fails", () => {
		const runtime = useSessionRuntimeStore.getState();
		const outcomes: Array<"idle" | "failed"> = [];
		const unsubscribe = subscribeSessionTerminals((_sessionId, outcome) => {
			outcomes.push(outcome);
		});

		runtime.beginOptimisticTurn(sessionId);
		runtime.settleOptimisticTurn(sessionId, "failed");
		expect(outcomes).toEqual([]);

		runtime.observeTimeline(sessionId, projection("running", "running"), 4);
		runtime.observeTimeline(sessionId, projection("error", null), 5);
		runtime.observeSummary(sessionId, "error");
		expect(outcomes).toEqual(["failed"]);
		unsubscribe();
	});
});
