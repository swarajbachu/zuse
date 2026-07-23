import { describe, expect, test } from "vitest";

import {
	nextThreadAnchor,
	nextThreadScrollMode,
	shouldFollowTranscript,
	shouldShowLatestAction,
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

	test("releases a sent-message anchor before a detached reader jumps", () => {
		const anchoredTurnId = nextThreadAnchor(null, {
			type: "message-anchored",
			turnId: "turn-2",
		});
		const detachedAnchor = nextThreadAnchor(anchoredTurnId, {
			type: "reader-interacted",
		});

		expect(anchoredTurnId).toBe("turn-2");
		expect(detachedAnchor).toBeNull();
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

	test("only initial and following modes permit content-driven movement", () => {
		expect(shouldFollowTranscript("initial")).toBe(true);
		expect(shouldFollowTranscript("following")).toBe(true);
		expect(shouldFollowTranscript("detached")).toBe(false);
	});
});
