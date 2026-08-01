import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LagSample, PowerSnapshot } from "@zuse/contracts";
import { describe, expect, test } from "vitest";

import { PerformanceHistoryStore } from "../../src/performance-history-store.ts";

const snapshot = (minute: number): PowerSnapshot => ({
	capturedAt: new Date(Date.UTC(2026, 6, 31, 0, minute)).toISOString(),
	powerSource: "ac",
	thermalState: "nominal",
	windowVisible: true,
	processes: [],
	workload: {
		activeAgents: 0,
		activeTerminals: 0,
		browserSessions: 0,
		activeBrowserSessions: 0,
		browserRecordings: 0,
		indexing: false,
	},
	totalCpuPercent: minute,
	totalIdleWakeupsPerSecond: 0,
	totalMemoryBytes: 100,
	memoryKind: "private",
});

describe("PerformanceHistoryStore", () => {
	test("persists one rollup per minute and restores valid history", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-performance-"));
		const path = join(directory, "diagnostics.host-resources.ndjson");
		const store = new PerformanceHistoryStore({
			path,
			now: () => Date.UTC(2026, 6, 31, 1),
		});
		await store.initialize();
		store.recordSnapshot(snapshot(0));
		store.recordSnapshot({ ...snapshot(0), totalCpuPercent: 99 });
		store.recordSnapshot(snapshot(1));
		await store.flush();

		const persisted = (await readFile(path, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { sample: PowerSnapshot });
		expect(persisted).toHaveLength(2);
		expect(persisted[0]?.sample.totalCpuPercent).toBe(99);

		const restored = new PerformanceHistoryStore({
			path,
			now: () => Date.UTC(2026, 6, 31, 2),
		});
		await restored.initialize();
		expect(restored.getHistory(0).samples).toHaveLength(2);
	});

	test("retains lag samples and ignores corrupted lines", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-performance-"));
		const path = join(directory, "diagnostics.host-resources.ndjson");
		const store = new PerformanceHistoryStore({ path });
		await store.initialize();
		const lag: LagSample = {
			id: "lag-1",
			capturedAt: snapshot(0).capturedAt,
			kind: "long-task",
			durationMs: 250,
			source: "renderer",
			attribution: {
				cause: "script",
				label: "handleSend",
				confidence: "high",
				blockingDurationMs: 180,
				scriptFunction: "handleSend",
				scriptSource: "chat-view.js",
				recentActions: ["pointer.button"],
				activeWorkloads: ["agent"],
				relatedOperations: ["rpc:messages.queue.add"],
			},
		};
		store.recordLag(lag);
		await store.flush();

		const restored = new PerformanceHistoryStore({ path });
		await restored.initialize();
		expect(restored.getHistory(0).lagSamples).toEqual([lag]);
	});

	test("rotates bounded files and clears them", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-performance-"));
		const path = join(directory, "diagnostics.host-resources.ndjson");
		const store = new PerformanceHistoryStore({
			path,
			maxFileBytes: 350,
			fileCount: 3,
		});
		await store.initialize();
		for (let minute = 0; minute < 12; minute += 1) {
			store.recordSnapshot(snapshot(minute));
		}
		await store.flush();

		const files = (await readdir(directory)).filter((name) =>
			name.startsWith("diagnostics.host-resources.ndjson"),
		);
		expect(files.length).toBeGreaterThan(1);
		expect(files.length).toBeLessThanOrEqual(3);
		expect(await store.storageBytes()).toBeGreaterThan(0);

		await store.clear();
		expect(await store.storageBytes()).toBe(0);
	});
});
