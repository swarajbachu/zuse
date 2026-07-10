import { describe, expect, test } from "vitest";
import { evolveAll, initialSessionState } from "../state.js";
import { ingest, settleTruncatedTurn } from "./ingestion.js";

const running = evolveAll(initialSessionState, [
	{
		_tag: "SessionCreated",
		sessionId: "session-1",
		chatId: "chat-1",
		projectId: "project-1",
		createdAt: 1,
	},
	{ _tag: "TurnStarted", turnId: "turn-1", startedAt: 2 },
]);

describe("turn ingestion", () => {
	test("arbitrary stream truncation settles every open segment and the turn", () => {
		const stream = [
			{
				_tag: "SegmentStarted" as const,
				segmentId: "assistant-1",
				kind: "assistant" as const,
				at: 3,
			},
			{
				_tag: "SegmentStarted" as const,
				segmentId: "tool-1",
				kind: "tool" as const,
				at: 4,
			},
			{ _tag: "SegmentFinished" as const, segmentId: "tool-1", at: 5 },
		];

		for (let cut = 0; cut <= stream.length; cut += 1) {
			let state = running;
			for (const event of stream.slice(0, cut)) {
				state = evolveAll(state, ingest(state, "turn-1", event));
			}
			const settled = settleTruncatedTurn(state, "turn-1", "error", 10);
			const final = evolveAll(state, settled);
			expect(final.currentTurnId, `cut=${cut}`).toBeNull();
			expect(final.openSegments.size, `cut=${cut}`).toBe(0);
			expect(settled.at(-1), `cut=${cut}`).toEqual({
				_tag: "TurnSettled",
				turnId: "turn-1",
				outcome: "error",
				settledAt: 10,
			});
		}
	});

	test("normal completion settles open segments as completed", () => {
		const opened = evolveAll(
			running,
			ingest(running, "turn-1", {
				_tag: "SegmentStarted",
				segmentId: "assistant-1",
				kind: "assistant",
				at: 3,
			}),
		);
		expect(settleTruncatedTurn(opened, "turn-1", "completed", 4)).toEqual([
			{
				_tag: "SegmentSettled",
				turnId: "turn-1",
				segmentId: "assistant-1",
				outcome: "completed",
				settledAt: 4,
			},
			{
				_tag: "TurnSettled",
				turnId: "turn-1",
				outcome: "completed",
				settledAt: 4,
			},
		]);
	});
});
