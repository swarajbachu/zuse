import { posix } from "node:path";
import { Effect } from "effect";
import { blakeOf } from "./blob/hash.ts";
import { persistParse, upsertBlob } from "./blob/store.ts";
import { chunkSource } from "./chunker/index.ts";
import { detectLanguage } from "./chunker/language.ts";
import { extractStaticImports } from "./chunker/treesitter.ts";
import type { IndexDb } from "./db/sqlite.ts";
import { type IndexError, IndexIoError } from "./errors.ts";
import { listManifest, setManifestBulk } from "./manifest/manifest.ts";

export interface SnapshotFiles {
	/** Include tenant/repository in this identifier; do not share a database between tenants. */
	readonly repository: string;
	readonly sha: string;
	readonly paths: readonly string[];
	readonly read: (path: string) => Promise<string | null>;
}
export interface ImportRelation {
	readonly from: string;
	readonly specifier: string;
	readonly to: string | null;
	readonly line: number;
}
export function snapshotManifestKey(repository: string, sha: string): string {
	if (!repository || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sha))
		throw new Error("Invalid index snapshot identity");
	return JSON.stringify(["snapshot-v1", repository, sha]);
}
function resolveImport(
	from: string,
	specifier: string,
	paths: ReadonlySet<string>,
): string | null {
	if (!specifier.startsWith(".")) return null;
	const path = posix.normalize(posix.join(posix.dirname(from), specifier));
	if (path.startsWith("../") || path.startsWith("/")) return null;
	const candidates = [
		path,
		...[
			".ts",
			".tsx",
			".js",
			".jsx",
			"/index.ts",
			"/index.tsx",
			"/index.js",
			"/index.jsx",
		].map((suffix) => path + suffix),
	];
	const found = candidates.filter((candidate) => paths.has(candidate));
	return found.length === 1 ? (found[0] ?? null) : null;
}
/** Reuses blob/chunk storage, publishing the immutable manifest only after every source read succeeds. */
export const indexSnapshot = Effect.fn("index.indexSnapshot")(function* (
	db: IndexDb,
	source: SnapshotFiles,
): Effect.fn.Return<
	{ manifest: string; imports: readonly ImportRelation[] },
	IndexError
> {
	const manifest = snapshotManifestKey(source.repository, source.sha);
	if (source.paths.length > 50_000)
		return yield* new IndexIoError({
			path: source.repository,
			reason: "snapshot file limit exceeded",
		});
	const paths = new Set(source.paths);
	if (paths.size !== source.paths.length)
		return yield* new IndexIoError({
			path: source.repository,
			reason: "duplicate snapshot paths",
		});
	const entries: { filePath: string; blobId: number }[] = [];
	const imports: ImportRelation[] = [];
	let totalBytes = 0;
	for (const path of source.paths) {
		const content = yield* Effect.tryPromise({
			try: () => source.read(path),
			catch: (cause) =>
				new IndexIoError({ path, reason: "snapshot read failed", cause }),
		});
		if (content === null)
			return yield* new IndexIoError({
				path,
				reason: "snapshot file unavailable",
			});
		const bytes = Buffer.from(content);
		totalBytes += bytes.length;
		if (bytes.length > 1_500_000 || totalBytes > 250_000_000)
			return yield* new IndexIoError({
				path,
				reason: "snapshot byte limit exceeded",
			});
		if (content.includes("\0")) continue;
		const language = detectLanguage(path);
		const { blobId, isNew } = yield* upsertBlob(
			db,
			blakeOf(bytes),
			language,
			bytes.length,
		);
		// An interrupted earlier ingest can leave the content row without parsed data.
		const parsedBefore = db
			.prepare("SELECT id FROM chunks WHERE blob_id = ? LIMIT 1")
			.get(blobId);
		if (isNew || !parsedBefore) {
			const parsed = yield* chunkSource(path, content, language);
			yield* persistParse(db, blobId, parsed.symbols, parsed.chunks);
		}
		entries.push({ filePath: path, blobId });
		for (const item of extractStaticImports(content, language)) {
			if (imports.length >= 100_000)
				return yield* new IndexIoError({
					path,
					reason: "snapshot import limit exceeded",
				});
			imports.push({
				from: path,
				specifier: item.specifier,
				to: resolveImport(path, item.specifier, paths),
				line: item.line,
			});
		}
	}
	const existing = yield* listManifest(db, manifest);
	if (existing.length > 0) {
		const prior = new Map(
			existing.map((entry) => [entry.filePath, entry.blobId]),
		);
		if (
			prior.size !== entries.length ||
			entries.some((entry) => prior.get(entry.filePath) !== entry.blobId)
		) {
			return yield* new IndexIoError({
				path: source.repository,
				reason: "immutable snapshot contents changed",
			});
		}
	}
	yield* setManifestBulk(db, manifest, entries);
	return { manifest, imports };
});
