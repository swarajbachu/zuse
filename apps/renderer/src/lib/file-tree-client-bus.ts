import type {
	ResourceDriver,
	ResourceLease,
} from "@zuse/client-runtime/client-bus";
import type {
	ClientCommand,
	CommandReceipt,
	PersistedResource,
	ResourcePersistence,
} from "@zuse/client-runtime/client-persistence";
import {
	type ExecutionRef,
	makeResourceKey,
	type ResourceKey,
	resourceKeyId,
} from "@zuse/client-runtime/resource-ref";
import type { ResourceView } from "@zuse/client-runtime/resource-state";
import type { EnvironmentId, FsTreeWatchEvent } from "@zuse/contracts";
import { CommandId } from "@zuse/contracts";
import { Cause, Effect, Fiber, Stream } from "effect";
import { reconcileFileTreePaths } from "./file-tree-reconciliation.ts";
import type { MemoizeClient } from "./rpc-client.ts";
import {
	getRendererClientBus,
	registerRendererResourceDriver,
	registerRendererResourcePersistence,
} from "./session-timeline-client-bus.ts";

export type FileTreeResourceData = Readonly<{
	paths: ReadonlyArray<string>;
	truncated: boolean;
}>;

export type FileTreeResourceKey = ResourceKey<FileTreeResourceData>;

export type FileTreeDriverClient = Pick<
	MemoizeClient,
	"fs.listPaths" | "fs.tree" | "fs.watchTree"
>;

export const fileTreeResourceKey = (ref: ExecutionRef): FileTreeResourceKey =>
	makeResourceKey<FileTreeResourceData>("file-tree", ref);

const hex = (bytes: Uint8Array): string =>
	Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * Stable identity for one optimistic-concurrency write. If the process exits
 * after the server writes but before the receipt reaches IndexedDB, reopening
 * and saving the same draft reuses the command ID and observes that receipt.
 */
export const fileWriteCommandId = async (input: {
	readonly ref: ExecutionRef;
	readonly path: string;
	readonly content: string;
	readonly expectedMtime: string;
}): Promise<CommandId> => {
	const encoded = new TextEncoder().encode(
		JSON.stringify([
			input.ref.environmentId,
			input.ref.folderId,
			input.ref.worktreeId,
			input.ref.rootPath,
			input.path,
			input.expectedMtime,
			input.content,
		]),
	);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
	return CommandId.make(`fs-write:v1:${hex(digest)}`);
};

/**
 * Sends a retry-safe file mutation through the environment's single command
 * lane. The qualified file-tree key serializes writes with the same execution
 * root and exposes pending/failure state to every retained file surface.
 */
export const dispatchFileTreeCommand = <Payload, Result>(input: {
	readonly ref: ExecutionRef;
	readonly kind:
		| "fs.readFile"
		| "fs.writeFile"
		| "fs.move"
		| "fs.createFile"
		| "fs.createDirectory"
		| "fs.remove";
	readonly commandId: ClientCommand["commandId"];
	readonly payload: Payload;
	readonly retry?: ClientCommand["retry"];
}): Promise<CommandReceipt<Result>> =>
	getRendererClientBus().dispatch({
		kind: input.kind,
		commandId: input.commandId,
		environmentId: input.ref.environmentId,
		resource: fileTreeResourceKey(input.ref),
		payload: input.payload,
		retry: input.retry ?? (input.kind === "fs.writeFile" ? "safe" : "never"),
		createdAt: Date.now(),
	});

const executionRefFromKey = (key: ResourceKey<unknown>): ExecutionRef | null =>
	key.kind === "file-tree" && "folderId" in key.ref ? key.ref : null;

const messageOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

const fullReconcile = (
	client: FileTreeDriverClient,
	ref: ExecutionRef,
): Effect.Effect<FileTreeResourceData, unknown> =>
	client["fs.listPaths"]({
		folderId: ref.folderId,
		worktreeId: ref.worktreeId,
	});

const applyChanges = (
	client: FileTreeDriverClient,
	ref: ExecutionRef,
	current: FileTreeResourceData,
	changedPaths: ReadonlyArray<string>,
): Effect.Effect<FileTreeResourceData, unknown> =>
	Effect.tryPromise({
		try: async () => {
			const result = await reconcileFileTreePaths({
				changedPaths,
				knownPaths: new Set(current.paths),
				listDirectory: (path) =>
					Effect.runPromise(
						client["fs.tree"]({
							folderId: ref.folderId,
							worktreeId: ref.worktreeId,
							path,
						}),
					),
			});
			if (result.requiresFullReconciliation) {
				return Effect.runPromise(fullReconcile(client, ref));
			}
			return {
				paths: [...result.paths],
				truncated: current.truncated,
			};
		},
		catch: (cause) => cause,
	});

class FileTreeContinuityGap extends Error {}

/**
 * Attaches the live watcher before reading the bounded snapshot. Watch frames
 * that race the snapshot are serialized behind it, so no accepted change is
 * skipped. A reconnect creates a fresh epoch and always reads a full snapshot;
 * watcher epochs are process-local and are never used for server replay.
 */
export const makeFileTreeResourceDriver = (options: {
	reportConnectionFailure: (
		environmentId: EnvironmentId,
		generation: number,
		cause: unknown,
	) => void;
}): ResourceDriver<FileTreeDriverClient, FileTreeResourceData> => {
	let fiber: Fiber.Fiber<unknown, unknown> | null = null;
	let active = false;

	return {
		start: (context) => {
			const ref = executionRefFromKey(context.key);
			if (ref === null) return;
			active = true;
			let data = context.data;
			let epoch: string | null = null;
			let sequence = 0;
			let synchronized = false;

			const emit = (
				next: FileTreeResourceData,
				sync: "synchronizing" | "live",
				persist: boolean,
			): boolean => {
				if (epoch === null) return false;
				const accepted = context.emit({
					data: next,
					cursor: { epoch, version: sequence },
					sync,
					persist,
					resetEpoch: context.cursor?.epoch !== epoch,
				});
				if (accepted) data = next;
				return accepted;
			};

			const handleWatchEvent = (
				event: FsTreeWatchEvent,
			): Effect.Effect<void, unknown> => {
				if (!active || !context.isCurrent()) return Effect.void;
				if (epoch === null) {
					epoch = event.epoch;
					sequence = event.sequence;
				} else if (event.epoch !== epoch) {
					return Effect.fail(
						new FileTreeContinuityGap("Watcher epoch changed"),
					);
				} else if (event.sequence <= sequence) {
					return Effect.void;
				} else if (event.sequence !== sequence + 1) {
					return Effect.fail(
						new FileTreeContinuityGap("Watcher sequence is discontinuous"),
					);
				} else {
					sequence = event.sequence;
				}

				if (event._tag === "gap") {
					return Effect.fail(new FileTreeContinuityGap(event.reason));
				}
				if (event._tag === "ready") {
					return fullReconcile(context.client, ref).pipe(
						Effect.flatMap((snapshot) =>
							Effect.sync(() => {
								if (!active || !context.isCurrent()) return;
								synchronized = true;
								emit(snapshot, "live", true);
							}),
						),
					);
				}
				if (!synchronized) {
					return Effect.fail(
						new FileTreeContinuityGap(
							"Change arrived before watcher readiness",
						),
					);
				}
				if (data === null) {
					return Effect.fail(
						new FileTreeContinuityGap(
							"Change arrived before watcher readiness",
						),
					);
				}
				return applyChanges(context.client, ref, data, event.paths).pipe(
					Effect.flatMap((next) =>
						Effect.sync(() => {
							if (!active || !context.isCurrent()) return;
							emit(next, "live", true);
						}),
					),
				);
			};

			const program = Stream.runForEach(
				context.client["fs.watchTree"]({
					folderId: ref.folderId,
					worktreeId: ref.worktreeId,
				}),
				handleWatchEvent,
			).pipe(
				Effect.andThen(
					Effect.fail(new FileTreeContinuityGap("File watcher ended")),
				),
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						if (!active || Cause.hasInterruptsOnly(cause)) return;
						options.reportConnectionFailure(
							ref.environmentId,
							context.generation,
							Cause.squash(cause),
						);
					}),
				),
			);
			fiber = Effect.runFork(Effect.yieldNow.pipe(Effect.andThen(program)));
		},
		stop: () => {
			active = false;
			const running = fiber;
			fiber = null;
			if (running !== null) void Effect.runPromise(Fiber.interrupt(running));
		},
	};
};

const DATABASE_NAME = "zuse-file-tree-resources";
const DATABASE_VERSION = 1;
const STORE_NAME = "resources";

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
	new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("IndexedDB request failed"));
	});

const transactionComplete = (transaction: IDBTransaction): Promise<void> =>
	new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
		transaction.onerror = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction failed"));
	});

class IndexedDbFileTreePersistence implements ResourcePersistence {
	private database: Promise<IDBDatabase> | null = null;

	private db(): Promise<IDBDatabase> {
		this.database ??= new Promise((resolve, reject) => {
			const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
			request.onupgradeneeded = () => {
				if (!request.result.objectStoreNames.contains(STORE_NAME)) {
					request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () =>
				reject(request.error ?? new Error("Unable to open file-tree cache"));
		});
		return this.database;
	}

	async loadResource<Data>(
		key: ResourceKey<Data>,
	): Promise<PersistedResource<Data> | null> {
		const database = await this.db();
		const transaction = database.transaction(STORE_NAME, "readonly");
		const row = (await requestResult(
			transaction.objectStore(STORE_NAME).get(resourceKeyId(key)),
		)) as
			| (PersistedResource<FileTreeResourceData> & { readonly key: string })
			| undefined;
		await transactionComplete(transaction);
		if (
			row === undefined ||
			!Array.isArray(row.data?.paths) ||
			typeof row.data.truncated !== "boolean"
		) {
			return null;
		}
		return {
			data: row.data as Data,
			cursor: row.cursor,
			storedAt: row.storedAt,
		};
	}

	async saveResource<Data>(
		key: ResourceKey<Data>,
		value: PersistedResource<Data>,
	): Promise<void> {
		const database = await this.db();
		const transaction = database.transaction(STORE_NAME, "readwrite");
		transaction.objectStore(STORE_NAME).put({
			key: resourceKeyId(key),
			...value,
		});
		await transactionComplete(transaction);
	}

	async removeResource(key: ResourceKey<unknown>): Promise<void> {
		const database = await this.db();
		const transaction = database.transaction(STORE_NAME, "readwrite");
		transaction.objectStore(STORE_NAME).delete(resourceKeyId(key));
		await transactionComplete(transaction);
	}
}

const reportConnectionFailure = (
	environmentId: EnvironmentId,
	generation: number,
	cause: unknown,
): void => {
	getRendererClientBus().reportConnectionFault(
		environmentId,
		{ phase: "failed", message: messageOf(cause) },
		generation,
	);
};

const driverFactory = (key: ResourceKey<unknown>) =>
	key.kind === "file-tree"
		? (makeFileTreeResourceDriver({
				reportConnectionFailure,
			}) as ResourceDriver<MemoizeClient, unknown>)
		: null;

const fileTreePersistence =
	typeof indexedDB === "undefined" ? null : new IndexedDbFileTreePersistence();

registerRendererResourceDriver("file-tree", driverFactory);
if (fileTreePersistence !== null) {
	registerRendererResourcePersistence("file-tree", fileTreePersistence);
}

export const retainFileTreeResource = (
	refOrKey: ExecutionRef | FileTreeResourceKey,
): Readonly<{
	key: FileTreeResourceKey;
	lease: ResourceLease;
}> => {
	const key = "kind" in refOrKey ? refOrKey : fileTreeResourceKey(refOrKey);
	return {
		key,
		lease: getRendererClientBus().retain(key, { activation: "wake" }),
	};
};

export const fileTreeResourceSnapshot = (
	key: FileTreeResourceKey,
): ResourceView<FileTreeResourceData> => getRendererClientBus().snapshot(key);

export const subscribeFileTreeResource = (
	key: FileTreeResourceKey,
	listener: (view: ResourceView<FileTreeResourceData>) => void,
): (() => void) => getRendererClientBus().subscribe(key, listener);
