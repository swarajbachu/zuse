import { describe, expect, test, vi } from "vitest";

import { ActiveTimeTracker } from "../../src/active-time.ts";
import {
	classifyTool,
	durationBucket,
	inputLengthBucket,
	safeModelId,
	sanitizeAnalyticsProperties,
} from "../../src/events.ts";
import {
	analyticsAccountId,
	createAnonymousAnalyticsId,
} from "../../src/identity.ts";
import { TurnAnalyticsAccumulator } from "../../src/turn-analytics.ts";

describe("analytics privacy contract", () => {
	test("keeps only registered, bounded, non-sensitive properties", () => {
		const properties = sanitizeAnalyticsProperties("message submitted", {
			provider: "claude",
			model: "private-custom-model",
			attachment_count: 2,
			input_length_bucket: "101-500",
			prompt: "secret",
			session_id: "session-secret",
			unknown: "ignored",
		});
		expect(properties).toEqual({
			analytics_schema_version: 2,
			provider: "claude",
			model: "custom",
			attachment_count: 2,
			input_length_bucket: "101-500",
		});
	});

	test("rejects sensitive values even when supplied under allowed keys", () => {
		const seeded = [
			"https://internal.example/secret",
			"/Users/example/private/repository.ts",
			"person@example.com",
		];
		for (const value of seeded) {
			const payload = sanitizeAnalyticsProperties("app error", {
				error_code: value,
				error_fingerprint: value,
				fatal: false,
			});
			expect(JSON.stringify(payload)).not.toContain(value);
		}
	});

	test("keeps only aggregate turn outcome properties", () => {
		expect(
			sanitizeAnalyticsProperties("turn completed", {
				provider: "codex",
				model: "gpt-5.6-sol",
				duration_ms: 42_000,
				input_tokens: 2_000,
				output_tokens: 500,
				tool_count: 1_000,
				tool_failure_count: 2,
				browser_tool_count: 100,
				shell_tool_count: 200,
				fs_tool_count: 300,
				git_tool_count: 100,
				mcp_tool_count: 100,
				subagent_tool_count: 100,
				other_tool_count: 100,
				subagent_failure_count: 1,
				compaction_count: 3,
				tool_name: "secret-tool-name",
			}),
		).toEqual({
			analytics_schema_version: 2,
			provider: "codex",
			model: "gpt-5.6-sol",
			duration_ms: 42_000,
			input_tokens: 2_000,
			output_tokens: 500,
			tool_count: 1_000,
			tool_failure_count: 2,
			browser_tool_count: 100,
			shell_tool_count: 200,
			fs_tool_count: 300,
			git_tool_count: 100,
			mcp_tool_count: 100,
			subagent_tool_count: 100,
			other_tool_count: 100,
			subagent_failure_count: 1,
			compaction_count: 3,
		});
	});

	test("normalizes models and tools without leaking custom identifiers", () => {
		expect(safeModelId("claude", "definitely-private-model")).toBe("custom");
		expect(classifyTool("mcp__browser__navigate")).toBe("browser");
		expect(classifyTool("Bash")).toBe("shell");
		expect(classifyTool("EditFile")).toBe("files");
		expect(classifyTool("Task")).toBe("subagent");
	});

	test("uses stable buckets", () => {
		expect(inputLengthBucket(0)).toBe("empty");
		expect(inputLengthBucket(501)).toBe("501-2000");
		expect(durationBucket(999)).toBe("250-999ms");
	});

	test("hashes account identity and generates scoped anonymous ids", () => {
		expect(analyticsAccountId("user-1")).toBe(analyticsAccountId("user-1"));
		expect(analyticsAccountId("user-1")).not.toContain("user-1");
		expect(createAnonymousAnalyticsId(() => "fixed")).toBe("anonymous_fixed");
	});
});

describe("ActiveTimeTracker", () => {
	test("counts recent foreground activity and flushes on background", () => {
		let now = 0;
		const onInterval = vi.fn();
		const tracker = new ActiveTimeTracker({
			now: () => now,
			onInterval,
		});
		tracker.foreground();
		now = 30_000;
		tracker.tick();
		now = 90_000;
		tracker.tick();
		tracker.background();
		expect(onInterval).toHaveBeenCalledWith({
			activeSeconds: 60,
			endedAt: 90_000,
		});
	});

	test("stops counting at the idle boundary", () => {
		let now = 0;
		const onInterval = vi.fn();
		const tracker = new ActiveTimeTracker({
			now: () => now,
			flushAfterMs: 60_000,
			onInterval,
		});
		tracker.foreground();
		tracker.interact();
		now = 90_000;
		tracker.tick();
		expect(onInterval).toHaveBeenCalledWith({
			activeSeconds: 60,
			endedAt: 90_000,
		});
	});
});

describe("TurnAnalyticsAccumulator", () => {
	test("collapses one thousand tool results into fixed aggregate properties", () => {
		const accumulator = new TurnAnalyticsAccumulator();
		for (let index = 0; index < 1_000; index++) {
			accumulator.recordToolUse(
				`tool-${index}`,
				index % 2 === 0 ? "shell" : "files",
			);
		}
		accumulator.recordToolResult("tool-999", true);
		accumulator.recordToolResult("tool-999", true);
		accumulator.recordToolResult("unknown-tool", true);
		accumulator.recordUsage({
			inputTokens: 2_000,
			outputTokens: 500,
			cacheReadTokens: 100,
			cacheCreationTokens: 50,
		});
		accumulator.recordSubagentResult(true);
		accumulator.recordCompaction();

		expect(accumulator.snapshot()).toEqual({
			input_tokens: 2_000,
			output_tokens: 500,
			cache_read_tokens: 100,
			cache_creation_tokens: 50,
			tool_count: 1_000,
			tool_failure_count: 1,
			browser_tool_count: 0,
			shell_tool_count: 500,
			fs_tool_count: 500,
			git_tool_count: 0,
			mcp_tool_count: 0,
			subagent_tool_count: 0,
			other_tool_count: 0,
			subagent_failure_count: 1,
			compaction_count: 1,
		});
	});
});
