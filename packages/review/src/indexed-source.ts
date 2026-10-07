import {
	bm25Search,
	type ImportRelation,
	type IndexDb,
	indexSnapshot,
	lookupSymbol,
} from "@zuse/index";
import { Effect } from "effect";
import type {
	ReviewRelatedFile,
	ReviewSearchHit,
	ReviewSource,
} from "./types.ts";

/** The caller owns a tenant-isolated DB lifecycle. No model API or embeddings are used here. */
export async function withIndexedReviewSource(
	source: ReviewSource,
	db: IndexDb,
	signal: AbortSignal,
): Promise<ReviewSource> {
	try {
		const index = async (side: "LEFT" | "RIGHT") =>
			Effect.runPromise(
				indexSnapshot(db, {
					repository: String(source.snapshot.repositoryId),
					sha:
						side === "LEFT"
							? source.snapshot.mergeBaseSha
							: source.snapshot.headSha,
					paths: source.files[side],
					read: (path) => {
						signal.throwIfAborted();
						return source.readFile(side, path, signal);
					},
				}),
				{ signal },
			);
		const LEFT = await index("LEFT");
		const RIGHT = await index("RIGHT");
		const indexes = { LEFT, RIGHT };
		return {
			...source,
			search: async (query, side, limit) => {
				signal.throwIfAborted();
				const manifest = indexes[side].manifest;
				const symbols = await Effect.runPromise(
					lookupSymbol(db, query, manifest, undefined, limit),
					{ signal },
				);
				const lexical = await Effect.runPromise(
					bm25Search(db, query, manifest, limit),
					{ signal },
				);
				const found: ReviewSearchHit[] = [];
				const seen = new Set<string>();
				for (const symbol of symbols) {
					const key = `${symbol.file}:${symbol.range.start}`;
					if (seen.has(key)) continue;
					seen.add(key);
					found.push({
						location: {
							path: symbol.file,
							side,
							startLine: symbol.range.start,
							endLine: symbol.range.end,
						},
						text: symbol.signature ?? symbol.name,
					});
				}
				for (const hit of lexical) {
					const key = `${hit.file}:${hit.startLine}`;
					if (seen.has(key)) continue;
					seen.add(key);
					found.push({
						location: {
							path: hit.file,
							side,
							startLine: hit.startLine,
							endLine: hit.endLine,
						},
						text: hit.content,
					});
				}
				return found.slice(0, limit);
			},
			relatedFiles: (path, side) => relatedFiles(indexes[side].imports, path),
		};
	} catch {
		signal.throwIfAborted();
		return { ...source, contextLimited: true };
	}
}

function relatedFiles(
	imports: readonly ImportRelation[],
	path: string,
): readonly ReviewRelatedFile[] {
	const related: ReviewRelatedFile[] = [];
	for (const item of imports) {
		if (item.from === path && item.to)
			related.push({ path: item.to, kind: "imports", line: item.line });
		else if (item.to === path)
			related.push({ path: item.from, kind: "imported-by", line: item.line });
	}
	return related;
}
