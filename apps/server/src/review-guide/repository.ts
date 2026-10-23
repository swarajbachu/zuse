import {
	type FolderId,
	type ProviderId,
	ReviewGuide,
	ReviewGuideChapter,
	type ReviewGuideChapterKind,
	ReviewGuideOverview,
	type ReviewGuideStatus,
	type SessionId,
	type WorktreeId,
} from "@zuse/contracts";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";

/** One guide per checkout: the project's main checkout or one worktree. */
export const workspaceKey = (
	folderId: FolderId,
	worktreeId: WorktreeId | null,
): string => `${folderId}\u0000${worktreeId ?? ""}`;

interface GuideRow {
	readonly id: string;
	readonly folder_id: string;
	readonly worktree_id: string | null;
	readonly status: string;
	readonly origin_session_id: string | null;
	readonly provider_id: string;
	readonly model: string;
	readonly base_sha: string;
	readonly head_sha: string;
	readonly overview_json: string | null;
	readonly error: string | null;
	readonly created_at: number;
	readonly updated_at: number;
}

interface ChapterRow {
	readonly id: string;
	readonly ordinal: number;
	readonly kind: string;
	readonly title: string;
	readonly summary: string;
	readonly hunk_ids_json: string;
	readonly validated_by_json: string;
	readonly ask_hints_json: string;
	readonly auto: number;
}

const decodeOverview = Schema.decodeUnknownEffect(
	Schema.fromJsonString(ReviewGuideOverview),
);
const decodeStrings = Schema.decodeUnknownEffect(
	Schema.fromJsonString(Schema.Array(Schema.String)),
);

export const makeReviewGuideRepository = (sql: SqlClient.SqlClient) => {
	const get = (folderId: FolderId, worktreeId: WorktreeId | null) =>
		Effect.gen(function* () {
			const rows = yield* sql<GuideRow>`
				SELECT * FROM review_guides
				WHERE workspace_key = ${workspaceKey(folderId, worktreeId)}
				LIMIT 1`;
			const row = rows[0];
			if (row === undefined) return null;
			const chapterRows = yield* sql<ChapterRow>`
				SELECT * FROM review_guide_chapters
				WHERE guide_id = ${row.id} ORDER BY ordinal ASC`;
			const chapters = yield* Effect.forEach(chapterRows, (chapter) =>
				Effect.all({
					hunkIds: decodeStrings(chapter.hunk_ids_json),
					validatedBy: decodeStrings(chapter.validated_by_json),
					askHints: decodeStrings(chapter.ask_hints_json),
				}).pipe(
					Effect.map(
						(lists) =>
							new ReviewGuideChapter({
								id: chapter.id,
								ordinal: chapter.ordinal,
								kind: chapter.kind as ReviewGuideChapterKind,
								title: chapter.title,
								summary: chapter.summary,
								auto: chapter.auto === 1,
								...lists,
							}),
					),
				),
			);
			return new ReviewGuide({
				id: row.id,
				folderId: row.folder_id as FolderId,
				worktreeId: row.worktree_id as WorktreeId | null,
				status: row.status as ReviewGuideStatus,
				originSessionId: row.origin_session_id as SessionId | null,
				providerId: row.provider_id as ProviderId,
				model: row.model,
				baseSha: row.base_sha,
				headSha: row.head_sha,
				// An overview from an older shape reads as none; the next refresh
				// writes a current one.
				overview:
					row.overview_json === null
						? null
						: yield* decodeOverview(row.overview_json).pipe(
								Effect.orElseSucceed(() => null),
							),
				chapters,
				error: row.error,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
			});
		});

	/** Replaces the workspace's guide whole, chapters included. */
	const put = (guide: ReviewGuide) =>
		sql.withTransaction(
			Effect.gen(function* () {
				const key = workspaceKey(guide.folderId, guide.worktreeId);
				yield* sql`DELETE FROM review_guides WHERE workspace_key = ${key}`;
				yield* sql`INSERT INTO review_guides (
					id, folder_id, worktree_id, workspace_key, status, origin_session_id,
					provider_id, model, base_sha, head_sha, overview_json, error,
					created_at, updated_at
				) VALUES (
					${guide.id}, ${guide.folderId}, ${guide.worktreeId}, ${key},
					${guide.status}, ${guide.originSessionId}, ${guide.providerId},
					${guide.model}, ${guide.baseSha}, ${guide.headSha},
					${guide.overview === null ? null : JSON.stringify(guide.overview)},
					${guide.error}, ${guide.createdAt}, ${guide.updatedAt}
				)`;
				for (const chapter of guide.chapters) {
					yield* sql`INSERT INTO review_guide_chapters (
						guide_id, id, ordinal, kind, title, summary, hunk_ids_json,
						validated_by_json, ask_hints_json, auto
					) VALUES (
						${guide.id}, ${chapter.id}, ${chapter.ordinal}, ${chapter.kind},
						${chapter.title}, ${chapter.summary},
						${JSON.stringify(chapter.hunkIds)},
						${JSON.stringify(chapter.validatedBy)},
						${JSON.stringify(chapter.askHints)}, ${chapter.auto ? 1 : 0}
					)`;
				}
			}),
		);

	/** Keeps the guide but points it at a newer head the change did not alter. */
	const touch = (guideId: string, headSha: string, updatedAt: number) =>
		sql`UPDATE review_guides SET head_sha = ${headSha}, updated_at = ${updatedAt}
			WHERE id = ${guideId}`.pipe(Effect.asVoid);

	return { get, put, touch };
};

export type ReviewGuideRepository = ReturnType<
	typeof makeReviewGuideRepository
>;
