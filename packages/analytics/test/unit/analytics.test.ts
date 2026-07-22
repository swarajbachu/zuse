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
			analytics_schema_version: 1,
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
			const payload = sanitizeAnalyticsProperties("control activated", {
				screen: value,
				control: value,
				interaction_source: "pointer",
			});
			expect(JSON.stringify(payload)).not.toContain(value);
		}
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
	test("counts recent foreground activity and stops at the idle boundary", () => {
		let now = 0;
		const onInterval = vi.fn();
		const tracker = new ActiveTimeTracker({ now: () => now, onInterval });
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

	test("flushes bounded intervals while activity continues", () => {
		let now = 0;
		const onInterval = vi.fn();
		const tracker = new ActiveTimeTracker({
			now: () => now,
			flushAfterMs: 60_000,
			onInterval,
		});
		tracker.foreground();
		now = 30_000;
		tracker.interact();
		now = 60_000;
		tracker.tick();
		expect(onInterval).toHaveBeenCalledWith({
			activeSeconds: 60,
			endedAt: 60_000,
		});
	});
});
