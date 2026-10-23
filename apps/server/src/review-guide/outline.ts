/**
 * What a guide is written from: the change reduced to its hunks, each with
 * a stable id, a classification, and a one-line digest. Everything here is
 * deterministic and runs before any model token is spent; the agent only
 * decides how the core hunks group into chapters and in what order.
 *
 * @module review-guide/outline
 */

import { NEW_SINCE_GUIDE_ID } from "@zuse/client-runtime/review-guide-view";
import {
	classifyReviewFile,
	detectMoves,
	hunkIds,
	isImportOnlyHunk,
	isMovedWholeHunk,
	isWhitespaceOnlyHunk,
	type PatchHunk,
	type ReviewFileKind,
	splitPatchHunks,
} from "@zuse/client-runtime/review-outline";
import {
	type GitReviewPatch,
	ReviewGuideChapter,
	type ReviewGuideChapterKind,
} from "@zuse/contracts";

export type OutlineHunkKind = ReviewFileKind | "mechanical";

export interface OutlineHunk {
	/** Stable id, `path@fingerprint`. */
	readonly id: string;
	/** Short handle the agent uses: `h12`. */
	readonly handle: string;
	readonly path: string;
	readonly kind: OutlineHunkKind;
	/** Git's enclosing-function hint from the hunk header, if any. */
	readonly enclosing: string;
	readonly added: number;
	readonly removed: number;
	/** First changed line, trimmed, for the digest. */
	readonly preview: string;
	/** The hunk as patch text, for `guide_read_hunks`. */
	readonly text: string;
}

export interface OutlineFile {
	/** Short handle the agent uses in large mode: `f3`. */
	readonly handle: string;
	readonly path: string;
	readonly hunkIds: ReadonlyArray<string>;
	readonly added: number;
	readonly removed: number;
}

export interface ChangeOutline {
	readonly hunks: ReadonlyArray<OutlineHunk>;
	readonly files: ReadonlyArray<OutlineFile>;
	/** Ids the agent must place into chapters. */
	readonly coreIds: ReadonlyArray<string>;
	readonly changedLines: number;
	/** Digest per file rather than per hunk, for very large changes. */
	readonly large: boolean;
}

/** Above either limit the agent sees files rather than hunks. */
const LARGE_CORE_HUNKS = 400;
const LARGE_CHANGED_LINES = 5_000;

const countLines = (hunk: PatchHunk, sign: "+" | "-"): number =>
	hunk.lines.filter((line) => line.startsWith(sign)).length;

const previewOf = (hunk: PatchHunk): string => {
	const line =
		hunk.lines.find(
			(candidate) => candidate.startsWith("+") && candidate.trim().length > 1,
		) ?? hunk.lines.find((candidate) => candidate.startsWith("-"));
	return (line ?? "").slice(1).trim().slice(0, 100);
};

const hunkText = (hunk: PatchHunk): string =>
	[
		`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${hunk.suffix}`,
		...hunk.lines,
	].join("\n");

/**
 * Builds the outline from review patches as git produced them. Hunk ids
 * depend on changed lines only, so they match what clients compute from
 * the scope-extended patches they render.
 */
export const buildOutline = (
	patches: ReadonlyArray<GitReviewPatch>,
): ChangeOutline => {
	const parsed = patches.map((patch) => {
		const hunks =
			patch.error === null && patch.result.patch.length > 0
				? splitPatchHunks(patch.result.patch).hunks
				: [];
		// Binary files, mode-only changes, and unreadable patches have no hunk
		// to point at; the whole file is one id, as clients compute it too.
		return {
			path: patch.path,
			kind: classifyReviewFile(patch.path),
			hunks,
			opaque: hunks.length === 0,
		};
	});
	const moves = detectMoves(
		parsed.map((file) => ({ path: file.path, hunks: file.hunks })),
	);
	const hunks: OutlineHunk[] = [];
	const files: OutlineFile[] = [];
	let changedLines = 0;
	for (const file of parsed) {
		const ids = file.opaque
			? [`${file.path}@file`]
			: hunkIds(file.path, file.hunks);
		let fileAdded = 0;
		let fileRemoved = 0;
		if (file.opaque) {
			hunks.push({
				id: ids[0] ?? `${file.path}@file`,
				handle: `h${hunks.length + 1}`,
				path: file.path,
				kind: file.kind === "core" ? "mechanical" : file.kind,
				enclosing: "",
				added: 0,
				removed: 0,
				preview: "(no textual diff)",
				text: "",
			});
		}
		file.hunks.forEach((hunk, index) => {
			const added = countLines(hunk, "+");
			const removed = countLines(hunk, "-");
			fileAdded += added;
			fileRemoved += removed;
			const mechanical =
				isWhitespaceOnlyHunk(hunk) ||
				isImportOnlyHunk(hunk) ||
				isMovedWholeHunk(file.path, hunk, moves);
			hunks.push({
				id: ids[index] ?? `${file.path}@${index}`,
				handle: `h${hunks.length + 1}`,
				path: file.path,
				kind: file.kind === "core" && mechanical ? "mechanical" : file.kind,
				enclosing: hunk.suffix.trim(),
				added,
				removed,
				preview: previewOf(hunk),
				text: hunkText(hunk),
			});
		});
		changedLines += fileAdded + fileRemoved;
		files.push({
			handle: `f${files.length + 1}`,
			path: file.path,
			hunkIds: ids,
			added: fileAdded,
			removed: fileRemoved,
		});
	}
	const coreIds = hunks
		.filter((hunk) => hunk.kind === "core")
		.map((hunk) => hunk.id);
	return {
		hunks,
		files,
		coreIds,
		changedLines,
		large:
			coreIds.length > LARGE_CORE_HUNKS || changedLines > LARGE_CHANGED_LINES,
	};
};

const AUTO_CHAPTERS: ReadonlyArray<{
	readonly kind: Exclude<ReviewGuideChapterKind, "core">;
	readonly title: string;
	readonly summary: string;
}> = [
	{
		kind: "tests",
		title: "Tests",
		summary: "Tests and fixtures that changed with this work.",
	},
	{
		kind: "mechanical",
		title: "Mechanical changes",
		summary:
			"Moved code, re-indentation, import lists, and files without a textual diff.",
	},
	{
		kind: "generated",
		title: "Generated files",
		summary: "Lockfiles and generated output. Rarely worth reading.",
	},
];

/** Chapters the server writes itself; the agent can't take these ids. */
export const OTHER_CHANGES_CHAPTER_ID = "other-changes";
const AUTO_CHAPTER_PREFIX = "auto-";
export const isReservedChapterId = (id: string): boolean =>
	id === OTHER_CHANGES_CHAPTER_ID ||
	id === NEW_SINCE_GUIDE_ID ||
	id.startsWith(AUTO_CHAPTER_PREFIX);

/** The collapsed groups at the end of every guide, in a fixed order. */
export const autoChapters = (
	outline: ChangeOutline,
	firstOrdinal: number,
): ReadonlyArray<ReviewGuideChapter> => {
	let ordinal = firstOrdinal;
	return AUTO_CHAPTERS.flatMap((group) => {
		const ids = outline.hunks
			.filter((hunk) => hunk.kind === group.kind)
			.map((hunk) => hunk.id);
		if (ids.length === 0) return [];
		return [
			new ReviewGuideChapter({
				id: `${AUTO_CHAPTER_PREFIX}${group.kind}`,
				ordinal: ordinal++,
				kind: group.kind,
				title: group.title,
				summary: group.summary,
				hunkIds: ids,
				validatedBy: [],
				askHints: [],
				auto: true,
			}),
		];
	});
};

/**
 * The compact view the agent reads instead of exploring the repository:
 * one line per core hunk (or per file for a very large change), plus a
 * line per collapsed group so it knows what it may cite as tests.
 */
export const outlineDigest = (outline: ChangeOutline): string => {
	const core = outline.hunks.filter((hunk) => hunk.kind === "core");
	const lines: string[] = [];
	if (outline.large) {
		const coreIds = new Set(outline.coreIds);
		for (const file of outline.files) {
			const owned = file.hunkIds.filter((id) => coreIds.has(id));
			if (owned.length === 0) continue;
			lines.push(
				`${file.handle} ${file.path} +${file.added} -${file.removed} (${owned.length} hunks)`,
			);
		}
	} else {
		for (const hunk of core) {
			const where = hunk.enclosing === "" ? "" : ` @ ${hunk.enclosing}`;
			lines.push(
				`${hunk.handle} ${hunk.path}${where} +${hunk.added} -${hunk.removed} | ${hunk.preview}`,
			);
		}
	}
	const tests = outline.hunks.filter((hunk) => hunk.kind === "tests");
	if (tests.length > 0) {
		lines.push("", "Tests (collapsed; cite them in validatedBy):");
		for (const hunk of tests)
			lines.push(`${hunk.handle} ${hunk.path} +${hunk.added} -${hunk.removed}`);
	}
	for (const kind of ["mechanical", "generated"] as const) {
		const count = outline.hunks.filter((hunk) => hunk.kind === kind).length;
		if (count > 0)
			lines.push("", `${count} ${kind} hunks are grouped already.`);
	}
	return lines.join("\n");
};

/**
 * Resolves the agent's handles (`h12`, `f3`) or full ids to hunk ids. File
 * handles expand to the file's hunks of the wanted kinds.
 */
export const resolveHandles = (
	outline: ChangeOutline,
	handles: ReadonlyArray<string>,
	kinds: ReadonlySet<OutlineHunkKind>,
): {
	readonly ids: ReadonlyArray<string>;
	readonly unknown: ReadonlyArray<string>;
} => {
	const byHandle = new Map(outline.hunks.map((hunk) => [hunk.handle, hunk]));
	const byId = new Map(outline.hunks.map((hunk) => [hunk.id, hunk]));
	const files = new Map(outline.files.map((file) => [file.handle, file]));
	const ids: string[] = [];
	const unknown: string[] = [];
	for (const raw of handles) {
		const handle = raw.trim();
		const file = files.get(handle);
		if (file !== undefined) {
			for (const id of file.hunkIds) {
				const hunk = byId.get(id);
				if (hunk !== undefined && kinds.has(hunk.kind)) ids.push(id);
			}
			continue;
		}
		const hunk = byHandle.get(handle) ?? byId.get(handle);
		if (hunk === undefined || !kinds.has(hunk.kind)) unknown.push(handle);
		else ids.push(hunk.id);
	}
	return { ids: [...new Set(ids)], unknown };
};
