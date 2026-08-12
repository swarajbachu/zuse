import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

export const expandHome = (path: string): string =>
	path === "~"
		? homedir()
		: path.startsWith("~/")
			? join(homedir(), path.slice(2))
			: path;

/**
 * Yield control back to the event loop. Source reads run inside the Electron
 * main process, so long file scans must pause periodically or the whole UI
 * freezes (the macOS spinner). Callers `await` this every N files.
 */
export const yieldToEventLoop = (): Promise<void> =>
	new Promise((resolve) => setImmediate(resolve));

/** How many files to process between event-loop yields. */
export const YIELD_EVERY = 24;

/** Stream a text file without allocating and splitting the entire file. */
export async function* readLines(path: string): AsyncGenerator<string> {
	const input = createReadStream(path, { encoding: "utf8" });
	const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
	try {
		for await (const line of lines) yield line;
	} finally {
		lines.close();
		input.destroy();
	}
}

/**
 * Resolve a comma-separated env override (or a fallback list) to a deduped list
 * of absolute paths. Mirrors ccusage's `normalizePathList`.
 */
export const normalizePathList = (
	value: string | undefined,
	fallback: ReadonlyArray<string>,
): string[] => {
	const entries =
		value === undefined || value.trim() === ""
			? fallback
			: value
					.split(",")
					.map((entry) => entry.trim())
					.filter((entry) => entry !== "");
	const list = entries.length === 0 ? fallback : entries;
	return Array.from(new Set(list.map((entry) => resolve(expandHome(entry)))));
};

export const isDirectory = (path: string): boolean => {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
};

export const existingDirectories = (paths: ReadonlyArray<string>): string[] =>
	paths.filter(isDirectory);

/** Recursively collect files with the given extension under `root` (sorted). */
export const collectFiles = (root: string, extension: string): string[] => {
	const out: string[] = [];
	const walk = (dir: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(path);
					return [];
				}
				return entry.isFile() && entry.name.endsWith(extension) ? [path] : [];
			});
		} catch {
			return;
		}
		out.push(...entries);
	};
	if (existsSync(root)) walk(root);
	return out.sort();
};
