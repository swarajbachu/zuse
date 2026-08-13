import type {
	ResourceDriverContext,
	ResourceDriverUpdate,
} from "@zuse/client-runtime/client-bus";
import { ClientBus } from "@zuse/client-runtime/client-bus";
import { resourceKeyId } from "@zuse/client-runtime/resource-ref";
import {
	EnvironmentId,
	FolderId,
	FsEntry,
	type FsTreeWatchEvent,
} from "@zuse/contracts";
import { Effect, Queue, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
	type FileTreeDriverClient,
	type FileTreeResourceData,
	fileTreeResourceKey,
	makeFileTreeResourceDriver,
} from "../../src/lib/file-tree-client-bus.ts";

const waitUntil = async (predicate: () => boolean): Promise<void> => {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("condition was not reached");
};

const environmentId = EnvironmentId.make("files-environment");
const folderId = FolderId.make("files-folder");
const ref = {
	environmentId,
	folderId,
	worktreeId: null,
	rootPath: "/workspace/files-folder",
} as const;
const key = fileTreeResourceKey(ref);

const file = (path: string) =>
	FsEntry.make({
		name: path.split("/").at(-1) ?? path,
		path,
		kind: "file",
	});

const makeHarness = (input: {
	watch: Queue.Queue<FsTreeWatchEvent>;
	listPaths: () => Promise<FileTreeResourceData>;
	tree?: (path: string) => ReadonlyArray<FsEntry>;
	reportFailure?: (cause: unknown) => void;
}) => {
	const updates: ResourceDriverUpdate<FileTreeResourceData>[] = [];
	let data: FileTreeResourceData | null = null;
	let cursor: { epoch: string; version: number } | null = null;
	const client: FileTreeDriverClient = {
		"fs.watchTree": () => Stream.fromQueue(input.watch),
		"fs.listPaths": () => Effect.promise(input.listPaths),
		"fs.tree": ({ path }: { path?: string }) =>
			Effect.succeed(input.tree?.(path ?? "") ?? []),
	} as FileTreeDriverClient;
	const context: ResourceDriverContext<
		FileTreeDriverClient,
		FileTreeResourceData
	> = {
		key,
		client,
		generation: 1,
		data: null,
		cursor: null,
		snapshot: () => null,
		isCurrent: () => true,
		emit: (update) => {
			updates.push(update);
			if (update.data !== undefined) data = update.data;
			if (update.cursor !== undefined) cursor = update.cursor;
			return true;
		},
	};
	const driver = makeFileTreeResourceDriver({
		reportConnectionFailure: (_environment, _generation, cause) =>
			input.reportFailure?.(cause),
	});
	return { context, driver, updates, data: () => data, cursor: () => cursor };
};

describe("file-tree ClientBus resource", () => {
	it("shares one qualified stream across consumers", async () => {
		const watch = Effect.runSync(Queue.unbounded<FsTreeWatchEvent>());
		let resolves = 0;
		let streamStarts = 0;
		const client = {
			"fs.watchTree": () => {
				streamStarts += 1;
				return Stream.fromQueue(watch);
			},
			"fs.listPaths": () =>
				Effect.succeed({
					paths: ["README.md"],
					truncated: false,
				}),
			"fs.tree": () => Effect.succeed([]),
		};
		const bus = new ClientBus({
			resolver: {
				resolve: () => {
					resolves += 1;
					return Effect.succeed({ client, dispose: async () => undefined });
				},
			},
			driverFor: (resource) =>
				resource.kind === "file-tree"
					? (makeFileTreeResourceDriver({
							reportConnectionFailure: () => undefined,
						}) as never)
					: null,
		});
		const first = bus.retain(key, { activation: "connect" });
		const second = bus.retain(key, { activation: "wake" });
		await waitUntil(() => streamStarts === 1);
		Queue.offerUnsafe(watch, {
			_tag: "ready",
			epoch: "watch-1",
			sequence: 0,
		});
		await waitUntil(() => bus.snapshot(key).sync === "live");
		expect(resolves).toBe(1);
		expect(bus.snapshot(key).data?.paths).toEqual(["README.md"]);
		first.release();
		expect(streamStarts).toBe(1);
		second.release();
		await bus.dispose();
	});

	it("attaches before snapshot and applies a change buffered during the read", async () => {
		const watch = Effect.runSync(Queue.unbounded<FsTreeWatchEvent>());
		let finishSnapshot!: (value: FileTreeResourceData) => void;
		const snapshot = new Promise<FileTreeResourceData>((resolve) => {
			finishSnapshot = resolve;
		});
		const harness = makeHarness({
			watch,
			listPaths: () => snapshot,
			tree: (path) =>
				path === "src" ? [file("src/app.ts"), file("src/created.ts")] : [],
		});
		harness.driver.start(harness.context);
		await new Promise((resolve) => setTimeout(resolve, 0));
		Queue.offerUnsafe(watch, {
			_tag: "ready",
			epoch: "watch-buffer",
			sequence: 0,
		});
		Queue.offerUnsafe(watch, {
			_tag: "changed",
			epoch: "watch-buffer",
			sequence: 1,
			paths: ["src/created.ts"],
		});
		finishSnapshot({ paths: ["src/", "src/app.ts"], truncated: false });
		await waitUntil(
			() => harness.data()?.paths.includes("src/created.ts") ?? false,
		);
		expect(harness.cursor()).toEqual({ epoch: "watch-buffer", version: 1 });
		harness.driver.stop();
	});

	it("rejects a watcher sequence gap instead of publishing stale data", async () => {
		const watch = Effect.runSync(Queue.unbounded<FsTreeWatchEvent>());
		const failures: unknown[] = [];
		const harness = makeHarness({
			watch,
			listPaths: async () => ({ paths: ["README.md"], truncated: false }),
			reportFailure: (cause) => failures.push(cause),
		});
		harness.driver.start(harness.context);
		Queue.offerUnsafe(watch, {
			_tag: "ready",
			epoch: "watch-gap",
			sequence: 0,
		});
		await waitUntil(() => harness.data() !== null);
		Queue.offerUnsafe(watch, {
			_tag: "changed",
			epoch: "watch-gap",
			sequence: 2,
			paths: ["lost.ts"],
		});
		await waitUntil(() => failures.length === 1);
		expect(harness.data()?.paths).toEqual(["README.md"]);
		expect(String(failures[0])).toContain("discontinuous");
		harness.driver.stop();
	});

	it("keys the same folder independently by environment and root", () => {
		const otherEnvironment = fileTreeResourceKey({
			...ref,
			environmentId: EnvironmentId.make("files-environment-2"),
		});
		const otherRoot = fileTreeResourceKey({ ...ref, rootPath: "/other/root" });
		expect(resourceKeyId(otherEnvironment)).not.toBe(resourceKeyId(key));
		expect(resourceKeyId(otherRoot)).not.toBe(resourceKeyId(key));
	});
});
