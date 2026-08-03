import type { Message, SessionId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import { deriveChatTimelineRows } from "../../src/lib/chat-timeline-rows.ts";
import {
	decodeTimelineReadingPosition,
	encodeTimelineReadingPosition,
	resolveInitialTimelineTarget,
	resolveReadingPositionTarget,
	resolveTimelineReadingPosition,
} from "../../src/lib/timeline-reading-position.ts";

const sessionId = "reading-session" as SessionId;

function userMessage(id: string, text: string): Message {
	return {
		id,
		sessionId,
		role: "user",
		content: { _tag: "user", text },
		createdAt: new Date("2026-08-03T00:00:00.000Z"),
	} as Message;
}

function rows() {
	return deriveChatTimelineRows({
		messages: [
			userMessage("u1", "first"),
			{
				...userMessage("a1", "reply"),
				role: "assistant",
				content: { _tag: "assistant", text: "reply" },
			} as Message,
			userMessage("u2", "second"),
		],
		inFlight: false,
		awaitingPlanApproval: false,
	});
}

describe("timeline reading position", () => {
	it("captures the semantic user turn at the reader's viewport offset", () => {
		const timelineRows = rows();
		const position = resolveTimelineReadingPosition({
			sessionId,
			rows: timelineRows,
			mode: "detached",
			measurement: {
				data: timelineRows,
				scroll: 520,
				scrollLength: 700,
				positionAtIndex: (index) => [0, 180, 480][index],
				sizeAtIndex: (index) => [120, 260, 120][index],
			},
			now: 42,
		});

		expect(position).toEqual({
			schemaVersion: 1,
			sessionId,
			userTurnMessageId: "u2",
			viewportOffset: -40,
			updatedAt: 42,
		});
	});

	it("stores the latest user turn near the top while following", () => {
		const timelineRows = rows();
		const position = resolveTimelineReadingPosition({
			sessionId,
			rows: timelineRows,
			mode: "following",
			measurement: {
				data: timelineRows,
				scroll: 900,
				scrollLength: 700,
				positionAtIndex: (index) => [0, 180, 480][index],
				sizeAtIndex: (index) => [120, 260, 120][index],
			},
			now: 42,
		});

		expect(position?.userTurnMessageId).toBe("u2");
		expect(position?.viewportOffset).toBe(16);
	});

	it("falls back to the latest user turn when a saved message is gone", () => {
		const timelineRows = rows();
		expect(resolveReadingPositionTarget(timelineRows, "deleted")).toEqual({
			index: 2,
			messageId: "u2",
		});
	});

	it("opens an unsaved conversation at its latest meaningful turn", () => {
		expect(
			resolveInitialTimelineTarget({
				rows: rows(),
				position: null,
				recoverAtLiveEdge: false,
			}),
		).toEqual({ index: 2, messageId: "u2", viewportOffset: 16 });
	});

	it("recovers a following transcript at the live edge instead of its saved prompt", () => {
		const position = {
			schemaVersion: 1 as const,
			sessionId,
			userTurnMessageId: "u2",
			viewportOffset: 16,
			updatedAt: 42,
		};

		expect(
			resolveInitialTimelineTarget({
				rows: rows(),
				position,
				recoverAtLiveEdge: true,
			}),
		).toBe(null);
		expect(
			resolveInitialTimelineTarget({
				rows: rows(),
				position,
				recoverAtLiveEdge: false,
			}),
		).toEqual({ index: 2, messageId: "u2", viewportOffset: 16 });
	});

	it("round-trips valid records and rejects corrupt IndexedDB values", () => {
		const value = {
			schemaVersion: 1 as const,
			sessionId,
			userTurnMessageId: "u1",
			viewportOffset: -12,
			updatedAt: 42,
		};

		expect(
			decodeTimelineReadingPosition(encodeTimelineReadingPosition(value)),
		).toEqual(value);
		expect(
			decodeTimelineReadingPosition({
				schemaVersion: 1,
				sessionId,
				userTurnMessageId: "u1",
				viewportOffset: Number.NaN,
				updatedAt: 42,
			}),
		).toBe(null);
	});
});
