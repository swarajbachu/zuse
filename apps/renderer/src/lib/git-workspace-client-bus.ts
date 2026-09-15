import "@zuse/i18n/english/projects";
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
import { message as uiMessage } from "@zuse/i18n";
import { Cause, Effect, Fiber, Stream } from "effect";
import { useEffect, useMemo } from "react";
import { toastManager } from "../components/ui/toast.tsx";
import { classifyGit, type GitErrorTag } from "./git-rpc.ts";
import { isRpcClientTransportError, type MemoizeClient } from "./rpc-client.ts";
import {
	getRendererClientBus,
	registerRendererResourceDriver,
	registerRendererResourcePersistence,
} from "./session-timeline-client-bus.ts";
import { useClientBusResource } from "./use-client-bus-resource.ts";

type GitResourceError = Readonly<{
	tag: GitErrorTag | null;
	message: string;
}>;

export type GitDiffStat = Readonly<{
	additions: number;
	deletions: number;
}>;

export type GitWorkspaceData = Readonly<{
	schemaVersion: 2;
	status: GitStatusSummary | null;
	pr: GitPrInfo | null;
	diffStat: GitDiffStat | null;
	changes: ReadonlyArray<GitChange>;
	reviewSummary: GitReviewSummary | null;
	reviewPatches: Readonly<Record<string, GitReviewPatch>>;
	reviewPatchesRevision: number | null;
	reviewPatchesLoading: boolean;
	prDetails: GitPrDetails | null;
	prDetailsIdentity: string | null;
	prDetailsLoading: boolean;
	noRepository: boolean;
	error: GitResourceError | null;
	reviewError: GitResourceError | null;
	prDetailsError: GitResourceError | null;
	revision: number;
	projectionVersion: number;
	localFingerprint: string;
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

const executionRef = (key: ResourceKey<unknown>): ExecutionRef | null =>
	key.kind === "git-workspace" && "folderId" in key.ref ? key.ref : null;

const throwTransportFailure = <A>(
	result: Awaited<ReturnType<typeof classifyGit<A>>>,
): void => {
	if (!result.ok && result.tag === null)
		throw result.cause ?? new Error(result.message);
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
			title: uiMessage("projects:git_workspace_client_bus_merged", {
				value1: String(prLabel(next)),
			}),
			description: prDescription(next),
		});
	} else {
		toastManager.add({
			type: "info",
			title: uiMessage("projects:git_workspace_client_bus_closed", {
				value1: String(prLabel(next)),
			}),
			description: prDescription(next),
		});
	}
};

type RefreshController = Readonly<{
	refresh: () => Promise<void>;
}>;

const workspaceRefreshers = new Map<string, RefreshController>();
let workspaceDriverStarts = 0;

const pullRequestIdentity = (pr: GitPrInfo | null): string =>
	pr === null || pr.state === "none"
		? "none"
		: JSON.stringify([
				pr.nodeId ?? pr.url ?? pr.number,
				pr.state,
				pr.checks,
				pr.checksTotal,
				pr.checksRunning,
				pr.checksPassing,
				pr.checksFailing,
				pr.mergeable,
				pr.autoMergeEnabled,
			]);

const makeWorkspaceDriver = (): ResourceDriver<
	MemoizeClient,
	GitWorkspaceData
> => {
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
			const epoch = `git-workspace:${context.generation}:${crypto.randomUUID()}`;

			const schedule = (): Promise<void> => {
				latestRevision += 1;
				if (refreshLoop !== null) return refreshLoop;
				let failed = false;
				refreshLoop = (async () => {
					while (active && appliedRevision < latestRevision) {
						const targetRevision = latestRevision;
						context.emit({ sync: "synchronizing" });
						const previous = context.snapshot()?.data ?? null;
						const snapshot = await classifyGit(
							context.client["git.workspaceSnapshot"]({
								folderId: ref.folderId,
								worktreeId: ref.worktreeId,
							}),
						);
						throwTransportFailure(snapshot);
						const noRepository =
							!snapshot.ok && snapshot.tag === "GitNotARepoError";
						let data: GitWorkspaceData;
						if (!snapshot.ok) {
							const error = noRepository
								? {
										tag: "GitNotARepoError" as const,
										message: "Not a git repository",
									}
								: { tag: snapshot.tag, message: snapshot.message };
							data = {
								schemaVersion: 2,
								status: noRepository ? null : (previous?.status ?? null),
								pr: noRepository ? null : (previous?.pr ?? null),
								diffStat: noRepository ? null : (previous?.diffStat ?? null),
								changes: noRepository ? [] : (previous?.changes ?? []),
								reviewSummary: noRepository
									? null
									: (previous?.reviewSummary ?? null),
								reviewPatches: noRepository
									? {}
									: (previous?.reviewPatches ?? {}),
								reviewPatchesRevision: noRepository
									? null
									: (previous?.reviewPatchesRevision ?? null),
								reviewPatchesLoading: false,
								prDetails: noRepository ? null : (previous?.prDetails ?? null),
								prDetailsIdentity: noRepository
									? null
									: (previous?.prDetailsIdentity ?? null),
								prDetailsLoading: false,
								noRepository,
								error,
								reviewError: noRepository
									? error
									: (previous?.reviewError ?? null),
								prDetailsError: noRepository
									? error
									: (previous?.prDetailsError ?? null),
								revision: targetRevision,
								projectionVersion: previous?.projectionVersion ?? 0,
								localFingerprint: previous?.localFingerprint ?? "",
							};
						} else {
							const observedPr = snapshot.value.pr;
							const nextPr =
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
									: observedPr;
							const sameReview =
								previous !== null &&
								previous.localFingerprint === snapshot.value.localFingerprint;
							const samePullRequest =
								previous !== null &&
								pullRequestIdentity(previous.pr) ===
									pullRequestIdentity(nextPr);
							await notifyPrStateTransition(
								context.client,
								ref,
								previous?.pr,
								nextPr,
							);
							data = {
								schemaVersion: 2,
								status: snapshot.value.status,
								pr: nextPr,
								diffStat: snapshot.value.diffStat,
								changes: snapshot.value.changes,
								reviewSummary: snapshot.value.reviewSummary,
								reviewPatches: sameReview ? previous.reviewPatches : {},
								reviewPatchesRevision:
									sameReview &&
									previous.reviewPatchesRevision !== null &&
									previous.reviewError === null
										? targetRevision
										: null,
								reviewPatchesLoading: false,
								prDetails: samePullRequest ? previous.prDetails : null,
								prDetailsIdentity: samePullRequest
									? previous.prDetailsError === null
										? previous.prDetailsIdentity
										: null
									: null,
								prDetailsLoading: false,
								noRepository: false,
								error: null,
								reviewError: sameReview ? previous.reviewError : null,
								prDetailsError: samePullRequest
									? previous.prDetailsError
									: null,
								revision: targetRevision,
								projectionVersion: snapshot.value.projectionVersion,
								localFingerprint: snapshot.value.localFingerprint,
							};
						}
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

			workspaceRefreshers.set(id, {
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
			if (id !== null) workspaceRefreshers.delete(id);
			id = null;
			const running = fiber;
			fiber = null;
			if (running !== null) void Effect.runPromise(Fiber.interrupt(running));
		},
	};
};

registerRendererResourceDriver("git-workspace", (key) =>
	executionRef(key) === null
		? null
		: (makeWorkspaceDriver() as ResourceDriver<MemoizeClient, unknown>),
);

const DATABASE_NAME = "zuse-git-workspace-resources";
const DATABASE_VERSION = 2;
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
			row.data.schemaVersion !== 2 ||
			typeof row.data.revision !== "number" ||
			typeof row.data.localFingerprint !== "string"
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

const projectResourceView = <Source, Data>(
	view: ResourceView<Source>,
	project: (data: Source) => Data,
): ResourceView<Data> => ({
	...view,
	data: view.data === null ? null : project(view.data),
});

const reviewHydrationRequests = new Map<string, Promise<void>>();
const prDetailsRequests = new Map<string, Promise<void>>();
const manualRefreshes = new Map<string, Promise<void>>();

const hydrateGitReviewPatches = (
	ref: ExecutionRef,
	force = false,
): Promise<void> => {
	const key = gitWorkspaceResourceKey(ref);
	const id = resourceKeyId(key);
	const bus = getRendererClientBus();
	const initial = bus.snapshot(key);
	const data = initial.data;
	if (data === null || data.reviewSummary === null) return Promise.resolve();
	if (
		!force &&
		(data.reviewPatchesLoading || data.reviewPatchesRevision === data.revision)
	) {
		return Promise.resolve();
	}
	if (data.reviewSummary.files.length === 0) {
		bus.update(key, {
			expectedGeneration: initial.generation,
			expectedCursor: initial.cursor,
			persist: true,
			update: (current) =>
				current.revision !== data.revision
					? undefined
					: {
							...current,
							reviewPatches: {},
							reviewPatchesRevision: current.revision,
							reviewPatchesLoading: false,
							reviewError: null,
						},
		});
		return Promise.resolve();
	}
	const requestId = `${id}:review:${data.revision}`;
	const existing = reviewHydrationRequests.get(requestId);
	if (existing !== undefined) return existing;
	const client = bus.client(ref.environmentId);
	if (client === null) return Promise.resolve();
	bus.update(key, {
		expectedGeneration: initial.generation,
		expectedCursor: initial.cursor,
		update: (current) =>
			current.revision !== data.revision
				? undefined
				: { ...current, reviewPatchesLoading: true },
	});
	const request = (async () => {
		const result = await classifyGit(
			Stream.runCollect(
				client["git.reviewPatches"]({
					folderId: ref.folderId,
					worktreeId: ref.worktreeId,
					scope: "branch",
				}),
			),
		);
		bus.update(key, {
			expectedGeneration: initial.generation,
			expectedCursor: initial.cursor,
			persist: result.ok,
			update: (current) => {
				if (current.revision !== data.revision) return undefined;
				return result.ok
					? {
							...current,
							reviewPatches: Object.fromEntries(
								result.value.map((patch) => [patch.path, patch]),
							),
							reviewPatchesRevision: current.revision,
							reviewPatchesLoading: false,
							reviewError: null,
						}
					: {
							...current,
							reviewPatchesRevision: current.revision,
							reviewPatchesLoading: false,
							reviewError: { tag: result.tag, message: result.message },
						};
			},
		});
	})().finally(() => reviewHydrationRequests.delete(requestId));
	reviewHydrationRequests.set(requestId, request);
	return request;
};

const hydrateGitPrDetails = (
	ref: ExecutionRef,
	force = false,
): Promise<void> => {
	const key = gitWorkspaceResourceKey(ref);
	const bus = getRendererClientBus();
	const initial = bus.snapshot(key);
	const data = initial.data;
	if (data === null || data.pr === null || data.pr.state === "none") {
		return Promise.resolve();
	}
	const identity = pullRequestIdentity(data.pr);
	if (!force && data.prDetailsIdentity === identity) return Promise.resolve();
	const requestId = `${resourceKeyId(key)}:pr-details:${identity}:${data.revision}`;
	const existing = prDetailsRequests.get(requestId);
	if (existing !== undefined) return existing;
	const client = bus.client(ref.environmentId);
	if (client === null) return Promise.resolve();
	bus.update(key, {
		expectedGeneration: initial.generation,
		expectedCursor: initial.cursor,
		update: (current) =>
			pullRequestIdentity(current.pr) !== identity
				? undefined
				: { ...current, prDetailsLoading: true },
	});
	const request = (async () => {
		const result = await classifyGit(
			client["git.prDetails"]({
				folderId: ref.folderId,
				worktreeId: ref.worktreeId,
			}),
		);
		bus.update(key, {
			expectedGeneration: initial.generation,
			expectedCursor: initial.cursor,
			persist: result.ok,
			update: (current) => {
				if (pullRequestIdentity(current.pr) !== identity) return undefined;
				return result.ok
					? {
							...current,
							prDetails: result.value,
							prDetailsIdentity: identity,
							prDetailsLoading: false,
							prDetailsError: null,
						}
					: {
							...current,
							prDetailsIdentity: identity,
							prDetailsLoading: false,
							prDetailsError: { tag: result.tag, message: result.message },
						};
			},
		});
	})().finally(() => prDetailsRequests.delete(requestId));
	prDetailsRequests.set(requestId, request);
	return request;
};

export const useGitChangesResource = (
	ref: ExecutionRef | null,
	activation: ResourceActivation = "connect",
): ResourceView<GitChangesData> => {
	const view = useGitWorkspaceResource(ref, activation);
	return useMemo(
		() =>
			projectResourceView(view, (data) => ({
				changes: data.changes,
				error: data.error,
				revision: data.revision,
			})),
		[view],
	);
};

export const useGitReviewResource = (
	ref: ExecutionRef | null,
	activation: ResourceActivation = "connect",
): ResourceView<GitReviewData> => {
	const view = useGitWorkspaceResource(ref, activation);
	const shouldHydrate = activation === "connect" || activation === "wake";
	useEffect(() => {
		if (
			ref === null ||
			!shouldHydrate ||
			view.data === null ||
			view.data.reviewSummary === null ||
			view.data.reviewPatchesRevision === view.data.revision
		) {
			return;
		}
		void hydrateGitReviewPatches(ref);
	}, [ref, shouldHydrate, view.data]);
	return useMemo(() => {
		const projected = projectResourceView(view, (data) => ({
			summary: data.reviewSummary,
			patches: data.reviewPatches,
			error: data.reviewError ?? data.error,
			revision: data.revision,
		}));
		return view.data?.reviewPatchesLoading === true
			? { ...projected, sync: "synchronizing" }
			: projected;
	}, [view]);
};

export const useGitPrDetailsResource = (
	ref: ExecutionRef | null,
	activation: ResourceActivation = "connect",
): ResourceView<GitPrDetailsData> => {
	const view = useGitWorkspaceResource(ref, activation);
	const shouldHydrate = activation === "connect" || activation === "wake";
	useEffect(() => {
		if (
			ref === null ||
			!shouldHydrate ||
			view.data === null ||
			view.data.pr === null ||
			view.data.pr.state === "none" ||
			view.data.prDetailsIdentity === pullRequestIdentity(view.data.pr)
		) {
			return;
		}
		void hydrateGitPrDetails(ref);
	}, [ref, shouldHydrate, view.data]);
	return useMemo(() => {
		const projected = projectResourceView(view, (data) => ({
			details: data.prDetails,
			error: data.prDetailsError,
			revision: data.revision,
		}));
		return view.data?.prDetailsLoading === true
			? { ...projected, sync: "synchronizing" }
			: projected;
	}, [view]);
};

export const refreshGitWorkspace = (ref: ExecutionRef): Promise<void> => {
	const id = resourceKeyId(gitWorkspaceResourceKey(ref));
	const existing = manualRefreshes.get(id);
	if (existing !== undefined) return existing;
	const request = Promise.resolve()
		.then(() => workspaceRefreshers.get(id)?.refresh())
		.then(() => undefined)
		.finally(() => manualRefreshes.delete(id));
	manualRefreshes.set(id, request);
	return request;
};

export const refreshGitReview = async (ref: ExecutionRef): Promise<void> => {
	await refreshGitWorkspace(ref);
	await hydrateGitReviewPatches(ref, true);
};

export const refreshGitPrDetails = async (ref: ExecutionRef): Promise<void> => {
	await refreshGitWorkspace(ref);
	await hydrateGitPrDetails(ref, true);
};

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
		| "git.stack"
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
	if (
		input.kind === "git.stack" &&
		(input.payload as { action?: string }).action === "view"
	)
		return dispatched;
	if (
		[
			"git.branches",
			"git.reviewIdentity",
			"git.reviewFileContents",
			"git.diff",
			"git.issueMarkdown",
			"git.listPrs",
			"git.listIssues",
		].includes(input.kind)
	)
		return dispatched;
	void dispatched
		.then(async () => {
			await refreshGitWorkspace(input.ref);
			if (
				input.kind === "git.createReviewComment" ||
				input.kind === "git.mergePr" ||
				input.kind === "git.markReady"
			) {
				await hydrateGitPrDetails(input.ref, true);
			}
		})
		.catch(() => undefined);
	return dispatched;
};

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
	if (initial.data?.reviewPatches[path] !== undefined) return Promise.resolve();
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
				reviewPatches: {
					...data.reviewPatches,
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
	reviewHydrationRequests.clear();
	prDetailsRequests.clear();
	manualRefreshes.clear();
	patchRequests.clear();
};
