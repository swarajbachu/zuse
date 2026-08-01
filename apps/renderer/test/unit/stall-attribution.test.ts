import { describe, expect, test } from "vitest";

import {
	createFallbackStallAttribution,
	createLongAnimationFrameSample,
	createReactCommitLagSample,
} from "../../src/lib/stall-attribution.ts";
import {
	beginStallOperation,
	getActiveStallOperations,
} from "../../src/lib/stall-context.ts";

const context = {
	recentActions: ["pointer.button", "chat.first-react-commit"],
	activeWorkloads: ["agent", "terminal"],
	relatedOperations: ["rpc:messages.queue.add"],
};

describe("stall attribution", () => {
	test("attributes a long frame to its slowest sanitized script entry point", () => {
		const sample = createLongAnimationFrameSample(
			{
				duration: 640,
				blockingDuration: 520,
				renderStart: 590,
				styleAndLayoutStart: 610,
				scripts: [
					{
						duration: 480,
						forcedStyleAndLayoutDuration: 12,
						invoker: "DOMWindow.onclick",
						invokerType: "event-listener",
						sourceFunctionName: "handleSend",
						sourceURL:
							"https://app.invalid/assets/chat-view.js?token=secret#fragment",
						sourceCharPosition: 4312,
					},
				],
			},
			context,
			{
				now: () => "2026-07-31T00:00:00.000Z",
				id: () => "lag-loaf-1",
			},
		);

		expect(sample).toEqual(
			expect.objectContaining({
				id: "lag-loaf-1",
				kind: "long-animation-frame",
				durationMs: 640,
				attribution: expect.objectContaining({
					cause: "script",
					label: "handleSend",
					confidence: "high",
					blockingDurationMs: 520,
					scriptSource: "chat-view.js",
					scriptFunction: "handleSend",
					recentActions: context.recentActions,
					activeWorkloads: context.activeWorkloads,
					relatedOperations: context.relatedOperations,
				}),
			}),
		);
		expect(sample?.attribution?.scriptSource).not.toContain("secret");
	});

	test("drops inline script URLs instead of persisting their contents", () => {
		const sample = createLongAnimationFrameSample(
			{
				duration: 180,
				scripts: [
					{
						duration: 160,
						sourceFunctionName: "inlineWork",
						sourceURL: "data:text/javascript,secretPrompt%3Dhello",
					},
				],
			},
			{ recentActions: [], activeWorkloads: [], relatedOperations: [] },
		);

		expect(sample?.attribution?.scriptSource).toBeUndefined();
	});

	test("prefers forced style and layout when it dominates the frame", () => {
		const sample = createLongAnimationFrameSample(
			{
				duration: 420,
				blockingDuration: 300,
				renderStart: 180,
				styleAndLayoutStart: 190,
				scripts: [
					{
						duration: 260,
						forcedStyleAndLayoutDuration: 210,
						invoker: "ResizeObserver",
						invokerType: "user-callback",
						sourceFunctionName: "measurePane",
						sourceURL: "file:///Users/private/project/assets/layout.js",
						sourceCharPosition: 100,
					},
				],
			},
			{ recentActions: [], activeWorkloads: [], relatedOperations: [] },
			{
				now: () => "2026-07-31T00:00:00.000Z",
				id: () => "lag-loaf-2",
			},
		);

		expect(sample?.attribution).toEqual(
			expect.objectContaining({
				cause: "style-layout",
				label: "Forced style/layout in measurePane",
				confidence: "high",
				styleLayoutDurationMs: 210,
				scriptSource: "layout.js",
			}),
		);
	});

	test("records only slow React commits with component-safe labels", () => {
		expect(
			createReactCommitLagSample({
				id: "chat.timeline#private",
				phase: "update",
				actualDurationMs: 99,
				baseDurationMs: 500,
				context,
			}),
		).toBeNull();

		expect(
			createReactCommitLagSample({
				id: "chat.timeline#private",
				phase: "update",
				actualDurationMs: 180,
				baseDurationMs: 500,
				context,
				now: () => "2026-07-31T00:00:00.000Z",
				sampleId: () => "lag-react-1",
			}),
		).toEqual(
			expect.objectContaining({
				id: "lag-react-1",
				kind: "react-commit",
				attribution: expect.objectContaining({
					cause: "react-render",
					label: "chat.timeline.private update",
					confidence: "high",
					reactPhase: "update",
					reactBaseDurationMs: 500,
				}),
			}),
		);
	});

	test("tracks only currently active sanitized operations", () => {
		const finishValid = beginStallOperation("rpc:chat.send");
		const finishInvalid = beginStallOperation("rpc:chat.send?prompt=private");
		expect(getActiveStallOperations()).toEqual(["rpc:chat.send", "operation"]);
		finishValid();
		finishInvalid();
		expect(getActiveStallOperations()).toEqual([]);
	});

	test("keeps context when detailed browser attribution is unavailable", () => {
		expect(
			createFallbackStallAttribution("long-task", undefined, {
				recentActions: ["keyboard.navigate"],
				activeWorkloads: ["agent"],
				relatedOperations: ["rpc:session.list"],
			}),
		).toMatchObject({
			cause: "unknown",
			label: "Browser timing unavailable",
			confidence: "low",
			recentActions: ["keyboard.navigate"],
			activeWorkloads: ["agent"],
			relatedOperations: ["rpc:session.list"],
		});
	});
});
