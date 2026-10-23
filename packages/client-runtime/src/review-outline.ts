/**
 * Pure structure of a review diff, shared by the server (guide outlines,
 * function-scoped hunks) and every client (move chips, viewed state).
 *
 * A hunk is identified by what it changes, not where it sits, so an id
 * survives edits elsewhere in the file. That is what lets a guide written
 * for one revision recognize its chapters in the next.
 */

import { fnv1a } from "./fnv1a.ts";

export interface PatchHunk {
	readonly index: number;
	/** Text after the closing `@@`, e.g. git's function-name hint. */
	readonly suffix: string;
	readonly oldStart: number;
	readonly oldLines: number;
	readonly newStart: number;
	readonly newLines: number;
	/** Body lines with their ` `/`+`/`-`/`\` prefix. */
	readonly lines: ReadonlyArray<string>;
}

export interface SplitPatch {
	/** Lines before the first hunk: `diff --git`, `index`, `---`, `+++`. */
	readonly preamble: ReadonlyArray<string>;
	readonly hunks: ReadonlyArray<PatchHunk>;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Splits one file's unified patch into its preamble and hunks. */
export const splitPatchHunks = (patch: string): SplitPatch => {
	const preamble: string[] = [];
	const hunks: PatchHunk[] = [];
	let current: {
		suffix: string;
		oldStart: number;
		oldLines: number;
		newStart: number;
		newLines: number;
		lines: string[];
	} | null = null;
	const lines = patch.split("\n");
	// A trailing newline yields one empty element that is not a context line.
	if (lines.at(-1) === "") lines.pop();
	for (const line of lines) {
		// Body lines always carry a prefix, so a header is a header even when a
		// malformed count claims more lines.
		const header = HUNK_HEADER.exec(line);
		if (header !== null) {
			if (current !== null) hunks.push({ index: hunks.length, ...current });
			current = {
				oldStart: Number(header[1]),
				oldLines: header[2] === undefined ? 1 : Number(header[2]),
				newStart: Number(header[3]),
				newLines: header[4] === undefined ? 1 : Number(header[4]),
				suffix: header[5] ?? "",
				lines: [],
			};
			continue;
		}
		if (current === null) {
			preamble.push(line);
			continue;
		}
		current.lines.push(line);
	}
	if (current !== null) hunks.push({ index: hunks.length, ...current });
	return { preamble, hunks };
};

const hunkHeader = (hunk: PatchHunk): string =>
	`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${hunk.suffix}`;

/** Inverse of `splitPatchHunks`. */
export const joinPatchHunks = (split: SplitPatch): string =>
	`${[
		...split.preamble,
		...split.hunks.flatMap((hunk) => [hunkHeader(hunk), ...hunk.lines]),
	].join("\n")}\n`;

const hash = (text: string): string => fnv1a(text).toString(36);

/** Identity of a whole file patch: changes whenever any line of it does. */
export const reviewFingerprint = (patch: string): string =>
	`${patch.length}:${hash(patch)}`;

const changedLines = (hunk: PatchHunk): ReadonlyArray<string> =>
	hunk.lines.filter((line) => line.startsWith("+") || line.startsWith("-"));

/**
 * Ids for a file's hunks, from their changed lines only: moving a hunk up or
 * down the file, or changing its context, keeps its id. Identical hunks in
 * one file are told apart by order.
 */
export const hunkIds = (
	path: string,
	hunks: ReadonlyArray<PatchHunk>,
): ReadonlyArray<string> => {
	const seen = new Map<string, number>();
	return hunks.map((hunk) => {
		const fingerprint = hash(
			changedLines(hunk)
				.map((line) => line.trimEnd())
				.join("\n"),
		);
		const occurrence = seen.get(fingerprint) ?? 0;
		seen.set(fingerprint, occurrence + 1);
		return `${path}@${fingerprint}${occurrence === 0 ? "" : `#${occurrence}`}`;
	});
};

/**
 * The file's patch narrowed to the hunks with the given ids, for showing one
 * chapter's part of a file. Null when none of the file's hunks are wanted.
 */
export const selectHunks = (
	path: string,
	patch: string,
	ids: ReadonlySet<string>,
): string | null => {
	const split = splitPatchHunks(patch);
	const fileIds = hunkIds(path, split.hunks);
	const hunks = split.hunks.filter((_, index) => ids.has(fileIds[index] ?? ""));
	if (hunks.length === 0) return null;
	return hunks.length === split.hunks.length
		? patch
		: joinPatchHunks({ ...split, hunks });
};

export type ReviewFileKind = "core" | "tests" | "generated";

const GENERATED_PATTERNS: ReadonlyArray<RegExp> = [
	/(^|\/)(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|Gemfile\.lock|poetry\.lock|composer\.lock|uv\.lock)$/,
	/\.generated\.[^/]+$/,
	/(^|\/)(generated|__generated__|dist|build)\//,
	/\.min\.(js|css)$/,
	/\.(js|css)\.map$/,
	/\.pb\.go$/,
	/_pb2(_grpc)?\.py$/,
];

const TEST_PATTERNS: ReadonlyArray<RegExp> = [
	/\.(test|spec)\.[^/]+$/,
	/(^|\/)(__tests__|__snapshots__|tests?)\//,
	/\.snap$/,
	/_test\.(go|py|rb|exs?)$/,
	/(^|\/)test_[^/]+\.py$/,
	/Tests?\.(swift|kt|java|cs)$/,
];

/** Whether a reader can skip a file by default: tests and generated output. */
export const classifyReviewFile = (path: string): ReviewFileKind =>
	GENERATED_PATTERNS.some((pattern) => pattern.test(path))
		? "generated"
		: TEST_PATTERNS.some((pattern) => pattern.test(path))
			? "tests"
			: "core";

const normalize = (line: string): string =>
	line.slice(1).trim().replace(/\s+/g, " ");

/**
 * Changed code without its layout, in order: whitespace outside string
 * literals only separates words. Re-indenting or re-wrapping keeps this the
 * same; reordering lines or editing text inside a string does not.
 */
const withoutLayout = (lines: ReadonlyArray<string>): string => {
	const text = lines.map((line) => line.slice(1)).join("\n");
	let out = "";
	let quote: string | null = null;
	let gap = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index] ?? "";
		if (quote !== null) {
			out += char;
			if (char === "\\") {
				out += text[index + 1] ?? "";
				index += 1;
			} else if (char === quote) quote = null;
			continue;
		}
		if (/\s/.test(char)) {
			gap = true;
			continue;
		}
		if (gap && /\w/.test(char) && /\w$/.test(out)) out += " ";
		gap = false;
		if (char === '"' || char === "'" || char === "`") quote = char;
		out += char;
	}
	return out;
};

/** True when the hunk only re-indents or re-wraps lines. */
export const isWhitespaceOnlyHunk = (hunk: PatchHunk): boolean => {
	const removed = hunk.lines.filter((line) => line.startsWith("-"));
	const added = hunk.lines.filter((line) => line.startsWith("+"));
	return (
		removed.length + added.length > 0 &&
		withoutLayout(removed) === withoutLayout(added)
	);
};

const IMPORT_LINE =
	/^(import\b|export\s+(\*|\{[^}]*\})\s+from\b|export\s+type\s+\{[^}]*\}\s+from\b|from\s+\S+\s+import\b|#include\b|use\s+[\w:{}, ]+;?$|require\(|\}\s*from\s+["']|[\w$]+,?$|type\s+[\w$]+,?$)/;

/** True when every changed line belongs to an import or export list. */
export const isImportOnlyHunk = (hunk: PatchHunk): boolean => {
	const changed = changedLines(hunk)
		.map(normalize)
		.filter((line) => line !== "");
	if (changed.length === 0) return false;
	// Bare identifiers are only import-list members when the hunk has a real
	// import line too; otherwise a lone `foo,` is ordinary code.
	return (
		changed.some((line) =>
			/^(import\b|export\b.*\bfrom\b|from\s|#include|use\s|.*require\()/.test(
				line,
			),
		) && changed.every((line) => IMPORT_LINE.test(line))
	);
};

const indentOf = (line: string): number => {
	const match = /^[ \t]*/.exec(line);
	return (match?.[0] ?? "").replace(/\t/g, "    ").length;
};

const CLOSER = /^\s*([}\])]|end\b|else\b|elif\b|except\b|catch\b|finally\b)/;
const DEFINITION =
	/^\s*(export\s+)?(default\s+)?(async\s+)?(pub(\([^)]*\))?\s+)?(def|class|func|fn|function|impl|module|interface|struct|enum|trait|type|public|private|protected|internal|static|override|fun|object|sub|proc|describe|it|test)\b/;
const CONTROL =
	/^\s*(if|for|while|switch|catch|with|do|try|else|return|match|loop|unless|until|when|select)\b/;
/** `name(args) {` with an optional return type: a method or function body. */
const CALLABLE_HEAD = /^\s*[\w$.<>]+\s*\([^;]*\)\s*(:\s*[^{;=]+)?\{\s*$/;

const isDefinition = (line: string): boolean =>
	DEFINITION.test(line) || (!CONTROL.test(line) && CALLABLE_HEAD.test(line));

/**
 * Where the scope around `line` (1-based) begins, judged by indentation, for
 * languages without a parser: the nearest less-indented line above that opens
 * a definition, else the nearest less-indented line that is not a closer.
 * Null at top level or when nothing qualifies within `maxUp` lines.
 */
export const indentationScopeStart = (
	lines: ReadonlyArray<string>,
	line: number,
	maxUp = 30,
): number | null => {
	let anchor = line - 1;
	while (anchor < lines.length && (lines[anchor] ?? "").trim() === "")
		anchor += 1;
	if (anchor >= lines.length) return null;
	const target = indentOf(lines[anchor] ?? "");
	if (target === 0) return null;
	let fallback: number | null = null;
	const floor = Math.max(0, anchor - maxUp);
	for (let index = anchor - 1; index >= floor; index -= 1) {
		const text = lines[index] ?? "";
		if (text.trim() === "" || indentOf(text) >= target || CLOSER.test(text))
			continue;
		if (isDefinition(text)) return index + 1;
		fallback ??= index + 1;
	}
	return fallback;
};

const firstChangedNewLine = (hunk: PatchHunk): number => {
	let newLine = hunk.newStart;
	for (const line of hunk.lines) {
		if (line.startsWith("+") || line.startsWith("-")) return newLine;
		if (!line.startsWith("\\")) newLine += 1;
	}
	return hunk.newStart;
};

const matchesNewSide = (
	hunk: PatchHunk,
	newFileLines: ReadonlyArray<string>,
): boolean => {
	let newLine = hunk.newStart;
	for (const line of hunk.lines) {
		if (line.startsWith("-") || line.startsWith("\\")) continue;
		if (newFileLines[newLine - 1] !== line.slice(1)) return false;
		newLine += 1;
	}
	return true;
};

/**
 * Grows each hunk upward so it starts where its enclosing scope does, the way
 * an editor's sticky scroll keeps the function in view. Only unchanged lines
 * are added, never more than `maxLines`, never into the hunk above, and
 * never downward. `newFileLines` is the full new side of the file.
 */
export const extendHunksToScope = (
	patch: string,
	newFileLines: ReadonlyArray<string>,
	scopeStart: (line: number) => number | null,
	maxLines = 30,
): string => {
	const split = splitPatchHunks(patch);
	if (split.hunks.length === 0) return patch;
	let previousNewEnd = 0;
	let changed = false;
	const hunks = split.hunks.map((hunk) => {
		const newEnd = hunk.newStart + hunk.newLines - 1;
		const floor = previousNewEnd + 1;
		previousNewEnd = Math.max(previousNewEnd, newEnd);
		if (hunk.newLines === 0) return hunk;
		// The file must be the hunk's new side; a stale or different read (a
		// staged diff against the working tree, say) is left alone.
		if (!matchesNewSide(hunk, newFileLines)) return hunk;
		const start = scopeStart(firstChangedNewLine(hunk));
		if (start === null || start >= hunk.newStart) return hunk;
		const from = Math.max(start, floor);
		const extra = hunk.newStart - from;
		if (extra <= 0 || extra > maxLines || hunk.oldStart - extra < 1)
			return hunk;
		const context = newFileLines
			.slice(from - 1, hunk.newStart - 1)
			.map((text) => ` ${text}`);
		if (context.length !== extra) return hunk;
		changed = true;
		return {
			...hunk,
			oldStart: hunk.oldStart - extra,
			oldLines: hunk.oldLines + extra,
			newStart: from,
			newLines: hunk.newLines + extra,
			lines: [...context, ...hunk.lines],
		};
	});
	return changed ? joinPatchHunks({ ...split, hunks }) : patch;
};

export interface MoveEnd {
	readonly path: string;
	readonly startLine: number;
	readonly endLine: number;
}

/** A block removed in one place and added, unchanged, in another. */
export interface Move {
	/** Old-side lines where the block was. */
	readonly from: MoveEnd;
	/** New-side lines where it landed. */
	readonly to: MoveEnd;
	readonly lineCount: number;
}

export interface MoveDetectionOptions {
	/** Fewest significant lines a block needs to count as moved. */
	readonly minLines?: number;
	/** A same-file move must travel at least this far to count. */
	readonly minSameFileDistance?: number;
	/** Above this many changed lines detection is skipped entirely. */
	readonly maxChangedLines?: number;
}

interface RunLine {
	readonly norm: string;
	readonly significant: boolean;
	readonly line: number;
}

interface Run {
	readonly path: string;
	readonly lines: ReadonlyArray<RunLine>;
}

const MAX_CANDIDATES = 8;

const runsOf = (
	path: string,
	hunks: ReadonlyArray<PatchHunk>,
	sign: "+" | "-",
): Run[] => {
	const runs: Run[] = [];
	for (const hunk of hunks) {
		let oldLine = hunk.oldStart;
		let newLine = hunk.newStart;
		let current: RunLine[] = [];
		const flush = () => {
			if (current.length > 0) runs.push({ path, lines: current });
			current = [];
		};
		for (const line of hunk.lines) {
			if (line.startsWith("\\")) continue;
			const kind = line[0];
			if (kind === sign) {
				const norm = normalize(line);
				current.push({
					norm,
					significant: norm.length >= 8 && /[A-Za-z0-9]/.test(norm),
					line: sign === "-" ? oldLine : newLine,
				});
			} else flush();
			if (kind === "-") oldLine += 1;
			else if (kind === "+") newLine += 1;
			else {
				oldLine += 1;
				newLine += 1;
			}
		}
		flush();
	}
	return runs;
};

/**
 * Finds blocks of code cut from one place and pasted in another, across the
 * whole change, so a reader sees one move instead of a red block and a green
 * block to compare by eye. Whitespace is ignored; trivial lines (braces,
 * blank lines) count toward a block but never start or qualify one.
 */
export const detectMoves = (
	files: ReadonlyArray<{
		readonly path: string;
		readonly hunks: ReadonlyArray<PatchHunk>;
	}>,
	options: MoveDetectionOptions = {},
): ReadonlyArray<Move> => {
	const minLines = options.minLines ?? 6;
	const minDistance = options.minSameFileDistance ?? 20;
	const maxChanged = options.maxChangedLines ?? 60_000;
	let total = 0;
	for (const file of files)
		for (const hunk of file.hunks) total += changedLines(hunk).length;
	if (total > maxChanged) return [];

	const removed = files.flatMap((file) => runsOf(file.path, file.hunks, "-"));
	const added = files.flatMap((file) => runsOf(file.path, file.hunks, "+"));
	const index = new Map<string, Array<{ run: number; offset: number }>>();
	added.forEach((run, runIndex) => {
		run.lines.forEach((line, offset) => {
			if (!line.significant) return;
			const slots = index.get(line.norm) ?? [];
			if (slots.length < MAX_CANDIDATES) slots.push({ run: runIndex, offset });
			index.set(line.norm, slots);
		});
	});

	interface Candidate {
		readonly from: number;
		readonly fromOffset: number;
		readonly to: number;
		readonly toOffset: number;
		readonly length: number;
		readonly significant: number;
	}
	const candidates: Candidate[] = [];
	removed.forEach((run, runIndex) => {
		let offset = 0;
		while (offset < run.lines.length) {
			const line = run.lines[offset];
			let best: Candidate | null = null;
			if (line?.significant) {
				for (const slot of index.get(line.norm) ?? []) {
					const target = added[slot.run];
					if (target === undefined) continue;
					let length = 0;
					let significant = 0;
					while (
						offset + length < run.lines.length &&
						slot.offset + length < target.lines.length &&
						run.lines[offset + length]?.norm ===
							target.lines[slot.offset + length]?.norm
					) {
						if (run.lines[offset + length]?.significant) significant += 1;
						length += 1;
					}
					if (best === null || significant > best.significant)
						best = {
							from: runIndex,
							fromOffset: offset,
							to: slot.run,
							toOffset: slot.offset,
							length,
							significant,
						};
				}
			}
			if (best !== null && best.significant >= minLines) {
				candidates.push(best);
				offset += best.length;
			} else offset += 1;
		}
	});

	candidates.sort((a, b) => b.significant - a.significant);
	const usedFrom = new Set<string>();
	const usedTo = new Set<string>();
	const moves: Move[] = [];
	for (const candidate of candidates) {
		const fromRun = removed[candidate.from];
		const toRun = added[candidate.to];
		if (fromRun === undefined || toRun === undefined) continue;
		const fromLines = fromRun.lines.slice(
			candidate.fromOffset,
			candidate.fromOffset + candidate.length,
		);
		const toLines = toRun.lines.slice(
			candidate.toOffset,
			candidate.toOffset + candidate.length,
		);
		const fromStart = fromLines[0]?.line ?? 0;
		const toStart = toLines[0]?.line ?? 0;
		if (
			fromRun.path === toRun.path &&
			Math.abs(fromStart - toStart) < minDistance
		)
			continue;
		const fromKeys = fromLines.map((line) => `${fromRun.path}:${line.line}`);
		const toKeys = toLines.map((line) => `${toRun.path}:${line.line}`);
		if (
			fromKeys.some((key) => usedFrom.has(key)) ||
			toKeys.some((key) => usedTo.has(key))
		)
			continue;
		for (const key of fromKeys) usedFrom.add(key);
		for (const key of toKeys) usedTo.add(key);
		moves.push({
			from: {
				path: fromRun.path,
				startLine: fromStart,
				endLine: fromLines.at(-1)?.line ?? fromStart,
			},
			to: {
				path: toRun.path,
				startLine: toStart,
				endLine: toLines.at(-1)?.line ?? toStart,
			},
			lineCount: candidate.length,
		});
	}
	return moves;
};

/** True when every changed line of the hunk is part of a detected move. */
export const isMovedWholeHunk = (
	path: string,
	hunk: PatchHunk,
	moves: ReadonlyArray<Move>,
): boolean => {
	let oldLine = hunk.oldStart;
	let newLine = hunk.newStart;
	let any = false;
	for (const line of hunk.lines) {
		if (line.startsWith("\\")) continue;
		if (line.startsWith("-")) {
			any = true;
			const at = oldLine;
			if (
				!moves.some(
					(move) =>
						move.from.path === path &&
						move.from.startLine <= at &&
						at <= move.from.endLine,
				)
			)
				return false;
			oldLine += 1;
		} else if (line.startsWith("+")) {
			any = true;
			const at = newLine;
			if (
				!moves.some(
					(move) =>
						move.to.path === path &&
						move.to.startLine <= at &&
						at <= move.to.endLine,
				)
			)
				return false;
			newLine += 1;
		} else {
			oldLine += 1;
			newLine += 1;
		}
	}
	return any;
};
