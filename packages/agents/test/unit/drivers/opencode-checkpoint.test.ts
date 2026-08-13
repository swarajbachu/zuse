import type { Event as SdkEvent } from "@opencode-ai/sdk";
import { describe, expect, it } from "vitest";

import {
	checkpointOpencodeDeltaState,
	flushOpencodeDeltaState,
	makeOpencodeDeltaState,
	translateOpencodeEvent,
} from "../../../src/drivers/opencode.ts";

const delta = (text: string): SdkEvent =>
	({
		type: "message.part.delta",
		properties: {
			sessionID: "session-1",
			partID: "part-1",
			field: "text",
			delta: text,
		},
	}) as unknown as SdkEvent;

describe("OpenCode durable text checkpoints", () => {
	it("finalizes accumulated deltas under one stable item", () => {
		const state = makeOpencodeDeltaState();
		expect(translateOpencodeEvent(delta("Hello "), "session-1", state)).toEqual(
			[],
		);
		expect(translateOpencodeEvent(delta("world"), "session-1", state)).toEqual(
			[],
		);

		expect(flushOpencodeDeltaState(state)).toMatchObject([
			{
				_tag: "AssistantMessage",
				itemId: "part-1",
				text: "Hello world",
				checkpoint: { revision: 1, final: true },
			},
		]);
		expect(flushOpencodeDeltaState(state)).toEqual([]);
	});

	it("advances absolute partial revisions before finalization", () => {
		const state = makeOpencodeDeltaState();
		translateOpencodeEvent(delta("first"), "session-1", state);
		expect(checkpointOpencodeDeltaState(state)).toMatchObject([
			{
				itemId: "part-1",
				text: "first",
				checkpoint: { revision: 1, final: false },
			},
		]);
		translateOpencodeEvent(delta(" second"), "session-1", state);
		expect(checkpointOpencodeDeltaState(state)).toMatchObject([
			{
				itemId: "part-1",
				text: "first second",
				checkpoint: { revision: 2, final: false },
			},
		]);
		expect(flushOpencodeDeltaState(state)).toMatchObject([
			{
				itemId: "part-1",
				text: "first second",
				checkpoint: { revision: 3, final: true },
			},
		]);
	});

	it("keeps reasoning and assistant provider item ids independent", () => {
		const state = makeOpencodeDeltaState();
		translateOpencodeEvent(
			{
				type: "message.part.delta",
				properties: {
					sessionID: "session-1",
					partID: "reasoning-1",
					field: "reasoning",
					delta: "Check carefully",
				},
			} as unknown as SdkEvent,
			"session-1",
			state,
		);

		expect(flushOpencodeDeltaState(state)).toMatchObject([
			{
				_tag: "Thinking",
				itemId: "reasoning-1",
				text: "Check carefully",
				checkpoint: { revision: 1, final: true },
			},
		]);
	});
});
