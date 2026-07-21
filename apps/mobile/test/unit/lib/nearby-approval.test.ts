import { describe, expect, test, vi } from "vitest";

import { pollNearbyApproval } from "../../../src/lib/nearby-approval";

describe("nearby approval polling", () => {
	test("waits for each status read before starting the next one", async () => {
		let activeReads = 0;
		let maximumActiveReads = 0;
		const states = ["pending", "pending", "approved"] as const;
		const readStatus = vi.fn(async () => {
			activeReads += 1;
			maximumActiveReads = Math.max(maximumActiveReads, activeReads);
			await Promise.resolve();
			activeReads -= 1;
			const state = states[readStatus.mock.calls.length - 1];
			return state === "approved"
				? { state, credential: { token: "encrypted" } }
				: { state: "pending" as const };
		});

		const result = await pollNearbyApproval({
			readStatus,
			wait: async () => {},
			isCancelled: () => false,
		});

		expect(result?.state).toBe("approved");
		expect(readStatus).toHaveBeenCalledTimes(3);
		expect(maximumActiveReads).toBe(1);
	});

	test("retries a temporary proxy failure without losing approval", async () => {
		const readStatus = vi
			.fn()
			.mockRejectedValueOnce(new Error("proxy busy"))
			.mockResolvedValueOnce({
				state: "approved",
				credential: { token: "encrypted" },
			});
		const onReadError = vi.fn();

		const result = await pollNearbyApproval({
			readStatus,
			wait: async () => {},
			isCancelled: () => false,
			onReadError,
		});

		expect(result?.state).toBe("approved");
		expect(onReadError).toHaveBeenCalledOnce();
	});
});
