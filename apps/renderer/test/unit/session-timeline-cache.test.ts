import type { SessionId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import { resolveReadingPositionKeysToPrune } from "../../src/lib/session-timeline-cache.ts";

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
});
