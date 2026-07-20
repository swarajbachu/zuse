import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { FolderId, WorktreeCheckpointError, WorktreeId } from "@zuse/contracts";
import { layer as sqliteLayer } from "@zuse/sqlite";
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
} from "../../../src/worktree/ports.ts";
import { WorktreeService } from "../../../src/worktree/worktree-service.ts";
import { WorktreeServiceLive } from "../../../src/worktree/worktree-service-live.ts";

const projectId = FolderId.make("project-1");

const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("WorktreeServiceLive", () => {
	let temporaryRoot = "";
	let repositoryRoot = "";
	let worktreeRoot = "";
	let setupScript: string | null = null;
	let originalHome: string | undefined;
	let originalGitConfigGlobal: string | undefined;
	let runtime: ManagedRuntime.ManagedRuntime<
		WorktreeService | SqlClient.SqlClient,
		SqlError
	>;

	beforeEach(async () => {
		temporaryRoot = mkdtempSync(join(tmpdir(), "zuse-worktree-service-"));
		originalHome = process.env.HOME;
		originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
		process.env.HOME = temporaryRoot;
		process.env.GIT_CONFIG_GLOBAL = "/dev/null";
		repositoryRoot = join(temporaryRoot, "repository");
		worktreeRoot = join(temporaryRoot, "worktrees");
		setupScript = null;
		git(temporaryRoot, "init", "--initial-branch=main", repositoryRoot);
		git(repositoryRoot, "config", "user.name", "Test User");
		git(repositoryRoot, "config", "user.email", "test@example.com");
		writeFileSync(join(repositoryRoot, "README.md"), "initial\n");
		writeFileSync(join(repositoryRoot, ".gitignore"), ".context\n");
		git(repositoryRoot, "add", "README.md", ".gitignore");
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
				yield* sql`
					CREATE TABLE attachments (
						id TEXT PRIMARY KEY,
						abs_path TEXT
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

		const WorktreeLive = WorktreeServiceLive.pipe(
			Layer.provide(PortsLive),
			Layer.provide(MigratedSql),
			Layer.provide(NodeServices.layer),
		);
		runtime = ManagedRuntime.make(Layer.merge(WorktreeLive, MigratedSql));
		await runtime.runPromise(Effect.void);
	});

	afterEach(async () => {
		await runtime.dispose();
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalGitConfigGlobal === undefined)
			delete process.env.GIT_CONFIG_GLOBAL;
		else process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal;
		rmSync(temporaryRoot, { recursive: true, force: true });
	});

	const run = <A, E>(
		operation: (service: WorktreeService["Service"]) => Effect.Effect<A, E>,
	) => runtime.runPromise(Effect.flatMap(WorktreeService, operation));
	const runSql = <A, E>(
		operation: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>,
	) => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, operation));

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
		await run((service) => service.remove(created.id));
		expect(await run((service) => service.get(created.id))).toBeNull();

		const restored = await run((service) => service.restore(snapshot));
		expect(restored).toMatchObject({ id: created.id, setupStatus: "pending" });
	});

	test("archives dirty state as a checkpoint and restores it as uncommitted changes", async () => {
		const created = await run((service) => service.create(projectId));
		writeFileSync(join(created.path, "dirty.txt"), "dirty\n");
		const beforeArchive = git(created.path, "rev-parse", "HEAD");

		const checkpoint = await run((service) => service.archive(created.id));
		expect(checkpoint).toMatchObject({
			checkpointCreated: true,
			archiveRef: null,
			branch: created.branch,
		});
		expect(existsSync(created.path)).toBe(false);
		expect(await run((service) => service.get(created.id))).toBeNull();
		expect(
			git(
				repositoryRoot,
				"show",
				"-s",
				"--format=%B",
				checkpoint.archiveCommit,
			),
		).toContain(`Zuse-Archive-Checkpoint: ${created.id}`);

		const restored = await run((service) =>
			service.restore({
				...checkpoint,
				id: created.id,
				projectId: created.projectId,
				path: created.path,
				name: created.name,
				branch: created.branch,
				baseBranch: created.baseBranch,
				createdAt: created.createdAt,
			}),
		);
		expect(restored.setupStatus).toBe("pending");
		expect(git(created.path, "rev-parse", "HEAD")).toBe(beforeArchive);
		expect(git(created.path, "status", "--short")).toContain("?? dirty.txt");
		const setupEvents = await run((service) =>
			service.setupStream(created.id).pipe(Stream.runCollect),
		);
		expect(
			[...setupEvents]
				.filter((event) => event._tag === "status")
				.map((event) => event.status),
		).toContain("skipped");
	});

	test("archives a clean worktree without creating a checkpoint commit", async () => {
		const created = await run((service) => service.create(projectId));
		await run((service) =>
			service.setupStream(created.id).pipe(Stream.runCollect),
		);
		const beforeArchive = git(created.path, "rev-parse", "HEAD");

		const outcome = await run((service) => service.archive(created.id));

		expect(outcome).toMatchObject({
			archiveCommit: beforeArchive,
			checkpointCreated: false,
			archiveRef: null,
		});
		expect(
			git(repositoryRoot, "rev-parse", `refs/heads/${created.branch}`),
		).toBe(beforeArchive);
	});

	test("records a checkpoint before removal and retries without a second commit", async () => {
		const created = await run((service) => service.create(projectId));
		writeFileSync(join(created.path, "retry.txt"), "retry\n");
		let recordedCommit = "";

		await expect(
			run((service) =>
				service.archive(created.id, (outcome) =>
					Effect.sync(() => {
						recordedCommit = outcome.archiveCommit;
						expect(existsSync(created.path)).toBe(true);
					}).pipe(
						Effect.andThen(
							Effect.fail(
								new WorktreeCheckpointError({
									worktreeId: created.id,
									reason: "simulated journal interruption",
								}),
							),
						),
					),
				),
			),
		).rejects.toMatchObject({ _tag: "WorktreeCheckpointError" });
		expect(existsSync(created.path)).toBe(true);
		expect(await run((service) => service.get(created.id))).not.toBeNull();

		const retried = await run((service) => service.archive(created.id));
		expect(retried.archiveCommit).toBe(recordedCommit);
		expect(existsSync(created.path)).toBe(false);
	});

	test("pins and restores a detached checkpoint through an archive ref", async () => {
		const created = await run((service) => service.create(projectId));
		await run((service) =>
			service.setupStream(created.id).pipe(Stream.runCollect),
		);
		git(created.path, "checkout", "--detach");
		writeFileSync(join(created.path, "detached.txt"), "detached\n");

		const outcome = await run((service) => service.archive(created.id));
		expect(outcome.archiveRef).toBe(`refs/zuse/archive/${created.id}`);
		if (outcome.archiveRef === null)
			throw new Error("archive ref was not created");
		const archiveRef = outcome.archiveRef;
		expect(git(repositoryRoot, "rev-parse", archiveRef)).toBe(
			outcome.archiveCommit,
		);

		await run((service) =>
			service.restore({
				...outcome,
				id: created.id,
				projectId: created.projectId,
				path: created.path,
				name: created.name,
				baseBranch: created.baseBranch,
				createdAt: created.createdAt,
			}),
		);
		expect(git(created.path, "status", "--short")).toContain("?? detached.txt");
		expect(() =>
			git(repositoryRoot, "rev-parse", "--verify", archiveRef),
		).toThrow();
	});

	test("moves context files and attachment paths out of the checkout and back", async () => {
		const created = await run((service) => service.create(projectId));
		await run((service) =>
			service.setupStream(created.id).pipe(Stream.runCollect),
		);
		const contextFile = join(created.path, ".context", "files", "note.txt");
		mkdirSync(join(created.path, ".context", "files"), { recursive: true });
		writeFileSync(contextFile, "context survives\n");
		await runSql(
			(sql) =>
				sql`INSERT INTO attachments (id, abs_path) VALUES ('attachment-1', ${contextFile})`,
		);

		const outcome = await run((service) => service.archive(created.id));
		expect(outcome.archivedContextPath).not.toBeNull();
		if (outcome.archivedContextPath === null) {
			throw new Error("archived context path was not recorded");
		}
		expect(outcome.archivedContextPath).toBe(
			join(worktreeRoot, "archived", created.id),
		);
		const archivedFile = join(outcome.archivedContextPath, "files", "note.txt");
		expect(readFileSync(archivedFile, "utf8")).toBe("context survives\n");
		const archivedRows = await runSql(
			(sql) =>
				sql<{
					readonly abs_path: string;
				}>`SELECT abs_path FROM attachments WHERE id = 'attachment-1'`,
		);
		expect(archivedRows[0]?.abs_path).toBe(archivedFile);

		await run((service) =>
			service.restore({
				...outcome,
				id: created.id,
				projectId: created.projectId,
				path: created.path,
				name: created.name,
				baseBranch: created.baseBranch,
				createdAt: created.createdAt,
			}),
		);
		expect(readFileSync(contextFile, "utf8")).toBe("context survives\n");
		const restoredRows = await runSql(
			(sql) =>
				sql<{
					readonly abs_path: string;
				}>`SELECT abs_path FROM attachments WHERE id = 'attachment-1'`,
		);
		expect(restoredRows[0]?.abs_path).toBe(contextFile);
	});

	test("restores relocated context when archive removal is cancelled", async () => {
		const created = await run((service) => service.create(projectId));
		await run((service) =>
			service.setupStream(created.id).pipe(Stream.runCollect),
		);
		const contextFile = join(created.path, ".context", "files", "note.txt");
		const archivedContextPath = join(worktreeRoot, "archived", created.id);
		mkdirSync(join(created.path, ".context", "files"), { recursive: true });
		writeFileSync(contextFile, "context survives cancellation\n");
		await runSql(
			(sql) =>
				sql`INSERT INTO attachments (id, abs_path) VALUES ('attachment-cancelled', ${contextFile})`,
		);

		const outcome = await run((service) =>
			service.archive(created.id, undefined, () =>
				Effect.sync(() => !existsSync(archivedContextPath)),
			),
		);

		expect(outcome.archivedContextPath).toBeNull();
		expect(existsSync(created.path)).toBe(true);
		expect(readFileSync(contextFile, "utf8")).toBe(
			"context survives cancellation\n",
		);
		expect(existsSync(archivedContextPath)).toBe(false);
		const rows = await runSql(
			(sql) =>
				sql<{
					readonly abs_path: string;
				}>`SELECT abs_path FROM attachments WHERE id = 'attachment-cancelled'`,
		);
		expect(rows[0]?.abs_path).toBe(contextFile);
	});

	test("uses a local fallback identity for checkpoint commits", async () => {
		const created = await run((service) => service.create(projectId));
		await run((service) =>
			service.setupStream(created.id).pipe(Stream.runCollect),
		);
		git(repositoryRoot, "config", "--unset", "user.name");
		git(repositoryRoot, "config", "--unset", "user.email");
		git(repositoryRoot, "config", "user.useConfigOnly", "true");
		writeFileSync(join(created.path, "identity.txt"), "identity\n");

		const outcome = await run((service) => service.archive(created.id));

		expect(
			git(
				repositoryRoot,
				"show",
				"-s",
				"--format=%an <%ae>",
				outcome.archiveCommit,
			),
		).toBe("Zuse <zuse@localhost>");
	});

	test("keeps a checkpoint committed when its branch advances while archived", async () => {
		const created = await run((service) => service.create(projectId));
		await run((service) =>
			service.setupStream(created.id).pipe(Stream.runCollect),
		);
		writeFileSync(join(created.path, "checkpoint.txt"), "checkpoint\n");
		const outcome = await run((service) => service.archive(created.id));
		const advancedPath = join(temporaryRoot, "advanced");
		git(repositoryRoot, "worktree", "add", advancedPath, created.branch);
		writeFileSync(join(advancedPath, "advanced.txt"), "advanced\n");
		git(advancedPath, "add", "advanced.txt");
		git(advancedPath, "commit", "-m", "advance branch");
		const advancedCommit = git(advancedPath, "rev-parse", "HEAD");
		git(repositoryRoot, "worktree", "remove", advancedPath);

		await run((service) =>
			service.restore({
				...outcome,
				id: created.id,
				projectId: created.projectId,
				path: created.path,
				name: created.name,
				baseBranch: created.baseBranch,
				createdAt: created.createdAt,
			}),
		);
		expect(git(created.path, "rev-parse", "HEAD")).toBe(advancedCommit);
		expect(git(created.path, "status", "--short")).toBe("");
	});

	test("manual removal checkpoints dirty work instead of rejecting it", async () => {
		const created = await run((service) => service.create(projectId));
		await run((service) =>
			service.setupStream(created.id).pipe(Stream.runCollect),
		);
		writeFileSync(join(created.path, "manual.txt"), "manual\n");

		await run((service) => service.remove(created.id));

		expect(await run((service) => service.get(created.id))).toBeNull();
		expect(
			git(repositoryRoot, "show", "-s", "--format=%B", created.branch),
		).toContain(`Zuse-Archive-Checkpoint: ${created.id}`);
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
