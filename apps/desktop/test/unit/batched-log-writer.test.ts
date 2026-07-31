import { describe, expect, it } from "vitest";

import { makeBatchedLogWriter } from "../../src/batched-log-writer.ts";

const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};

describe("batched log writer", () => {
	it("batches queued lines into fewer writes", async () => {
		const gate = deferred();
		const writes: ReadonlyArray<string>[] = [];
		const writer = makeBatchedLogWriter({
			batchSize: 10,
			writeBatch: async (_path, lines) => {
				writes.push(lines);
				if (writes.length === 1) await gate.promise;
			},
		});

		writer.append("/tmp/app.log", "one");
		writer.append("/tmp/app.log", "two");
		writer.append("/tmp/app.log", "three");
		gate.resolve();
		await writer.flush();

		expect(writes).toEqual([["one"], ["two", "three"]]);
	});

	it("bounds pending memory and reports dropped lines", async () => {
		const gate = deferred();
		const written: string[] = [];
		const writer = makeBatchedLogWriter({
			maxPendingLines: 3,
			batchSize: 3,
			writeBatch: async (_path, lines) => {
				written.push(...lines);
				if (written.length === 1) await gate.promise;
			},
		});

		writer.append("/tmp/app.log", "line-1");
		for (let index = 2; index <= 10; index += 1) {
			writer.append("/tmp/app.log", `line-${index}`);
		}
		gate.resolve();
		await writer.flush();

		expect(written).toContain("line-1");
		expect(written).toContain("line-8");
		expect(written).toContain("line-9");
		expect(written).toContain("line-10");
		expect(written).not.toContain("line-2");
		const notice = written
			.map((line) => {
				try {
					return JSON.parse(line) as { event?: string; lines?: number };
				} catch {
					return {};
				}
			})
			.find((line) => line.event === "log.lines.dropped");
		expect(notice?.lines).toBe(6);
	});

	it("bounds queued bytes and rejects oversized individual lines", async () => {
		const gate = deferred();
		const written: string[] = [];
		const writer = makeBatchedLogWriter({
			maxPendingBytes: 12,
			maxLineBytes: 8,
			writeBatch: async (_path, lines) => {
				written.push(...lines);
				if (written.length === 1) await gate.promise;
			},
		});

		writer.append("/tmp/app.log", "active");
		writer.append("/tmp/app.log", "12345678");
		writer.append("/tmp/app.log", "abcdefgh");
		writer.append("/tmp/app.log", "123456789");
		gate.resolve();
		await writer.flush();

		expect(written).toContain("active");
		expect(written).toContain("abcdefgh");
		expect(written).not.toContain("12345678");
		expect(written).not.toContain("123456789");
		const notice = written
			.map((line) => {
				try {
					return JSON.parse(line) as {
						event?: string;
						lines?: number;
						bytes?: number;
					};
				} catch {
					return {};
				}
			})
			.find((line) => line.event === "log.lines.dropped");
		expect(notice).toMatchObject({ lines: 2, bytes: 17 });
	});
});
