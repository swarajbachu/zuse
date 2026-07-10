import { Result } from "effect";
import { describe, expect, test } from "vitest";

import { decide } from "./decider.js";
import { evolveAll, initialSessionState } from "./state.js";

const failure = (result: ReturnType<typeof decide>) =>
	Result.isFailure(result) ? result.failure : null;

const created = () =>
	evolveAll(initialSessionState, [
		{
			_tag: "SessionCreated" as const,
			sessionId: "session-1",
			chatId: "chat-1",
			projectId: "project-1",
			createdAt: 1,
		},
	]);

describe("session decider", () => {
	test("creates a session exactly once", () => {
		const first = decide(initialSessionState, {
			_tag: "CreateSession",
			sessionId: "session-1",
			chatId: "chat-1",
			projectId: "project-1",
			createdAt: 1,
		});
		expect(Result.getOrThrow(first)).toEqual([
			{
				_tag: "SessionCreated",
				sessionId: "session-1",
				chatId: "chat-1",
				projectId: "project-1",
				createdAt: 1,
			},
		]);
		expect(
			failure(
				decide(created(), {
					_tag: "CreateSession",
					sessionId: "session-1",
					chatId: "chat-1",
					projectId: "project-1",
					createdAt: 1,
				}),
			)?._tag,
		).toBe("SessionAlreadyExists");
	});

	test("prevents mutation before creation and after deletion", () => {
		expect(
			failure(
				decide(initialSessionState, {
					_tag: "SetTitle",
					title: "Hello",
				}),
			)?._tag,
		).toBe("SessionNotFound");

		const deleted = evolveAll(created(), [
			{ _tag: "SessionDeleted", deletedAt: 2 },
		]);
		expect(
			failure(decide(deleted, { _tag: "SetTitle", title: "Hello" }))?._tag,
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

	test("keeps provider attachment and archive requests idempotent", () => {
		const attached = evolveAll(created(), [
			{ _tag: "ProviderAttached", providerId: "provider-1", attachedAt: 2 },
			{
				_tag: "WorktreeArchiveRequested",
				worktreeId: "worktree-1",
				requestedAt: 3,
			},
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
		expect(
			Result.getOrThrow(
				decide(attached, {
					_tag: "RequestWorktreeArchive",
					worktreeId: "worktree-1",
					requestedAt: 5,
				}),
			),
		).toEqual([]);
	});
});
