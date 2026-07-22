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
});
