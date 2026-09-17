import { afterEach, expect, it, vi } from "vitest";
import { BackgroundHistory } from "../../src/background-history";

afterEach(() => vi.useRealTimers());
it("limits concurrency, prioritizes selection, yields and cancels queued work", async () => {
	vi.useFakeTimers();
	const scheduler = new BackgroundHistory(2);
	const order: string[] = [];
	const resolve: Array<(more: boolean) => void> = [];
	const run = (id: string) => () => {
		order.push(id);
		return new Promise<boolean>((done) => resolve.push(done));
	};
	scheduler.retain("background", run("background"));
	scheduler.retain("selected", run("selected"), () => 10);
	const cancel = scheduler.retain("cancelled", run("cancelled"));
	cancel();
	await vi.advanceTimersByTimeAsync(16);
	expect(order).toEqual(["selected", "background"]);
	resolve[0]?.(true);
	await vi.advanceTimersByTimeAsync(16);
	expect(order).toEqual(["selected", "background", "selected"]);
	resolve[1]?.(false);
	resolve[2]?.(false);
	await vi.runAllTimersAsync();
	expect(scheduler.status("selected")).toBe("idle");
	expect(vi.getTimerCount()).toBe(0);
});
it("shares a job and retries failures without dropping other retained readers", async () => {
	vi.useFakeTimers();
	const scheduler = new BackgroundHistory();
	const run = vi.fn().mockRejectedValue(new Error("offline"));
	const release = scheduler.retain("chat", run);
	scheduler.retain("chat", run);
	release();
	await vi.runAllTimersAsync();
	expect(run).toHaveBeenCalledTimes(4);
	expect(scheduler.status("chat")).toBe("failed");
	run.mockResolvedValue(false);
	scheduler.retry("chat");
	await vi.runAllTimersAsync();
	expect(scheduler.status("chat")).toBe("idle");
});
