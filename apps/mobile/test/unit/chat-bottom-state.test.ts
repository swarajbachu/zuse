import { describe, expect, it } from "vitest";
import { coordinateChatBottomState } from "../../src/lib/chat-bottom-state";

describe("coordinateChatBottomState", () => {
	it("uses permission, question, plan precedence", () => {
		const question = { itemId: "q", questions: [] };
		const plan = {
			kind: "emulated",
			emulated: { messageId: "m", plan: "P" },
			plan: "P",
			sourceMessageId: "m",
		} as const;
		const permission = { id: "p" } as never;
		expect(
			coordinateChatBottomState({
				permissions: [permission],
				question,
				planReview: plan,
				goal: null,
				serverQueueCount: 1,
				localQueueCount: 2,
				queuePaused: false,
			}).blocking?.kind,
		).toBe("permission");
		expect(
			coordinateChatBottomState({
				permissions: [],
				question,
				planReview: plan,
				goal: null,
				serverQueueCount: 0,
				localQueueCount: 0,
				queuePaused: false,
			}).blocking?.kind,
		).toBe("question");
		expect(
			coordinateChatBottomState({
				permissions: [],
				question: null,
				planReview: plan,
				goal: null,
				serverQueueCount: 1,
				localQueueCount: 2,
				queuePaused: true,
			}),
		).toMatchObject({
			blocking: null,
			planReview: plan,
			queue: { count: 3, paused: true },
		});
	});
});
