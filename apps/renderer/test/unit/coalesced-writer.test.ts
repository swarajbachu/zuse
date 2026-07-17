import { describe, expect, it, vi } from "vitest";
import { makeCoalescedWriter } from "../../src/lib/coalesced-writer.ts";

describe("coalesced writer", () => {
	it("keeps repeated composer updates off the synchronous input path", () => {
		const pending = new Map<number, () => void>();
		let nextHandle = 0;
		const write = vi.fn<(value: string) => void>();
		const writer = makeCoalescedWriter(write, {
			schedule: (run) => {
				const handle = ++nextHandle;
				pending.set(handle, run);
				return handle;
			},
			cancel: (handle) => pending.delete(handle as number),
		});

		writer.schedule("h");
		writer.schedule("he");
		writer.schedule("hello");

		expect(write).not.toHaveBeenCalled();
		expect(pending).toHaveLength(1);
		pending.values().next().value?.();
		expect(write).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenLastCalledWith("hello");
	});

	it("flushes the latest pending value during editor teardown", () => {
		const pending = new Map<number, () => void>();
		const write = vi.fn<(value: string) => void>();
		const writer = makeCoalescedWriter(write, {
			schedule: (run) => {
				pending.set(1, run);
				return 1;
			},
			cancel: (handle) => pending.delete(handle as number),
		});

		writer.schedule("draft");
		writer.flush();

		expect(write).toHaveBeenCalledOnce();
		expect(write).toHaveBeenCalledWith("draft");
		expect(pending).toHaveLength(0);
	});
});
