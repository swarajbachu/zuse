import { type AgentEvent, AgentItemId } from "@zuse/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	CheckpointFlushScheduler,
	ProviderCheckpointBatcher,
} from "../../../src/kernel/provider-checkpoint-batcher.ts";

const checkpoint = (
	text: string,
	revision: number,
	final = false,
): AgentEvent => ({
	_tag: "AssistantMessage",
	itemId: AgentItemId.make("item-1"),
	text,
	checkpoint: { revision, final },
});

describe("provider checkpoint batching", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("requests a partial flush by the configured deadline", () => {
		vi.useFakeTimers();
		const flush = vi.fn();
		const scheduler = new CheckpointFlushScheduler({
			onFlush: flush,
			intervalMs: 50,
		});

		scheduler.update(1);
		vi.advanceTimersByTime(49);
		expect(flush).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(flush).toHaveBeenCalledOnce();
	});

	it("requests an immediate partial flush at the byte limit", () => {
		vi.useFakeTimers();
		const flush = vi.fn();
		const scheduler = new CheckpointFlushScheduler({
			onFlush: flush,
			maxBytes: 4 * 1024,
		});

		scheduler.update(4 * 1024 - 1);
		expect(flush).not.toHaveBeenCalled();
		scheduler.update(4 * 1024);
		expect(flush).toHaveBeenCalledOnce();
	});

	it("coalesces cumulative partials and publishes the final checkpoint now", () => {
		vi.useFakeTimers();
		const emitted: AgentEvent[] = [];
		const batcher = new ProviderCheckpointBatcher({
			emit: (event) => emitted.push(event),
		});

		batcher.offer(checkpoint("a", 1));
		batcher.offer(checkpoint("absolute", 2));
		expect(emitted).toEqual([]);

		vi.advanceTimersByTime(50);
		expect(emitted).toMatchObject([
			{ text: "absolute", checkpoint: { revision: 2, final: false } },
		]);

		batcher.offer(checkpoint("absolute final", 3, true));
		expect(emitted.at(-1)).toMatchObject({
			text: "absolute final",
			checkpoint: { revision: 3, final: true },
		});
	});

	it("flushes partial text before a later ordering boundary", () => {
		const emitted: AgentEvent[] = [];
		const batcher = new ProviderCheckpointBatcher({
			emit: (event) => emitted.push(event),
		});

		batcher.offer(checkpoint("before tool", 1));
		batcher.offer({
			_tag: "ToolUse",
			itemId: AgentItemId.make("tool-1"),
			tool: "Read",
			input: { file_path: "README.md" },
		});

		expect(emitted.map((event) => event._tag)).toEqual([
			"AssistantMessage",
			"ToolUse",
		]);
	});

	it("flushes a last recovery point before immediate final promotion", () => {
		const emitted: AgentEvent[] = [];
		const batcher = new ProviderCheckpointBatcher({
			emit: (event) => emitted.push(event),
		});

		batcher.offer(checkpoint("partial", 1));
		batcher.offer(checkpoint("complete", 2, true));

		expect(emitted).toMatchObject([
			{ text: "partial", checkpoint: { revision: 1, final: false } },
			{ text: "complete", checkpoint: { revision: 2, final: true } },
		]);
	});

	it("does not let an older pending checkpoint replace a newer one", () => {
		const emitted: AgentEvent[] = [];
		const batcher = new ProviderCheckpointBatcher({
			emit: (event) => emitted.push(event),
		});

		batcher.offer(checkpoint("newest", 3));
		batcher.offer(checkpoint("stale", 2));
		batcher.flush();

		expect(emitted).toMatchObject([
			{ text: "newest", checkpoint: { revision: 3, final: false } },
		]);
	});
});
