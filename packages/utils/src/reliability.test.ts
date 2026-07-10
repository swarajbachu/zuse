import { describe, expect, test } from "vitest";

import { OrderedPushBus } from "./push-bus.js";
import { ReadinessBarrier } from "./readiness.js";
import { Reaper } from "./reaper.js";
import { ConnectionSupervisorState } from "./supervisor.js";

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

	test("supervisor caps backoff and resets after a stable connection", () => {
		const supervisor = new ConnectionSupervisorState();
		expect([0, 1, 2, 3, 4, 5].map((now) => supervisor.failed(now))).toEqual([
			1_000, 2_000, 4_000, 8_000, 16_000, 16_000,
		]);
		supervisor.connected(100);
		expect(supervisor.failed(30_100)).toBe(1_000);
		expect(supervisor.snapshot().attempt).toBe(1);
	});
});
