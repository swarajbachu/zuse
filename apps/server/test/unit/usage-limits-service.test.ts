import type { ProviderUsageLimits } from "@zuse/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	invalidateUsageLimits,
	loadUsageLimitsCached,
	loadUsageLimitsForPoll,
	resetUsageLimitsCacheForTest,
	setUsageLimitFetcherForTest,
	USAGE_FETCH_TIMEOUT_MS,
} from "../../src/usage/limits/service.ts";

const reading = (
	providerId: ProviderUsageLimits["providerId"] = "claude",
): ProviderUsageLimits => ({
	providerId,
	planLabel: "Pro",
	windows: [
		{
			id: "five_hour",
			label: "Session",
			scope: "session",
			usedPercent: 0.5,
			resetsAt: null,
			windowMinutes: 300,
		},
	],
	creditsRemaining: null,
	fetchedAt: "2026-10-03T12:00:00.000Z",
	source: "api",
});
describe("isolated usage reads", () => {
	beforeEach(() => {
		resetUsageLimitsCacheForTest();
		for (const id of ["claude", "codex", "grok", "gemini", "kiro"] as const)
			setUsageLimitFetcherForTest(id, async () => reading(id));
	});
	afterEach(() => vi.useRealTimers());
	it("keeps healthy providers when another throws or rejects", async () => {
		setUsageLimitFetcherForTest("kiro", () => {
			throw new Error("private diagnostic");
		});
		setUsageLimitFetcherForTest("grok", async () => {
			throw new Error("private diagnostic");
		});
		const values = await loadUsageLimitsCached(true);
		expect(values).toHaveLength(5);
		expect(
			values.find((p) => p.providerId === "claude")?.windows[0]?.usedPercent,
		).toBe(0.5);
		expect(values.find((p) => p.providerId === "kiro")?.unavailableReason).toBe(
			"error",
		);
		expect(JSON.stringify(values)).not.toContain("private diagnostic");
	});
	it("isolates malformed results", async () => {
		setUsageLimitFetcherForTest("kiro", async () =>
			JSON.parse('{"windows":null}'),
		);
		const values = await loadUsageLimitsCached(true);
		expect(values.find((p) => p.providerId === "kiro")?.unavailableReason).toBe(
			"invalid-response",
		);
		expect(values.find((p) => p.providerId === "codex")?.windows).toHaveLength(
			1,
		);
	});
	it("bounds a hung provider and aborts its work", async () => {
		vi.useFakeTimers();
		const aborted = vi.fn();
		setUsageLimitFetcherForTest(
			"kiro",
			(signal) =>
				new Promise(() => {
					signal.addEventListener("abort", aborted);
				}),
		);
		const pending = loadUsageLimitsCached(true);
		await vi.advanceTimersByTimeAsync(USAGE_FETCH_TIMEOUT_MS);
		expect(
			(await pending).find((p) => p.providerId === "kiro")?.unavailableReason,
		).toBe("timeout");
		expect(aborted).toHaveBeenCalledOnce();
	});
	it("keeps the original timestamp on transient failure", async () => {
		await loadUsageLimitsCached(false, "claude", 0);
		setUsageLimitFetcherForTest("claude", async () => {
			throw new Error("offline");
		});
		expect((await loadUsageLimitsCached(true, "claude", 60_000))[0]).toEqual({
			...reading(),
			source: "cache",
			unavailableReason: "error",
		});
	});
	it("retries auth failures after a bounded delay", async () => {
		const fetcher = vi.fn(async () => ({
			...reading(),
			windows: [],
			unavailableReason: "expired" as const,
		}));
		setUsageLimitFetcherForTest("claude", fetcher);
		await loadUsageLimitsForPoll(["claude"], 0);
		await loadUsageLimitsForPoll(["claude"], 120_000);
		expect(fetcher).toHaveBeenCalledOnce();
		await loadUsageLimitsForPoll(["claude"], 300_000);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
	it("deduplicates forced reads and discards invalidated account data", async () => {
		let resolve!: (value: ProviderUsageLimits) => void;
		const fetcher = vi.fn(
			() =>
				new Promise<ProviderUsageLimits>((done) => {
					resolve = done;
				}),
		);
		setUsageLimitFetcherForTest("claude", fetcher);
		const a = loadUsageLimitsCached(true, "claude");
		const b = loadUsageLimitsCached(true, "claude");
		await Promise.resolve();
		expect(fetcher).toHaveBeenCalledOnce();
		invalidateUsageLimits("claude");
		resolve(reading());
		expect((await a)[0]?.windows).toEqual([]);
		await b;
		setUsageLimitFetcherForTest("claude", async () => {
			throw new Error("offline");
		});
		expect((await loadUsageLimitsCached(true, "claude"))[0]?.windows).toEqual(
			[],
		);
	});
});
