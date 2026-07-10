import { describe, expect, test } from "vitest";

import {
	InMemoryReactorStorage,
	type ReactorDispatchInput,
	ReactorRunner,
} from "./reactor-runner.js";

type Event = {
	readonly eventId: string;
	readonly correlationId: string;
	readonly sequence: number;
	readonly value: string;
};

describe("ReactorRunner", () => {
	test("replays from its cursor with deterministic command ids", async () => {
		const storage = new InMemoryReactorStorage<Event>([
			{
				eventId: "event-1",
				correlationId: "request-1",
				sequence: 1,
				value: "one",
			},
		]);
		const applied: ReactorDispatchInput<string>[] = [];
		const receipts = new Set<string>();
		let failSecondCommand = true;
		const dispatch = async (input: ReactorDispatchInput<string>) => {
			if (receipts.has(input.commandId)) return;
			if (input.command === "one:second" && failSecondCommand) {
				throw new Error("dispatch failed");
			}
			receipts.add(input.commandId);
			applied.push(input);
		};
		const runner = new ReactorRunner(storage, dispatch, {
			name: "follow-up",
			react: (event) => [
				{ streamId: "target-1", command: `${event.value}:first` },
				{ streamId: "target-1", command: `${event.value}:second` },
			],
		});

		await expect(runner.catchUp()).rejects.toThrow("dispatch failed");
		expect(storage.cursorValue("reactor:follow-up")).toBe(0);

		failSecondCommand = false;
		await expect(runner.catchUp()).resolves.toBe(1);
		expect(storage.cursorValue("reactor:follow-up")).toBe(1);
		expect(applied).toEqual([
			expect.objectContaining({
				commandId: "reactor:follow-up:event-1:0",
				correlationId: "request-1",
				causationEventId: "event-1",
				command: "one:first",
			}),
			expect.objectContaining({
				commandId: "reactor:follow-up:event-1:1",
				correlationId: "request-1",
				causationEventId: "event-1",
				command: "one:second",
			}),
		]);

		await expect(runner.catchUp()).resolves.toBe(1);
		expect(applied).toHaveLength(2);
	});
});
