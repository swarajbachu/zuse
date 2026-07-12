import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import {
	InMemoryProjectorStorage,
	ProjectorRunner,
} from "../../../src/engine/projector-runner.js";

type Event = { readonly sequence: number; readonly value: string };

describe("ProjectorRunner", () => {
	test("recovers from the last committed cursor and becomes idempotent at head", async () => {
		const storage = new InMemoryProjectorStorage<Event>([
			{ sequence: 1, value: "one" },
			{ sequence: 2, value: "two" },
			{ sequence: 3, value: "three" },
		]);
		const applied: string[] = [];
		let failAtTwo = true;
		const runner = new ProjectorRunner(storage, {
			name: "messages",
			sequenceOf: (event) => event.sequence,
			apply: (event) =>
				Effect.sync(() => {
					if (event.sequence === 2 && failAtTwo)
						throw new Error("projection failed");
					applied.push(event.value);
				}),
		});

		await expect(Effect.runPromise(runner.catchUp())).rejects.toThrow(
			"projection failed",
		);
		expect(storage.cursorValue("messages")).toBe(1);
		expect(applied).toEqual(["one"]);

		failAtTwo = false;
		await expect(Effect.runPromise(runner.catchUp())).resolves.toBe(3);
		expect(storage.cursorValue("messages")).toBe(3);
		expect(applied).toEqual(["one", "two", "three"]);

		await expect(Effect.runPromise(runner.catchUp())).resolves.toBe(3);
		expect(applied).toEqual(["one", "two", "three"]);
	});
});
