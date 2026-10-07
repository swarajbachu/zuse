import { constants, promises as fs } from "node:fs";
import { join, relative, sep } from "node:path";
import { Effect } from "effect";
import ignore, { type Ignore } from "ignore";

import { IndexIoError } from "./errors.ts";

const DEFAULT_IGNORES = [
	".git",
	"node_modules",
	// The code-index sqlite lives at <root>/.zuse/index.sqlite; skip the
	// dir so we never try to index our own database file.
	".zuse",
	"dist",
	"build",
	"out",
	".next",
	".turbo",
	"coverage",
	".cache",
	"target",
	"vendor",
	".DS_Store",
];

const MAX_BYTES = 1_500_000; // 1.5MB cap — bigger files get skipped (binary, lockfiles, etc.)

const isProbablyBinary = (bytes: Buffer): boolean => {
	const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
	for (let i = 0; i < sample.length; i++) {
		if (sample[i] === 0) return true;
	}
	return false;
};

const readGitignore = async (root: string): Promise<Ignore> => {
	const ig = ignore().add(DEFAULT_IGNORES);
	try {
		const txt = await fs.readFile(join(root, ".gitignore"), "utf8");
		ig.add(txt);
	} catch {
		// no .gitignore — defaults are enough
	}
	try {
		const txt = await fs.readFile(join(root, ".zuse-ignore"), "utf8");
		ig.add(txt);
	} catch {
		// optional override file
	}
	return ig;
};

const toPosix = (p: string): string =>
	sep === "/" ? p : p.split(sep).join("/");

export interface WalkedFile {
	readonly relPath: string;
	readonly absPath: string;
	readonly bytes: Buffer;
}

export interface WalkLimits {
	readonly maxFiles?: number;
	readonly maxTotalBytes?: number;
	readonly maxFileBytes?: number;
}

/** Fails instead of committing a silently truncated branch manifest. */
export async function* streamRepo(
	root: string,
	limits: WalkLimits = {},
): AsyncGenerator<WalkedFile> {
	const maxFiles = limits.maxFiles ?? 50_000;
	const maxTotalBytes = limits.maxTotalBytes ?? 250_000_000;
	const maxFileBytes = limits.maxFileBytes ?? MAX_BYTES;
	for (const value of [maxFiles, maxTotalBytes, maxFileBytes]) {
		if (!Number.isSafeInteger(value) || value < 1)
			throw new IndexIoError({ path: root, reason: "invalid walk limit" });
	}
	const ig = await readGitignore(root);
	const stack = [root];
	let files = 0;
	let bytesRead = 0;
	while (stack.length > 0) {
		const dir = stack.pop();
		if (!dir) break;
		const handle = await fs.opendir(dir);
		for await (const entry of handle) {
			const abs = join(dir, entry.name);
			const rel = toPosix(relative(root, abs));
			if (!rel || rel.startsWith("../") || entry.isSymbolicLink()) continue;
			if (ig.ignores(entry.isDirectory() ? `${rel}/` : rel)) continue;
			if (entry.isDirectory()) {
				stack.push(abs);
				continue;
			}
			if (!entry.isFile()) continue;
			const file = await fs.open(
				abs,
				constants.O_RDONLY | constants.O_NOFOLLOW,
			);
			let bytes: Buffer;
			try {
				const stat = await file.stat();
				if (!stat.isFile() || stat.size > maxFileBytes) continue;
				// Fixed read buffer bounds memory even if the file grows after stat.
				const buffer = Buffer.alloc(stat.size + 1);
				let offset = 0;
				while (offset < buffer.length) {
					const read = await file.read(
						buffer,
						offset,
						buffer.length - offset,
						offset,
					);
					if (read.bytesRead === 0) break;
					offset += read.bytesRead;
				}
				if (offset > stat.size)
					throw new IndexIoError({
						path: abs,
						reason: "file changed during read",
					});
				bytes = buffer.subarray(0, offset);
			} finally {
				await file.close();
			}
			if (isProbablyBinary(bytes)) continue;
			if (++files > maxFiles || bytesRead + bytes.length > maxTotalBytes)
				throw new IndexIoError({
					path: root,
					reason: "repository indexing limit exceeded",
				});
			bytesRead += bytes.length;
			yield { relPath: rel, absPath: abs, bytes };
		}
	}
}

/** Compatibility collector; indexRepo consumes streamRepo directly to avoid retaining file bytes. */
export const walkRepo = (
	root: string,
	limits?: WalkLimits,
): Effect.Effect<ReadonlyArray<WalkedFile>, IndexIoError> =>
	Effect.tryPromise({
		try: async () => {
			const files: WalkedFile[] = [];
			for await (const file of streamRepo(root, limits)) files.push(file);
			return files;
		},
		catch: (cause) =>
			new IndexIoError({ path: root, reason: "repository walk failed", cause }),
	});
