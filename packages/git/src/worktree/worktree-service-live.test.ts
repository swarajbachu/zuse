import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { FolderId, WorktreeId } from "@zuse/contracts";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
	PokemonAssignment,
	ProjectLocator,
	RepositorySettingsReader,
	WorktreeDecoration,
	WorktreeNameAllocator,
} from "./ports.ts";
import { WorktreeService } from "./worktree-service.ts";
import { WorktreeServiceLive } from "./worktree-service-live.ts";

const projectId = FolderId.make("project-1");

const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("WorktreeServiceLive", () => {
	let temporaryRoot = "";
	let repositoryRoot = "";
	let worktreeRoot = "";
	let setupScript: string | null = null;
	let runtime: ManagedRuntime.ManagedRuntime<WorktreeService, SqlError>;

	beforeEach(async () => {
		temporaryRoot = mkdtempSync(join(tmpdir(), "zuse-worktree-service-"));
		repositoryRoot = join(temporaryRoot, "repository");
		worktreeRoot = join(temporaryRoot, "worktrees");
		setupScript = null;
		git(temporaryRoot, "init", "--initial-branch=main", repositoryRoot);
		git(repositoryRoot, "config", "user.name", "Test User");
		git(repositoryRoot, "config", "user.email", "test@example.com");
		writeFileSync(join(repositoryRoot, "README.md"), "initial\n");
		git(repositoryRoot, "add", "README.md");
		git(repositoryRoot, "commit", "-m", "initial commit");

		const SqlLive = sqliteLayer({ filename: ":memory:" });
		const SchemaLive = Layer.effectDiscard(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					CREATE TABLE worktrees (
						id TEXT PRIMARY KEY,
						project_id TEXT NOT NULL,
						path TEXT NOT NULL,
						name TEXT NOT NULL,
						branch TEXT NOT NULL,
						base_branch TEXT NOT NULL,
						created_at TEXT NOT NULL,
						setup_status TEXT NOT NULL DEFAULT 'pending',
						setup_output TEXT NOT NULL DEFAULT '',
						setup_started_at TEXT,
						setup_finished_at TEXT,
						pokemon_number INTEGER,
						UNIQUE(project_id, path)
					)
				`;
				yield* sql`
					CREATE TABLE pokemon_unlocks (
						pokemon_number INTEGER PRIMARY KEY,
						worktree_id TEXT,
						unlocked_at TEXT NOT NULL
					)
				`;
			}),
		).pipe(Layer.provide(SqlLive));
		const MigratedSql = SqlLive.pipe(Layer.provideMerge(SchemaLive));

		const PortsLive = Layer.mergeAll(
			Layer.succeed(ProjectLocator, {
				find: (requestedProjectId) =>
					Effect.succeed(
						requestedProjectId === projectId
							? {
									id: projectId,
									name: "repository",
									path: repositoryRoot,
								}
							: null,
					),
			}),
			Layer.succeed(RepositorySettingsReader, {
				get: () =>
					Effect.succeed({
						worktreeBaseDir: worktreeRoot,
						setupScript,
						runScript: null,
						environmentVariables: {},
						fileIncludeGlobs: "",
					}),
			}),
			Layer.succeed(WorktreeNameAllocator, {
				allocate: () => Effect.succeed({ name: "bulbasaur", pokemonNumber: 1 }),
			}),
			Layer.succeed(PokemonAssignment, {
				record: () => Effect.void,
			}),
			Layer.succeed(WorktreeDecoration, {
				pokemonSummary: () => null,
			}),
		);

		runtime = ManagedRuntime.make(
			WorktreeServiceLive.pipe(
				Layer.provide(PortsLive),
				Layer.provide(MigratedSql),
				Layer.provide(NodeServices.layer),
			),
		);
		await runtime.runPromise(Effect.void);
	});

	afterEach(async () => {
		await runtime.dispose();
		rmSync(temporaryRoot, { recursive: true, force: true });
	});

	const run = <A, E>(
		operation: (service: WorktreeService["Service"]) => Effect.Effect<A, E>,
	) => runtime.runPromise(Effect.flatMap(WorktreeService, operation));

	test("creates, lists, streams setup completion, removes, and restores a worktree", async () => {
		const created = await run((service) => service.create(projectId));
		expect(created).toMatchObject({
			projectId,
			name: "bulbasaur",
			branch: "bulbasaur",
			baseBranch: "main",
		});
		expect(created.path).toBe(join(worktreeRoot, "bulbasaur"));
		expect(await run((service) => service.list(projectId))).toHaveLength(1);

		const setupEvents = await run((service) =>
			service.setupStream(created.id).pipe(Stream.runCollect),
		);
		expect(
			[...setupEvents]
				.filter((event) => event._tag === "status")
				.map((event) => event.status),
		).toContain("skipped");

		const snapshot = {
			id: created.id,
			projectId: created.projectId,
			path: created.path,
			name: created.name,
			branch: created.branch,
			baseBranch: created.baseBranch,
			createdAt: created.createdAt,
		};
		await run((service) => service.remove(created.id, false));
		expect(await run((service) => service.get(created.id))).toBeNull();

		const restored = await run((service) => service.restore(snapshot));
		expect(restored).toMatchObject({ id: created.id, setupStatus: "skipped" });
	});

	test("refuses to remove a dirty worktree unless force is enabled", async () => {
		const created = await run((service) => service.create(projectId));
		writeFileSync(join(created.path, "dirty.txt"), "dirty\n");

		await expect(
			run((service) => service.remove(created.id, false)),
		).rejects.toMatchObject({
			_tag: "WorktreeDirtyError",
			worktreeId: created.id,
		});

		await run((service) => service.remove(created.id, true));
		expect(await run((service) => service.get(created.id))).toBeNull();
	});

	test("runs setup commands and streams a succeeded terminal state", async () => {
		setupScript = "printf setup-ok > setup-result.txt";
		const created = await run((service) => service.create(projectId));
		const events = await run((service) =>
			service.setupStream(created.id).pipe(Stream.runCollect),
		);
		const persisted = await run((service) => service.get(created.id));

		expect(
			[...events]
				.filter((event) => event._tag === "status")
				.map((event) => event.status),
		).toContain("succeeded");
		expect(persisted?.setupStatus).toBe("succeeded");
		expect(git(created.path, "status", "--short")).toContain(
			"setup-result.txt",
		);
	});

	test("persists and streams setup command failures", async () => {
		setupScript = "printf setup-failed; exit 7";
		const created = await run((service) => service.create(projectId));
		const events = await run((service) =>
			service.setupStream(created.id).pipe(Stream.runCollect),
		);
		const persisted = await run((service) => service.get(created.id));

		expect(
			[...events]
				.filter((event) => event._tag === "status")
				.map((event) => event.status),
		).toContain("failed");
		expect(persisted).toMatchObject({
			setupStatus: "failed",
			setupOutput: expect.stringContaining("setup-failed"),
		});
	});

	test("truncates setup output while preserving the newest bytes", async () => {
		setupScript =
			"head -c 90000 /dev/zero | tr '\\0' x; printf setup-output-end";
		const created = await run((service) => service.create(projectId));
		await run((service) =>
			service.setupStream(created.id).pipe(Stream.runCollect),
		);
		const persisted = await run((service) => service.get(created.id));

		expect(persisted?.setupOutput.length).toBe(80_000);
		expect(persisted?.setupOutput.endsWith("setup-output-end")).toBe(true);
	});

	test("reports missing worktrees and projects", async () => {
		const missingWorktreeId = WorktreeId.make("missing-worktree");
		await expect(
			run((service) => service.rerunSetup(missingWorktreeId)),
		).rejects.toMatchObject({
			_tag: "WorktreeNotFoundError",
			worktreeId: missingWorktreeId,
		});
		await expect(
			run((service) => service.create(FolderId.make("missing-project"))),
		).rejects.toMatchObject({
			_tag: "WorktreeCreateError",
			reason: "project not found",
		});
	});
});
