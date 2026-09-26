import { describe, expect, it } from "vitest";
import { resolveAwaitingUserAction } from "../../src/components/chat-view.tsx";

describe("chat user-action state", () => {
	it("suppresses misleading working UI for a quarantined durable question", () => {
		expect(
			resolveAwaitingUserAction({
				awaitingPlanApproval: false,
				livePermissionCount: 0,
				durableQuestionCount: 1,
			}),
		).toBe(true);
	});

	it("keeps working visible for normal running activity", () => {
		expect(
			resolveAwaitingUserAction({
				awaitingPlanApproval: false,
				livePermissionCount: 0,
				durableQuestionCount: 0,
			}),
		).toBe(false);
	});
});
