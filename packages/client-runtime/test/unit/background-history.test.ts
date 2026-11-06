import { afterEach, expect, it, vi } from "vitest";
import {
	BackgroundHistory,
	retainSessionHistory,
} from "../../src/background-history";

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

it("waits for a recent head, supports dormant reads, and aborts on release", async () => {
	vi.useFakeTimers();
	const { retainSessionHistory } = await import("../../src/background-history");
	let notify = () => {};
	const view = {
		origin: "cache",
		sync: "synchronizing",
		connection: "connecting",
		data: { olderMessageSequence: 100 },
	};
	const bus = {
		snapshot: () => view,
		subscribe: (_key: unknown, cb: () => void) => {
			notify = cb;
			return () => {
				notify = () => {};
			};
		},
	} as unknown as import("../../src/client-bus").ClientBus<unknown>;
	let signal: AbortSignal | undefined;
	const load = vi.fn((s: AbortSignal) => {
		signal = s;
		return new Promise<never>(() => {});
	});
	const release = retainSessionHistory({
		bus,
		ref: { environmentId: "cloud" as never, sessionId: "session" as never },
		scheduler: new BackgroundHistory(2),
		load,
	});
	await vi.advanceTimersByTimeAsync(20);
	expect(load).not.toHaveBeenCalled();
	view.origin = "remote";
	notify();
	await vi.advanceTimersByTimeAsync(20);
	expect(load).not.toHaveBeenCalled();
	view.connection = "dormant";
	notify();
	expect(load).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(16);
	expect(load).toHaveBeenCalledTimes(1);
	release();
	expect(signal?.aborted).toBe(true);
	notify();
	await vi.advanceTimersByTimeAsync(50);
	expect(load).toHaveBeenCalledTimes(1);
});

it.each([
	"failed",
	"queued",
	"running",
] as const)("clears a %s history job when a fresh head contains the full transcript", async (state) => {
	vi.useFakeTimers();
	let notify = () => {};
	const view = {
		origin: "remote",
		sync: "live",
		connection: "connected",
		data: { olderMessageSequence: 100 as number | null },
	};
	const bus = {
		snapshot: () => view,
		subscribe: (_key: unknown, cb: () => void) => {
			notify = cb;
			return () => {};
		},
	} as unknown as import("../../src/client-bus").ClientBus<unknown>;
	const scheduler = new BackgroundHistory();
	const ref = {
		environmentId: "cloud" as never,
		sessionId: "session" as never,
	};
	const { makeResourceKey, resourceKeyId } = await import(
		"../../src/resource-ref"
	);
	const id = resourceKeyId(makeResourceKey("session-timeline", ref));
	let signal: AbortSignal | undefined;
	const load = vi.fn((s: AbortSignal) => {
		signal = s;
		return state === "failed"
			? Promise.reject(new Error("offline"))
			: new Promise<never>(() => {});
	});
	const release = retainSessionHistory({ bus, ref, scheduler, load });
	if (state === "failed") await vi.runAllTimersAsync();
	else if (state === "running") await vi.advanceTimersByTimeAsync(16);
	expect(scheduler.status(id)).toBe(state === "failed" ? "failed" : "loading");
	view.data.olderMessageSequence = null;
	notify();
	expect(scheduler.status(id)).toBe("idle");
	if (state === "queued") expect(load).not.toHaveBeenCalled();
	else expect(signal?.aborted).toBe(true);
	release();
});

const historyHarness = () => {
	const listeners = new Set<() => void>();
	const view = {
		origin: "runtime",
		sync: "live",
		connection: "connected",
		generation: 1,
		cursor: { epoch: "first", version: 1 },
		data: { olderMessageSequence: 100 as number | null },
	};
	const bus = {
		snapshot: () => view,
		subscribe: (_key: unknown, listener: () => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	} as unknown as import("../../src/client-bus").ClientBus<unknown>;
	return {
		bus,
		scheduler: new BackgroundHistory(),
		ref: { environmentId: "cloud" as never, sessionId: "session" as never },
		view,
		notify: () => {
			for (const listener of listeners) listener();
		},
	};
};

it.each([
	"generation",
	"epoch",
] as const)("replaces failed history on a new %s while sharing work across readers", async (changed) => {
	vi.useFakeTimers();
	const h = historyHarness();
	const load = vi.fn((_signal: AbortSignal) =>
		Promise.reject(new Error("offline")),
	);
	const first = retainSessionHistory({ ...h, load });
	const second = retainSessionHistory({ ...h, load });
	await vi.runAllTimersAsync();
	expect(load).toHaveBeenCalledTimes(4);
	// Ordinary live events must not reset a real failure or its retry budget.
	h.view.cursor.version++;
	h.notify();
	await vi.runAllTimersAsync();
	expect(load).toHaveBeenCalledTimes(4);
	load.mockImplementation(() => new Promise<never>(() => {}));
	if (changed === "generation") h.view.generation++;
	else h.view.cursor.epoch = "second";
	h.notify();
	await vi.advanceTimersByTimeAsync(16);
	expect(load).toHaveBeenCalledTimes(5);
	const signal = load.mock.calls[4]?.[0];
	first();
	expect(signal?.aborted).toBe(false);
	second();
	expect(signal?.aborted).toBe(true);
});

it("pauses history during synchronization and resumes when the timeline is ready", async () => {
	vi.useFakeTimers();
	const h = historyHarness();
	const load = vi.fn((_signal: AbortSignal) => new Promise<never>(() => {}));
	const release = retainSessionHistory({ ...h, load });
	await vi.advanceTimersByTimeAsync(16);
	h.view.sync = "synchronizing";
	h.notify();
	expect(load.mock.calls[0]?.[0].aborted).toBe(true);
	h.view.sync = "live";
	h.notify();
	await vi.advanceTimersByTimeAsync(16);
	expect(load).toHaveBeenCalledTimes(2);
	release();
});

it("ignores settlement and releases from a replaced job, retaining current readers", async () => {
	vi.useFakeTimers();
	const scheduler = new BackgroundHistory();
	let rejectOld!: (error: Error) => void;
	const oldRun = vi.fn(
		(_signal: AbortSignal) =>
			new Promise<boolean>((_resolve, reject) => {
				rejectOld = reject;
			}),
	);
	const releaseOld = scheduler.retain("chat", oldRun, undefined, "old");
	await vi.advanceTimersByTimeAsync(16);
	let resolveNew!: (more: boolean) => void;
	const newRun = vi.fn(
		(_signal: AbortSignal) =>
			new Promise<boolean>((resolve) => {
				resolveNew = resolve;
			}),
	);
	const releaseNew = scheduler.retain("chat", newRun, undefined, "new");
	// An imperative reader must join the current job without replacing it.
	const releaseReader = scheduler.retain("chat", newRun);
	expect(oldRun.mock.calls[0]?.[0].aborted).toBe(true);
	releaseOld();
	await vi.advanceTimersByTimeAsync(16);
	expect(newRun).toHaveBeenCalledTimes(1);
	rejectOld(new Error("obsolete failure"));
	await vi.advanceTimersByTimeAsync(16);
	expect(scheduler.status("chat")).toBe("loading");
	releaseNew();
	expect(newRun.mock.calls[0]?.[0].aborted).toBe(false);
	resolveNew(false);
	await vi.runAllTimersAsync();
	expect(scheduler.status("chat")).toBe("idle");
	releaseReader();
});

it.each([
	"cache",
	"checkpoint",
])("loads paused %s history without waiting for a runtime connection", async (origin) => {
	vi.useFakeTimers();
	const h = historyHarness();
	h.view.origin = origin;
	h.view.sync = "cached";
	h.view.connection = "dormant";
	const load = vi.fn((_signal: AbortSignal) => new Promise<never>(() => {}));
	const release = retainSessionHistory({ ...h, load });
	await vi.advanceTimersByTimeAsync(16);
	expect(load).toHaveBeenCalledTimes(1);
	release();
});

it("does not poll while slow history requests occupy every available job", async () => {
	vi.useFakeTimers();
	const scheduler = new BackgroundHistory(2);
	let finish!: (more: boolean) => void;
	const release = scheduler.retain(
		"slow",
		() =>
			new Promise<boolean>((resolve) => {
				finish = resolve;
			}),
	);
	await vi.advanceTimersByTimeAsync(16);
	expect(vi.getTimerCount()).toBe(0);
	await vi.advanceTimersByTimeAsync(30_000);
	expect(vi.getTimerCount()).toBe(0);
	finish(false);
	await vi.runAllTimersAsync();
	release();
});

it("sleeps until retry is due instead of waking every frame during network failures", async () => {
	vi.useFakeTimers();
	const wakeups = vi.spyOn(globalThis, "setTimeout");
	const scheduler = new BackgroundHistory();
	const run = vi.fn().mockRejectedValue(new Error("connection lost"));
	scheduler.retain("offline", run);
	await vi.advanceTimersByTimeAsync(16);
	wakeups.mockClear();
	await vi.advanceTimersByTimeAsync(499);
	expect(run).toHaveBeenCalledTimes(1);
	expect(wakeups).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	expect(run).toHaveBeenCalledTimes(2);
	scheduler.clear();
	wakeups.mockRestore();
});

it("starts newly queued work without waiting for an unrelated network retry", async () => {
	vi.useFakeTimers();
	const scheduler = new BackgroundHistory();
	const failed = vi.fn().mockRejectedValue(new Error("offline"));
	const releaseFailed = scheduler.retain("failed", failed);
	await vi.advanceTimersByTimeAsync(16);
	const foreground = vi.fn().mockResolvedValue(false);
	scheduler.retain("foreground", foreground, () => 10);
	await vi.advanceTimersByTimeAsync(16);
	expect(foreground).toHaveBeenCalledTimes(1);
	expect(failed).toHaveBeenCalledTimes(1);
	releaseFailed();
	expect(vi.getTimerCount()).toBe(0);
});

it("fetches one older page only after demand and cancels it with the last reader", async () => {
	vi.useFakeTimers();
	const { HistoryPageDemand } = await import("../../src/background-history.ts");
	const scheduler = new BackgroundHistory();
	const demand = new HistoryPageDemand(scheduler);
	const first = demand.retain("chat");
	const second = demand.retain("chat");
	const load = vi
		.fn()
		.mockResolvedValue({ applied: true, loaded: 10, hasMore: true });
	await vi.runAllTimersAsync();
	expect(load).not.toHaveBeenCalled();
	demand.request("chat", load);
	demand.request("chat", load);
	await vi.runAllTimersAsync();
	expect(load).toHaveBeenCalledTimes(1);
	expect(scheduler.status("chat")).toBe("idle");
	const slow = vi.fn((_signal: AbortSignal) => new Promise<never>(() => {}));
	demand.request("chat", slow);
	await vi.advanceTimersByTimeAsync(16);
	first();
	expect(slow.mock.calls[0]?.[0].aborted).toBe(false);
	second();
	expect(slow.mock.calls[0]?.[0].aborted).toBe(true);
	demand.request("chat", load);
	await vi.advanceTimersByTimeAsync(16);
	expect(load).toHaveBeenCalledTimes(1);
});

it("holds explicit history demand through synchronization and starts once ready", async () => {
	vi.useFakeTimers();
	const { HistoryPageDemand } = await import("../../src/background-history.ts");
	const scheduler = new BackgroundHistory();
	const demand = new HistoryPageDemand(scheduler);
	let ready = false;
	let changed = () => {};
	const unsubscribe = vi.fn();
	const release = demand.retain("restoring", {
		ready: () => ready,
		subscribe: (listener) => {
			changed = listener;
			return unsubscribe;
		},
	});
	const load = vi
		.fn()
		.mockResolvedValue({ applied: true, hasMore: true, loaded: 10 });
	demand.request("restoring", load);
	await vi.runAllTimersAsync();
	expect(load).not.toHaveBeenCalled();
	expect(scheduler.status("restoring")).toBe("idle");
	ready = true;
	changed();
	await vi.runAllTimersAsync();
	expect(load).toHaveBeenCalledTimes(1);
	changed();
	await vi.runAllTimersAsync();
	expect(load).toHaveBeenCalledTimes(1);
	release();
	expect(unsubscribe).toHaveBeenCalledOnce();
});
