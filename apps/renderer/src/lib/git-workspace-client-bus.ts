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
import { isRpcClientTransportError, type MemoizeClient } from "./rpc-client.ts";
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
	pr: GitPrInfo | null;
	diffStat: GitDiffStat | null;
	noRepository: boolean;
	error: GitResourceError | null;
	revision: number;
}>;

export type GitReviewData = Readonly<{
	summary: GitReviewSummary | null;
	patches: Readonly<Record<string, GitReviewPatch>>;
	error: GitResourceError | null;
	revision: number;
}>;

export type GitChangesData = Readonly<{
	changes: ReadonlyArray<GitChange>;
	error: GitResourceError | null;
	revision: number;
}>;

export type GitPrDetailsData = Readonly<{
	details: GitPrDetails | null;
	error: GitResourceError | null;
	revision: number;
}>;

export type GitWorkspaceResourceKey = ResourceKey<GitWorkspaceData>;

export const gitWorkspaceResourceKey = (
	ref: ExecutionRef,
): GitWorkspaceResourceKey => makeResourceKey("git-workspace", ref);

export const gitChangesResourceKey = (
	ref: ExecutionRef,
): ResourceKey<GitChangesData> => makeResourceKey("git-changes", ref);

export const gitReviewResourceKey = (
	ref: ExecutionRef,
): ResourceKey<GitReviewData> => makeResourceKey("git-review", ref);

export const gitPrDetailsResourceKey = (
	ref: ExecutionRef,
): ResourceKey<GitPrDetailsData> => makeResourceKey("git-pr-details", ref);

const executionRef = (key: ResourceKey<unknown>): ExecutionRef | null =>
	(key.kind === "git-workspace" ||
		key.kind === "git-changes" ||
		key.kind === "git-review" ||
		key.kind === "git-pr-details") &&
	"folderId" in key.ref
		? key.ref
		: null;

const throwTransportFailure = <A>(
	result: Awaited<ReturnType<typeof classifyGit<A>>>,
): void => {
	if (!result.ok && result.tag === null)
		throw result.cause ?? new Error(result.message);
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

const prTerminalStateKey = async (
	ref: ExecutionRef,
	info: GitPrInfo,
): Promise<string> => {
	const identity = JSON.stringify([
		"git-pr-terminal-v1",
		info.nodeId ??
			info.url ??
			`${ref.environmentId}:${ref.folderId}:${info.number ?? "unknown"}`,
		info.state,
	]);
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(identity),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
};

const notifyPrStateTransition = async (
	client: MemoizeClient,
	ref: ExecutionRef,
	previous: GitPrInfo | null | undefined,
	next: GitPrInfo | null,
): Promise<void> => {
	if (
		previous?.state !== "open" ||
		next === null ||
		(next.state !== "merged" && next.state !== "closed")
	) {
		return;
	}
	const transitionKey = await prTerminalStateKey(ref, next);
	const claim = await Effect.runPromise(
		client["git.prNotification.claim"]({ identity: transitionKey }),
	).catch(() => ({ claimed: false }));
	if (!claim.claimed) return;
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
const changesRefreshers = new Map<string, RefreshController>();
const reviewRefreshers = new Map<string, RefreshController>();
const prDetailsRefreshers = new Map<string, RefreshController>();
let workspaceDriverStarts = 0;

const makeInvalidatedDriver = <Data>(options: {
	readonly refreshers: Map<string, RefreshController>;
	readonly reconcileEveryMs?: number;
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
	let reconcileTimer: ReturnType<typeof setTimeout> | null = null;

	return {
		start: (context) => {
			const ref = executionRef(context.key);
			if (ref === null) return;
			active = true;
			workspaceDriverStarts += 1;
			id = resourceKeyId(context.key);
			const epoch = `git-workspace:${context.generation}`;
			const armReconciliation = () => {
				if (options.reconcileEveryMs === undefined || !active) return;
				if (reconcileTimer !== null) clearTimeout(reconcileTimer);
				reconcileTimer = setTimeout(() => {
					reconcileTimer = null;
					void schedule();
				}, options.reconcileEveryMs);
			};

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
						armReconciliation();
					}
				})()
					.catch((cause) => {
						failed = true;
						if (!active) return;
						context.emit({ sync: "failed" });
						if (!isRpcClientTransportError(cause)) return;
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
						const failure = Cause.squash(cause);
						context.emit({ sync: "failed" });
						if (!isRpcClientTransportError(failure)) return;
						getRendererClientBus().reportConnectionFault(
							ref.environmentId,
							{ phase: "failed", message: String(failure) },
							context.generation,
						);
					}),
				),
			);
			fiber = Effect.runFork(program);
		},
		stop: () => {
			active = false;
			if (reconcileTimer !== null) clearTimeout(reconcileTimer);
			reconcileTimer = null;
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
		reconcileEveryMs: 5_000,
		load: async (client, ref, previous, revision) => {
			const payload = {
				folderId: ref.folderId,
				worktreeId: ref.worktreeId,
			};
			const snapshot = await classifyGit(
				client["git.workspaceSnapshot"](payload),
			);
			throwTransportFailure(snapshot);
			const noRepository = !snapshot.ok && snapshot.tag === "GitNotARepoError";
			const observedPr = snapshot.ok ? snapshot.value.pr : null;
			const nextPr =
				observedPr !== null &&
				observedPr.prCapability !== undefined &&
				observedPr.prCapability !== "available" &&
				previous?.pr !== null &&
				previous?.pr !== undefined &&
				previous.pr.state !== "none"
					? {
							...previous.pr,
							prCapability: observedPr.prCapability,
							stale: true,
						}
					: (observedPr ?? previous?.pr ?? null);
			await notifyPrStateTransition(client, ref, previous?.pr, nextPr);
			return {
				status: noRepository
					? null
					: snapshot.ok
						? snapshot.value.status
						: (previous?.status ?? null),
				pr: noRepository ? null : nextPr,
				diffStat: noRepository
					? null
					: snapshot.ok
						? snapshot.value.diffStat
						: (previous?.diffStat ?? null),
				noRepository,
				error: noRepository
					? { tag: "GitNotARepoError", message: "Not a git repository" }
					: firstError(snapshot),
				revision,
			};
		},
	});

const makeReviewDriver = (): ResourceDriver<MemoizeClient, GitReviewData> =>
	makeInvalidatedDriver({
		refreshers: reviewRefreshers,
		load: async (client, ref, previous, revision) => {
			const payload = { folderId: ref.folderId, worktreeId: ref.worktreeId };
			const summary = await classifyGit(client["git.reviewSummary"](payload));
			throwTransportFailure(summary);
			if (!summary.ok) {
				return {
					summary: previous?.summary ?? null,
					patches: previous?.patches ?? {},
					error: { tag: summary.tag, message: summary.message },
					revision,
				};
			}
			const patchResult = await classifyGit(
				Stream.runCollect(client["git.reviewPatches"](payload)),
			);
			throwTransportFailure(patchResult);
			return {
				summary: summary.value,
				patches: patchResult.ok
					? Object.fromEntries(
							patchResult.value.map((patch) => [patch.path, patch]),
						)
					: (previous?.patches ?? {}),
				error: patchResult.ok
					? null
					: { tag: patchResult.tag, message: patchResult.message },
				revision,
			};
		},
	});

const makeChangesDriver = (): ResourceDriver<MemoizeClient, GitChangesData> =>
	makeInvalidatedDriver({
		refreshers: changesRefreshers,
		load: async (client, ref, previous, revision) => {
			const result = await classifyGit(
				client["git.changes"]({
					folderId: ref.folderId,
					worktreeId: ref.worktreeId,
				}),
			);
			throwTransportFailure(result);
			return result.ok
				? { changes: result.value, error: null, revision }
				: {
						changes: previous?.changes ?? [],
						error: { tag: result.tag, message: result.message },
						revision,
					};
		},
	});

const makePrDetailsDriver = (): ResourceDriver<
	MemoizeClient,
	GitPrDetailsData
> =>
	makeInvalidatedDriver({
		refreshers: prDetailsRefreshers,
		load: async (client, ref, previous, revision) => {
			const result = await classifyGit(
				client["git.prDetails"]({
					folderId: ref.folderId,
					worktreeId: ref.worktreeId,
				}),
			);
			throwTransportFailure(result);
			return result.ok
				? { details: result.value, error: null, revision }
				: {
						details: previous?.details ?? null,
						error: { tag: result.tag, message: result.message },
						revision,
					};
		},
	});

registerRendererResourceDriver("git-workspace", (key) =>
	executionRef(key) === null
		? null
		: (makeWorkspaceDriver() as ResourceDriver<MemoizeClient, unknown>),
);
registerRendererResourceDriver("git-changes", (key) =>
	executionRef(key) === null
		? null
		: (makeChangesDriver() as ResourceDriver<MemoizeClient, unknown>),
);
registerRendererResourceDriver("git-review", (key) =>
	executionRef(key) === null
		? null
		: (makeReviewDriver() as ResourceDriver<MemoizeClient, unknown>),
);
registerRendererResourceDriver("git-pr-details", (key) =>
	executionRef(key) === null
		? null
		: (makePrDetailsDriver() as ResourceDriver<MemoizeClient, unknown>),
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
const EMPTY_CHANGES_VIEW = emptyResourceView<GitChangesData>();
const EMPTY_REVIEW_VIEW = emptyResourceView<GitReviewData>();
const EMPTY_PR_DETAILS_VIEW = emptyResourceView<GitPrDetailsData>();

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

export const useGitChangesResource = (
	ref: ExecutionRef | null,
	activation: ResourceActivation = "connect",
): ResourceView<GitChangesData> =>
	useClientBusResource(
		useKey(ref, gitChangesResourceKey),
		EMPTY_CHANGES_VIEW,
		activation,
	);

export const useGitReviewResource = (
	ref: ExecutionRef | null,
	activation: ResourceActivation = "connect",
): ResourceView<GitReviewData> =>
	useClientBusResource(
		useKey(ref, gitReviewResourceKey),
		EMPTY_REVIEW_VIEW,
		activation,
	);

export const useGitPrDetailsResource = (
	ref: ExecutionRef | null,
	activation: ResourceActivation = "connect",
): ResourceView<GitPrDetailsData> =>
	useClientBusResource(
		useKey(ref, gitPrDetailsResourceKey),
		EMPTY_PR_DETAILS_VIEW,
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

export const refreshGitChanges = (ref: ExecutionRef): Promise<void> =>
	refresh(gitChangesResourceKey(ref), changesRefreshers);

export const refreshGitReview = (ref: ExecutionRef): Promise<void> =>
	refresh(gitReviewResourceKey(ref), reviewRefreshers);

export const refreshGitPrDetails = (ref: ExecutionRef): Promise<void> =>
	refresh(gitPrDetailsResourceKey(ref), prDetailsRefreshers);

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
}): Promise<CommandReceipt<Result>> => {
	const dispatched = getRendererClientBus().dispatch<Result>({
		kind: input.kind,
		commandId: input.commandId,
		environmentId: input.ref.environmentId,
		resource: gitWorkspaceResourceKey(input.ref),
		payload: input.payload,
		retry: input.retry ?? "never",
		createdAt: Date.now(),
	});
	void dispatched
		.then(() =>
			Promise.all([
				refreshGitWorkspace(input.ref),
				refreshGitChanges(input.ref),
				refreshGitReview(input.ref),
				refreshGitPrDetails(input.ref),
			]),
		)
		.catch(() => undefined);
	return dispatched;
};

const patchRequests = new Map<string, Promise<void>>();

export const ensureGitReviewPatch = (
	ref: ExecutionRef,
	path: string,
): Promise<void> => {
	const key = gitReviewResourceKey(ref);
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
	changesRefreshers.clear();
	reviewRefreshers.clear();
	prDetailsRefreshers.clear();
	patchRequests.clear();
};
