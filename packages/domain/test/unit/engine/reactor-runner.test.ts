import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import {
	InMemoryReactorStorage,
	type ReactorDispatchInput,
	ReactorRunner,
} from "../../../src/engine/reactor-runner.js";

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
		const dispatch = (input: ReactorDispatchInput<string>) =>
			Effect.sync(() => {
				if (receipts.has(input.commandId)) return;
				if (input.command === "one:second" && failSecondCommand) {
					throw new Error("dispatch failed");
				}
				receipts.add(input.commandId);
				applied.push(input);
			});
		const runner = new ReactorRunner(storage, dispatch, {
			name: "follow-up",
			react: (event) =>
				Effect.succeed([
					{ streamId: "target-1", command: `${event.value}:first` },
					{ streamId: "target-1", command: `${event.value}:second` },
				]),
		});

		await expect(Effect.runPromise(runner.catchUp())).rejects.toThrow(
			"dispatch failed",
		);
		expect(storage.cursorValue("reactor:follow-up")).toBe(0);

		failSecondCommand = false;
		await expect(Effect.runPromise(runner.catchUp())).resolves.toBe(1);
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

		await expect(Effect.runPromise(runner.catchUp())).resolves.toBe(1);
		expect(applied).toHaveLength(2);
	});

	test("dispatches independent events concurrently up to the configured bound", async () => {
		const storage = new InMemoryReactorStorage<Event>(
			Array.from({ length: 6 }, (_, index) => ({
				eventId: `event-${index + 1}`,
				correlationId: `request-${index + 1}`,
				sequence: index + 1,
				value: `${index + 1}`,
			})),
		);
		let active = 0;
		let maximumActive = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const dispatch = () =>
			Effect.promise(async () => {
				active += 1;
				maximumActive = Math.max(maximumActive, active);
				await gate;
				active -= 1;
			});
		const runner = new ReactorRunner(
			storage,
			dispatch,
			{
				name: "bounded",
				react: (event) =>
					Effect.succeed([{ streamId: event.value, command: event.value }]),
			},
			{ dispatchConcurrency: 4 },
		);

		const run = Effect.runPromise(runner.catchUp());
		for (let attempt = 0; attempt < 100 && maximumActive < 4; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		expect(maximumActive).toBe(4);
		release();
		await expect(run).resolves.toBe(6);
		expect(maximumActive).toBe(4);
		expect(storage.cursorValue("reactor:bounded")).toBe(6);
	});

	test("preserves ordering for commands targeting the same stream", async () => {
		const storage = new InMemoryReactorStorage<Event>([
			{
				eventId: "event-1",
				correlationId: "request-1",
				sequence: 1,
				value: "first",
			},
			{
				eventId: "event-2",
				correlationId: "request-2",
				sequence: 2,
				value: "second",
			},
		]);
		const observed: string[] = [];
		let activeForStream = 0;
		let maximumActiveForStream = 0;
		const dispatch = (input: ReactorDispatchInput<string>) =>
			Effect.promise(async () => {
				activeForStream += 1;
				maximumActiveForStream = Math.max(
					maximumActiveForStream,
					activeForStream,
				);
				await new Promise((resolve) => setTimeout(resolve, 5));
				observed.push(input.command);
				activeForStream -= 1;
			});
		const runner = new ReactorRunner(
			storage,
			dispatch,
			{
				name: "per-stream-order",
				react: (event) =>
					Effect.succeed([{ streamId: "same-session", command: event.value }]),
			},
			{ dispatchConcurrency: 4 },
		);

		await Effect.runPromise(runner.catchUp());

		expect(maximumActiveForStream).toBe(1);
		expect(observed).toEqual(["first", "second"]);
	});
});
