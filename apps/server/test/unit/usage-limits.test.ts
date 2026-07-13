import { describe, expect, it } from "vitest";
import { mergePersistedDaily } from "../../src/usage/cost-history.ts";
import { parseClaudeUsagePayload } from "../../src/usage/limits/claude-usage.ts";
import { mapCodexRateLimits } from "../../src/usage/limits/codex-usage.ts";
import {
	geminiPlanLabel,
	mapGeminiQuota,
	projectFromResourceList,
} from "../../src/usage/limits/gemini-usage.ts";
import {
	fetchGrokCreditsWithRetry,
	mapGrokBillingResult,
	parseGrokCreditsResponse,
} from "../../src/usage/limits/grok-usage.ts";
import { mergeUsageLimits } from "../../src/usage/limits/merge.ts";

describe("usage limit normalization", () => {
	it("normalizes Claude windows and discovers model-specific weekly limits", () => {
		const result = parseClaudeUsagePayload(
			{
				five_hour: { utilization: 0.4, resets_at: 1_800_000_000 },
				seven_day_fable: { utilization: 82, resets_at: "2027-01-01T00:00:00Z" },
				extra_usage: { credits_remaining: 12 },
			},
			"2026-01-01T00:00:00Z",
		);
		expect(result.windows).toMatchObject([
			{ scope: "session", usedPercent: 40, windowMinutes: 300 },
			{ label: "Fable only", scope: "model", usedPercent: 82 },
		]);
		expect(result.creditsRemaining).toBe(12);
	});

	it("discovers model-scoped Claude limits from the limits array", () => {
		const result = parseClaudeUsagePayload({
			five_hour: { utilization: 48 },
			seven_day: { utilization: 65 },
			seven_day_fable: null,
			limits: [
				{
					kind: "weekly_scoped",
					group: "weekly",
					percent: 69,
					resets_at: "2026-07-14T22:00:00Z",
					scope: { model: { id: null, display_name: "Fable" } },
				},
			],
		});

		expect(result.windows).toMatchObject([
			{ label: "Session", scope: "session", usedPercent: 48 },
			{ label: "Weekly", scope: "weekly", usedPercent: 65 },
			{ label: "Fable only", scope: "model", usedPercent: 69 },
		]);
	});

	it("maps all Codex buckets and scopes short windows as sessions", () => {
		const result = mapCodexRateLimits({
			rateLimitsByLimitId: {
				one: {
					limitName: "General",
					primary: {
						usedPercent: 25,
						windowDurationMins: 300,
						resetsAt: 1_800_000_000,
					},
					secondary: {
						usedPercent: 50,
						windowDurationMins: 10_080,
						resetsAt: 1_800_000_000,
					},
				},
			},
		});
		expect(result.windows.map((item) => item.scope)).toEqual([
			"session",
			"weekly",
		]);
	});

	it("keeps named model allowances behind the general weekly window", () => {
		const result = mapCodexRateLimits({
			rateLimitsByLimitId: {
				general: {
					limitName: "General",
					secondary: { usedPercent: 15, windowDurationMins: 10_080 },
				},
				model: {
					limitName: "GPT Spark",
					secondary: { usedPercent: 0, windowDurationMins: 10_080 },
				},
			},
		});

		expect(result.windows).toMatchObject([
			{ label: "General", scope: "weekly" },
			{ label: "GPT Spark", scope: "model" },
		]);
	});

	it("keeps weekly usage when Codex omits the session limit and label", () => {
		const result = mapCodexRateLimits({
			rateLimitsByLimitId: {
				codex: {
					limitName: null,
					primary: { usedPercent: 19, windowDurationMins: 10_080 },
					secondary: null,
					planType: "prolite",
				},
			},
		});

		expect(result.windows).toMatchObject([
			{ label: "Weekly", scope: "weekly", usedPercent: 19 },
		]);
		expect(result.planLabel).toBe("prolite");
	});

	it("reads Codex plan and credits from the rate-limit snapshot", () => {
		const result = mapCodexRateLimits({
			rateLimits: {
				planType: "pro",
				credits: { balance: "12.5" },
				primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: null },
				secondary: null,
			},
		});
		expect(result.planLabel).toBe("pro");
		expect(result.creditsRemaining).toBe(12.5);
	});

	it("keeps the lowest Gemini remaining fraction per model family", () => {
		const result = mapGeminiQuota(
			{
				buckets: [
					{ modelId: "gemini-flash", remainingFraction: 0.8 },
					{ modelId: "gemini-flash-2", remainingFraction: 0.25 },
				],
			},
			"Free",
		);
		expect(result.windows[0]?.usedPercent).toBe(75);
	});

	it("discovers a Gemini CLI project from resource manager data", () => {
		expect(
			projectFromResourceList({
				projects: [
					{ projectId: "unrelated" },
					{ projectId: "gen-lang-client-123" },
				],
			}),
		).toBe("gen-lang-client-123");
	});

	it("labels hosted free Gemini accounts as Workspace", () => {
		const payload = Buffer.from(JSON.stringify({ hd: "example.com" })).toString(
			"base64url",
		);
		const token = `header.${payload}.signature`;
		expect(geminiPlanLabel({ currentTier: { id: "free-tier" } }, token)).toBe(
			"Workspace",
		);
	});

	it("lets newer session events replace polled windows", () => {
		const fetched = parseClaudeUsagePayload(
			{ five_hour: { utilization: 10 } },
			"2026-01-01T00:00:00Z",
		);
		const result = mergeUsageLimits(
			[fetched],
			[
				{
					providerId: "claude",
					createdAt: "2026-01-01T00:01:00Z",
					window: {
						id: "event",
						label: "Session",
						scope: "session",
						usedPercent: 20,
						resetsAt: null,
						windowMinutes: 300,
					},
				},
			],
		);
		expect(result[0]?.source).toBe("session-event");
		expect(result[0]?.windows[0]?.usedPercent).toBe(20);
	});

	it("keeps model-specific limits when a generic window is refreshed", () => {
		const fetched = parseClaudeUsagePayload(
			{
				seven_day: { utilization: 35 },
				seven_day_fable: { utilization: 82 },
			},
			"2026-01-01T00:00:00Z",
		);
		const result = mergeUsageLimits(
			[fetched],
			[
				{
					providerId: "claude",
					createdAt: "2026-01-01T00:01:00Z",
					window: {
						id: "weekly-event",
						label: "Weekly",
						scope: "weekly",
						usedPercent: 40,
						resetsAt: null,
						windowMinutes: 10_080,
					},
				},
			],
		);

		expect(result[0]?.windows).toMatchObject([
			{ label: "Fable only", scope: "model", usedPercent: 82 },
			{ label: "Weekly", scope: "weekly", usedPercent: 40 },
		]);
	});

	it("parses nested framed billing values", () => {
		const nested = Uint8Array.from([0x0a, 0x05, 0x0d, 0, 0, 72, 66]);
		const frame = new Uint8Array(5 + nested.length);
		new DataView(frame.buffer).setUint32(1, nested.length);
		frame.set(nested, 5);
		const parsed = parseGrokCreditsResponse(
			frame,
			Date.parse("2026-01-01T00:00:00Z"),
		);
		expect(parsed.usedPercent).toBe(50);
	});

	it("maps CLI billing into a monthly usage window", () => {
		expect(
			mapGrokBillingResult({
				billingCycle: { billingPeriodEnd: "2026-08-01T00:00:00Z" },
				monthlyLimit: { val: 1_000 },
				usage: { totalUsed: { val: 250 } },
			}),
		).toEqual({
			usedPercent: 25,
			resetsAt: "2026-08-01T00:00:00Z",
		});
	});

	it("retries transient Grok billing failures once", async () => {
		let calls = 0;
		const response = await fetchGrokCreditsWithRetry(
			"https://example.test",
			{},
			async () => {
				calls += 1;
				return new Response(null, { status: calls === 1 ? 503 : 200 });
			},
		);
		expect(response.status).toBe(200);
		expect(calls).toBe(2);
	});

	it("fills only daily cost keys that have no live records", () => {
		const rows = [
			{
				day: "2026-01-01",
				source_id: "codex" as const,
				model: "m",
				input_tokens: 10,
				output_tokens: 2,
				cache_read_tokens: 0,
				cache_creation_tokens: 0,
				reasoning_tokens: 0,
				cost_usd: 1,
				cost_status: "known" as const,
				record_count: 1,
			},
		];
		const empty = mergePersistedDaily({ records: [], sources: [] }, rows);
		expect(empty.records[0]?.provenance).toBe("persisted-daily");
		const persisted = empty.records[0];
		expect(persisted).toBeDefined();
		if (persisted === undefined) return;
		const live = {
			...empty,
			records: [{ ...persisted, provenance: "live" }],
		};
		expect(mergePersistedDaily(live, rows).records).toHaveLength(1);
	});
});
