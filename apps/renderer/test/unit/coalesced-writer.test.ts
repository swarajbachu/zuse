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

it("flushes live draft annotations on teardown even after the text write already completed", () => {
	let annotations = ["original"];
	const saved: { text: string; annotations: string[] }[] = [];
	const tasks: (() => void)[] = [];
	const writer = makeCoalescedWriter<string>(
		(text) => saved.push({ text, annotations: [...annotations] }),
		{ schedule: (run) => tasks.push(run), cancel: () => undefined },
	);
	writer.schedule("unchanged text");
	tasks[0]?.();
	annotations = ["edited context"];
	writer.flush("unchanged text");
	expect(saved.at(-1)).toEqual({
		text: "unchanged text",
		annotations: ["edited context"],
	});
	annotations = [];
	writer.flush("unchanged text");
	expect(saved.at(-1)).toEqual({ text: "unchanged text", annotations: [] });
});
