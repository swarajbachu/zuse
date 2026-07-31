import { describe, expect, test } from "vitest";

import { createRendererLagSample } from "../../src/lib/renderer-lag-monitor.ts";

describe("renderer lag classification", () => {
	test("ignores short and background animation gaps", () => {
		expect(
			createRendererLagSample({
				kind: "animation-stall",
				durationMs: 99,
				visible: true,
				now: () => "2026-07-31T00:00:00.000Z",
				id: () => "lag-1",
			}),
		).toBeNull();
		expect(
			createRendererLagSample({
				kind: "animation-stall",
				durationMs: 600,
				visible: false,
				now: () => "2026-07-31T00:00:00.000Z",
				id: () => "lag-2",
			}),
		).toBeNull();
	});

	test("creates a sanitized renderer lag sample at the public threshold", () => {
		expect(
			createRendererLagSample({
				kind: "input-latency",
				durationMs: 250.456,
				visible: true,
				name: "click button#secret",
				now: () => "2026-07-31T00:00:00.000Z",
				id: () => "lag-3",
			}),
		).toEqual({
			id: "lag-3",
			capturedAt: "2026-07-31T00:00:00.000Z",
			kind: "input-latency",
			durationMs: 250.5,
			source: "renderer",
			name: "renderer.input-latency",
		});
	});

	test("retains safe context when detailed browser timing is unavailable", () => {
		expect(
			createRendererLagSample(
				{
					kind: "long-task",
					durationMs: 250,
					visible: true,
					now: () => "2026-07-31T00:00:00.000Z",
					id: () => "lag-4",
				},
				{
					recentActions: ["keyboard.navigate"],
					activeWorkloads: ["agent"],
					relatedOperations: ["rpc:workspace.list"],
				},
			),
		).toMatchObject({
			attribution: {
				cause: "unknown",
				confidence: "low",
				recentActions: ["keyboard.navigate"],
				activeWorkloads: ["agent"],
				relatedOperations: ["rpc:workspace.list"],
			},
		});
	});
});
