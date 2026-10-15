import { stat } from "node:fs/promises";

// Retain parsed usage rows, never raw transcripts. Bound both entry count and
// row count so long-running servers do not accumulate every history ever seen.
const MAX_FILES = 2_000;
const MAX_ROWS = 100_000;
const fingerprint = async (path: string): Promise<string> => {
	const value = await stat(path, { bigint: true });
	return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(
		":",
	);
};

/** Cache bounded parsed snapshots only when file metadata and parser eligibility permit reuse. */
export const createParsedFileCache = <A>(
	canCache: (rows: ReadonlyArray<A>) => boolean = () => true,
) => {
	const entries = new Map<string, { fingerprint: string; rows: A[] }>();
	let rowCount = 0;
	const remove = (key: string) => {
		const entry = entries.get(key);
		if (entry) rowCount -= entry.rows.length;
		entries.delete(key);
	};
	return {
		read: async (
			path: string,
			context: string,
			parse: () => Promise<A[]>,
		): Promise<A[]> => {
			const key = JSON.stringify([path, context]);
			const before = await fingerprint(path);
			const cached = entries.get(key);
			if (cached?.fingerprint === before) {
				entries.delete(key);
				entries.set(key, cached);
				return cached.rows;
			}
			remove(key);
			const rows = await parse();
			// A writer may append or replace the file during parsing. Return this
			// reading, but do not reuse it as a complete snapshot on the next scan.
			if (
				rows.length <= MAX_ROWS &&
				canCache(rows) &&
				(await fingerprint(path).catch(() => null)) === before
			) {
				remove(key);
				entries.set(key, { fingerprint: before, rows });
				rowCount += rows.length;
				while (entries.size > MAX_FILES || rowCount > MAX_ROWS) {
					const oldest = entries.keys().next().value;
					if (oldest === undefined) break;
					remove(oldest);
				}
			}
			return rows;
		},
	};
};
