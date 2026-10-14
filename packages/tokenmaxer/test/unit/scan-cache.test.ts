import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readAnthropicJsonl } from "../../src/sources/engines/anthropic-jsonl.ts";
import { readCodexJsonl } from "../../src/sources/engines/codex-jsonl.ts";
import { readLines } from "../../src/sources/fs-util.ts";
import { createParsedFileCache } from "../../src/sources/parsed-file-cache.ts";

vi.mock("../../src/sources/fs-util.ts", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../src/sources/fs-util.ts")>();
	return { ...actual, readLines: vi.fn(actual.readLines) };
});
const roots: string[] = [];
afterEach(() => {
	vi.mocked(readLines).mockClear();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
const root = () => {
	const dir = mkdtempSync(join(tmpdir(), "usage-scan-"));
	roots.push(dir);
	return dir;
};
const claudeLine = (id: string, tokens: number) =>
	`${JSON.stringify({
		timestamp: "2026-10-12T12:00:00Z",
		message: {
			id,
			model: "claude-sonnet-4-6",
			usage: { input_tokens: tokens, output_tokens: 1 },
		},
	})}\n`;

it("reuses unchanged Claude files and reparses only the changed file", async () => {
	const dir = root();
	const projects = join(dir, "projects", "project");
	mkdirSync(projects, { recursive: true });
	const a = join(projects, "a.jsonl");
	const b = join(projects, "b.jsonl");
	writeFileSync(a, claudeLine("a", 10));
	writeFileSync(b, claudeLine("b", 20));
	const read = () =>
		readAnthropicJsonl({
			sourceId: "claude",
			sourceLabel: "Claude",
			roots: [dir],
		});
	const first = await read();
	const second = await read();
	expect(second).toEqual(first);
	expect(readLines).toHaveBeenCalledTimes(2);
	appendFileSync(a, claudeLine("a", 30));
	const updated = await read();
	expect(readLines).toHaveBeenCalledTimes(3);
	expect(
		updated.records.map((r) => r.inputTokens).sort((a, b) => a - b),
	).toEqual([20, 30]);
	rmSync(b);
	expect((await read()).records).toHaveLength(1);
});

it("reuses unchanged Codex files while preserving cumulative usage after growth and replacement", async () => {
	const dir = root();
	const file = join(dir, "session.jsonl");
	const line = (timestamp: string, total: number) =>
		`${JSON.stringify({
			timestamp,
			type: "event_msg",
			payload: {
				type: "token_count",
				info: { total_token_usage: { input_tokens: total, output_tokens: 1 } },
			},
		})}\n`;
	writeFileSync(file, line("2026-10-12T12:00:00Z", 10));
	const read = () =>
		readCodexJsonl({
			sourceId: "codex",
			sourceLabel: "Codex",
			sessionsDirs: [dir],
		});
	const first = await read();
	expect(await read()).toEqual(first);
	expect(readLines).toHaveBeenCalledTimes(1);
	appendFileSync(file, line("2026-10-12T12:01:00Z", 30));
	expect((await read()).records.map((r) => r.inputTokens)).toEqual([10, 20]);
	expect(readLines).toHaveBeenCalledTimes(2);
	writeFileSync(file, line("2026-10-12T12:00:00Z", 90));
	expect((await read()).records[0]?.inputTokens).toBe(90);
	expect(readLines).toHaveBeenCalledTimes(3);
});

it("does not cache a file changed while parsing, and retries failed parses", async () => {
	const file = join(root(), "changing.jsonl");
	writeFileSync(file, "first");
	const cache = createParsedFileCache<string>();
	const parse = vi.fn(async () => {
		appendFileSync(file, "changed");
		return ["partial"];
	});
	expect(await cache.read(file, "context", parse)).toEqual(["partial"]);
	const failure = vi.fn(async (): Promise<string[]> => {
		throw new Error("read failed");
	});
	await expect(cache.read(file, "context", failure)).rejects.toThrow(
		"read failed",
	);
	const recovered = vi.fn(async () => ["complete"]);
	expect(await cache.read(file, "context", recovered)).toEqual(["complete"]);
	expect(await cache.read(file, "context", recovered)).toEqual(["complete"]);
	expect(recovered).toHaveBeenCalledOnce();
	expect(await cache.read(file, "different account", recovered)).toEqual([
		"complete",
	]);
	expect(recovered).toHaveBeenCalledTimes(2);
});
