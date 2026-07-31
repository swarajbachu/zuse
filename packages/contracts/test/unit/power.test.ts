import { Schema } from "effect";
import { describe, expect, test } from "vitest";

import { LagSample } from "../../src/power.ts";

const attributedLag = {
	id: "lag-1",
	capturedAt: "2026-07-31T00:00:00.000Z",
	kind: "long-animation-frame",
	durationMs: 200,
	source: "renderer",
	attribution: {
		cause: "script",
		label: "handleSend",
		confidence: "high",
		scriptSource: "chat-view.js",
		recentActions: ["pointer.button"],
		activeWorkloads: ["agent"],
		relatedOperations: ["rpc:chat.create"],
	},
} as const;

describe("LagSample", () => {
	test("accepts bounded sanitized stall attribution", () => {
		expect(Schema.decodeUnknownSync(LagSample)(attributedLag)).toMatchObject(
			attributedLag,
		);
	});

	test("rejects oversized or unsafe renderer attribution at the IPC boundary", () => {
		expect(() =>
			Schema.decodeUnknownSync(LagSample)({
				...attributedLag,
				attribution: {
					...attributedLag.attribution,
					label: "x".repeat(121),
				},
			}),
		).toThrow();
		expect(() =>
			Schema.decodeUnknownSync(LagSample)({
				...attributedLag,
				attribution: {
					...attributedLag.attribution,
					recentActions: ["pointer.button", "prompt=private/value"],
				},
			}),
		).toThrow();
	});
});
