import { deriveSessionPresentation } from "@zuse/client-runtime/session-presentation";
import {
	AgentItemId,
	EnvironmentId,
	Message,
	MessageId,
	QueueState,
	SessionId,
	SessionNotFoundError,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { Effect, Queue, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { getActiveEnvironment } from "../../src/lib/rpc-client.ts";
import {
	getRendererClientBus,
	resetSessionTimelineClientBusForTest,
	retainSessionTimeline,
	setSessionTimelineRpcClientForTest,
} from "../../src/lib/session-timeline-client-bus.ts";
import { useSessionsStore } from "../../src/store/sessions.ts";

const waitUntil = async (predicate: () => boolean): Promise<void> => {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("condition was not reached");
};

const sessionId = SessionId.make("question-answer-recovery-session");
const itemId = AgentItemId.make("question-answer-recovery-item");
const answers = [{ questionIndex: 0, selected: [0] }] as const;
const question = {
	_tag: "Question" as const,
	id: itemId,
	questions: [{ question: "Keep the changes?", options: ["Keep", "Discard"] }],
	requestedAt: new Date("2026-08-24T00:00:00.000Z"),
};
const initialSessionsState = useSessionsStore.getInitialState();

const snapshot = () =>
	SessionTimelineProjection.make({
		messages: [],
		status: "running",
		currentTurn: null,
		queue: QueueState.make({ items: [], paused: false }),
		permissionMode: "default",
		runtimeMode: "approval-required",
		interactions: [question],
	});

describe("question answer recovery", () => {
	afterEach(() => {
		useSessionsStore.setState(initialSessionsState, true);
		resetSessionTimelineClientBusForTest();
	});

	it("keeps the durable question through rejection and successful retry until the answer event", async () => {
		const environmentId = EnvironmentId.make(getActiveEnvironment());
		const frames = Effect.runSync(Queue.unbounded());
		let attempts = 0;
		let releaseRetry!: () => void;
		const retryGate = new Promise<void>((resolve) => {
			releaseRetry = resolve;
		});
		setSessionTimelineRpcClientForTest(
			async () =>
				({
					"session.events": () => Stream.fromQueue(frames),
					"session.answerQuestion": () => {
						attempts += 1;
						return attempts === 1
							? Effect.fail(new SessionNotFoundError({ sessionId }))
							: Effect.promise(() => retryGate);
					},
				}) as never,
		);
		const retained = retainSessionTimeline(
			{ environmentId, sessionId },
			"connect",
		);
		Queue.offerUnsafe(frames, {
			kind: "snapshot",
			sessionId,
			throughVersion: 0,
			cursor: { epoch: "question-answer", version: 0 },
			projection: snapshot(),
		});
		await waitUntil(
			() =>
				getRendererClientBus().snapshot(retained.key).data?.interactions
					.length === 1,
		);

		await expect(
			useSessionsStore.getState().answerQuestion(sessionId, itemId, answers),
		).rejects.toBeInstanceOf(SessionNotFoundError);
		let presentation = deriveSessionPresentation({
			view: getRendererClientBus().snapshot(retained.key),
		});
		expect(presentation.interactions).toMatchObject([
			{ interaction: { id: itemId }, submission: "failed" },
		]);

		const retry = useSessionsStore
			.getState()
			.answerQuestion(sessionId, itemId, answers);
		await waitUntil(() => attempts === 2);
		presentation = deriveSessionPresentation({
			view: getRendererClientBus().snapshot(retained.key),
		});
		expect(presentation.interactions).toHaveLength(1);
		expect(presentation.interactions[0]?.submission).toBe("submitting");
		releaseRetry();
		await retry;

		presentation = deriveSessionPresentation({
			view: getRendererClientBus().snapshot(retained.key),
		});
		expect(presentation.interactions).toHaveLength(1);
		Queue.offerUnsafe(frames, {
			kind: "event",
			eventId: "question-answer-event",
			sessionId,
			streamVersion: 1,
			cursor: { epoch: "question-answer", version: 1 },
			event: {
				_tag: "MessagePersisted",
				message: Message.make({
					id: MessageId.make("question-answer-message"),
					sessionId,
					role: "user",
					content: { _tag: "user_question_answer", itemId, answers },
					createdAt: new Date("2026-08-24T00:00:01.000Z"),
				}),
			},
		});
		await waitUntil(
			() =>
				deriveSessionPresentation({
					view: getRendererClientBus().snapshot(retained.key),
				}).interactions.length === 0,
		);
		expect(attempts).toBe(2);
		retained.lease.release();
	});

	it("retains an ambiguous transport failure for idempotent replay", async () => {
		const environmentId = EnvironmentId.make(getActiveEnvironment());
		const frames = Effect.runSync(Queue.unbounded());
		setSessionTimelineRpcClientForTest(
			async () =>
				({
					"session.events": () => Stream.fromQueue(frames),
					"session.answerQuestion": () =>
						Effect.fail({
							_tag: "RpcClientError",
							reason: { _tag: "SocketError", message: "lost response" },
						}),
				}) as never,
		);
		const retained = retainSessionTimeline(
			{ environmentId, sessionId },
			"connect",
		);
		Queue.offerUnsafe(frames, {
			kind: "snapshot",
			sessionId,
			throughVersion: 0,
			cursor: { epoch: "question-answer-transport", version: 0 },
			projection: snapshot(),
		});
		await waitUntil(
			() => getRendererClientBus().snapshot(retained.key).data !== null,
		);

		await expect(
			useSessionsStore.getState().answerQuestion(sessionId, itemId, answers),
		).rejects.toMatchObject({ _tag: "RpcClientError" });
		expect(
			getRendererClientBus().snapshot(retained.key).failedCommands,
		).toEqual([
			expect.objectContaining({
				kind: "session.answerQuestion",
				targetId: itemId,
				retryable: true,
			}),
		]);
		retained.lease.release();
	});

	it("cancels through its dedicated safe command without submitting empty answers", async () => {
		const environmentId = EnvironmentId.make(getActiveEnvironment());
		const frames = Effect.runSync(Queue.unbounded());
		let cancelAttempts = 0;
		let answerAttempts = 0;
		setSessionTimelineRpcClientForTest(
			async () =>
				({
					"session.events": () => Stream.fromQueue(frames),
					"session.answerQuestion": () => {
						answerAttempts += 1;
						return Effect.void;
					},
					"session.cancelQuestion": () => {
						cancelAttempts += 1;
						return Effect.fail({
							_tag: "RpcClientError",
							reason: { _tag: "SocketError", message: "lost acknowledgement" },
						});
					},
				}) as never,
		);
		const retained = retainSessionTimeline(
			{ environmentId, sessionId },
			"connect",
		);
		Queue.offerUnsafe(frames, {
			kind: "snapshot",
			sessionId,
			throughVersion: 0,
			cursor: { epoch: "question-cancel-transport", version: 0 },
			projection: snapshot(),
		});
		await waitUntil(
			() => getRendererClientBus().snapshot(retained.key).data !== null,
		);

		await expect(
			useSessionsStore.getState().cancelQuestion(sessionId, itemId),
		).rejects.toMatchObject({ _tag: "RpcClientError" });
		expect({ cancelAttempts, answerAttempts }).toEqual({
			cancelAttempts: 1,
			answerAttempts: 0,
		});
		expect(
			getRendererClientBus().snapshot(retained.key).failedCommands,
		).toEqual([
			expect.objectContaining({
				kind: "session.cancelQuestion",
				targetId: itemId,
				retryable: true,
			}),
		]);
		retained.lease.release();
	});
});
