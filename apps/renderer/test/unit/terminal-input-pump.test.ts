import { describe, expect, it, vi } from "vitest";

import {
	createTerminalInputPump,
	retainPendingInitialInput,
} from "../../src/lib/terminal-input-pump.ts";

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
			timeoutMs: 3_000,
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

	it("fails once on an ambiguous timeout and never replays queued input", async () => {
		vi.useFakeTimers();
		const onFailure = vi.fn();
		const writes: string[] = [];
		const pump = createTerminalInputPump({
			timeoutMs: 3_000,
			write: async (data) => {
				writes.push(data);
				await new Promise<void>(() => undefined);
			},
			onFailure,
		});

		pump.enqueue("first");
		pump.enqueue("second");
		await vi.advanceTimersByTimeAsync(3_000);

		expect(onFailure).toHaveBeenCalledTimes(1);
		expect(onFailure).toHaveBeenCalledWith("write-timeout", expect.any(Error));
		expect(writes).toEqual(["first"]);
		expect(pump.failed).toBe(true);
		pump.enqueue("ignored");
		expect(writes).toEqual(["first"]);
		vi.useRealTimers();
	});

	it("acknowledges buffered input only after the PTY write succeeds", async () => {
		const write = deferred();
		const pump = createTerminalInputPump({
			timeoutMs: 3_000,
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
			timeoutMs: 3_000,
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
