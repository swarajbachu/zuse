import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Path } from "effect";
import { GitChange, GitStatusSummary } from "@zuse/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { writeContextCheckpoint } from "../../src/context/checkpoint.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

const fixture = (): string => {
	const directory = mkdtempSync(join(tmpdir(), "zuse-checkpoint-"));
	temporaryDirectories.push(directory);
	return directory;
};

const baseSession = {
	id: "s_1",
	chatId: "c_1",
	providerId: "claude",
	model: "claude-sonnet-5",
	worktreeId: "wt_1" as string | null,
};

const baseCompaction = {
	itemId: "compact_1",
	beforeTokens: 182000,
	afterTokens: 45000,
	durationMs: 3200,
};

const runWrite = (
	cwd: string,
	overrides: Partial<Parameters<typeof writeContextCheckpoint>[0]> = {},
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const pathSvc = yield* Path.Path;
		yield* writeContextCheckpoint({
			fs,
			path: pathSvc,
			cwd,
			writtenAt: 1760000000000,
			session: baseSession,
			compaction: baseCompaction,
			git: null,
			lastUserMessage: null,
			...overrides,
		});
	}).pipe(Effect.provide(NodeServices.layer));

describe("context checkpoint", () => {
	it("writes a checkpoint with session, compaction, and git sections", async () => {
		const cwd = fixture();
		const git = {
			status: GitStatusSummary.make({
				branch: "feature/x",
				ahead: 2,
				behind: 0,
				dirtyFiles: 2,
			}),
			changes: [
				GitChange.make({
					path: "src/a.ts",
					kind: "modified",
					oldPath: null,
					staged: true,
				}),
			],
		};
		await Effect.runPromise(
			runWrite(cwd, {
				git,
				lastUserMessage: "Refactor the session store.\nKeep it backward compatible.",
			}),
		);
		const file = readFileSync(join(cwd, ".context", "checkpoint.md"), "utf8");
		expect(file).toContain("# Context checkpoint — ");
		expect(file).toContain("`s_1`");
		expect(file).toContain("`wt_1`");
		expect(file).toContain("182000 → 45000 tokens");
		expect(file).toContain("`feature/x`");
		expect(file).toContain("modified `src/a.ts`");
		expect(file).toContain("> Refactor the session store.");
	});

	it("handles missing git state and no user message", async () => {
		const cwd = fixture();
		await Effect.runPromise(
			runWrite(cwd, { session: { ...baseSession, worktreeId: null } }),
		);
		const file = readFileSync(join(cwd, ".context", "checkpoint.md"), "utf8");
		expect(file).toContain("_Git state unavailable._");
		expect(file).toContain("_No user message recorded yet._");
		expect(file).toContain("main checkout");
	});

	it("overwrites a previous checkpoint atomically", async () => {
		const cwd = fixture();
		await Effect.runPromise(runWrite(cwd, { lastUserMessage: "first" }));
		await Effect.runPromise(
			runWrite(cwd, { lastUserMessage: "second", writtenAt: 1760000060000 }),
		);
		const file = readFileSync(join(cwd, ".context", "checkpoint.md"), "utf8");
		expect(file).toContain("> second");
		expect(file).not.toContain("> first");
		// No temp file left behind.
		expect(() =>
			readFileSync(join(cwd, ".context", "checkpoint.md.tmp")),
		).toThrow();
	});

	it("truncates a very long last request", async () => {
		const cwd = fixture();
		await Effect.runPromise(
			runWrite(cwd, { lastUserMessage: "x".repeat(5000) }),
		);
		const file = readFileSync(join(cwd, ".context", "checkpoint.md"), "utf8");
		const quote = file.split("## Last request")[1] ?? "";
		expect(quote.length).toBeLessThan(1400);
	});
});
