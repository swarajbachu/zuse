import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as Path from "node:path";
import { NodeServices } from "@effect/platform-node";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceServiceLive } from "../../src/workspace/layers/workspace-service.ts";
import { prepareProjectRegistration } from "../../src/workspace/project-registration.ts";
import { WorkspaceService } from "../../src/workspace/services/workspace-service.ts";

describe("prepareProjectRegistration", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(
			Path.join(os.tmpdir(), "zuse-project-registration-"),
		);
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("adds .context to an existing .gitignore", async () => {
		await fs.writeFile(Path.join(dir, ".gitignore"), "node_modules\n");

		await prepareProjectRegistration(dir);

		expect(await fs.readFile(Path.join(dir, ".gitignore"), "utf8")).toBe(
			"node_modules\n.context\n",
		);
	});

	it("creates .gitignore when missing", async () => {
		await prepareProjectRegistration(dir);

		expect(await fs.readFile(Path.join(dir, ".gitignore"), "utf8")).toBe(
			".context\n",
		);
	});

	it("creates a commented .zuse/settings.toml when missing", async () => {
		await prepareProjectRegistration(dir);

		const content = await fs.readFile(
			Path.join(dir, ".zuse", "settings.toml"),
			"utf8",
		);
		expect(content).toContain("Zuse repository settings");
		expect(content).toContain("file_include_globs");
	});

	it("does not overwrite an existing .zuse/settings.toml", async () => {
		await fs.mkdir(Path.join(dir, ".zuse"), { recursive: true });
		await fs.writeFile(Path.join(dir, ".zuse", "settings.toml"), "custom");

		await prepareProjectRegistration(dir);

		expect(
			await fs.readFile(Path.join(dir, ".zuse", "settings.toml"), "utf8"),
		).toBe("custom");
	});

	it("does not duplicate .context", async () => {
		await fs.writeFile(Path.join(dir, ".gitignore"), ".context\n");

		await prepareProjectRegistration(dir);
		await prepareProjectRegistration(dir);

		expect(await fs.readFile(Path.join(dir, ".gitignore"), "utf8")).toBe(
			".context\n",
		);
	});

	it("removes only project-local SQLite artifacts", async () => {
		await fs.mkdir(Path.join(dir, ".zuse", "nested"), { recursive: true });
		await fs.mkdir(Path.join(dir, ".memoize"), { recursive: true });
		await fs.writeFile(Path.join(dir, ".zuse", "index.sqlite"), "");
		await fs.writeFile(Path.join(dir, ".zuse", "index.sqlite-shm"), "");
		await fs.writeFile(Path.join(dir, ".zuse", "index.sqlite-wal"), "");
		await fs.writeFile(Path.join(dir, ".zuse", "nested", "cache.sqlite"), "");
		await fs.writeFile(Path.join(dir, ".zuse", "settings.toml"), "");
		await fs.writeFile(Path.join(dir, ".memoize", "legacy.sqlite"), "");
		await fs.writeFile(Path.join(dir, ".memoize", "notes.txt"), "");

		await prepareProjectRegistration(dir);

		expect(await exists(Path.join(dir, ".zuse", "index.sqlite"))).toBe(false);
		expect(await exists(Path.join(dir, ".zuse", "index.sqlite-shm"))).toBe(
			false,
		);
		expect(await exists(Path.join(dir, ".zuse", "index.sqlite-wal"))).toBe(
			false,
		);
		expect(
			await exists(Path.join(dir, ".zuse", "nested", "cache.sqlite")),
		).toBe(false);
		expect(await exists(Path.join(dir, ".zuse", "settings.toml"))).toBe(true);
		expect(await exists(Path.join(dir, ".memoize", "legacy.sqlite"))).toBe(
			false,
		);
		expect(await exists(Path.join(dir, ".memoize", "notes.txt"))).toBe(true);
	});
});

describe("WorkspaceServiceLive project registration", () => {
	let dir: string;
	let runtime: ManagedRuntime.ManagedRuntime<
		WorkspaceService | SqlClient.SqlClient,
		SqlError
	>;

	beforeEach(async () => {
		dir = await fs.mkdtemp(Path.join(os.tmpdir(), "zuse-workspace-add-"));
		const SqlLive = sqliteLayer({ filename: ":memory:" });
		const TestLayer = Layer.mergeAll(
			SqlLive,
			WorkspaceServiceLive.pipe(
				Layer.provide(SqlLive),
				Layer.provide(NodeServices.layer),
			),
		);
		runtime = ManagedRuntime.make(TestLayer);
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
          CREATE TABLE projects (
            id TEXT PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            workspace_key TEXT NOT NULL DEFAULT 'personal'
          )
        `;
				yield* sql`
          CREATE TABLE app_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          )
        `;
			}),
		);
	});

	afterEach(async () => {
		await runtime.dispose();
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("prepares .gitignore during workspace add", async () => {
		await runtime.runPromise(
			Effect.flatMap(WorkspaceService, (workspace) => workspace.add(dir)),
		);

		expect(await fs.readFile(Path.join(dir, ".gitignore"), "utf8")).toBe(
			".context\n",
		);
	});

	it("records Personal by default and the requested organization otherwise", async () => {
		const other = await fs.mkdtemp(Path.join(os.tmpdir(), "zuse-org-add-"));
		try {
			const [personal, org, listed] = await runtime.runPromise(
				Effect.gen(function* () {
					const workspace = yield* WorkspaceService;
					const personal = yield* workspace.add(dir);
					const org = yield* workspace.add(other, {
						workspaceKey: "organization:org_1",
					});
					return [personal, org, yield* workspace.list()] as const;
				}),
			);
			expect(personal.workspaceKey).toBe("personal");
			expect(org.workspaceKey).toBe("organization:org_1");
			expect(listed.map((folder) => folder.workspaceKey)).toEqual([
				"personal",
				"organization:org_1",
			]);
		} finally {
			await fs.rm(other, { recursive: true, force: true });
		}
	});

	it("reports the owning workspace when a path is registered elsewhere", async () => {
		const error = await runtime.runPromise(
			Effect.gen(function* () {
				const workspace = yield* WorkspaceService;
				const personal = yield* workspace.add(dir);
				const failure = yield* Effect.flip(
					workspace.add(dir, { workspaceKey: "organization:org_1" }),
				);
				return { personal, failure };
			}),
		);
		expect(error.failure._tag).toBe("WorkspaceDuplicatePathError");
		if (error.failure._tag !== "WorkspaceDuplicatePathError") return;
		expect(error.failure.folderId).toBe(error.personal.id);
		expect(error.failure.workspaceKey).toBe("personal");
	});

	it("moves a project between workspaces only from the expected owner", async () => {
		const result = await runtime.runPromise(
			Effect.gen(function* () {
				const workspace = yield* WorkspaceService;
				const personal = yield* workspace.add(dir);
				const stale = yield* Effect.flip(
					workspace.add(dir, {
						workspaceKey: "organization:org_1",
						moveFrom: "organization:org_2",
					}),
				);
				const moved = yield* workspace.add(dir, {
					workspaceKey: "organization:org_1",
					moveFrom: "personal",
				});
				return { personal, stale, moved, stored: yield* workspace.list() };
			}),
		);
		expect(result.stale._tag).toBe("WorkspaceDuplicatePathError");
		expect(result.moved.id).toBe(result.personal.id);
		expect(result.moved.workspaceKey).toBe("organization:org_1");
		expect(result.stored).toHaveLength(1);
		expect(result.stored[0]?.workspaceKey).toBe("organization:org_1");
	});
});

const exists = async (filePath: string): Promise<boolean> => {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
};
