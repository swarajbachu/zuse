import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

import { ProviderId } from "./agent.ts";
import { FolderId, WorktreeId } from "./ids.ts";
import { SessionId } from "./session.ts";

/**
 * A guided review walks a reader through a workspace's changes in reading
 * order, beside the diff itself: a before/after for the whole change, then
 * short chapters, each owning the hunks that carry one idea. Tests,
 * generated files, and mechanical edits (moves, renames, re-indentation)
 * are grouped at the end, collapsed, so the reader starts where judgment is
 * needed.
 *
 * Chapters own hunks by id (`path@fingerprint`, see `hunkIds` in
 * `@zuse/client-runtime/review-outline`), so a guide written for one
 * revision still recognizes its chapters after unrelated edits elsewhere.
 */

export const ReviewGuideChapterKind = Schema.Literals([
	"core",
	"tests",
	"generated",
	"mechanical",
]);
export type ReviewGuideChapterKind = typeof ReviewGuideChapterKind.Type;

export class ReviewGuideChapter extends Schema.Class<ReviewGuideChapter>(
	"ReviewGuideChapter",
)({
	id: Schema.String,
	ordinal: Schema.Number,
	kind: ReviewGuideChapterKind,
	title: Schema.String,
	/** Two or three sentences: what changed here and why it matters. */
	summary: Schema.String,
	hunkIds: Schema.Array(Schema.String),
	/** Test hunks that exercise this chapter's code. */
	validatedBy: Schema.Array(Schema.String),
	/** Short questions a reader might ask the author about this chapter. */
	askHints: Schema.Array(Schema.String),
	/** Written by the server's classification rather than the agent. */
	auto: Schema.Boolean,
}) {}

/**
 * One line of the before/after sketch: a few lines of pseudo-code tracing the
 * path the change touches. Removed lines are what used to happen, added lines
 * what happens now, context lines what stayed. A changed line may carry a
 * short note and the id of the chapter that implements it.
 */
export const ReviewGuideSketchLine = Schema.Struct({
	kind: Schema.Literals(["context", "add", "remove"]),
	indent: Schema.Number,
	code: Schema.String,
	note: Schema.NullOr(Schema.String),
	chapterId: Schema.NullOr(Schema.String),
});
export type ReviewGuideSketchLine = typeof ReviewGuideSketchLine.Type;

export class ReviewGuideOverview extends Schema.Class<ReviewGuideOverview>(
	"ReviewGuideOverview",
)({
	/** A short title for the change, like a pull request's. */
	title: Schema.String,
	/** A sentence or two: what the change does and why. */
	context: Schema.String,
	/** Two to five steps the change takes, in the order it works. */
	steps: Schema.Array(Schema.String),
	beforeAfter: Schema.NullOr(
		Schema.Struct({
			/** What the sketch traces, e.g. "How a retry delay is chosen". */
			caption: Schema.String,
			lines: Schema.Array(ReviewGuideSketchLine),
		}),
	),
}) {}

export const ReviewGuideStatus = Schema.Literals([
	"ready",
	"failed",
	"interrupted",
]);
export type ReviewGuideStatus = typeof ReviewGuideStatus.Type;

export class ReviewGuide extends Schema.Class<ReviewGuide>("ReviewGuide")({
	id: Schema.String,
	folderId: FolderId,
	worktreeId: Schema.NullOr(WorktreeId),
	status: ReviewGuideStatus,
	/** The chat whose agent wrote the code, and is the one to ask about it. */
	originSessionId: Schema.NullOr(SessionId),
	providerId: ProviderId,
	model: Schema.String,
	baseSha: Schema.String,
	headSha: Schema.String,
	overview: Schema.NullOr(ReviewGuideOverview),
	chapters: Schema.Array(ReviewGuideChapter),
	error: Schema.NullOr(Schema.String),
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
}) {}

export class ReviewGuideRun extends Schema.Class<ReviewGuideRun>(
	"ReviewGuideRun",
)({
	/** Short head the run is writing for, shown as "Updating for <sha>". */
	forSha: Schema.String,
	phase: Schema.Literals(["outlining", "writing"]),
	overview: Schema.NullOr(ReviewGuideOverview),
	/** Chapters written so far, in reading order. */
	chapters: Schema.Array(ReviewGuideChapter),
	assigned: Schema.Number,
	total: Schema.Number,
}) {}

export const ReviewGuideUnavailableReason = Schema.Literals([
	"disabled",
	"unsupported-provider",
	"no-session",
	"no-changes",
	"too-large",
]);
export type ReviewGuideUnavailableReason =
	typeof ReviewGuideUnavailableReason.Type;

export class ReviewGuideState extends Schema.Class<ReviewGuideState>(
	"ReviewGuideState",
)({
	/** The last guide written, kept readable while a newer one is written. */
	guide: Schema.NullOr(ReviewGuide),
	run: Schema.NullOr(ReviewGuideRun),
	/** Why a guide cannot be written right now, or null when it can. */
	unavailable: Schema.NullOr(ReviewGuideUnavailableReason),
	/** Why the last run failed, until the next one starts. */
	lastError: Schema.NullOr(Schema.String),
	/** Provider and model a new guide would be written with. */
	writer: Schema.NullOr(
		Schema.Struct({ providerId: ProviderId, model: Schema.String }),
	),
}) {}

export class ReviewGuideError extends Schema.TaggedErrorClass<ReviewGuideError>()(
	"ReviewGuideError",
	{ reason: Schema.String },
) {}

const WorkspaceRef = {
	folderId: FolderId,
	worktreeId: Schema.NullOr(WorktreeId),
};

/** Live state of a workspace's guide: the stored one plus any run. */
export const ReviewGuideStreamRpc = Rpc.make("reviewGuide.stream", {
	payload: Schema.Struct(WorkspaceRef),
	success: ReviewGuideState,
	error: ReviewGuideError,
	stream: true,
});

/**
 * Write or refresh the guide now. `force` writes one even when the change is
 * over the automatic size limit.
 */
export const ReviewGuideGenerateRpc = Rpc.make("reviewGuide.generate", {
	payload: Schema.Struct({
		...WorkspaceRef,
		originSessionId: Schema.optional(Schema.NullOr(SessionId)),
		force: Schema.optional(Schema.Boolean),
	}),
	success: Schema.Void,
	error: ReviewGuideError,
});

export const ReviewGuideCancelRpc = Rpc.make("reviewGuide.cancel", {
	payload: Schema.Struct(WorkspaceRef),
	success: Schema.Void,
	error: ReviewGuideError,
});
