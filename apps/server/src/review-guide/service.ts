/**
 * Guided reviews for a workspace's changes: one guide per checkout, written
 * by a hidden read-only run of the authoring chat's own agent, kept current
 * as the agent keeps working.
 *
 * A run writes into memory and streams there; only a finished guide replaces
 * the stored one, so readers never see half a guide and a restart mid-run
 * leaves the previous guide intact. Refreshes reuse every chapter whose hunks
 * are unchanged and ask the agent only about what moved.
 *
 * @module review-guide/service
 */
import {
	type FolderId,
	type GitReviewPatch,
	type ProviderId,
	ReviewGuide,
	ReviewGuideError,
	ReviewGuideRun,
	ReviewGuideState,
	type ReviewGuideUnavailableReason,
	type SessionId,
	type WorktreeId,
} from "@zuse/contracts";
import { GitService } from "@zuse/git/git-service";
import {
	Cause,
	Context,
	Effect,
	FiberMap,
	Layer,
	PubSub,
	Semaphore,
	Stream,
} from "effect";
import { SqlClient } from "effect/unstable/sql";

import { ConfigStoreService } from "../config-store/services/config-store-service.ts";
import { HiddenAgentRunner } from "../provider/hidden-agent-run.ts";
import { pullRequestIntent, readSessionIntent } from "./intent.ts";
import { autoChapters, buildOutline, type ChangeOutline } from "./outline.ts";
import { buildGuidePrompt } from "./prompt.ts";
import { makeReviewGuideRepository, workspaceKey } from "./repository.ts";
import { GuideDraft } from "./tools.ts";

/** Providers whose read-only runs and app tools are verified for guides. */
const GUIDE_PROVIDERS: ReadonlySet<string> = new Set(["claude", "codex"]);
/** Automatic refreshes wait for a quiet moment after the last trigger. */
const AUTO_DEBOUNCE = "20 seconds";
/** Automatic runs skip changes this large; a person can still ask. */
const AUTO_MAX_CHANGED_LINES = 20_000;
const AUTO_MAX_HUNKS = 1_500;
/** Above this share of changed hunks the overview is rewritten. */
const OVERVIEW_REWRITE_SHARE = 0.3;
const RUN_TIMEOUT = "6 minutes";
const RUN_IDLE_TIMEOUT = "90 seconds";

export interface WorkspaceRef {
	readonly folderId: FolderId;
	readonly worktreeId: WorktreeId | null;
}

export type RefreshReason = "manual" | "turn" | "commit" | "push";

export interface ReviewGuideServiceShape {
	readonly stream: (
		ref: WorkspaceRef,
	) => Stream.Stream<ReviewGuideState, ReviewGuideError>;
	/** Write or refresh now, superseding any run for the workspace. */
	readonly generate: (
		ref: WorkspaceRef,
		options: {
			readonly originSessionId?: SessionId | null;
			readonly force?: boolean;
		},
	) => Effect.Effect<void, ReviewGuideError>;
	readonly cancel: (ref: WorkspaceRef) => Effect.Effect<void>;
	/**
	 * Ask for a refresh after the workspace changed. Debounced per
	 * workspace, skipped when automatic guides are off, never fails.
	 */
	readonly requestRefresh: (
		ref: WorkspaceRef,
		reason: Exclude<RefreshReason, "manual">,
		originSessionId?: SessionId | null,
	) => Effect.Effect<void>;
}

export class ReviewGuideService extends Context.Service<
	ReviewGuideService,
	ReviewGuideServiceShape
>()("memoize/ReviewGuideService") {}

interface Writer {
	readonly sessionId: SessionId;
	readonly providerId: ProviderId;
	readonly model: string;
}

interface WorkspaceNotes {
	readonly unavailable: ReviewGuideUnavailableReason | null;
	readonly lastError: string | null;
}

const failure = (reason: string) => new ReviewGuideError({ reason });

/** Which stored chapters survive into the next guide, and what changed. */
export const planUpdate = (
	previous: ReviewGuide | null,
	outline: ChangeOutline,
) => {
	if (previous === null)
		return { unchanged: false, kept: [], keepOverview: false } as const;
	const live = new Set(outline.hunks.map((hunk) => hunk.id));
	const stored = new Set(
		previous.chapters.flatMap((chapter) => chapter.hunkIds),
	);
	const added = [...live].filter((id) => !stored.has(id));
	const removed = [...stored].filter((id) => !live.has(id));
	if (added.length === 0 && removed.length === 0)
		return { unchanged: true, kept: [], keepOverview: true } as const;
	const kept = previous.chapters.filter(
		(chapter) => !chapter.auto && chapter.hunkIds.every((id) => live.has(id)),
	);
	const previousFiles = new Set(
		[...stored].map((id) => id.slice(0, id.lastIndexOf("@"))),
	);
	const newFile = outline.files.some((file) => !previousFiles.has(file.path));
	const share = (added.length + removed.length) / Math.max(1, live.size);
	return {
		unchanged: false,
		kept,
		keepOverview:
			previous.overview !== null && !newFile && share <= OVERVIEW_REWRITE_SHARE,
	} as const;
};

export const ReviewGuideServiceLive = Layer.effect(
	ReviewGuideService,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const git = yield* GitService;
		const config = yield* ConfigStoreService;
		const runner = yield* HiddenAgentRunner;
		const repository = makeReviewGuideRepository(sql);
		const changes = yield* PubSub.unbounded<string>();
		const fibers = yield* FiberMap.make<string>();
		// Hidden runs spend the user's tokens and a provider process each.
		const slots = yield* Semaphore.make(2);
		const runs = new Map<string, ReviewGuideRun>();
		const notes = new Map<string, WorkspaceNotes>();

		const publish = (key: string) => PubSub.publish(changes, key);
		const note = (key: string, next: Partial<WorkspaceNotes>) =>
			Effect.suspend(() => {
				const current = notes.get(key) ?? {
					unavailable: null,
					lastError: null,
				};
				notes.set(key, { ...current, ...next });
				return publish(key);
			});

		const settings = config.getSettings();

		/** The chat to write for: the one asked about, else the latest here. */
		const findWriter = (
			ref: WorkspaceRef,
			preferred: SessionId | null | undefined,
		) =>
			Effect.gen(function* () {
				const rows = yield* sql<{
					readonly id: string;
					readonly provider_id: string;
					readonly model: string;
				}>`
					SELECT id, provider_id, model FROM sessions
					WHERE project_id = ${ref.folderId}
						AND worktree_id IS ${ref.worktreeId}
						AND archived_at IS NULL
						AND parent_session_id IS NULL
					ORDER BY CASE WHEN id = ${preferred ?? ""} THEN 0 ELSE 1 END,
						updated_at DESC
					LIMIT 1`;
				const row = rows[0];
				return row === undefined
					? null
					: ({
							sessionId: row.id as SessionId,
							providerId: row.provider_id as ProviderId,
							model: row.model,
						} satisfies Writer);
			}).pipe(Effect.orElseSucceed(() => null));

		const checkoutPath = (ref: WorkspaceRef) =>
			Effect.gen(function* () {
				const rows =
					ref.worktreeId === null
						? yield* sql<{ readonly path: string }>`
								SELECT path FROM projects WHERE id = ${ref.folderId}`
						: yield* sql<{ readonly path: string }>`
								SELECT path FROM worktrees WHERE id = ${ref.worktreeId}`;
				return rows[0]?.path ?? null;
			}).pipe(Effect.orElseSucceed(() => null));

		const state = (ref: WorkspaceRef) =>
			Effect.gen(function* () {
				const key = workspaceKey(ref.folderId, ref.worktreeId);
				const [guide, current, writer] = yield* Effect.all(
					[
						repository
							.get(ref.folderId, ref.worktreeId)
							.pipe(Effect.orElseSucceed(() => null)),
						settings,
						findWriter(ref, null),
					],
					{ concurrency: "unbounded" },
				);
				const workspaceNotes = notes.get(key);
				const unavailable: ReviewGuideUnavailableReason | null =
					current.reviewGuidesEnabled === false
						? "disabled"
						: writer === null
							? "no-session"
							: !GUIDE_PROVIDERS.has(writer.providerId)
								? "unsupported-provider"
								: (workspaceNotes?.unavailable ?? null);
				return new ReviewGuideState({
					guide,
					run: runs.get(key) ?? null,
					unavailable,
					lastError: workspaceNotes?.lastError ?? null,
					writer:
						writer === null
							? null
							: { providerId: writer.providerId, model: writer.model },
				});
			});

		const readChange = (ref: WorkspaceRef) =>
			Effect.all(
				{
					summary: git.reviewSummary(ref.folderId, ref.worktreeId, "branch"),
					patches: Stream.runCollect(
						git.reviewPatches(ref.folderId, ref.worktreeId, "branch"),
					),
				},
				{ concurrency: "unbounded" },
			).pipe(
				Effect.mapError(() =>
					failure("Could not read the workspace's changes."),
				),
			);

		const write = (
			ref: WorkspaceRef,
			options: {
				readonly originSessionId?: SessionId | null;
				readonly force?: boolean;
				readonly automatic: boolean;
			},
		) =>
			Effect.gen(function* () {
				const key = workspaceKey(ref.folderId, ref.worktreeId);
				const current = yield* settings;
				if (current.reviewGuidesEnabled === false)
					return yield* failure("Guided reviews are turned off in Settings.");
				// Automatic refreshes wait out a debounce; the setting may have been
				// turned off since they were queued.
				if (options.automatic && current.reviewGuidesAutoGenerate === false)
					return;
				const writer = yield* findWriter(ref, options.originSessionId);
				if (writer === null)
					return yield* failure(
						"Start a chat in this workspace to write a guide.",
					);
				if (!GUIDE_PROVIDERS.has(writer.providerId))
					return yield* failure(
						"Guides can be written by Claude or Codex chats. Switch this chat's provider to write one.",
					);
				const cwd = yield* checkoutPath(ref);
				if (cwd === null)
					return yield* failure("This workspace is not available.");

				const { summary, patches } = yield* readChange(ref);
				const outline = buildOutline(patches as ReadonlyArray<GitReviewPatch>);
				if (outline.hunks.length === 0) {
					yield* note(key, { unavailable: "no-changes" });
					return;
				}
				if (
					options.automatic &&
					options.force !== true &&
					(outline.changedLines > AUTO_MAX_CHANGED_LINES ||
						outline.hunks.length > AUTO_MAX_HUNKS)
				) {
					yield* note(key, { unavailable: "too-large" });
					return;
				}
				const headSha = summary.headSha ?? "";
				const baseSha = summary.baseSha ?? "";
				const previous = yield* repository
					.get(ref.folderId, ref.worktreeId)
					.pipe(Effect.orElseSucceed(() => null));
				// A forced write is a person asking for a fresh guide: nothing is reused.
				const update =
					options.force === true
						? ({ unchanged: false, kept: [], keepOverview: false } as const)
						: planUpdate(previous, outline);
				if (update.unchanged && previous !== null) {
					if (previous.headSha !== headSha)
						yield* repository
							.touch(previous.id, headSha, Date.now())
							.pipe(Effect.ignore);
					yield* note(key, { unavailable: null, lastError: null });
					return;
				}

				const draft = new GuideDraft(
					outline,
					update.kept,
					update.keepOverview ? (previous?.overview ?? null) : null,
				);
				const showRun = (phase: ReviewGuideRun["phase"]) =>
					Effect.suspend(() => {
						runs.set(
							key,
							new ReviewGuideRun({
								forSha: headSha.slice(0, 7),
								phase,
								overview: draft.overview ?? previous?.overview ?? null,
								chapters: draft.chapterList,
								assigned: draft.assigned,
								total: outline.coreIds.length,
							}),
						);
						return publish(key);
					});
				yield* note(key, { unavailable: null, lastError: null });
				yield* showRun("outlining");

				const [session, pullRequest] = yield* Effect.all(
					[
						readSessionIntent(sql, writer.sessionId).pipe(
							Effect.orElseSucceed(() => ({ requests: [], lastReply: null })),
						),
						git.prDetails(ref.folderId, ref.worktreeId).pipe(
							Effect.map(pullRequestIntent),
							Effect.orElseSucceed(() => null),
						),
					],
					{ concurrency: "unbounded" },
				);
				const prompt = buildGuidePrompt({
					outline,
					intent: { ...session, pullRequest },
					baseSha,
					kept: update.kept,
					keepOverview: update.keepOverview,
				});
				yield* showRun("writing");
				const toolset = draft.toolset(() => {
					Effect.runFork(showRun("writing"));
				});
				// The turn's own error (signed out, rate limited) is the most useful
				// thing to tell a reader when the agent wrote nothing.
				let agentError: string | null = null;
				const runError = yield* slots
					.withPermits(1)(
						runner.run(
							{
								label: "review-guide",
								folderId: ref.folderId,
								providerId: writer.providerId,
								model: writer.model,
								prompt,
								access: { _tag: "ReadOnly", cwd, toolsets: [toolset] },
								timeout: RUN_TIMEOUT,
								idleTimeout: RUN_IDLE_TIMEOUT,
							},
							(events) =>
								Stream.runForEach(events, (event) =>
									Effect.sync(() => {
										if (event._tag === "Error") agentError = event.message;
									}),
								),
						),
					)
					.pipe(
						Effect.as(null),
						Effect.catch((error) => Effect.succeed(error.message)),
					);
				// A run that wrote some of the guide before stopping still leaves a
				// useful guide; one that wrote nothing is a failure. An update can
				// rightly write nothing new: it kept every chapter and the overview,
				// and only finished.
				const carriedOver =
					draft.finished && (update.kept.length > 0 || update.keepOverview);
				if (draft.writes === 0 && !carriedOver)
					return yield* failure(
						agentError ?? runError ?? "The agent did not write the guide.",
					);
				if (!draft.finished) draft.finish({ force: true });

				const core = draft.chapterList.map((chapter, ordinal) => ({
					...chapter,
					ordinal,
				}));
				const now = Date.now();
				yield* repository
					.put(
						new ReviewGuide({
							id: crypto.randomUUID(),
							folderId: ref.folderId,
							worktreeId: ref.worktreeId,
							status: "ready",
							originSessionId: writer.sessionId,
							providerId: writer.providerId,
							model: writer.model,
							baseSha,
							headSha,
							// Already the previous overview when the update could reuse
							// it; a stale one never sits above rewritten chapters.
							overview: draft.overview,
							chapters: [...core, ...autoChapters(outline, core.length)],
							error: null,
							createdAt: previous?.createdAt ?? now,
							updatedAt: now,
						}),
					)
					.pipe(Effect.mapError(() => failure("Could not save the guide.")));
			}).pipe(
				Effect.ensuring(
					Effect.suspend(() => {
						const key = workspaceKey(ref.folderId, ref.worktreeId);
						runs.delete(key);
						return publish(key);
					}),
				),
			);

		/** Runs one write in the workspace's slot, superseding any before it. */
		const launch = (
			ref: WorkspaceRef,
			body: Effect.Effect<void, ReviewGuideError>,
		) =>
			FiberMap.run(
				fibers,
				workspaceKey(ref.folderId, ref.worktreeId),
				body.pipe(
					Effect.catchCause((cause) =>
						Cause.hasInterruptsOnly(cause)
							? Effect.void
							: Effect.logWarning("Review guide run failed", {
									cause: Cause.pretty(cause),
								}).pipe(
									Effect.andThen(
										note(workspaceKey(ref.folderId, ref.worktreeId), {
											lastError:
												Cause.squash(cause) instanceof ReviewGuideError
													? (Cause.squash(cause) as ReviewGuideError).reason
													: "The guide could not be written.",
										}),
									),
								),
					),
				),
			).pipe(Effect.asVoid);

		const generate: ReviewGuideServiceShape["generate"] = (ref, options) =>
			Effect.gen(function* () {
				const current = yield* settings;
				if (current.reviewGuidesEnabled === false)
					return yield* failure("Guided reviews are turned off in Settings.");
				yield* launch(ref, write(ref, { ...options, automatic: false }));
			});

		const cancel: ReviewGuideServiceShape["cancel"] = (ref) =>
			FiberMap.remove(fibers, workspaceKey(ref.folderId, ref.worktreeId));

		const requestRefresh: ReviewGuideServiceShape["requestRefresh"] = (
			ref,
			_reason,
			originSessionId,
		) =>
			Effect.gen(function* () {
				const current = yield* settings;
				if (
					current.reviewGuidesEnabled === false ||
					current.reviewGuidesAutoGenerate === false
				)
					return;
				yield* launch(
					ref,
					Effect.sleep(AUTO_DEBOUNCE).pipe(
						Effect.andThen(write(ref, { originSessionId, automatic: true })),
					),
				);
			}).pipe(Effect.ignore);

		const stream: ReviewGuideServiceShape["stream"] = (ref) => {
			const key = workspaceKey(ref.folderId, ref.worktreeId);
			return Stream.concat(
				Stream.succeed(key),
				Stream.fromPubSub(changes).pipe(
					Stream.filter((changed) => changed === key),
				),
			).pipe(
				Stream.mapEffect(() =>
					state(ref).pipe(
						Effect.mapError(() => failure("Could not read the guide.")),
					),
				),
			);
		};

		return {
			stream,
			generate,
			cancel,
			requestRefresh,
		} satisfies ReviewGuideServiceShape;
	}),
);
