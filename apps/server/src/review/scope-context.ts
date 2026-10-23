/**
 * Function-scoped hunks: review hunks start where their enclosing function
 * does, like an editor's sticky scroll, instead of three lines above the
 * change. The patch is extended here, once, so every client renders the
 * same hunks and a guide's outline names the same enclosing symbols.
 *
 * @module review/scope-context
 */
import {
	extendHunksToScope,
	indentationScopeStart,
} from "@zuse/client-runtime/review-outline";
import {
	type FolderId,
	GitDiffResult,
	GitReviewPatch,
	type GitReviewScope,
	type WorktreeId,
} from "@zuse/contracts";
import type { GitService } from "@zuse/git/git-service";
import { Effect } from "effect";

/** Files larger than this keep git's default context. */
const MAX_SCOPE_SOURCE_BYTES = 512 * 1024;
/** A symbol further above the change than this falls back to indentation. */
const MAX_SCOPE_DISTANCE = 30;
const CACHE_SIZE = 200;

export interface ScopeSymbol {
	readonly name: string;
	readonly kind: string;
	readonly startLine: number;
	readonly endLine: number;
}

export interface FileScopes {
	/** First line of the scope enclosing `line`, or null. */
	readonly startOf: (line: number) => number | null;
	/** Innermost named symbol enclosing `line`, for outlines. */
	readonly symbolAt: (line: number) => ScopeSymbol | null;
}

type IndexModule = typeof import("@zuse/index");

let indexModule: Promise<IndexModule | null> | undefined;

/**
 * The parser ships a native binding. Load it lazily and treat any failure
 * (missing binary, unsupported platform) as "no parser": hunks then fall
 * back to indentation, which is never worse than git's default.
 */
const loadIndex = (): Promise<IndexModule | null> => {
	indexModule ??= import("@zuse/index").catch(() => null);
	return indexModule;
};

const parseSymbols = (
	index: IndexModule | null,
	path: string,
	source: string,
): ReadonlyArray<ScopeSymbol> => {
	if (index === null) return [];
	const language = index.detectLanguage(path);
	if (
		language !== "typescript" &&
		language !== "tsx" &&
		language !== "javascript" &&
		language !== "jsx"
	)
		return [];
	const parsed = Effect.runSync(
		index
			.chunkSource(path, source, language)
			.pipe(Effect.orElseSucceed(() => null)),
	);
	return (parsed?.symbols ?? []).filter(
		(symbol) => symbol.endLine > symbol.startLine,
	);
};

/** The innermost symbol that spans `line`. */
export const innermostSymbol = (
	symbols: ReadonlyArray<ScopeSymbol>,
	line: number,
): ScopeSymbol | null => {
	let best: ScopeSymbol | null = null;
	for (const symbol of symbols) {
		if (symbol.startLine > line || symbol.endLine < line) continue;
		if (best === null || symbol.startLine >= best.startLine) best = symbol;
	}
	return best;
};

export const fileScopesFrom = (
	source: string,
	symbols: ReadonlyArray<ScopeSymbol>,
): FileScopes => {
	const lines = source.split(/\r?\n/);
	return {
		startOf: (line) => {
			const symbol = innermostSymbol(symbols, line);
			if (
				symbol !== null &&
				symbol.startLine < line &&
				line - symbol.startLine <= MAX_SCOPE_DISTANCE
			)
				return symbol.startLine;
			return indentationScopeStart(lines, line, MAX_SCOPE_DISTANCE);
		},
		symbolAt: (line) => innermostSymbol(symbols, line),
	};
};

const cache = new Map<string, Promise<FileScopes | null>>();

/**
 * Scopes for one file's new side. Cached by caller-supplied `version` (the
 * file's mtime), so re-streaming an unchanged file reuses its parse.
 */
export const fileScopes = (
	path: string,
	version: string,
	source: string,
): Promise<FileScopes | null> => {
	const key = `${path}\u0000${version}`;
	const cached = cache.get(key);
	if (cached !== undefined) {
		cache.delete(key);
		cache.set(key, cached);
		return cached;
	}
	const scopes =
		source.length > MAX_SCOPE_SOURCE_BYTES
			? Promise.resolve(null)
			: loadIndex().then((index) =>
					fileScopesFrom(source, parseSymbols(index, path, source)),
				);
	cache.set(key, scopes);
	while (cache.size > CACHE_SIZE) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
	return scopes;
};

/**
 * Extends one streamed review patch so each hunk starts at its enclosing
 * scope. Only scopes whose new side is the working tree qualify, since that
 * is the file read here; anything that cannot be read or matched is returned
 * as git produced it.
 */
export const extendReviewPatch = (
	git: GitService["Service"],
	folderId: FolderId,
	worktreeId: WorktreeId | null,
	scope: GitReviewScope,
	patch: GitReviewPatch,
): Effect.Effect<GitReviewPatch> => {
	if (
		scope === "staged" ||
		patch.error !== null ||
		patch.result.mode !== "worktree" ||
		patch.result.truncated ||
		patch.result.patch.length === 0
	)
		return Effect.succeed(patch);
	return git.reviewFileContents(folderId, patch.path, null, worktreeId).pipe(
		Effect.flatMap((contents) => {
			const source = contents.newContent;
			if (source === null) return Effect.succeed(patch);
			return Effect.tryPromise(() =>
				fileScopes(
					patch.path,
					`${contents.mtime ?? ""}:${source.length}`,
					source,
				),
			).pipe(
				Effect.map((scopes) => {
					if (scopes === null) return patch;
					const extended = extendHunksToScope(
						patch.result.patch,
						source.split(/\r?\n/),
						scopes.startOf,
					);
					return extended === patch.result.patch
						? patch
						: GitReviewPatch.make({
								...patch,
								result: GitDiffResult.make({
									...patch.result,
									patch: extended,
									bytes: extended.length,
								}),
							});
				}),
			);
		}),
		Effect.orElseSucceed(() => patch),
	);
};
