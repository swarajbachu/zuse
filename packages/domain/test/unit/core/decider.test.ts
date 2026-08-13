import { Result } from "effect";
import { describe, expect, test } from "vitest";
import { decide, turnInterruptReceipt } from "../../../src/core/decider.js";
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
	test("allows automatic naming only while the session title is pending", () => {
		let state = created();
		const automatic = Result.getOrThrow(
			decide(state, {
				_tag: "SetTitle",
				title: "Generated session",
				titleProvenance: "automatic",
				updatedAt: 2,
			}),
		);
		state = evolveAll(state, automatic);
		expect(state.titleProvenance).toBe("automatic");
		expect(
			Result.getOrThrow(
				decide(state, {
					_tag: "SetTitle",
					title: "Late title",
					titleProvenance: "automatic",
					updatedAt: 3,
				}),
			),
		).toEqual([]);
	});

	test("manual session titles permanently win over automatic naming", () => {
		let state = created();
		state = evolveAll(
			state,
			Result.getOrThrow(
				decide(state, {
					_tag: "SetTitle",
					title: "Manual session",
					titleProvenance: "manual",
					updatedAt: 2,
				}),
			),
		);
		expect(
			Result.getOrThrow(
				decide(state, {
					_tag: "SetTitle",
					title: "Generated session",
					titleProvenance: "automatic",
					updatedAt: 3,
				}),
			),
		).toEqual([]);
	});

	test("can explicitly re-emit an idempotent worktree projection repair", () => {
		const state = evolveAll(created(), [
			{
				_tag: "SessionWorktreeSet",
				worktreeId: "worktree-1",
				updatedAt: 2,
			},
		]);
		expect(
			Result.getOrThrow(
				decide(state, {
					_tag: "SetWorktree",
					worktreeId: "worktree-1",
					updatedAt: 3,
					forceProjection: true,
				}),
			),
		).toEqual([
			{
				_tag: "SessionWorktreeSet",
				worktreeId: "worktree-1",
				updatedAt: 3,
			},
		]);
	});

	test("treats the provider replay cursor as resume identity", () => {
		const resumed = evolveAll(created(), [
			{
				_tag: "SessionResumeSet",
				cursor: "provider-session",
				resumeStrategy: "grok-session-id",
				providerEventCursor: "event-7",
				updatedAt: 2,
			},
		]);
		expect(
			Result.getOrThrow(
				decide(resumed, {
					_tag: "SetResume",
					cursor: "provider-session",
					resumeStrategy: "grok-session-id",
					providerEventCursor: "event-8",
					updatedAt: 3,
				}),
			),
		).toEqual([
			{
				_tag: "SessionResumeSet",
				cursor: "provider-session",
				resumeStrategy: "grok-session-id",
				providerEventCursor: "event-8",
				updatedAt: 3,
			},
		]);
	});

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
			providerInputJson:
				'{"text":"hello","attachments":[],"fileRefs":[],"skillRefs":[]}',
		});
		expect(Result.getOrThrow(result).map((event) => event._tag)).toEqual([
			"SessionCreated",
			"MessagePersisted",
			"TurnStarted",
			"SessionStatusSet",
			"ProviderTurnRequested",
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
					expectedTurnId: "turn-1",
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
					expectedTurnId: "turn-1",
					requestedAt: 4,
				}),
			),
		).toEqual([]);
	});

	test("treats an interrupt repeated after exact-turn settlement as a no-op", () => {
		const settled = evolveAll(created(), [
			{ _tag: "TurnStarted", turnId: "turn-1", startedAt: 2 },
			{
				_tag: "TurnSettled",
				turnId: "turn-1",
				outcome: "interrupted",
				settledAt: 3,
			},
		]);
		expect(
			Result.getOrThrow(
				decide(settled, {
					_tag: "RequestTurnInterrupt",
					expectedTurnId: "turn-1",
					requestedAt: 4,
				}),
			),
		).toEqual([]);
	});

	test("treats late interrupt outcomes after exact-turn settlement as no-ops", () => {
		const settled = evolveAll(created(), [
			{ _tag: "TurnStarted", turnId: "turn-1", startedAt: 2 },
			{
				_tag: "TurnSettled",
				turnId: "turn-1",
				outcome: "completed",
				settledAt: 3,
			},
		]);
		expect(
			Result.getOrThrow(
				decide(settled, {
					_tag: "AcknowledgeTurnInterrupt",
					turnId: "turn-1",
					acknowledgedAt: 4,
				}),
			),
		).toEqual([]);
		expect(
			Result.getOrThrow(
				decide(settled, {
					_tag: "FailTurnInterrupt",
					turnId: "turn-1",
					reason: "provider already completed",
					failedAt: 4,
				}),
			),
		).toEqual([]);
	});

	test("treats a stale interrupt as a no-op but rejects stale terminal commands", () => {
		const running = evolveAll(created(), [
			{ _tag: "TurnStarted", turnId: "turn-2", startedAt: 2 },
		]);
		expect(
			Result.getOrThrow(
				decide(running, {
					_tag: "RequestTurnInterrupt",
					expectedTurnId: "turn-1",
					requestedAt: 3,
				}),
			),
		).toEqual([]);
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
		expect(turnInterruptReceipt(running, "turn-1")).toEqual({
			_tag: "not-active",
			reason: "turn-mismatch",
			expectedTurnId: "turn-1",
			actualTurnId: "turn-2",
		});
	});

	test("resolves an unfenced interrupt to the current durable turn", () => {
		const running = evolveAll(created(), [
			{ _tag: "TurnStarted", turnId: "turn-current", startedAt: 2 },
		]);
		expect(turnInterruptReceipt(running, undefined)).toEqual({
			_tag: "requested",
			turnId: "turn-current",
		});
		expect(turnInterruptReceipt(created(), "turn-old")).toEqual({
			_tag: "not-active",
			reason: "no-active-turn",
			expectedTurnId: "turn-old",
			actualTurnId: null,
		});
	});

	test("treats terminal interrupt replay for a settled turn as idempotent", () => {
		const running = evolveAll(created(), [
			{ _tag: "TurnStarted", turnId: "turn-1", startedAt: 2 },
			{
				_tag: "TurnSettled",
				turnId: "turn-1",
				outcome: "interrupted",
				settledAt: 3,
			},
			{ _tag: "TurnStarted", turnId: "turn-2", startedAt: 4 },
		]);

		expect(
			Result.getOrThrow(
				decide(running, {
					_tag: "AcknowledgeTurnInterrupt",
					turnId: "turn-1",
					acknowledgedAt: 5,
				}),
			),
		).toEqual([]);
		expect(
			Result.getOrThrow(
				decide(running, {
					_tag: "FailTurnInterrupt",
					turnId: "turn-1",
					reason: "replayed after restart",
					failedAt: 5,
				}),
			),
		).toEqual([]);
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

	test("accepts only monotonic provider checkpoints and seals final content", () => {
		const first = {
			_tag: "PersistMessage" as const,
			messageId: "provider-message-1",
			turnId: "turn-1",
			role: "assistant",
			kind: "assistant",
			contentJson: '{"_tag":"assistant","text":"new"}',
			parentItemId: null,
			checkpointRevision: 2,
			checkpointFinal: false,
			createdAt: 2,
		};
		const accepted = Result.getOrThrow(decide(created(), first));
		expect(accepted).toHaveLength(1);
		const checkpointed = evolveAll(created(), accepted);

		expect(
			Result.getOrThrow(
				decide(checkpointed, {
					...first,
					checkpointRevision: 1,
					contentJson: '{"_tag":"assistant","text":"old"}',
				}),
			),
		).toEqual([]);
		expect(Result.getOrThrow(decide(checkpointed, first))).toEqual([]);
		expect(
			Result.getOrThrow(
				decide(checkpointed, {
					...first,
					checkpointRevision: undefined,
					checkpointFinal: undefined,
					contentJson: '{"_tag":"assistant","text":"unversioned"}',
				}),
			),
		).toEqual([]);

		const final = Result.getOrThrow(
			decide(checkpointed, {
				...first,
				checkpointRevision: 3,
				checkpointFinal: true,
			}),
		);
		expect(final).toHaveLength(1);
		const sealed = evolveAll(checkpointed, final);
		expect(
			Result.getOrThrow(
				decide(sealed, {
					...first,
					checkpointRevision: 4,
					contentJson: '{"_tag":"assistant","text":"regressed"}',
				}),
			),
		).toEqual([]);
		expect(sealed.messageCheckpoints.get(first.messageId)).toEqual({
			revision: 3,
			final: true,
		});
	});

	test("rejects incomplete and non-positive checkpoint metadata", () => {
		const base = {
			_tag: "PersistMessage" as const,
			messageId: "provider-message-1",
			turnId: "turn-1",
			role: "assistant",
			kind: "assistant",
			contentJson: "{}",
			parentItemId: null,
			createdAt: 2,
		};
		expect(
			failure(decide(created(), { ...base, checkpointRevision: 1 }))?._tag,
		).toBe("ValidationFailed");
		expect(
			failure(
				decide(created(), {
					...base,
					checkpointRevision: 0,
					checkpointFinal: false,
				}),
			)?._tag,
		).toBe("ValidationFailed");
	});
});
