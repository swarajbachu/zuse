import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	appendRotatingLogFile,
	makeBatchedLogWriter,
} from "../../src/batched-log-writer.ts";

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

describe("rotating log append", () => {
	it("moves an oversized log aside and keeps one older copy", async () => {
		const file = join(mkdtempSync(join(tmpdir(), "zuse-log-")), "app.log");
		await appendRotatingLogFile(file, "a\n", { maxBytes: 3 });
		await appendRotatingLogFile(file, "b\n", { maxBytes: 3 });
		expect(readFileSync(file, "utf8")).toBe("a\nb\n");
		await appendRotatingLogFile(file, "c\n", { maxBytes: 3 });
		expect(readFileSync(`${file}.1`, "utf8")).toBe("a\nb\n");
		expect(readFileSync(file, "utf8")).toBe("c\n");

		writeFileSync(file, "older and larger\n");
		await appendRotatingLogFile(file, "d\n", { maxBytes: 3 });
		expect(readFileSync(`${file}.1`, "utf8")).toBe("older and larger\n");
		expect(readFileSync(file, "utf8")).toBe("d\n");
	});

	it("starts the log over when the older copy can't be replaced", async () => {
		const file = join(mkdtempSync(join(tmpdir(), "zuse-log-")), "app.log");
		// A non-empty directory in the `.1` slot makes the rename fail.
		mkdirSync(`${file}.1`);
		writeFileSync(join(`${file}.1`, "keep"), "");
		writeFileSync(file, "older and larger\n");
		await appendRotatingLogFile(file, "e\n", { maxBytes: 3 });
		expect(readFileSync(file, "utf8")).toBe("e\n");
	});
});
