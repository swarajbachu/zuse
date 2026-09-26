import {
	appendPendingTerminalInput,
	createTerminalInputPump,
	retainPendingInitialInput,
} from "@zuse/client-runtime/terminal-input-pump";
import { describe, expect, it, vi } from "vitest";

const deferred = () => {
	let resolve!: () => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<void>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
};

describe("terminal input pump", () => {
	it("preserves batched resume keys and paste in order", () => {
		const updates = ["b", "u", "n", " ", "test --watch", "\r"];
		const buffered = updates.reduce(
			(current, input) => appendPendingTerminalInput(current, input),
			{ data: "", overflowed: false },
		);

		expect(buffered).toEqual({
			data: "bun test --watch\r",
			overflowed: false,
		});
	});

	it("rejects an overflowing resume chunk without sending a partial paste", () => {
		const current = { data: "abc", overflowed: false };
		const overflowed = appendPendingTerminalInput(current, "paste", 7);

		expect(overflowed).toEqual({ data: "abc", overflowed: true });
		expect(appendPendingTerminalInput(overflowed, "d", 7)).toEqual({
			data: "abcd",
			overflowed: false,
		});
	});

	it("retains one trigger input when the terminal remounts before acknowledgement", () => {
		expect(retainPendingInitialInput("bun dev\n", "bun dev\n")).toBe(
			"bun dev\n",
		);
	});
	it("preserves rapid input and backspace order with one write in flight", async () => {
		const first = deferred();
		const second = deferred();
		const writes: string[] = [];
		let concurrent = 0;
		let maxConcurrent = 0;
		const completions = [first, second];
		const pump = createTerminalInputPump({
			stallWarningMs: 3_000,
			write: async (data) => {
				writes.push(data);
				concurrent += 1;
				maxConcurrent = Math.max(maxConcurrent, concurrent);
				await completions[writes.length - 1]?.promise;
				concurrent -= 1;
			},
			onFailure: vi.fn(),
		});

		pump.enqueue("a");
		pump.enqueue("b");
		pump.enqueue("c");
		pump.enqueue("\x7f");

		expect(writes).toEqual(["a"]);
		first.resolve();
		await vi.waitFor(() => expect(writes).toEqual(["a", "bc\x7f"]));
		second.resolve();
		await pump.whenIdle();

		expect(writes.join("")).toBe("abc\x7f");
		expect(maxConcurrent).toBe(1);
	});

	it("warns once and resumes queued input in order after a late acknowledgement", async () => {
		vi.useFakeTimers();
		const first = deferred();
		const onStall = vi.fn();
		const onFailure = vi.fn();
		const writes: string[] = [];
		const pump = createTerminalInputPump({
			stallWarningMs: 3_000,
			write: async (data) => {
				writes.push(data);
				if (writes.length === 1) await first.promise;
			},
			onStall,
			onFailure,
		});

		pump.enqueue("first");
		pump.enqueue("second");
		await vi.advanceTimersByTimeAsync(3_000);

		expect(onStall).toHaveBeenCalledOnce();
		expect(onStall).toHaveBeenCalledWith(3_000);
		expect(onFailure).not.toHaveBeenCalled();
		expect(writes).toEqual(["first"]);
		expect(pump.failed).toBe(false);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(onStall).toHaveBeenCalledOnce();

		first.resolve();
		await vi.waitFor(() => expect(writes).toEqual(["first", "second"]));
		await pump.whenIdle();
		expect(pump.failed).toBe(false);
		expect(onFailure).not.toHaveBeenCalled();
		vi.useRealTimers();
	});

	it("fails once on a late rejection without replaying queued input", async () => {
		vi.useFakeTimers();
		const first = deferred();
		const onStall = vi.fn();
		const onFailure = vi.fn();
		const writes: string[] = [];
		const pump = createTerminalInputPump({
			stallWarningMs: 3_000,
			write: async (data) => {
				writes.push(data);
				if (writes.length === 1) await first.promise;
			},
			onStall,
			onFailure,
		});

		pump.enqueue("first");
		pump.enqueue("second");
		await vi.advanceTimersByTimeAsync(3_000);
		expect(onStall).toHaveBeenCalledOnce();
		expect(onFailure).not.toHaveBeenCalled();

		const rejected = new Error("transport rejected the write");
		first.reject(rejected);
		await pump.whenIdle();

		expect(onFailure).toHaveBeenCalledOnce();
		expect(onFailure).toHaveBeenCalledWith(rejected);
		expect(writes).toEqual(["first"]);
		expect(pump.failed).toBe(true);
		pump.enqueue("ignored");
		expect(writes).toEqual(["first"]);
		vi.useRealTimers();
	});

	it("acknowledges buffered input only after the PTY write succeeds", async () => {
		const write = deferred();
		const pump = createTerminalInputPump({
			stallWarningMs: 3_000,
			write: () => write.promise,
			onFailure: vi.fn(),
		});
		let acknowledged = false;
		const pending = pump.enqueueAndWait("resume input").then((written) => {
			acknowledged = written;
		});
		await Promise.resolve();
		expect(acknowledged).toBe(false);
		write.resolve();
		await pending;
		expect(acknowledged).toBe(true);
	});

	it("acknowledges its own batch even when a later write fails", async () => {
		const first = deferred();
		const second = deferred();
		let writes = 0;
		const pump = createTerminalInputPump({
			stallWarningMs: 3_000,
			write: () => (++writes === 1 ? first.promise : second.promise),
			onFailure: vi.fn(),
		});

		const initial = pump.enqueueAndWait("resume input");
		pump.enqueue("later input");
		first.resolve();
		await expect(initial).resolves.toBe(true);
		second.reject(new Error("later write failed"));
		await pump.whenIdle();
		expect(pump.failed).toBe(true);
	});
});
