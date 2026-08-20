import { createHash } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { NodeServices } from "@effect/platform-node";
import {
	CommandId,
	Folder,
	FolderId,
	FsCommandReuseError,
} from "@zuse/contracts";
import { WorktreeService } from "@zuse/git/worktree-service";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Layer, ManagedRuntime, Result, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FsServiceLive } from "../../src/fs/layers/fs-service.ts";
import { FsService } from "../../src/fs/services/fs-service.ts";
import { Migration0048FsWriteReceipts } from "../../src/persistence/migrations/0048_fs_write_receipts.ts";
import { WorkspaceService } from "../../src/workspace/services/workspace-service.ts";

const folderId = FolderId.make("folder-1");
const hash = (content: string): string =>
	createHash("sha256").update(content).digest("hex");

const commandId = (value: string) => CommandId.make(value);

const makeRuntime = (root: string) => {
	const SqlLive = sqliteLayer({ filename: ":memory:" });
	const WorkspaceLive = Layer.succeed(WorkspaceService, {
		add: () => Effect.die("not used"),
		list: () => Effect.succeed([]),
		streamChanges: () => Stream.die("not used"),
		remove: () => Effect.die("not used"),
		getSelected: () => Effect.succeed(null),
		setSelected: () => Effect.void,
		findById: (requestedId) =>
			Effect.succeed(
				requestedId === folderId
					? Folder.make({
							id: folderId,
							path: root,
							name: "fixture",
							addedAt: new Date("2026-01-01T00:00:00.000Z"),
						})
					: null,
			),
	});
	const WorktreeLive = Layer.succeed(WorktreeService, {
		create: () => Effect.die("not used"),
		list: () => Effect.succeed([]),
		get: () => Effect.succeed(null),
		renameBranch: () => Effect.die("not used"),
		archive: () => Effect.die("not used"),
		remove: () => Effect.die("not used"),
		rerunSetup: () => Effect.die("not used"),
		setupStream: () => Stream.die("not used"),
		startRun: () => Effect.die("not used"),
		restore: () => Effect.die("not used"),
	});
	const Dependencies = Layer.mergeAll(
		SqlLive,
		NodeServices.layer,
		WorkspaceLive,
		WorktreeLive,
	);
	return ManagedRuntime.make(
		Layer.mergeAll(
			Dependencies,
			FsServiceLive.pipe(Layer.provide(Dependencies)),
		),
	);
};

describe("filesystem write receipts", () => {
	let root: string;
	let runtime: ReturnType<typeof makeRuntime>;

	beforeEach(async () => {
		root = await nodeFs.mkdtemp(nodePath.join(os.tmpdir(), "zuse-fs-write-"));
		runtime = makeRuntime(root);
		await runtime.runPromise(Migration0048FsWriteReceipts);
	});

	afterEach(async () => {
		await runtime.dispose();
		await nodeFs.rm(root, { recursive: true, force: true });
	});

	it("creates the durable intent and identity columns", async () => {
		const columns = await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql<{ readonly name: string }>`
					PRAGMA table_info(fs_write_receipts)
				`;
			}),
		);

		expect(columns.map(({ name }) => name)).toEqual([
			"command_id",
			"folder_id",
			"worktree_id",
			"path",
			"expected_mtime",
			"content_hash",
			"state",
			"mtime",
			"created_at",
			"updated_at",
		]);
	});

	it("returns the stored receipt after a response is lost", async () => {
		const target = nodePath.join(root, "notes.txt");
		await nodeFs.writeFile(target, "before");
		const service = await runtime.runPromise(FsService);
		const initial = await runtime.runPromise(
			service.readFile(folderId, "notes.txt"),
		);
		if (initial.kind !== "text") throw new Error("expected text fixture");
		const id = commandId("write-lost-response");
		const receipt = await runtime.runPromise(
			service.writeFile(id, folderId, "notes.txt", "accepted", initial.mtime),
		);

		await nodeFs.writeFile(target, "later external edit");
		const retried = await runtime.runPromise(
			service.writeFile(id, folderId, "notes.txt", "accepted", initial.mtime),
		);

		expect(retried).toEqual(receipt);
		expect(await nodeFs.readFile(target, "utf8")).toBe("later external edit");
	});

	it("finalizes a prepared receipt when the file write survived a crash", async () => {
		const target = nodePath.join(root, "crash.txt");
		await nodeFs.writeFile(target, "before");
		const service = await runtime.runPromise(FsService);
		const initial = await runtime.runPromise(
			service.readFile(folderId, "crash.txt"),
		);
		if (initial.kind !== "text") throw new Error("expected text fixture");
		const id = commandId("write-crash-window");
		const desired = "content already replaced";

		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const now = Date.now();
				yield* sql`
					INSERT INTO fs_write_receipts
						(command_id, folder_id, worktree_id, path, expected_mtime,
						 content_hash, state, mtime, created_at, updated_at)
					VALUES
						(${id}, ${folderId}, NULL, 'crash.txt', ${initial.mtime},
						 ${hash(desired)}, 'prepared', NULL, ${now}, ${now})
				`;
			}),
		);
		await nodeFs.writeFile(target, desired);

		const receipt = await runtime.runPromise(
			service.writeFile(id, folderId, "crash.txt", desired, initial.mtime),
		);
		const rows = await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql<{
					readonly state: string;
					readonly mtime: string | null;
				}>`
					SELECT state, mtime FROM fs_write_receipts
					WHERE command_id = ${id}
				`;
			}),
		);

		expect(rows).toEqual([{ state: "applied", mtime: receipt.mtime }]);
		expect(await nodeFs.readFile(target, "utf8")).toBe(desired);
	});

	it("rejects command id reuse with another payload or target", async () => {
		await nodeFs.writeFile(nodePath.join(root, "one.txt"), "one");
		await nodeFs.writeFile(nodePath.join(root, "two.txt"), "two");
		const service = await runtime.runPromise(FsService);
		const initial = await runtime.runPromise(
			service.readFile(folderId, "one.txt"),
		);
		if (initial.kind !== "text") throw new Error("expected text fixture");
		const id = commandId("reused-write-command");
		await runtime.runPromise(
			service.writeFile(id, folderId, "one.txt", "updated", initial.mtime),
		);

		const payloadFailure = await runtime.runPromise(
			Effect.flip(
				service.writeFile(id, folderId, "one.txt", "different", initial.mtime),
			),
		);
		const targetFailure = await runtime.runPromise(
			Effect.flip(
				service.writeFile(id, folderId, "two.txt", "updated", initial.mtime),
			),
		);

		expect(payloadFailure).toEqual(
			new FsCommandReuseError({ commandId: id, reason: "payload-mismatch" }),
		);
		expect(targetFailure).toEqual(
			new FsCommandReuseError({ commandId: id, reason: "target-mismatch" }),
		);
		expect(await nodeFs.readFile(nodePath.join(root, "two.txt"), "utf8")).toBe(
			"two",
		);
	});

	it("serializes writes to one target so a stale concurrent write conflicts", async () => {
		const target = nodePath.join(root, "shared.txt");
		await nodeFs.writeFile(target, "before");
		const oldTime = new Date("2020-01-01T00:00:00.000Z");
		await nodeFs.utimes(target, oldTime, oldTime);
		const service = await runtime.runPromise(FsService);
		const initial = await runtime.runPromise(
			service.readFile(folderId, "shared.txt"),
		);
		if (initial.kind !== "text") throw new Error("expected text fixture");

		const results = await Promise.all([
			runtime.runPromise(
				Effect.result(
					service.writeFile(
						commandId("concurrent-write-a"),
						folderId,
						"shared.txt",
						"first",
						initial.mtime,
					),
				),
			),
			runtime.runPromise(
				Effect.result(
					service.writeFile(
						commandId("concurrent-write-b"),
						folderId,
						"shared.txt",
						"second",
						initial.mtime,
					),
				),
			),
		]);

		expect(results.filter(Result.isSuccess)).toHaveLength(1);
		const failure = results.find(Result.isFailure);
		expect(failure?._tag).toBe("Failure");
		if (failure !== undefined && Result.isFailure(failure)) {
			expect(failure.failure._tag).toBe("FsConflictError");
		}
		expect(["first", "second"]).toContain(
			await nodeFs.readFile(target, "utf8"),
		);
	});

	it("prunes expired receipts while accepting a new intent", async () => {
		const target = nodePath.join(root, "active.txt");
		await nodeFs.writeFile(target, "before");
		const service = await runtime.runPromise(FsService);
		const initial = await runtime.runPromise(
			service.readFile(folderId, "active.txt"),
		);
		if (initial.kind !== "text") throw new Error("expected text fixture");
		const expiredId = commandId("expired-write-receipt");

		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO fs_write_receipts
						(command_id, folder_id, worktree_id, path, expected_mtime,
						 content_hash, state, mtime, created_at, updated_at)
					VALUES
						(${expiredId}, ${folderId}, NULL, 'old.txt', 'old',
						 ${hash("old")}, 'applied', 'old', 0, 0)
				`;
			}),
		);
		await runtime.runPromise(
			service.writeFile(
				commandId("new-write-receipt"),
				folderId,
				"active.txt",
				"after",
				initial.mtime,
			),
		);

		const rows = await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql`
					SELECT command_id FROM fs_write_receipts
					WHERE command_id = ${expiredId}
				`;
			}),
		);
		expect(rows).toEqual([]);
	});
});
