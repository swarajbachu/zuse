import { expect, it } from "vitest";
import { PreviewQueue } from "../../src/html-render/preview-queue.ts";

it("runs two previews, bounds the waiting queue, and releases cancelled waiters", async () => {
	const queue = new PreviewQueue();
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let active = 0;
	let max = 0;
	const work = async () => {
		active++;
		max = Math.max(max, active);
		await gate;
		active--;
		return "ok";
	};
	const signal = new AbortController().signal;
	const running = [queue.run(work, signal), queue.run(work, signal)];
	const controller = new AbortController();
	const cancelled = queue.run(work, controller.signal);
	const waiting = Array.from({ length: 7 }, () => queue.run(work, signal));
	await expect(queue.run(work, signal)).rejects.toThrow("queue is full");
	controller.abort();
	await expect(cancelled).rejects.toThrow();
	waiting.push(queue.run(work, signal));
	release();
	expect(await Promise.all([...running, ...waiting])).toHaveLength(10);
	expect(max).toBe(2);
	await expect(
		queue.run(async () => {
			throw new Error("failed");
		}, signal),
	).rejects.toThrow("failed");
	expect(await queue.run(async () => "next", signal)).toBe("next");
});
