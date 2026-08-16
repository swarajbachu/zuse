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
import type { ResourceActivation } from "@zuse/client-runtime/environment-runtime";
import {
	type EnvironmentRef,
	makeResourceKey,
	type ResourceKey,
	resourceKeyId,
} from "@zuse/client-runtime/resource-ref";
import type { ResourceView } from "@zuse/client-runtime/resource-state";
import { emptyResourceView } from "@zuse/client-runtime/resource-state";
import type {
	Chat,
	ChatCreationOperation,
	ChatCreationSummaryChange,
	ChatSummaryChange,
	CommandId,
	EnvironmentId,
	Folder,
	FolderId,
	GitOriginInfo,
	Session,
	SessionSummaryChange,
} from "@zuse/contracts";
import { EnvironmentId as EnvironmentIdSchema } from "@zuse/contracts";
import { Cause, Effect, Fiber, Stream } from "effect";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useSessionRuntimeStore } from "../store/session-runtime.ts";
import { upsertLatestEntity } from "./latest-entity.ts";
import type { MemoizeClient } from "./rpc-client.ts";
import {
	getRendererClientBus,
	registerRendererResourceDriver,
	registerRendererResourcePersistence,
} from "./session-timeline-client-bus.ts";
import { useClientBusResource } from "./use-client-bus-resource.ts";

export type EnvironmentShellData = Readonly<{
	folders: ReadonlyArray<Folder>;
	originsByFolder: Readonly<Record<string, GitOriginInfo | null>>;
	chatsByProject: Readonly<Record<string, ReadonlyArray<Chat>>>;
	sessionsByProject: Readonly<Record<string, ReadonlyArray<Session>>>;
	creationOperationsByProject: Readonly<
		Record<string, ReadonlyArray<ChatCreationOperation>>
	>;
}>;

export const normalizeEnvironmentShellData = (
	data: EnvironmentShellData,
): EnvironmentShellData => ({
	...data,
	creationOperationsByProject: data.creationOperationsByProject ?? {},
});

export type EnvironmentShellResourceKey = ResourceKey<EnvironmentShellData>;

export type EnvironmentShellDriverClient = Pick<
	MemoizeClient,
	| "workspace.streamChanges"
	| "chat.streamChanges"
	| "session.streamChanges"
	| "chat.creation.stream"
	| "git.origin"
>;

export const environmentShellResourceKey = (
	ref: EnvironmentRef,
): EnvironmentShellResourceKey =>
	makeResourceKey<EnvironmentShellData>("environment-shell", ref);

let nextDriverEpoch = 0;

const environmentRef = (key: ResourceKey<unknown>): EnvironmentRef | null =>
	key.kind === "environment-shell" && !("folderId" in key.ref) ? key.ref : null;

const foldersMatch = (
	left: ReadonlyArray<Folder>,
	right: ReadonlyArray<Folder>,
): boolean =>
	left.length === right.length &&
	left.every((folder) => right.some((candidate) => candidate.id === folder.id));

const resolveOrigins = async (
	client: EnvironmentShellDriverClient,
	folders: ReadonlyArray<Folder>,
	previous: EnvironmentShellData | null,
): Promise<Readonly<Record<string, GitOriginInfo | null>>> =>
	previous !== null && foldersMatch(previous.folders, folders)
		? previous.originsByFolder
		: Object.fromEntries(
				await Promise.all(
					folders.map(async (folder) => {
						const origin = await Effect.runPromise(
							client["git.origin"]({ folderId: folder.id }),
						).catch(() => null);
						return [folder.id, origin] as const;
					}),
				),
			);

type EnvironmentShellInput =
	| Readonly<{
			type: "workspace";
			folders: ReadonlyArray<Folder>;
			originsByFolder: Readonly<Record<string, GitOriginInfo | null>>;
	  }>
	| Readonly<{
			type: "chat";
			projectId: FolderId;
			change: ChatSummaryChange;
	  }>
	| Readonly<{
			type: "session";
			projectId: FolderId;
			change: SessionSummaryChange;
	  }>
	| Readonly<{
			type: "creation";
			projectId: FolderId;
			change: ChatCreationSummaryChange;
	  }>;

const emptyShell = (): EnvironmentShellData => ({
	folders: [],
	originsByFolder: {},
	chatsByProject: {},
	sessionsByProject: {},
	creationOperationsByProject: {},
});

const projectInputs = (
	client: EnvironmentShellDriverClient,
	folder: Folder,
): Stream.Stream<EnvironmentShellInput, unknown> =>
	Stream.mergeAll(
		[
			client["chat.streamChanges"]({ projectId: folder.id }).pipe(
				Stream.map(
					(change): EnvironmentShellInput => ({
						type: "chat",
						projectId: folder.id,
						change,
					}),
				),
			),
			client["session.streamChanges"]({ projectId: folder.id }).pipe(
				Stream.map(
					(change): EnvironmentShellInput => ({
						type: "session",
						projectId: folder.id,
						change,
					}),
				),
			),
			client["chat.creation.stream"]({ projectId: folder.id }).pipe(
				Stream.map(
					(change): EnvironmentShellInput => ({
						type: "creation",
						projectId: folder.id,
						change,
					}),
				),
			),
		],
		{ concurrency: "unbounded" },
	);

const shellInputs = (
	client: EnvironmentShellDriverClient,
	initial: EnvironmentShellData | null,
): Stream.Stream<EnvironmentShellInput, unknown> => {
	let previous = initial;
	return client["workspace.streamChanges"]({}).pipe(
		Stream.switchMap((folders) => {
			const workspace = Stream.fromEffect(
				Effect.tryPromise({
					try: async (): Promise<EnvironmentShellInput> => {
						const originsByFolder = await resolveOrigins(
							client,
							folders,
							previous,
						);
						previous = {
							...(previous ?? emptyShell()),
							folders,
							originsByFolder,
						};
						return { type: "workspace", folders, originsByFolder };
					},
					catch: (cause) => cause,
				}),
			);
			return Stream.concat(
				workspace,
				Stream.mergeAll(
					folders.map((folder) => projectInputs(client, folder)),
					{
						concurrency: "unbounded",
					},
				),
			);
		}),
	);
};

const pruneProjectMap = <Value>(
	map: Readonly<Record<string, Value>>,
	folders: ReadonlyArray<Folder>,
	empty: () => Value,
): Readonly<Record<string, Value>> =>
	Object.fromEntries(
		folders.map((folder) => [folder.id, map[folder.id] ?? empty()]),
	);

const chatSortTime = (chat: Chat): number =>
	(chat.updatedAt ?? chat.createdAt).getTime();

const upsertChat = (
	chats: ReadonlyArray<Chat>,
	chat: Chat,
): ReadonlyArray<Chat> =>
	[...upsertLatestEntity(chats, chat)].sort(
		(left, right) => chatSortTime(right) - chatSortTime(left),
	);

/**
 * One driver owns every environment-shell stream. Workspace frames switch the
 * qualified project subscriptions as one unit, and `runForEach` serializes all
 * reducer input so chat/session/creation summaries cannot race one another.
 * Each server stream subscribes before its snapshot, so switching the set of
 * projects does not open a snapshot/live gap and requires no feature polling.
 */
export const makeEnvironmentShellResourceDriver = (options: {
	reportConnectionFailure: (
		environmentId: EnvironmentId,
		generation: number,
		cause: unknown,
	) => void;
}): ResourceDriver<EnvironmentShellDriverClient, EnvironmentShellData> => {
	let fiber: Fiber.Fiber<unknown, unknown> | null = null;
	let active = false;

	return {
		start: (context) => {
			const ref = environmentRef(context.key);
			if (ref === null) return;
			active = true;
			let current: EnvironmentShellData = {
				...(context.data ?? emptyShell()),
				creationOperationsByProject:
					context.data?.creationOperationsByProject ?? {},
			};
			let version = 0;
			const chatReady = new Set<FolderId>();
			const sessionReady = new Set<FolderId>();
			const creationReady = new Set<FolderId>();
			const sessionCursorByProject = new Map<FolderId, number>();
			const epoch = `environment-shell:${context.generation}:${++nextDriverEpoch}`;
			const isLive = (): boolean =>
				current.folders.every(
					(folder) =>
						chatReady.has(folder.id) &&
						sessionReady.has(folder.id) &&
						creationReady.has(folder.id),
				);
			const emit = (): void => {
				if (!active || !context.isCurrent()) return;
				version += 1;
				context.emit({
					data: current,
					cursor: { epoch, version },
					resetEpoch: version === 1 && context.cursor?.epoch !== epoch,
					sync: isLive() ? "live" : "synchronizing",
					persist: isLive(),
				});
			};
			const applyInput = (input: EnvironmentShellInput): void => {
				if (!active || !context.isCurrent()) return;
				// Commands apply optimistic overlays to the same ClientBus cell. Fold the
				// currently visible value back into the serialized stream reducer before
				// applying the next durable frame, otherwise an unrelated frame could
				// resurrect this driver's pre-command snapshot.
				const visible = context.snapshot()?.data;
				if (visible !== null && visible !== undefined && visible !== current) {
					current = visible;
				}
				if (input.type === "workspace") {
					for (const ready of [chatReady, sessionReady, creationReady]) {
						// switchMap replaces every project stream for this workspace
						// frame. A prior readiness bit cannot prove the replacement stream
						// has delivered its subscribe-before-snapshot boundary.
						ready.clear();
					}
					sessionCursorByProject.clear();
					current = {
						folders: input.folders,
						originsByFolder: input.originsByFolder,
						chatsByProject: pruneProjectMap(
							current.chatsByProject,
							input.folders,
							() => [],
						),
						sessionsByProject: pruneProjectMap(
							current.sessionsByProject,
							input.folders,
							() => [],
						),
						creationOperationsByProject: pruneProjectMap(
							current.creationOperationsByProject,
							input.folders,
							() => [],
						),
					};
					emit();
					return;
				}
				if (!current.folders.some((folder) => folder.id === input.projectId)) {
					return;
				}
				if (input.type === "chat") {
					const chats = current.chatsByProject[input.projectId] ?? [];
					current = {
						...current,
						chatsByProject: {
							...current.chatsByProject,
							[input.projectId]:
								input.change._tag === "snapshot"
									? input.change.chats
									: upsertChat(chats, input.change.chat),
						},
					};
					if (input.change._tag === "snapshot") chatReady.add(input.projectId);
					emit();
					return;
				}
				if (input.type === "session") {
					const change = input.change;
					const sequence =
						change._tag === "snapshot" ? change.cursor : change.sequence;
					const previousSequence = sessionCursorByProject.get(input.projectId);
					if (
						change._tag !== "snapshot" &&
						previousSequence !== undefined &&
						previousSequence >= sequence
					) {
						return;
					}
					sessionCursorByProject.set(
						input.projectId,
						Math.max(previousSequence ?? -1, sequence),
					);
					const sessions = current.sessionsByProject[input.projectId] ?? [];
					current = {
						...current,
						sessionsByProject: {
							...current.sessionsByProject,
							[input.projectId]:
								change._tag === "snapshot"
									? change.sessions
									: change._tag === "change"
										? upsertLatestEntity(sessions, change.session)
										: sessions.filter(
												(session) => session.id !== change.sessionId,
											),
						},
					};
					if (change._tag === "snapshot") sessionReady.add(input.projectId);
					if (change._tag === "snapshot") {
						useSessionRuntimeStore.getState().observeSummaries(
							change.sessions.map((session) => ({
								sessionId: session.id,
								status: session.status,
							})),
						);
					} else if (change._tag === "change") {
						useSessionRuntimeStore
							.getState()
							.observeSummary(change.session.id, change.session.status);
					} else {
						useSessionRuntimeStore.getState().remove(change.sessionId);
					}
					emit();
					return;
				}
				const upsertCreation = (
					operations: ReadonlyArray<ChatCreationOperation>,
					operation: ChatCreationOperation,
				): ReadonlyArray<ChatCreationOperation> => {
					const current = operations.find(
						(candidate) => candidate.operationId === operation.operationId,
					);
					if (
						current !== undefined &&
						current.updatedAt.getTime() > operation.updatedAt.getTime()
					) {
						return operations;
					}
					return [
						...operations.filter(
							(candidate) => candidate.operationId !== operation.operationId,
						),
						operation,
					];
				};
				const operations =
					input.change._tag === "snapshot"
						? input.change.operations
						: upsertCreation(
								current.creationOperationsByProject[input.projectId] ?? [],
								input.change.operation,
							);
				current = {
					...current,
					creationOperationsByProject: {
						...current.creationOperationsByProject,
						[input.projectId]: operations,
					},
				};
				if (input.change._tag === "snapshot")
					creationReady.add(input.projectId);
				emit();
			};
			const program = Stream.runForEach(
				shellInputs(context.client, current),
				(input) => Effect.sync(() => applyInput(input)),
			).pipe(
				Effect.andThen(
					Effect.fail(new Error("Environment shell stream ended unexpectedly")),
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

const DATABASE_NAME = "zuse-environment-shell-resources";
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

class IndexedDbEnvironmentShellPersistence implements ResourcePersistence {
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
				reject(request.error ?? new Error("Unable to open environment cache"));
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
			| (PersistedResource<EnvironmentShellData> & { readonly key: string })
			| undefined;
		await transactionComplete(transaction);
		if (row === undefined || !Array.isArray(row.data?.folders)) return null;
		return {
			data: normalizeEnvironmentShellData(row.data) as Data,
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
		{
			phase: "failed",
			message: cause instanceof Error ? cause.message : String(cause),
		},
		generation,
	);
};

registerRendererResourceDriver("environment-shell", (key) =>
	key.kind === "environment-shell"
		? (makeEnvironmentShellResourceDriver({
				reportConnectionFailure,
			}) as ResourceDriver<MemoizeClient, unknown>)
		: null,
);

if (typeof indexedDB !== "undefined") {
	registerRendererResourcePersistence(
		"environment-shell",
		new IndexedDbEnvironmentShellPersistence(),
	);
}

export const retainEnvironmentShell = (
	ref: EnvironmentRef,
	activation: ResourceActivation,
): Readonly<{ key: EnvironmentShellResourceKey; lease: ResourceLease }> => {
	const key = environmentShellResourceKey(ref);
	return {
		key,
		lease: getRendererClientBus().retain(key, { activation }),
	};
};

export const environmentShellSnapshot = (
	ref: EnvironmentRef,
): ResourceView<EnvironmentShellData> =>
	getRendererClientBus().snapshot(environmentShellResourceKey(ref));

export const dispatchEnvironmentShellCommand = <Payload, Result>(input: {
	readonly environmentId: EnvironmentId;
	readonly kind: string;
	readonly commandId: CommandId;
	readonly payload: Payload;
	readonly retry?: ClientCommand["retry"];
}): Promise<CommandReceipt<Result>> =>
	getRendererClientBus().dispatch({
		kind: input.kind,
		commandId: input.commandId,
		environmentId: input.environmentId,
		resource: environmentShellResourceKey({
			environmentId: input.environmentId,
		}),
		payload: input.payload,
		retry: input.retry ?? "never",
		createdAt: Date.now(),
	});

export const subscribeEnvironmentShell = (
	ref: EnvironmentRef,
	listener: (view: ResourceView<EnvironmentShellData>) => void,
): (() => void) =>
	getRendererClientBus().subscribe(environmentShellResourceKey(ref), listener);

export const subscribeEnvironmentShellIfPresent = (
	ref: EnvironmentRef,
	listener: (view: ResourceView<EnvironmentShellData>) => void,
): (() => void) =>
	getRendererClientBus().subscribeIfPresent(
		environmentShellResourceKey(ref),
		listener,
	);

const catalogSnapshotCache = new Map<
	string,
	Readonly<{
		views: ReadonlyArray<ResourceView<EnvironmentShellData>>;
		value: Readonly<Record<string, ResourceView<EnvironmentShellData>>>;
	}>
>();

const environmentShellCatalogSnapshot = (
	environmentIds: ReadonlyArray<EnvironmentId>,
): Readonly<Record<string, ResourceView<EnvironmentShellData>>> => {
	const id = environmentIds.join("\u0001");
	const views = environmentIds.map((environmentId) =>
		environmentShellSnapshot({ environmentId }),
	);
	const cached = catalogSnapshotCache.get(id);
	if (
		cached !== undefined &&
		cached.views.length === views.length &&
		cached.views.every((view, index) => view === views[index])
	) {
		return cached.value;
	}
	const value = Object.fromEntries(
		environmentIds.map((environmentId, index) => [environmentId, views[index]]),
	) as Readonly<Record<string, ResourceView<EnvironmentShellData>>>;
	catalogSnapshotCache.set(id, { views, value });
	return value;
};

/**
 * Observe qualified environment-shell cells without copying their entities
 * into the connection catalog. The catalog already owns cache-only leases;
 * this selector only joins their keyed notifications for sidebar discovery.
 */
export const useEnvironmentShellCatalog = (
	environmentIds: ReadonlyArray<string>,
): Readonly<Record<string, ResourceView<EnvironmentShellData>>> => {
	const ids = useMemo(
		() =>
			[...new Set(environmentIds)]
				.sort()
				.map((environmentId) => EnvironmentIdSchema.make(environmentId)),
		[environmentIds.join("\u0001")],
	);
	const subscribe = useCallback(
		(listener: () => void) => {
			const releases = ids.map((environmentId) =>
				subscribeEnvironmentShellIfPresent({ environmentId }, listener),
			);
			return () => {
				for (const release of releases) release();
			};
		},
		[ids],
	);
	const snapshot = useCallback(
		() => environmentShellCatalogSnapshot(ids),
		[ids],
	);
	return useSyncExternalStore(subscribe, snapshot, snapshot);
};

const EMPTY_ENVIRONMENT_SHELL_VIEW = emptyResourceView<EnvironmentShellData>();

/** Qualified keyed selector for environment shell state and connection phase. */
export const useEnvironmentShellResource = (
	environmentId: EnvironmentId | null,
	activation: ResourceActivation = "cache-only",
): ResourceView<EnvironmentShellData> => {
	const ref = useMemo<EnvironmentRef | null>(
		() => (environmentId === null ? null : { environmentId }),
		[environmentId],
	);
	const key = useMemo(
		() => (ref === null ? null : environmentShellResourceKey(ref)),
		[ref],
	);
	return useClientBusResource(key, EMPTY_ENVIRONMENT_SHELL_VIEW, activation);
};
