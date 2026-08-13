import { makeSessionTimelineCacheEntry } from "@zuse/client-runtime/session-timeline-cache";
import {
	EnvironmentId,
	QueueState,
	type SessionId,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	environmentSessionCacheKey,
	resolveReadingPositionKeysToPrune,
	shouldPersistTimelineCheckpoint,
} from "../../src/lib/session-timeline-cache.ts";

const position = (sessionId: string, updatedAt: number) => ({
	schemaVersion: 1 as const,
	sessionId: sessionId as SessionId,
	userTurnMessageId: `turn-${sessionId}`,
	viewportOffset: 16,
	updatedAt,
});

describe("session timeline reading-position cache", () => {
	it("prunes corrupt and least-recently-updated records", () => {
		expect(
			resolveReadingPositionKeysToPrune(
				[
					position("recent", 30),
					position("oldest", 10),
					{ sessionId: "corrupt", schemaVersion: 99 },
					position("middle", 20),
				],
				2,
			),
		).toEqual(["corrupt", "oldest"]);
	});

	it("treats a negative limit as an empty cache", () => {
		expect(
			resolveReadingPositionKeysToPrune(
				[position("one", 1), position("two", 2)],
				-1,
			),
		).toEqual(["two", "one"]);
	});

	it("namespaces colliding session IDs by environment", () => {
		expect(
			environmentSessionCacheKey({
				environmentId: EnvironmentId.make("local"),
				sessionId: "same" as SessionId,
			}),
		).not.toBe(
			environmentSessionCacheKey({
				environmentId: EnvironmentId.make("remote"),
				sessionId: "same" as SessionId,
			}),
		);
	});

	it("rejects a delayed same-epoch checkpoint but permits an explicit epoch reset", () => {
		const ref = {
			environmentId: EnvironmentId.make("local"),
			sessionId: "same" as SessionId,
		};
		const projection = SessionTimelineProjection.make({
			messages: [],
			status: "idle",
			currentTurn: null,
			queue: QueueState.make({ items: [], paused: false }),
			permissionMode: "default",
			runtimeMode: "approval-required",
		});
		const entry = (epoch: string, version: number) =>
			makeSessionTimelineCacheEntry({
				ref,
				cursor: { epoch, version },
				projection,
				now: version,
			});

		expect(shouldPersistTimelineCheckpoint(entry("a", 8), entry("a", 7))).toBe(
			false,
		);
		expect(shouldPersistTimelineCheckpoint(entry("a", 8), entry("a", 8))).toBe(
			true,
		);
		expect(shouldPersistTimelineCheckpoint(entry("a", 8), entry("b", 1))).toBe(
			true,
		);
	});
});
