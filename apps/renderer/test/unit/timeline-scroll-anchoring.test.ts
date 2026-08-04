import { describe, expect, it } from "vitest";

import {
	resolveScrollableNodeIsAtEnd,
	resolveTimelineHasContentBelowViewport,
} from "../../src/lib/timeline-scroll-anchoring.ts";

describe("timeline scroll anchoring", () => {
	it("detects whether the actual scroll node has left the live edge", () => {
		// 20px from bottom — close, but no longer at the true live edge.
		expect(
			resolveScrollableNodeIsAtEnd({
				scrollTop: 960,
				scrollHeight: 1400,
				clientHeight: 420,
			}),
		).toBe(false);

		// Exactly at bottom — following can resume.
		expect(
			resolveScrollableNodeIsAtEnd({
				scrollTop: 980,
				scrollHeight: 1400,
				clientHeight: 420,
			}),
		).toBe(true);

		// 280px from bottom — meaningfully scrolled away.
		expect(
			resolveScrollableNodeIsAtEnd({
				scrollTop: 700,
				scrollHeight: 1400,
				clientHeight: 420,
			}),
		).toBe(false);

		expect(resolveScrollableNodeIsAtEnd(null)).toBeUndefined();
	});

	it("detects anchored content hidden below the readable viewport", () => {
		const state = {
			data: [0, 1],
			scroll: 300,
			scrollLength: 700,
			positionAtIndex: (index: number) => [0, 900][index],
			sizeAtIndex: (index: number) => [800, 240][index],
		};

		expect(resolveTimelineHasContentBelowViewport(state, 120)).toBe(true);
		expect(
			resolveTimelineHasContentBelowViewport(
				{
					...state,
					positionAtIndex: (index) => [0, 800][index],
					sizeAtIndex: (index) => [800, 60][index],
				},
				120,
			),
		).toBe(false);
	});
});
