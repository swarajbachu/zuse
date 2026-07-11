import { describe, expect, test } from "vitest";

import { OrderedPushBus } from "../../src/push-bus.js";
import { ReadinessBarrier } from "../../src/readiness.js";
import { Reaper } from "../../src/reaper.js";

describe("reliability primitives", () => {
	test("readiness opens once", async () => {
		const barrier = new ReadinessBarrier();
		let opened = 0;
		const waiting = barrier.wait().then(() => {
			opened += 1;
		});
		barrier.open();
		barrier.open();
		await waiting;
		expect(barrier.isReady).toBe(true);
		expect(opened).toBe(1);
	});

	test("push bus preserves publication and listener order", async () => {
		const bus = new OrderedPushBus<number>();
		const seen: string[] = [];
		bus.subscribe(async (event) => {
			await Promise.resolve();
			seen.push(`a:${event}`);
		});
		bus.subscribe((event) => {
			seen.push(`b:${event}`);
		});
		await Promise.all([bus.publish(1), bus.publish(2)]);
		expect(seen).toEqual(["a:1", "b:1", "a:2", "b:2"]);
	});

	test("reaper removes only expired keys", () => {
		const reaper = new Reaper<string>();
		reaper.touch("old", 10);
		reaper.touch("new", 20);
		expect(reaper.reap(10)).toEqual(["old"]);
		expect(reaper.reap(19)).toEqual([]);
		expect(reaper.reap(20)).toEqual(["new"]);
	});
});
