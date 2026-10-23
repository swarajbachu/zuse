import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FolderId,
	GitDiffResult,
	GitReviewPatch,
	type ReviewGuideState,
} from "@zuse/contracts";
import { GitService } from "@zuse/git/git-service";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Exit, Layer, ManagedRuntime, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, it } from "vitest";

import { ConfigStoreService } from "../../src/config-store/services/config-store-service.ts";
import { MigrationsLive } from "../../src/persistence/migrations.ts";
import {
	HiddenAgentRunner,
	type HiddenAgentRunnerShape,
} from "../../src/provider/hidden-agent-run.ts";
import {
	ReviewGuideService,
	ReviewGuideServiceLive,
} from "../../src/review-guide/service.ts";

const patch = (path: string, hunks: ReadonlyArray<string>) => {
	const text = `${[`--- a/${path}`, `+++ b/${path}`, ...hunks].join("\n")}\n`;
	return GitReviewPatch.make({
		path,
		error: null,
		result: GitDiffResult.make({
			mode: "worktree",
			patch: text,
			truncated: false,
			bytes: text.length,
		}),
	});
};

const firstChange = [
	patch("src/store.ts", ["@@ -1 +1,2 @@", " class Store {", "+  cache = 1;"]),
	patch("src/store.test.ts", ["@@ -1 +1,2 @@", " it()", "+it('caches')"]),
];

const ref = { folderId: "project-1" as FolderId, worktreeId: null };

interface Harness {
	readonly runtime: ManagedRuntime.ManagedRuntime<
		ReviewGuideService | SqlClient.SqlClient,
		unknown
	>;
	readonly prompts: string[];
	setPatches(next: ReadonlyArray<GitReviewPatch>): void;
	setEnabled(enabled: boolean): void;
	setRunner(behavior: "write" | "hang" | "signed-out" | "finish-only"): void;
	readonly dispose: () => Promise<void>;
}

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

const makeHarness = async (provider = "claude"): Promise<Harness> => {
	const directory = mkdtempSync(join(tmpdir(), "zuse-review-guide-"));
	directories.push(directory);
	let patches: ReadonlyArray<GitReviewPatch> = firstChange;
	let enabled = true;
	let behavior: "write" | "hang" | "signed-out" | "finish-only" = "write";
	const prompts: string[] = [];

	const git = {
		reviewSummary: () =>
			Effect.succeed({ baseSha: "base000", headSha: "head111" } as never),
		reviewPatches: () => Stream.fromIterable(patches),
		prDetails: () => Effect.fail(new Error("no pr") as never),
	};
	const config = {
		getSettings: () =>
			Effect.sync(
				() =>
					({
						reviewGuidesEnabled: enabled,
						reviewGuidesAutoGenerate: true,
					}) as never,
			),
	};
	const runner: HiddenAgentRunnerShape = {
		run: (input, consume) =>
			Effect.gen(function* () {
				prompts.push(input.prompt);
				if (behavior === "hang") return yield* Effect.never;
				if (behavior === "signed-out")
					return yield* consume(
						Stream.make(
							{ _tag: "Error", message: "You're signed out of Claude Code." },
							{ _tag: "Completed", reason: "error" },
						) as never,
					);
				if (input.access._tag !== "ReadOnly") return yield* Effect.die("text");
				const tools = input.access.toolsets[0];
				if (tools === undefined) return yield* Effect.die("no tools");
				if (behavior === "finish-only") {
					yield* Effect.promise(() => tools.call("guide_finish", {}));
					return yield* consume(Stream.empty);
				}
				const handles = [...input.prompt.matchAll(/^(h\d+) src\/store\.ts/gm)]
					.map((match) => match[1] as string)
					.filter((handle, index, all) => all.indexOf(handle) === index);
				yield* Effect.promise(() =>
					tools.call("guide_set_overview", {
						title: "Cache loads",
						context: "Loads are cached.",
						steps: ["The store keeps a cache"],
					}),
				);
				yield* Effect.promise(() =>
					tools.call("guide_add_chapter", {
						id: `cache-${prompts.length}`,
						title: "The store caches",
						summary: "Adds a cache.",
						hunks: handles,
						validatedBy: ["h2"],
					}),
				);
				yield* Effect.promise(() => tools.call("guide_finish", {}));
				return yield* consume(Stream.empty);
			}),
	};

	const sqlite = sqliteLayer({
		filename: join(directory, "db.sqlite"),
		disableWAL: true,
	});
	const database = Layer.merge(
		sqlite,
		MigrationsLive.pipe(Layer.provide(sqlite)),
	);
	const service = ReviewGuideServiceLive.pipe(
		Layer.provide(Layer.succeed(GitService, git as never)),
		Layer.provide(Layer.succeed(ConfigStoreService, config as never)),
		Layer.provide(Layer.succeed(HiddenAgentRunner, runner)),
		Layer.provide(database),
	);
	const runtime = ManagedRuntime.make(Layer.merge(service, database));
	await runtime.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO projects (id,path,name,created_at,updated_at) VALUES ('project-1',${directory},'Project','2026-10-01','2026-10-01')`;
			yield* sql`INSERT INTO chats (id,project_id,title,created_at,updated_at) VALUES ('chat-1','project-1','Chat','2026-10-01','2026-10-01')`;
			yield* sql`INSERT INTO sessions (id,project_id,title,provider_id,model,status,chat_id,created_at,updated_at) VALUES ('session-1','project-1','Chat',${provider},'model-x','idle','chat-1','2026-10-01','2026-10-01')`;
		}),
	);
	return {
		runtime,
		prompts,
		setPatches: (next) => {
			patches = next;
		},
		setEnabled: (next) => {
			enabled = next;
		},
		setRunner: (next) => {
			behavior = next;
		},
		dispose: () => runtime.dispose(),
	};
};

/** The first state the stream reports that satisfies `done`. */
const waitFor = (
	harness: Harness,
	done: (state: ReviewGuideState) => boolean,
) =>
	harness.runtime.runPromise(
		Effect.flatMap(ReviewGuideService, (svc) =>
			svc
				.stream(ref)
				.pipe(Stream.filter(done), Stream.runHead, Effect.timeout("5 seconds")),
		),
	);

const generate = (harness: Harness) =>
	harness.runtime.runPromise(
		Effect.flatMap(ReviewGuideService, (svc) => svc.generate(ref, {})),
	);

describe("ReviewGuideService", () => {
	it("writes, stores, and reuses a guide", async () => {
		const harness = await makeHarness();
		try {
			await generate(harness);
			const ready = await waitFor(
				harness,
				(state) => state.guide !== null && state.run === null,
			);
			const guide = ready._tag === "Some" ? ready.value.guide : null;
			expect(guide?.originSessionId).toBe("session-1");
			expect(guide?.headSha).toBe("head111");
			expect(guide?.overview?.context).toBe("Loads are cached.");
			expect(guide?.chapters.map((chapter) => chapter.kind)).toEqual([
				"core",
				"tests",
			]);
			expect(guide?.chapters[0]?.validatedBy).toHaveLength(1);
			expect(harness.prompts).toHaveLength(1);

			// Nothing changed: no second run.
			await generate(harness);
			await waitFor(harness, (state) => state.run === null);
			expect(harness.prompts).toHaveLength(1);

			// One new hunk: the existing chapter is kept and only the new hunk asked about.
			harness.setPatches([
				patch("src/store.ts", [
					"@@ -1 +1,2 @@",
					" class Store {",
					"+  cache = 1;",
					"@@ -20 +21,2 @@",
					" save() {",
					"+  clear();",
				]),
				firstChange[1] as GitReviewPatch,
			]);
			await generate(harness);
			const updated = await waitFor(
				harness,
				(state) =>
					state.run === null && (state.guide?.chapters.length ?? 0) === 3,
			);
			expect(harness.prompts).toHaveLength(2);
			expect(harness.prompts[1]).toContain("A guide already exists");
			expect(harness.prompts[1]).toContain("- cache-1: The store caches");
			const chapters =
				updated._tag === "Some" ? (updated.value.guide?.chapters ?? []) : [];
			expect(chapters.map((chapter) => chapter.id)).toEqual([
				"cache-1",
				"cache-2",
				"auto-tests",
			]);
		} finally {
			await harness.dispose();
		}
	});

	it("rewrites from scratch when forced, even if nothing changed", async () => {
		const harness = await makeHarness();
		try {
			await generate(harness);
			await waitFor(
				harness,
				(state) => state.guide !== null && state.run === null,
			);
			await harness.runtime.runPromise(
				Effect.flatMap(ReviewGuideService, (svc) =>
					svc.generate(ref, { force: true }),
				),
			);
			const rewritten = await waitFor(
				harness,
				(state) =>
					state.run === null && state.guide?.chapters[0]?.id === "cache-2",
			);
			expect(rewritten._tag).toBe("Some");
			expect(harness.prompts[1]).not.toContain("A guide already exists");
		} finally {
			await harness.dispose();
		}
	});

	it("cancels a run and keeps the stored guide", async () => {
		const harness = await makeHarness();
		try {
			harness.setRunner("hang");
			await generate(harness);
			await waitFor(harness, (state) => state.run !== null);
			await harness.runtime.runPromise(
				Effect.flatMap(ReviewGuideService, (svc) => svc.cancel(ref)),
			);
			const after = await waitFor(harness, (state) => state.run === null);
			expect(after._tag === "Some" ? after.value.guide : "missing").toBeNull();
		} finally {
			await harness.dispose();
		}
	});

	it("fails a run that writes nothing and keeps the stored guide", async () => {
		const harness = await makeHarness();
		try {
			await generate(harness);
			const first = await waitFor(
				harness,
				(state) => state.guide !== null && state.run === null,
			);
			const stored = first._tag === "Some" ? first.value.guide : null;
			harness.setRunner("signed-out");
			harness.setPatches([
				patch("src/store.ts", [
					"@@ -1 +1,2 @@",
					" class Store {",
					"+  cache = 2;",
				]),
			]);
			await generate(harness);
			const failed = await waitFor(
				harness,
				(state) => state.lastError !== null,
			);
			const state = failed._tag === "Some" ? failed.value : null;
			expect(state?.lastError).toBe("You're signed out of Claude Code.");
			expect(state?.guide?.id).toBe(stored?.id);
			expect(state?.guide?.overview?.context).toBe("Loads are cached.");
		} finally {
			await harness.dispose();
		}
	});

	it("accepts an update that only finishes over kept chapters", async () => {
		const harness = await makeHarness();
		try {
			await generate(harness);
			await waitFor(
				harness,
				(state) => state.guide !== null && state.run === null,
			);
			// Only the test file changes: every core chapter and the overview
			// carry over, and finishing is the whole job.
			harness.setRunner("finish-only");
			harness.setPatches([
				firstChange[0] as GitReviewPatch,
				patch("src/store.test.ts", [
					"@@ -1 +1,3 @@",
					" it()",
					"+it('caches')",
					"+it('clears')",
				]),
			]);
			await generate(harness);
			const done = await waitFor(
				harness,
				(state) => state.run === null && harness.prompts.length === 2,
			);
			const state = done._tag === "Some" ? done.value : null;
			expect(state?.lastError).toBeNull();
			expect(state?.guide?.chapters[0]?.id).toBe("cache-1");
			// A third of the hunks changed, so the old overview was not reused;
			// this run wrote no new one, and a stale one is not kept.
			expect(state?.guide?.overview).toBeNull();
		} finally {
			await harness.dispose();
		}
	});

	it("refuses when guides are off", async () => {
		const harness = await makeHarness();
		try {
			harness.setEnabled(false);
			const exit = await harness.runtime.runPromiseExit(
				Effect.flatMap(ReviewGuideService, (svc) => svc.generate(ref, {})),
			);
			expect(Exit.isFailure(exit)).toBe(true);
			const state = await waitFor(harness, () => true);
			expect(state._tag === "Some" ? state.value.unavailable : null).toBe(
				"disabled",
			);
		} finally {
			await harness.dispose();
		}
	});

	it("reports unsupported providers instead of running", async () => {
		const harness = await makeHarness("gemini");
		try {
			await generate(harness);
			const failed = await waitFor(
				harness,
				(state) => state.lastError !== null,
			);
			expect(failed._tag === "Some" ? failed.value.unavailable : null).toBe(
				"unsupported-provider",
			);
			expect(harness.prompts).toHaveLength(0);
		} finally {
			await harness.dispose();
		}
	});
});
