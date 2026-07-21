import { describe, expect, test } from "vitest";

import {
	latestTurnAnchorSpace,
	latestTurnTopOffset,
	nextThreadScrollMode,
	shouldFollowTranscript,
	shouldShowLatestAction,
	transcriptBottomInset,
} from "../../../src/lib/thread-scroll";

describe("thread scroll policy", () => {
	test("follows after initial positioning, submission, and an explicit jump", () => {
		expect(
			nextThreadScrollMode("initial", { type: "initial-positioned" }),
		).toBe("following");
		expect(
			nextThreadScrollMode("detached", { type: "message-submitted" }),
		).toBe("following");
		expect(nextThreadScrollMode("detached", { type: "jumped-to-latest" })).toBe(
			"following",
		);
	});

	test("detaches for reader interaction and resumes only at the live edge", () => {
		expect(
			nextThreadScrollMode("following", { type: "reader-interacted" }),
		).toBe("detached");
		expect(
			nextThreadScrollMode("detached", {
				type: "returned-to-live-edge",
				distance: 49,
			}),
		).toBe("detached");
		expect(
			nextThreadScrollMode("detached", {
				type: "returned-to-live-edge",
				distance: 48,
			}),
		).toBe("following");
	});

	test("shows the latest action only for detached offscreen or unseen content", () => {
		expect(
			shouldShowLatestAction({
				mode: "following",
				distance: 200,
				hasUnseenContent: true,
			}),
		).toBe(false);
		expect(
			shouldShowLatestAction({
				mode: "detached",
				distance: 20,
				hasUnseenContent: true,
			}),
		).toBe(true);
		expect(
			shouldShowLatestAction({
				mode: "detached",
				distance: 97,
				hasUnseenContent: false,
			}),
		).toBe(true);
	});

	test("combines composer and keyboard clearance without negative values", () => {
		expect(transcriptBottomInset(72, 310)).toBe(394);
		expect(transcriptBottomInset(-1, -2)).toBe(12);
	});

	test("shrinks anchor space as the latest turn fills the viewport", () => {
		expect(
			latestTurnAnchorSpace({
				viewportHeight: 800,
				bottomInset: 300,
				latestTurnHeight: 120,
				previousContext: 72,
			}),
		).toBe(308);
		expect(
			latestTurnAnchorSpace({
				viewportHeight: 800,
				bottomInset: 300,
				latestTurnHeight: 500,
				previousContext: 72,
			}),
		).toBe(0);
	});

	test("positions the latest user turn directly below the native header", () => {
		expect(latestTurnTopOffset(900, 120, 12)).toBe(768);
		expect(latestTurnTopOffset(80, 120, 12)).toBe(0);
	});

	test("only initial and following modes permit content-driven movement", () => {
		expect(shouldFollowTranscript("initial")).toBe(true);
		expect(shouldFollowTranscript("following")).toBe(true);
		expect(shouldFollowTranscript("detached")).toBe(false);
	});
});
