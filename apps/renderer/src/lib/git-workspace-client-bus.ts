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
	type ExecutionRef,
	makeResourceKey,
	type ResourceKey,
	resourceKeyId,
} from "@zuse/client-runtime/resource-ref";
import {
	emptyResourceView,
	type ResourceView,
} from "@zuse/client-runtime/resource-state";
import type {
	GitChange,
	GitPrDetails,
	GitPrInfo,
	GitReviewPatch,
	GitReviewSummary,
	GitStatusSummary,
} from "@zuse/contracts";
import { Cause, Effect, Fiber, Stream } from "effect";
import { useMemo } from "react";
import { toastManager } from "../components/ui/toast.tsx";
import { classifyGit, type GitErrorTag } from "./git-rpc.ts";
import type { MemoizeClient } from "./rpc-client.ts";
import {
	getRendererClientBus,
	registerRendererResourceDriver,
	registerRendererResourcePersistence,
} from "./session-timeline-client-bus.ts";
import { useClientBusResource } from "./use-client-bus-resource.ts";

export type GitResourceError = Readonly<{
	tag: GitErrorTag | null;
	message: string;
}>;

export type GitDiffStat = Readonly<{
	additions: number;
	deletions: number;
}>;

export type GitWorkspaceData = Readonly<{
	status: GitStatusSummary | null;
	changes: readonly GitChange[];
	pr: GitPrInfo | null;
	diffStat: GitDiffStat | null;
	summary: GitReviewSummary | null;
	patches: Readonly<Record<string, GitReviewPatch>>;
	prDetails: GitPrDetails | null;
	noRepository: boolean;
	error: GitResourceError | null;
	revision: number;
}>;

export type GitWorkspaceResourceKey = ResourceKey<GitWorkspaceData>;

export const gitWorkspaceResourceKey = (
	ref: ExecutionRef,
): GitWorkspaceResourceKey => makeResourceKey("git-workspace", ref);

const executionRef = (key: ResourceKey<unknown>): ExecutionRef | null =>
	key.kind === "git-workspace" && "folderId" in key.ref ? key.ref : null;

const throwTransportFailure = <A>(
	result: Awaited<ReturnType<typeof classifyGit<A>>>,
): void => {
	if (!result.ok && result.tag === null) throw new Error(result.message);
};

const firstError = (
	...results: readonly Awaited<ReturnType<typeof classifyGit<unknown>>>[]
): GitResourceError | null => {
	const failed = results.find((result) => !result.ok);
	return failed === undefined || failed.ok
		? null
		: { tag: failed.tag, message: failed.message };
};

const prLabel = (info: GitPrInfo): string =>
	info.number === null ? "Pull request" : `Pull request #${info.number}`;

const prDescription = (info: GitPrInfo): string => {
	if (info.branch !== null && info.baseBranch !== null) {
		return `${info.branch} into ${info.baseBranch}`;
	}
	return info.branch ?? "";
};

const notifiedPrTerminalStates = new Set<string>();

const prTerminalStateKey = (ref: ExecutionRef, info: GitPrInfo): string => {
	const identity =
		info.url ??
		`${ref.environmentId}:${ref.folderId}:${info.number ?? "unknown"}:${info.branch ?? "unknown"}:${info.baseBranch ?? "unknown"}`;
	return `${identity}:${info.state}`;
};

const notifyPrStateTransition = (
	ref: ExecutionRef,
	previous: GitPrInfo | null | undefined,
	next: GitPrInfo | null,
): void => {
	if (
		previous?.state !== "open" ||
		next === null ||
		(next.state !== "merged" && next.state !== "closed")
	) {
		return;
	}
	const transitionKey = prTerminalStateKey(ref, next);
	if (notifiedPrTerminalStates.has(transitionKey)) return;
	notifiedPrTerminalStates.add(transitionKey);
	if (next.state === "merged") {
		toastManager.add({
			type: "success",
			title: `${prLabel(next)} merged`,
			description: prDescription(next),
		});
	} else {
		toastManager.add({
			type: "info",
			title: `${prLabel(next)} closed`,
			description: prDescription(next),
		});
	}
};

type RefreshController = Readonly<{
	refresh: () => Promise<void>;
}>;

const workspaceRefreshers = new Map<string, RefreshController>();
let workspaceDriverStarts = 0;

const makeInvalidatedDriver = <Data>(options: {
	readonly refreshers: Map<string, RefreshController>;
	readonly load: (
		client: MemoizeClient,
		ref: ExecutionRef,
		previous: Data | null,
		revision: number,
	) => Promise<Data>;
}): ResourceDriver<MemoizeClient, Data> => {
	let fiber: Fiber.Fiber<unknown, unknown> | null = null;
	let active = false;
	let latestRevision = -1;
	let appliedRevision = -1;
	let refreshLoop: Promise<void> | null = null;
	let id: string | null = null;

	return {
		start: (context) => {
			const ref = executionRef(context.key);
			if (ref === null) return;
			active = true;
			workspaceDriverStarts += 1;
			id = resourceKeyId(context.key);
			const epoch = `git-workspace:${context.generation}`;

			const schedule = (): Promise<void> => {
				latestRevision += 1;
				if (refreshLoop !== null) return refreshLoop;
				let failed = false;
				refreshLoop = (async () => {
					while (active && appliedRevision < latestRevision) {
						const targetRevision = latestRevision;
						context.emit({ sync: "synchronizing" });
						const previous = context.snapshot()?.data ?? null;
						const data = await options.load(
							context.client,
							ref,
							previous,
							targetRevision,
						);
						if (!active || !context.isCurrent()) return;
						const previousEpoch = context.snapshot()?.cursor?.epoch;
						const accepted = context.emit({
							data,
							cursor: { epoch, version: targetRevision },
							resetEpoch:
								previousEpoch !== undefined && previousEpoch !== epoch,
							sync: "live",
							persist: true,
						});
						if (accepted) appliedRevision = targetRevision;
					}
				})()
					.catch((cause) => {
						failed = true;
						if (!active) return;
						getRendererClientBus().reportConnectionFault(
							ref.environmentId,
							{
								phase: "failed",
								message: cause instanceof Error ? cause.message : String(cause),
							},
							context.generation,
						);
					})
					.finally(() => {
						refreshLoop = null;
						if (active && !failed && appliedRevision < latestRevision) {
							void schedule();
						}
					});
				return refreshLoop;
			};

			options.refreshers.set(id, {
				refresh: schedule,
			});

			const program = Stream.runForEach(
				context.client["git.workspaceChanges"]({
					folderId: ref.folderId,
					worktreeId: ref.worktreeId,
				}).pipe(
					// A plain folder, a removed checkout, or a missing Git binary is a
					// resource-level capability failure. Materialize that state through
					// the normal snapshot loader and keep the invalidation stream alive;
					// escalating a typed Git error would disconnect every resource on the
					// computer (including auth and the project catalog).
					Stream.catchTags({
						GitNotARepoError: () =>
							Stream.concat(Stream.make({ revision: 0 }), Stream.never),
						GitNotInstalledError: () =>
							Stream.concat(Stream.make({ revision: 0 }), Stream.never),
						GitCommandError: () =>
							Stream.concat(Stream.make({ revision: 0 }), Stream.never),
						GitFolderNotFoundError: () =>
							Stream.concat(Stream.make({ revision: 0 }), Stream.never),
					}),
				),
				() => Effect.sync(() => void schedule()),
			).pipe(
				Effect.andThen(
					Effect.fail(
						new Error("Git workspace invalidation stream ended unexpectedly"),
					),
				),
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						if (!active || Cause.hasInterruptsOnly(cause)) return;
						getRendererClientBus().reportConnectionFault(
							ref.environmentId,
							{ phase: "failed", message: String(Cause.squash(cause)) },
							context.generation,
						);
					}),
				),
			);
			fiber = Effect.runFork(program);
		},
		stop: () => {
			active = false;
			if (id !== null) options.refreshers.delete(id);
			id = null;
			const running = fiber;
			fiber = null;
			if (running !== null) void Effect.runPromise(Fiber.interrupt(running));
		},
	};
};

const makeWorkspaceDriver = (): ResourceDriver<
	MemoizeClient,
	GitWorkspaceData
> =>
	makeInvalidatedDriver({
		refreshers: workspaceRefreshers,
		load: async (client, ref, previous, revision) => {
			const payload = {
				folderId: ref.folderId,
				worktreeId: ref.worktreeId,
			};
			const [status, changes, pr, summary, prDetails] = await Promise.all([
				classifyGit(client["git.status"](payload)),
				classifyGit(client["git.changes"](payload)),
				classifyGit(client["git.prState"](payload)),
				classifyGit(client["git.reviewSummary"](payload)),
				classifyGit(client["git.prDetails"](payload)),
			]);
			throwTransportFailure(status);
			throwTransportFailure(changes);
			throwTransportFailure(pr);
			throwTransportFailure(summary);
			throwTransportFailure(prDetails);
			const noRepository =
				(!status.ok && status.tag === "GitNotARepoError") ||
				(!changes.ok && changes.tag === "GitNotARepoError");
			let patches: Readonly<Record<string, GitReviewPatch>> = {};
			let patchError: GitResourceError | null = null;
			if (summary.ok) {
				const patchResult = await classifyGit(
					Stream.runCollect(client["git.reviewPatches"](payload)),
				);
				throwTransportFailure(patchResult);
				if (patchResult.ok) {
					patches = Object.fromEntries(
						patchResult.value.map((patch) => [patch.path, patch]),
					);
				} else {
					patchError = {
						tag: patchResult.tag,
						message: patchResult.message,
					};
				}
			}
			const nextPr = pr.ok ? pr.value : (previous?.pr ?? null);
			notifyPrStateTransition(ref, previous?.pr, nextPr);
			return {
				status: noRepository
					? null
					: status.ok
						? status.value
						: (previous?.status ?? null),
				changes: noRepository
					? []
					: changes.ok
						? changes.value
						: (previous?.changes ?? []),
				pr: noRepository ? null : nextPr,
				diffStat: noRepository
					? null
					: summary.ok
						? {
								additions: summary.value.additions,
								deletions: summary.value.deletions,
							}
						: (previous?.diffStat ?? null),
				summary: noRepository
					? null
					: summary.ok
						? summary.value
						: (previous?.summary ?? null),
				patches: noRepository
					? {}
					: summary.ok
						? patches
						: (previous?.patches ?? {}),
				prDetails: noRepository
					? null
					: prDetails.ok
						? prDetails.value
						: (previous?.prDetails ?? null),
				noRepository,
				error: noRepository
					? { tag: "GitNotARepoError", message: "Not a git repository" }
					: (patchError ?? firstError(status, changes, pr, summary, prDetails)),
				revision,
			};
		},
	});

registerRendererResourceDriver("git-workspace", (key) =>
	executionRef(key) === null
		? null
		: (makeWorkspaceDriver() as ResourceDriver<MemoizeClient, unknown>),
);

const DATABASE_NAME = "zuse-git-workspace-resources";
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

class IndexedDbGitWorkspacePersistence implements ResourcePersistence {
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
				reject(request.error ?? new Error("Unable to open Git cache"));
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
			| (PersistedResource<GitWorkspaceData> & { readonly key: string })
			| undefined;
		await transactionComplete(transaction);
		if (
			row === undefined ||
			typeof row.data !== "object" ||
			row.data === null ||
			!Array.isArray(row.data.changes) ||
			typeof row.data.revision !== "number"
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

if (typeof indexedDB !== "undefined") {
	registerRendererResourcePersistence(
		"git-workspace",
		new IndexedDbGitWorkspacePersistence(),
	);
}

const EMPTY_WORKSPACE_VIEW = emptyResourceView<GitWorkspaceData>();

const useKey = <Data>(
	ref: ExecutionRef | null,
	makeKey: (value: ExecutionRef) => ResourceKey<Data>,
): ResourceKey<Data> | null =>
	useMemo(
		() => (ref === null ? null : makeKey(ref)),
		[
			ref?.environmentId,
			ref?.folderId,
			ref?.worktreeId,
			ref?.rootPath,
			makeKey,
		],
	);

export const useGitWorkspaceResource = (
	ref: ExecutionRef | null,
	activation: ResourceActivation = "connect",
): ResourceView<GitWorkspaceData> =>
	useClientBusResource(
		useKey(ref, gitWorkspaceResourceKey),
		EMPTY_WORKSPACE_VIEW,
		activation,
	);

const refresh = (
	key: ResourceKey<unknown>,
	refreshers: Map<string, RefreshController>,
): Promise<void> => {
	const controller = refreshers.get(resourceKeyId(key));
	return controller?.refresh() ?? Promise.resolve();
};

export const refreshGitWorkspace = (ref: ExecutionRef): Promise<void> =>
	refresh(gitWorkspaceResourceKey(ref), workspaceRefreshers);

export const refreshGitReview = (ref: ExecutionRef): Promise<void> =>
	refreshGitWorkspace(ref);

export const dispatchGitWorkspaceCommand = <Payload, Result>(input: {
	readonly ref: ExecutionRef;
	readonly kind:
		| "git.revertAll"
		| "git.revertFile"
		| "git.commit"
		| "git.push"
		| "git.reviewIdentity"
		| "git.reviewFileContents"
		| "git.restoreFileToBase"
		| "git.createReviewComment"
		| "git.resolveConflict"
		| "git.branches"
		| "git.switchBranch"
		| "worktree.renameBranch"
		| "git.markReady"
		| "git.mergePr"
		| "git.fixFailingChecks"
		| "git.diff"
		| "git.issueMarkdown"
		| "git.listPrs"
		| "git.listIssues";
	readonly retry?: ClientCommand["retry"];
	readonly commandId: ClientCommand["commandId"];
	readonly payload: Payload;
}): Promise<CommandReceipt<Result>> =>
	getRendererClientBus().dispatch({
		kind: input.kind,
		commandId: input.commandId,
		environmentId: input.ref.environmentId,
		resource: gitWorkspaceResourceKey(input.ref),
		payload: input.payload,
		retry: input.retry ?? "never",
		createdAt: Date.now(),
	});

const patchRequests = new Map<string, Promise<void>>();

export const ensureGitReviewPatch = (
	ref: ExecutionRef,
	path: string,
): Promise<void> => {
	const key = gitWorkspaceResourceKey(ref);
	const id = `${resourceKeyId(key)}:${encodeURIComponent(path)}`;
	const existing = patchRequests.get(id);
	if (existing !== undefined) return existing;
	const bus = getRendererClientBus();
	const initial = bus.snapshot(key);
	if (initial.data?.patches[path] !== undefined) return Promise.resolve();
	const request = (async () => {
		const client = bus.client(ref.environmentId);
		if (client === null) return;
		const result = await classifyGit(
			client["git.diff"]({
				folderId: ref.folderId,
				worktreeId: ref.worktreeId,
				path,
			}),
		);
		if (!result.ok) return;
		bus.update(key, {
			expectedGeneration: initial.generation,
			expectedCursor: initial.cursor,
			update: (data) => ({
				...data,
				patches: {
					...data.patches,
					[path]: { path, result: result.value, error: null },
				},
			}),
		});
	})();
	patchRequests.set(id, request);
	void request.finally(() => patchRequests.delete(id));
	return request;
};

export const initializeGitRepository = async (
	ref: ExecutionRef,
): Promise<void> => {
	const client = getRendererClientBus().client(ref.environmentId);
	if (client === null) throw new Error("Environment is not connected");
	await Effect.runPromise(client["git.init"]({ folderId: ref.folderId }));
	await refreshGitWorkspace(ref);
};

export const retainGitWorkspace = (
	ref: ExecutionRef,
	activation: ResourceActivation = "connect",
): Readonly<{ key: GitWorkspaceResourceKey; lease: ResourceLease }> => {
	const key = gitWorkspaceResourceKey(ref);
	return {
		key,
		lease: getRendererClientBus().retain(key, { activation }),
	};
};

export const gitWorkspaceDriverStartsForTest = (): number =>
	workspaceDriverStarts;

export const resetGitWorkspaceClientBusForTest = (): void => {
	workspaceDriverStarts = 0;
	workspaceRefreshers.clear();
	patchRequests.clear();
	notifiedPrTerminalStates.clear();
};
