import { describe, expect, test } from "vitest";

import {
	nextThreadAnchor,
	nextThreadEndIntent,
	nextThreadScrollMode,
	pendingThreadScrollCommand,
	sendAnchorSpace,
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
		expect(
			nextThreadEndIntent(null, {
				type: "jumped-to-latest",
			}),
		).toBe("jump");
	});

	test("keeps end-scroll intents across provisional FlatList measurements", () => {
		let initialIntent = nextThreadEndIntent(null, {
			type: "open-at-latest",
		});
		initialIntent = nextThreadEndIntent(initialIntent, {
			type: "scroll-attempted",
		});
		initialIntent = nextThreadEndIntent(initialIntent, {
			type: "scroll-positioned",
			distance: 0,
		});
		expect(initialIntent).toBe("initial");
		initialIntent = nextThreadEndIntent(initialIntent, {
			type: "scroll-positioned",
			distance: 240,
		});
		expect(initialIntent).toBe("initial");
		expect(
			nextThreadEndIntent(initialIntent, { type: "reader-interacted" }),
		).toBeNull();

		let jumpIntent = nextThreadEndIntent(null, {
			type: "jumped-to-latest",
		});
		jumpIntent = nextThreadEndIntent(jumpIntent, {
			type: "scroll-attempted",
		});
		expect(jumpIntent).toBe("jump");
		expect(
			nextThreadEndIntent(jumpIntent, {
				type: "reader-interacted",
			}),
		).toBeNull();
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

	test("reserves one anchored viewport independent of turn height", () => {
		expect(
			sendAnchorSpace({
				viewportHeight: 800,
				headerOffset: 110,
				bottomInset: 300,
			}),
		).toBe(390);
	});

	test("clamps anchor space to zero when chrome exceeds the viewport", () => {
		expect(
			sendAnchorSpace({
				viewportHeight: 400,
				headerOffset: 110,
				bottomInset: 340,
			}),
		).toBe(0);
	});

	test("ignores negative measurements while the layout settles", () => {
		expect(
			sendAnchorSpace({
				viewportHeight: 800,
				headerOffset: -20,
				bottomInset: -40,
			}),
		).toBe(800);
	});

	test("only initial and following modes permit content-driven movement", () => {
		expect(shouldFollowTranscript("initial")).toBe(true);
		expect(shouldFollowTranscript("following")).toBe(true);
		expect(shouldFollowTranscript("detached")).toBe(false);
	});

	test("waits for footer layout before issuing a send anchor", () => {
		expect(
			pendingThreadScrollCommand({
				pendingSendAnchor: true,
				anchorActive: false,
			}),
		).toBeNull();
		expect(
			pendingThreadScrollCommand({
				pendingSendAnchor: true,
				anchorActive: true,
			}),
		).toBe("send-anchor");
	});
});
