import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	providerIdsForUsagePoll,
	shouldPersistDailyCosts,
} from "../../src/usage/limits/poller.ts";
import {
	loadUsageLimitsCached,
	loadUsageLimitsForPoll,
	resetUsageLimitsCacheForTest,
	setUsageLimitFetcherForTest,
} from "../../src/usage/limits/service.ts";

describe("usage limits poller", () => {
	beforeEach(() => {
		resetUsageLimitsCacheForTest();
	});

	it("skips the Codex probe while a recent session window is available", () => {
		const now = Date.parse("2026-07-13T12:00:00.000Z");
		const providers = providerIdsForUsagePoll(
			[
				{
					providerId: "codex",
					createdAt: "2026-07-13T11:45:00.000Z",
					window: {
						id: "weekly",
						label: "Weekly",
						scope: "weekly",
						usedPercent: 20,
						resetsAt: null,
						windowMinutes: 10_080,
					},
				},
			],
			now,
		);

		expect(providers).toEqual(["claude", "grok", "gemini"]);
	});

	it("suppresses repeated auth failures until a manual refresh", async () => {
		const fetchClaude = vi.fn(async () => ({
			providerId: "claude" as const,
			planLabel: null,
			windows: [],
			creditsRemaining: null,
			fetchedAt: "2026-07-13T12:00:00.000Z",
			source: "api" as const,
			unavailableReason: "no-credentials" as const,
		}));
		setUsageLimitFetcherForTest("claude", fetchClaude);

		await loadUsageLimitsForPoll(["claude"], 0);
		await loadUsageLimitsForPoll(["claude"], 120_000);
		expect(fetchClaude).toHaveBeenCalledTimes(1);

		await loadUsageLimitsCached(true, "claude", 120_000);
		expect(fetchClaude).toHaveBeenCalledTimes(2);
	});

	it("resumes polling after a foreground load sees repaired credentials", async () => {
		setUsageLimitFetcherForTest("claude", async () => ({
			providerId: "claude",
			planLabel: null,
			windows: [],
			creditsRemaining: null,
			fetchedAt: "2026-07-13T12:00:00.000Z",
			source: "api",
			unavailableReason: "no-credentials",
		}));
		await loadUsageLimitsForPoll(["claude"], 0);

		const recovered = vi.fn(async () => ({
			providerId: "claude" as const,
			planLabel: "Pro",
			windows: [],
			creditsRemaining: null,
			fetchedAt: "2026-07-13T12:02:00.000Z",
			source: "api" as const,
		}));
		setUsageLimitFetcherForTest("claude", recovered);
		await loadUsageLimitsCached(false, "claude", 120_000);
		await loadUsageLimitsForPoll(["claude"], 240_000);

		expect(recovered).toHaveBeenCalledTimes(2);
	});

	it("persists daily costs at most once every six hours", () => {
		const sixHours = 6 * 60 * 60 * 1_000;
		expect(shouldPersistDailyCosts(sixHours, 0)).toBe(true);
		expect(shouldPersistDailyCosts(sixHours - 1, 0)).toBe(false);
	});
});
