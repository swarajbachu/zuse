import { Effect, Stream } from "effect";

import { blakeOf } from "./blob/hash.ts";
import { persistParse, upsertBlob } from "./blob/store.ts";
import { chunkSource } from "./chunker/index.ts";
import { detectLanguage } from "./chunker/language.ts";
import type { IndexDb } from "./db/sqlite.ts";
import { type IndexError, IndexIoError } from "./errors.ts";
import { setManifestBulk } from "./manifest/manifest.ts";
import { streamRepo, type WalkLimits } from "./walker.ts";

export interface IndexProgress {
	readonly processed: number;
	readonly total: number;
	readonly newBlobs: number;
	readonly dedupedBlobs: number;
}

export type ProgressSink = (p: IndexProgress) => void;

/**
 * Index every file under `root` and persist it under the (`branch`)
 * manifest. Returns counters useful for tests + the `index.status` RPC.
 *
 * The dedup story: if we've seen a file's exact bytes before — same branch
 * different session, different branch same file — `upsertBlob` returns
 * `isNew: false` and we skip the chunker entirely. Re-indexing two branches
 * that share 95% of files costs 5% the parse work.
 */
export const indexRepo = (
	db: IndexDb,
	root: string,
	branch: string,
	onProgress?: ProgressSink,
	limits?: WalkLimits,
): Effect.Effect<IndexProgress, IndexError> =>
	Effect.gen(function* () {
		let newBlobs = 0;
		let dedupedBlobs = 0;
		const manifestEntries: Array<{ filePath: string; blobId: number }> = [];

		let processed = 0;
		yield* Stream.fromAsyncIterable(
			streamRepo(root, limits),
			(cause) =>
				new IndexIoError({
					path: root,
					reason: "repository walk failed",
					cause,
				}),
		).pipe(
			Stream.mapEffect((file) =>
				Effect.gen(function* () {
					const language = detectLanguage(file.relPath);
					const sha = blakeOf(file.bytes);
					const { blobId, isNew } = yield* upsertBlob(
						db,
						sha,
						language,
						file.bytes.length,
					);
					if (isNew) {
						const source = file.bytes.toString("utf8");
						const parsed = yield* chunkSource(file.relPath, source, language);
						yield* persistParse(db, blobId, parsed.symbols, parsed.chunks);
						newBlobs++;
					} else {
						dedupedBlobs++;
					}
					manifestEntries.push({ filePath: file.relPath, blobId });
					processed++;
					if (onProgress && processed % 50 === 0) {
						onProgress({ processed, total: processed, newBlobs, dedupedBlobs });
					}
				}),
			),
			Stream.runDrain,
		);

		yield* setManifestBulk(db, branch, manifestEntries);
		const final = { processed, total: processed, newBlobs, dedupedBlobs };
		onProgress?.(final);
		return final;
	});
