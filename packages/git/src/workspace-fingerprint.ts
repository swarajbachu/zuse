import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";

export const WORKSPACE_FINGERPRINT_MAX_FILE_BYTES = 8n * 1024n * 1024n;
export const WORKSPACE_FINGERPRINT_MAX_TOTAL_BYTES = 32n * 1024n * 1024n;
const WORKSPACE_FINGERPRINT_MAX_PATHS = 2_048;
const HASH_BATCH_SIZE = 128;

type WorkspacePathType =
	| "file"
	| "directory"
	| "symbolic-link"
	| "block-device"
	| "character-device"
	| "fifo"
	| "socket"
	| "unknown";

type WorkspacePathMetadata =
	| Readonly<{
			path: string;
			availability: "available";
			type: WorkspacePathType;
			dev: string;
			ino: string;
			mode: string;
			size: string;
			mtimeNs: string;
			ctimeNs: string;
	  }>
	| Readonly<{
			path: string;
			availability: "unavailable";
	  }>;

export type WorkspaceFingerprintPathObservation = Readonly<{
	pathMetadata: ReadonlyArray<WorkspacePathMetadata>;
	contentHashes: ReadonlyArray<readonly [path: string, hash: string]>;
	/** Present only when a path could not be observed conclusively. */
	coverageNonce: string | null;
}>;

type WorkspaceFingerprintOptions = Readonly<{
	lstat?: (path: string) => Promise<BigIntStats>;
	nonce?: () => string;
}>;

const classifyPath = (stat: BigIntStats): WorkspacePathType => {
	if (stat.isFile()) return "file";
	if (stat.isDirectory()) return "directory";
	if (stat.isSymbolicLink()) return "symbolic-link";
	if (stat.isBlockDevice()) return "block-device";
	if (stat.isCharacterDevice()) return "character-device";
	if (stat.isFIFO()) return "fifo";
	if (stat.isSocket()) return "socket";
	return "unknown";
};

const metadataFor = (
	relativePath: string,
	stat: BigIntStats,
): WorkspacePathMetadata => ({
	path: relativePath,
	availability: "available",
	type: classifyPath(stat),
	dev: String(stat.dev),
	ino: String(stat.ino),
	mode: String(stat.mode),
	size: String(stat.size),
	mtimeNs: String(stat.mtimeNs),
	ctimeNs: String(stat.ctimeNs),
});

const parseHashes = (
	output: string,
	expectedCount: number,
): ReadonlyArray<string> | null => {
	const trimmed = output.trim();
	const hashes = trimmed.length === 0 ? [] : trimmed.split(/\r?\n/);
	return hashes.length === expectedCount &&
		hashes.every((hash) => hash.length > 0)
		? hashes
		: null;
};

/**
 * Captures stable filesystem evidence without reading unbounded changed-file
 * content. Metadata covers every selected candidate, while small regular files
 * receive exact Git object hashes within per-file and aggregate byte budgets.
 */
export const observeWorkspaceFingerprintPaths = <Error, Requirements>(
	cwd: string,
	candidatePaths: ReadonlyArray<string>,
	hashPaths: (
		paths: ReadonlyArray<string>,
	) => Effect.Effect<string, Error, Requirements>,
	options: WorkspaceFingerprintOptions = {},
): Effect.Effect<WorkspaceFingerprintPathObservation, never, Requirements> =>
	Effect.gen(function* () {
		const statPath =
			options.lstat ?? ((target: string) => lstat(target, { bigint: true }));
		const makeNonce = options.nonce ?? randomUUID;
		const uniquePaths = [...new Set(candidatePaths)];
		const coveredPaths = uniquePaths.slice(0, WORKSPACE_FINGERPRINT_MAX_PATHS);
		let incomplete = uniquePaths.length > coveredPaths.length;
		let totalHashBytes = 0n;
		const hashablePaths: string[] = [];
		const pathMetadata: WorkspacePathMetadata[] = [];
		const observedPaths = yield* Effect.forEach(
			coveredPaths,
			(relativePath) =>
				Effect.tryPromise({
					try: () => statPath(path.resolve(cwd, relativePath)),
					catch: (cause) => cause,
				}).pipe(
					Effect.map((stat) => ({
						relativePath,
						observed: { _tag: "Available" as const, stat },
					})),
					Effect.catch(() =>
						Effect.succeed({
							relativePath,
							observed: { _tag: "Unavailable" as const },
						}),
					),
				),
			{ concurrency: 8 },
		);

		for (const { relativePath, observed } of observedPaths) {
			if (observed._tag === "Unavailable") {
				incomplete = true;
				pathMetadata.push({
					path: relativePath,
					availability: "unavailable",
				});
				continue;
			}

			const { stat } = observed;
			pathMetadata.push(metadataFor(relativePath, stat));
			if (
				stat.isFile() &&
				stat.size <= WORKSPACE_FINGERPRINT_MAX_FILE_BYTES &&
				totalHashBytes + stat.size <= WORKSPACE_FINGERPRINT_MAX_TOTAL_BYTES
			) {
				hashablePaths.push(relativePath);
				totalHashBytes += stat.size;
			}
		}

		const contentHashes: Array<readonly [string, string]> = [];
		const attemptHash = (paths: ReadonlyArray<string>) =>
			hashPaths(paths).pipe(
				Effect.map((output) => ({ _tag: "Success" as const, output })),
				Effect.catch(() => Effect.succeed({ _tag: "Failure" as const })),
			);

		for (
			let offset = 0;
			offset < hashablePaths.length;
			offset += HASH_BATCH_SIZE
		) {
			const batch = hashablePaths.slice(offset, offset + HASH_BATCH_SIZE);
			const batchResult = yield* attemptHash(batch);
			const batchHashes =
				batchResult._tag === "Success"
					? parseHashes(batchResult.output, batch.length)
					: null;
			if (batchHashes !== null) {
				for (const [index, relativePath] of batch.entries()) {
					contentHashes.push([relativePath, batchHashes[index] as string]);
				}
				continue;
			}

			// A single disappearing or unreadable path must not discard exact hashes
			// for every healthy peer in its batch.
			for (const relativePath of batch) {
				const result = yield* attemptHash([relativePath]);
				const hashes =
					result._tag === "Success" ? parseHashes(result.output, 1) : null;
				if (hashes === null) {
					incomplete = true;
					contentHashes.push([relativePath, "unavailable"]);
				} else {
					contentHashes.push([relativePath, hashes[0] as string]);
				}
			}
		}

		return {
			pathMetadata,
			contentHashes,
			coverageNonce: incomplete ? makeNonce() : null,
		};
	});
