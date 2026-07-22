import { Result } from "effect";
import { describe, expect, test } from "vitest";
import { decide } from "../../../src/core/decider.js";
import { evolveAll, initialSessionState } from "../../../src/core/state.js";
import {
	createSessionCommand,
	sessionCreation,
} from "../../../src/test/session.js";

const failure = (result: ReturnType<typeof decide>) =>
	Result.isFailure(result) ? result.failure : null;

const created = () =>
	evolveAll(initialSessionState, [
		{
			_tag: "SessionCreated" as const,
			...sessionCreation,
		},
	]);

describe("session decider", () => {
	test("creates a session exactly once", () => {
		const first = decide(initialSessionState, createSessionCommand);
		expect(Result.getOrThrow(first)).toEqual([
			{
				_tag: "SessionCreated",
				...sessionCreation,
			},
		]);
		expect(failure(decide(created(), createSessionCommand))?._tag).toBe(
			"SessionAlreadyExists",
		);
	});

	test("creates a session and its initial turn as one decision", () => {
		const result = decide(initialSessionState, {
			...createSessionCommand,
			_tag: "CreateSessionWithInitialTurn",
			providerStartJson: '{"initialPrompt":"hello"}',
			turnId: "turn-initial",
			messageId: "message-initial",
			messageContentJson: '{"_tag":"user","text":"hello"}',
		});
		expect(Result.getOrThrow(result).map((event) => event._tag)).toEqual([
			"SessionCreated",
			"MessagePersisted",
			"TurnStarted",
		]);
	});

	test("prevents mutation before creation and after deletion", () => {
		expect(
			failure(
				decide(initialSessionState, {
					_tag: "SetTitle",
					title: "Hello",
					updatedAt: 2,
				}),
			)?._tag,
		).toBe("SessionNotFound");

		const deleted = evolveAll(created(), [
			{ _tag: "SessionDeleted", deletedAt: 2 },
		]);
		expect(
			failure(
				decide(deleted, { _tag: "SetTitle", title: "Hello", updatedAt: 3 }),
			)?._tag,
		).toBe("SessionDeletedConflict");
	});

	test("enforces one running turn and settles every open segment with it", () => {
		const running = evolveAll(created(), [
			{ _tag: "TurnStarted", turnId: "turn-1", startedAt: 2 },
			{
				_tag: "SegmentOpened",
				turnId: "turn-1",
				segmentId: "segment-1",
				kind: "assistant",
				openedAt: 3,
			},
			{
				_tag: "SegmentOpened",
				turnId: "turn-1",
				segmentId: "segment-2",
				kind: "tool",
				openedAt: 4,
			},
		]);
		expect(
			failure(
				decide(running, { _tag: "StartTurn", turnId: "turn-2", startedAt: 5 }),
			)?._tag,
		).toBe("TurnAlreadyRunning");

		expect(
			Result.getOrThrow(
				decide(running, {
					_tag: "SettleTurn",
					turnId: "turn-1",
					outcome: "interrupted",
					settledAt: 6,
				}),
			),
		).toEqual([
			{
				_tag: "SegmentSettled",
				turnId: "turn-1",
				segmentId: "segment-1",
				outcome: "interrupted",
				settledAt: 6,
			},
			{
				_tag: "SegmentSettled",
				turnId: "turn-1",
				segmentId: "segment-2",
				outcome: "interrupted",
				settledAt: 6,
			},
			{
				_tag: "TurnSettled",
				turnId: "turn-1",
				outcome: "interrupted",
				settledAt: 6,
			},
			{
				_tag: "SessionStatusSet",
				status: "idle",
				updatedAt: 6,
			},
		]);
	});

	test("requires permission requests to resolve once", () => {
		const pending = evolveAll(created(), [
			{
				_tag: "PermissionRequested",
				requestId: "permission-1",
				turnId: "turn-1",
				payloadJson: "{}",
				requestedAt: 2,
			},
		]);
		expect(
			Result.getOrThrow(
				decide(pending, {
					_tag: "ResolvePermission",
					requestId: "permission-1",
					decision: "deny",
					resolvedAt: 3,
				}),
			)[0]?._tag,
		).toBe("PermissionResolved");

		const resolved = evolveAll(pending, [
			{
				_tag: "PermissionResolved",
				requestId: "permission-1",
				decision: "deny",
				resolvedAt: 3,
			},
		]);
		expect(
			failure(
				decide(resolved, {
					_tag: "ResolvePermission",
					requestId: "permission-1",
					decision: "allow",
					resolvedAt: 4,
				}),
			)?._tag,
		).toBe("PermissionNotPending");
	});

	test("keeps provider attachment idempotent", () => {
		const attached = evolveAll(created(), [
			{ _tag: "ProviderAttached", providerId: "provider-1", attachedAt: 2 },
		]);
		expect(
			Result.getOrThrow(
				decide(attached, {
					_tag: "AttachProvider",
					providerId: "provider-1",
					attachedAt: 4,
				}),
			),
		).toEqual([]);
	});

	test("records queue pause changes idempotently", () => {
		const command = {
			_tag: "SetQueuePaused" as const,
			paused: true,
			updatedAt: 2,
		};
		expect(Result.getOrThrow(decide(created(), command))).toEqual([
			{ _tag: "SessionQueuePausedSet", paused: true, updatedAt: 2 },
		]);
		const paused = evolveAll(created(), [
			{ _tag: "SessionQueuePausedSet", paused: true, updatedAt: 2 },
		]);
		expect(Result.getOrThrow(decide(paused, command))).toEqual([]);
	});

	test("persists exact-turn interrupt intent without settling the turn", () => {
		const running = evolveAll(created(), [
			{ _tag: "TurnStarted", turnId: "turn-1", startedAt: 2 },
		]);
		expect(
			Result.getOrThrow(
				decide(running, {
					_tag: "RequestTurnInterrupt",
					turnId: "turn-1",
					requestedAt: 3,
				}),
			),
		).toEqual([
			{ _tag: "TurnInterruptRequested", turnId: "turn-1", requestedAt: 3 },
		]);
		const requested = evolveAll(running, [
			{ _tag: "TurnInterruptRequested", turnId: "turn-1", requestedAt: 3 },
		]);
		expect(requested.currentTurnId).toBe("turn-1");
		expect(requested.currentTurnPhase).toBe("interrupt-requested");
		expect(
			Result.getOrThrow(
				decide(requested, {
					_tag: "RequestTurnInterrupt",
					turnId: "turn-1",
					requestedAt: 4,
				}),
			),
		).toEqual([]);
	});

	test("rejects stale interrupt and terminal commands", () => {
		const running = evolveAll(created(), [
			{ _tag: "TurnStarted", turnId: "turn-2", startedAt: 2 },
		]);
		expect(
			failure(
				decide(running, {
					_tag: "RequestTurnInterrupt",
					turnId: "turn-1",
					requestedAt: 3,
				}),
			)?._tag,
		).toBe("TurnConflict");
		expect(
			failure(
				decide(running, {
					_tag: "SettleTurn",
					turnId: "turn-1",
					outcome: "completed",
					settledAt: 4,
				}),
			)?._tag,
		).toBe("TurnConflict");
		expect(running.currentTurnId).toBe("turn-2");
	});

	test("atomically claims a queued turn, requests interrupt, and schedules its successor", () => {
		const running = evolveAll(created(), [
			{ _tag: "TurnStarted", turnId: "turn-1", startedAt: 2 },
			{
				_tag: "QueuedTurnEnqueued",
				queueId: "queue-1",
				inputJson: '{"text":"follow up"}',
				position: 0,
				createdAt: 3,
				ready: true,
			},
		]);
		expect(
			Result.getOrThrow(
				decide(running, {
					_tag: "SteerQueuedTurn",
					expectedTurnId: "turn-1",
					queueId: "queue-1",
					successorTurnId: "turn-2",
					requestedAt: 4,
				}),
			),
		).toEqual([
			{ _tag: "QueuedTurnClaimed", queueId: "queue-1", claimedAt: 4 },
			{ _tag: "TurnInterruptRequested", turnId: "turn-1", requestedAt: 4 },
			{
				_tag: "SuccessorTurnScheduled",
				predecessorTurnId: "turn-1",
				turnId: "turn-2",
				queueId: "queue-1",
				inputJson: '{"text":"follow up"}',
				scheduledAt: 4,
			},
		]);
	});

	test("admits a scheduled successor only after its exact predecessor settles", () => {
		const scheduled = evolveAll(created(), [
			{ _tag: "TurnStarted", turnId: "turn-1", startedAt: 2 },
			{
				_tag: "SuccessorTurnScheduled",
				predecessorTurnId: "turn-1",
				turnId: "turn-2",
				queueId: "queue-1",
				inputJson: '{"text":"follow up"}',
				scheduledAt: 3,
			},
		]);

		const events = Result.getOrThrow(
			decide(scheduled, {
				_tag: "SettleTurn",
				turnId: "turn-1",
				outcome: "interrupted",
				settledAt: 4,
			}),
		);
		expect(events.map((event) => event._tag)).toEqual([
			"TurnSettled",
			"SessionStatusSet",
			"ScheduledSuccessorReady",
		]);
		expect(events[1]).toMatchObject({ status: "running" });
	});

	test("starts a steer successor when the expected terminal won the race", () => {
		const settled = evolveAll(created(), [
			{ _tag: "TurnStarted", turnId: "turn-1", startedAt: 2 },
			{
				_tag: "TurnSettled",
				turnId: "turn-1",
				outcome: "completed",
				settledAt: 3,
			},
			{
				_tag: "QueuedTurnEnqueued",
				queueId: "queue-1",
				inputJson: '{"text":"follow up"}',
				position: 0,
				createdAt: 4,
				ready: true,
			},
		]);
		const events = Result.getOrThrow(
			decide(settled, {
				_tag: "SteerQueuedTurn",
				expectedTurnId: "turn-1",
				queueId: "queue-1",
				successorTurnId: "turn-2",
				requestedAt: 5,
			}),
		);
		expect(events.map((event) => event._tag)).toEqual([
			"QueuedTurnClaimed",
			"SuccessorTurnScheduled",
			"ScheduledSuccessorReady",
		]);
	});

	test("commits user message, exact turn, and provider intent together", () => {
		const result = decide(created(), {
			_tag: "SubmitTurn",
			turnId: "turn-1",
			messageId: "message-1",
			role: "user",
			kind: "user",
			contentJson: '{"_tag":"user","text":"hello"}',
			parentItemId: null,
			providerInputJson: '{"text":"hello"}',
			createdAt: 2,
		});
		expect(Result.getOrThrow(result).map((event) => event._tag)).toEqual([
			"MessagePersisted",
			"TurnStarted",
			"SessionStatusSet",
			"ProviderTurnRequested",
		]);
	});
});
