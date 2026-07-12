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
import type { FolderId, RepositorySettingsFile } from "@zuse/contracts";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, it } from "vitest";

import { Migration0001Initial } from "../../src/persistence/migrations/0001_initial.ts";
import { Migration0008WorktreesAndRepoSettings } from "../../src/persistence/migrations/0008_worktrees_and_repo_settings.ts";
import { RepositorySettingsServiceLive } from "../../src/repository-settings/layers/repository-settings-service.ts";
import { RepositorySettingsService } from "../../src/repository-settings/services/repository-settings-service.ts";

const PROJECT_ID = "repo-settings-project" as FolderId;

const runMigrations = Effect.all(
	[Migration0001Initial, Migration0008WorktreesAndRepoSettings],
	{ discard: true },
);

const makeRuntime = (dbPath: string) => {
	const SqlLive = sqliteLayer({ filename: dbPath });
	const Migrated = Layer.effectDiscard(runMigrations).pipe(
		Layer.provideMerge(SqlLive),
	);
	const TestLayer = RepositorySettingsServiceLive.pipe(
		Layer.provideMerge(Migrated),
	);
	return ManagedRuntime.make(TestLayer);
};

const tempDirs: string[] = [];

const withRuntime = async <A>(
	fn: (args: {
		run: <X>(
			eff: Effect.Effect<
				X,
				unknown,
				RepositorySettingsService | SqlClient.SqlClient
			>,
		) => Promise<X>;
		repoPath: string;
	}) => Promise<A>,
): Promise<A> => {
	const dir = mkdtempSync(join(tmpdir(), "mz-repo-settings-"));
	tempDirs.push(dir);
	const repoPath = join(dir, "repo");
	mkdirSync(repoPath, { recursive: true });
	const runtime = makeRuntime(join(dir, "test.sqlite"));
	const run = <X>(
		eff: Effect.Effect<
			X,
			unknown,
			RepositorySettingsService | SqlClient.SqlClient
		>,
	): Promise<X> => runtime.runPromise(eff as Effect.Effect<X, unknown, never>);
	await run(seedProject(repoPath));
	try {
		return await fn({ run, repoPath });
	} finally {
		await runtime.dispose();
	}
};

const seedProject = (repoPath: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`
      INSERT INTO projects (id, path, name, created_at, updated_at)
      VALUES (${PROJECT_ID}, ${repoPath}, 'repo', '2026-01-01T00:00:00.000Z',
              '2026-01-01T00:00:00.000Z')
    `;
	});

const settingsPath = (repoPath: string): string =>
	join(repoPath, ".zuse", "settings.json");
const tomlSettingsPath = (repoPath: string): string =>
	join(repoPath, ".zuse", "settings.toml");

const writeRepoSettings = (
	repoPath: string,
	value: Partial<RepositorySettingsFile> | string,
): void => {
	mkdirSync(join(repoPath, ".zuse"), { recursive: true });
	writeFileSync(
		settingsPath(repoPath),
		typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
		"utf8",
	);
};

const readRepoSettings = (repoPath: string): RepositorySettingsFile =>
	JSON.parse(
		readFileSync(settingsPath(repoPath), "utf8"),
	) as RepositorySettingsFile;

const readRepoSettingsToml = (repoPath: string): string =>
	readFileSync(tomlSettingsPath(repoPath), "utf8");

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("RepositorySettingsService repository file persistence", () => {
	it("returns defaults when no JSON, TOML, or legacy row exists", async () => {
		await withRuntime(async ({ run }) => {
			const settings = await run(
				Effect.flatMap(RepositorySettingsService, (svc) => svc.get(PROJECT_ID)),
			);

			expect(settings.defaultProviderId).toBeNull();
			expect(settings.autoCreateWorktree).toBe(false);
			expect(settings.environmentVariables).toEqual({});
		});
	});

	it("migrates an existing SQLite row into .zuse/settings.toml", async () => {
		await withRuntime(async ({ run, repoPath }) => {
			await run(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`
            INSERT INTO repository_settings
              (project_id, default_provider_id, default_model,
               default_runtime_mode, auto_create_worktree, worktree_base_dir,
               archive_cleanup_script, archive_remove_worktree, setup_script,
               run_script, auto_run_after_setup, environment_variables_json)
            VALUES
              (${PROJECT_ID}, 'codex', 'gpt-5-codex', 'full-access', 1,
               '/tmp/worktrees', 'echo archive', 1, 'bun install',
               'bun dev', 1, '{"NODE_ENV":"development"}')
          `;
				}),
			);

			const settings = await run(
				Effect.flatMap(RepositorySettingsService, (svc) => svc.get(PROJECT_ID)),
			);
			const rows = await run(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					return yield* sql<{ readonly count: number }>`
            SELECT count(*) AS count FROM repository_settings
            WHERE project_id = ${PROJECT_ID}
          `;
				}),
			);

			expect(settings.defaultProviderId).toBe("codex");
			expect(settings.autoCreateWorktree).toBe(true);
			expect(settings.archiveRemoveWorktree).toBe(true);
			expect(settings.environmentVariables.NODE_ENV).toBe("development");
			expect(existsSync(tomlSettingsPath(repoPath))).toBe(true);
			expect(readRepoSettingsToml(repoPath)).toContain('run = "bun dev"');
			expect(rows[0]?.count).toBe(0);
		});
	});

	it("lets JSON override legacy TOML values", async () => {
		await withRuntime(async ({ run, repoPath }) => {
			mkdirSync(join(repoPath, ".zuse"), { recursive: true });
			writeFileSync(
				join(repoPath, ".zuse", "settings.toml"),
				[
					"[scripts]",
					'run = "bun dev"',
					"",
					"[environment_variables]",
					'NODE_ENV = "development"',
				].join("\n"),
				"utf8",
			);
			writeRepoSettings(repoPath, {
				schemaVersion: 1,
				runScript: "pnpm dev",
				environmentVariables: { NODE_ENV: "test" },
			});

			const settings = await run(
				Effect.flatMap(RepositorySettingsService, (svc) => svc.get(PROJECT_ID)),
			);

			expect(settings.runScript).toBe("pnpm dev");
			expect(settings.environmentVariables.NODE_ENV).toBe("test");
		});
	});

	it("uses TOML scripts and env when JSON is absent", async () => {
		await withRuntime(async ({ run, repoPath }) => {
			mkdirSync(join(repoPath, ".zuse"), { recursive: true });
			writeFileSync(
				join(repoPath, ".zuse", "settings.toml"),
				[
					"file_include_globs = [",
					'  ".env",',
					'  ".env.local",',
					"]",
					"",
					"",
					"[scripts]",
					'setup = "bun install"',
					'run = "bun dev"',
					"auto_run_after_setup = true",
					"",
					"[environment_variables]",
					'API_BASE = "http://localhost:3000"',
				].join("\n"),
				"utf8",
			);

			const settings = await run(
				Effect.flatMap(RepositorySettingsService, (svc) => svc.get(PROJECT_ID)),
			);

			expect(settings.setupScript).toBe("bun install");
			expect(settings.runScript).toBe("bun dev");
			expect(settings.autoRunAfterSetup).toBe(true);
			expect(settings.fileIncludeGlobs).toBe(".env\n.env.local");
			expect(settings.environmentVariables.API_BASE).toBe(
				"http://localhost:3000",
			);
		});
	});

	it("still reads legacy root file_include_globs strings", async () => {
		await withRuntime(async ({ run, repoPath }) => {
			mkdirSync(join(repoPath, ".zuse"), { recursive: true });
			writeFileSync(
				join(repoPath, ".zuse", "settings.toml"),
				'file_include_globs = ".env\\n.env.local\\n"\n',
				"utf8",
			);

			const settings = await run(
				Effect.flatMap(RepositorySettingsService, (svc) => svc.get(PROJECT_ID)),
			);

			expect(settings.fileIncludeGlobs).toBe(".env\n.env.local\n");
		});
	});

	it("still reads legacy file_include_globs tables", async () => {
		await withRuntime(async ({ run, repoPath }) => {
			mkdirSync(join(repoPath, ".zuse"), { recursive: true });
			writeFileSync(
				join(repoPath, ".zuse", "settings.toml"),
				[
					"[file_include_globs]",
					'env = ".env"',
					'env_local = ".env.local"',
				].join("\n"),
				"utf8",
			);

			const settings = await run(
				Effect.flatMap(RepositorySettingsService, (svc) => svc.get(PROJECT_ID)),
			);

			expect(settings.fileIncludeGlobs).toBe(".env\n.env.local");
		});
	});

	it("uses .worktreeinclude as a legacy include fallback", async () => {
		await withRuntime(async ({ run, repoPath }) => {
			writeFileSync(
				join(repoPath, ".worktreeinclude"),
				"# local files\n.env\n.env.local\n",
				"utf8",
			);

			const settings = await run(
				Effect.flatMap(RepositorySettingsService, (svc) => svc.get(PROJECT_ID)),
			);

			expect(settings.fileIncludeGlobs).toBe(".env\n.env.local");
		});
	});

	it("handles invalid and partial JSON without crashing", async () => {
		await withRuntime(async ({ run, repoPath }) => {
			writeRepoSettings(repoPath, "{ nope");
			const invalid = await run(
				Effect.flatMap(RepositorySettingsService, (svc) => svc.get(PROJECT_ID)),
			);
			expect(invalid.runScript).toBeNull();

			writeRepoSettings(repoPath, { schemaVersion: 1, runScript: "bun dev" });
			const partial = await run(
				Effect.flatMap(RepositorySettingsService, (svc) => svc.get(PROJECT_ID)),
			);
			expect(partial.defaultProviderId).toBeNull();
			expect(partial.runScript).toBe("bun dev");
		});
	});

	it("updates TOML atomically while preserving unspecified fields", async () => {
		await withRuntime(async ({ run, repoPath }) => {
			writeRepoSettings(repoPath, {
				schemaVersion: 1,
				defaultProviderId: "claude",
				runScript: "bun dev",
				fileIncludeGlobs: ".env\n",
			});

			const settings = await run(
				Effect.flatMap(RepositorySettingsService, (svc) =>
					svc.update(PROJECT_ID, { autoRunAfterSetup: true }),
				),
			);
			const toml = readRepoSettingsToml(repoPath);

			expect(settings.defaultProviderId).toBe("claude");
			expect(settings.runScript).toBe("bun dev");
			expect(settings.autoRunAfterSetup).toBe(true);
			expect(existsSync(settingsPath(repoPath))).toBe(false);
			expect(toml).toContain('defaultProviderId = "claude"');
			expect(toml).toContain('run = "bun dev"');
			expect(toml).toContain("auto_run_after_setup = true");
			expect(toml).toContain("file_include_globs = [");
			expect(toml).toContain('  ".env",');
		});
	});
});
