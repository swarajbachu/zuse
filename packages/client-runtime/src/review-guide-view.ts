/**
 * How a guided review lays over the live diff a client renders. Chapters
 * own hunk ids; this maps them onto the files a diff view shows, in reading
 * order, and works out what changed since the guide was written. Pure, so
 * every client shows the same tour of the same diff.
 */
import type {
	ReviewGuideChapter,
	ReviewGuideChapterKind,
} from "@zuse/contracts";

import { hunkIds, splitPatchHunks } from "./review-outline.ts";

export interface GuideViewPatch {
	readonly path: string;
	readonly patch: string;
}

export interface GuideViewChapter {
	readonly id: string;
	/** 1-based reading position among core chapters; null for groups. */
	readonly number: number | null;
	readonly kind: ReviewGuideChapterKind | "new";
	readonly title: string;
	readonly summary: string;
	/** Files this chapter shows, in diff order. */
	readonly files: ReadonlyArray<string>;
	readonly hunkCount: number;
	/** The chapter's hunks that are in the live diff. */
	readonly hunkIds: ReadonlyArray<string>;
	/** Some of the chapter's hunks are gone or changed since it was written. */
	readonly changed: boolean;
	readonly testFiles: ReadonlyArray<string>;
	readonly askHints: ReadonlyArray<string>;
	readonly auto: boolean;
}

export interface GuideView {
	/** "New since guide" first when present, then chapters in reading order. */
	readonly chapters: ReadonlyArray<GuideViewChapter>;
}

export const NEW_SINCE_GUIDE_ID = "new-since-guide";

/** The path a hunk id belongs to (`path@fingerprint`). */
export const pathOfHunkId = (id: string): string =>
	id.slice(0, id.lastIndexOf("@"));

/** Live hunk ids for the patches a client renders. */
export const liveHunkIds = (
	patches: ReadonlyArray<GuideViewPatch>,
): ReadonlyArray<string> =>
	patches.flatMap((entry) => {
		const { hunks } = splitPatchHunks(entry.patch);
		return hunks.length === 0
			? [`${entry.path}@file`]
			: hunkIds(entry.path, hunks);
	});

/**
 * Chapters split files by hunk, so a chapter is reviewed hunk by hunk: each
 * of its hunks was checked off in a chapter, or its whole file was viewed.
 * Hunk ids follow the code, so a hunk that changes is unreviewed again.
 */
export const isChapterReviewed = (
	chapter: Pick<GuideViewChapter, "hunkIds">,
	reviewedHunks: ReadonlySet<string>,
	isFileViewed: (path: string) => boolean,
): boolean =>
	chapter.hunkIds.length > 0 &&
	chapter.hunkIds.every(
		(id) => reviewedHunks.has(id) || isFileViewed(pathOfHunkId(id)),
	);

/** Reviewed hunks without any of one file's, for when the file is unchecked. */
export const withoutFileHunks = (
	reviewedHunks: ReadonlySet<string>,
	path: string,
): ReadonlySet<string> =>
	new Set([...reviewedHunks].filter((id) => pathOfHunkId(id) !== path));

/**
 * Review state after checking a chapter on or off. A file is viewed once all
 * of its hunks are reviewed. Unchecking keeps the file's other hunks
 * reviewed, so one chapter never unreviews another.
 */
export const reviewChapter = (
	chapter: Pick<GuideViewChapter, "hunkIds">,
	reviewed: boolean,
	state: {
		readonly reviewedHunks: ReadonlySet<string>;
		/** Live hunk ids of each file in the change. */
		readonly fileHunks: ReadonlyMap<string, ReadonlyArray<string>>;
		readonly isFileViewed: (path: string) => boolean;
	},
): {
	readonly reviewedHunks: ReadonlySet<string>;
	/** Files whose viewed state should flip to match `reviewed`. */
	readonly toggleFiles: ReadonlyArray<string>;
} => {
	const next = new Set(state.reviewedHunks);
	const paths = unique(chapter.hunkIds.map(pathOfHunkId));
	const toggleFiles: string[] = [];
	if (reviewed) {
		for (const id of chapter.hunkIds) next.add(id);
		for (const path of paths) {
			const all = state.fileHunks.get(path) ?? [];
			if (
				!state.isFileViewed(path) &&
				all.length > 0 &&
				all.every((id) => next.has(id))
			)
				toggleFiles.push(path);
		}
	} else {
		const own = new Set(chapter.hunkIds);
		for (const path of paths) {
			if (!state.isFileViewed(path)) continue;
			for (const id of state.fileHunks.get(path) ?? [])
				if (!own.has(id)) next.add(id);
			toggleFiles.push(path);
		}
		for (const id of own) next.delete(id);
	}
	return { reviewedHunks: next, toggleFiles };
};

const unique = <A>(values: ReadonlyArray<A>): ReadonlyArray<A> => [
	...new Set(values),
];

export const projectGuide = (
	chapters: ReadonlyArray<ReviewGuideChapter>,
	patches: ReadonlyArray<GuideViewPatch>,
	labels: { readonly newTitle: string; readonly newSummary: string },
): GuideView => {
	const diffOrder = new Map(patches.map((entry, index) => [entry.path, index]));
	const byDiffOrder = (paths: ReadonlyArray<string>) =>
		[...paths].sort(
			(a, b) =>
				(diffOrder.get(a) ?? Number.MAX_SAFE_INTEGER) -
				(diffOrder.get(b) ?? Number.MAX_SAFE_INTEGER),
		);
	const live = liveHunkIds(patches);
	const liveSet = new Set(live);
	const owned = new Set(chapters.flatMap((chapter) => chapter.hunkIds));
	const fresh = live.filter((id) => !owned.has(id));

	const ordered = [...chapters].sort((a, b) => a.ordinal - b.ordinal);
	let number = 0;
	const projected: GuideViewChapter[] = ordered.flatMap((chapter) => {
		const present = chapter.hunkIds.filter((id) => liveSet.has(id));
		const files = byDiffOrder(
			unique(present.map(pathOfHunkId)).filter((path) => diffOrder.has(path)),
		);
		if (files.length === 0 && chapter.auto) return [];
		const core = chapter.kind === "core";
		return [
			{
				id: chapter.id,
				number: core ? ++number : null,
				kind: chapter.kind,
				title: chapter.title,
				summary: chapter.summary,
				files,
				hunkCount: present.length,
				hunkIds: present,
				changed: present.length < chapter.hunkIds.length,
				testFiles: byDiffOrder(
					unique(
						chapter.validatedBy
							.filter((id) => liveSet.has(id))
							.map(pathOfHunkId),
					),
				),
				askHints: chapter.askHints,
				auto: chapter.auto,
			},
		];
	});
	if (fresh.length > 0)
		projected.unshift({
			id: NEW_SINCE_GUIDE_ID,
			number: null,
			kind: "new",
			title: labels.newTitle,
			summary: labels.newSummary,
			files: byDiffOrder(unique(fresh.map(pathOfHunkId))),
			hunkCount: fresh.length,
			hunkIds: fresh,
			changed: false,
			testFiles: [],
			askHints: [],
			auto: true,
		});

	return { chapters: projected };
};
