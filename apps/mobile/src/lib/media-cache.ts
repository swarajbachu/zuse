import { Directory, File, Paths } from "expo-file-system";
import { selectMediaCacheEvictions } from "./media-cache-policy";

const CACHE_LIMIT_BYTES = 100 * 1024 * 1024;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ROOT_NAME = "zuse-protected-media-v1";
const INDEX_NAME = "index.json";

type MediaCacheEntry = {
	readonly key: string;
	readonly fileName: string;
	readonly sizeBytes: number;
	readonly mimeType: string;
	readonly originalName: string;
	readonly createdAt: number;
	readonly accessedAt: number;
};

type MediaCacheIndex = {
	readonly entries: readonly MediaCacheEntry[];
};

let operation = Promise.resolve();

const serialize = async <T>(task: () => Promise<T>): Promise<T> => {
	const previous = operation;
	let release = () => {};
	operation = new Promise<void>((resolve) => {
		release = resolve;
	});
	await previous;
	try {
		return await task();
	} finally {
		release();
	}
};

const safeSegment = (value: string): string =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/gu, "-")
		.slice(0, 96) || "unknown";

const extensionFor = (name: string, mimeType: string): string => {
	const match = /\.([a-zA-Z0-9]{1,12})$/u.exec(name);
	if (match?.[1] !== undefined) return match[1].toLowerCase();
	const subtype = mimeType.split("/")[1]?.split(/[;+]/u)[0];
	return safeSegment(subtype ?? "bin");
};

const rootDirectory = (): Directory => new Directory(Paths.cache, ROOT_NAME);

const connectionDirectory = (connectionKey: string): Directory =>
	new Directory(rootDirectory(), safeSegment(connectionKey));

const ensureDirectory = (directory: Directory): void => {
	if (!directory.exists)
		directory.create({ intermediates: true, idempotent: true });
};

const readIndex = async (directory: Directory): Promise<MediaCacheEntry[]> => {
	const file = new File(directory, INDEX_NAME);
	if (!file.exists) return [];
	try {
		const decoded = JSON.parse(await file.text()) as MediaCacheIndex;
		return Array.isArray(decoded.entries) ? [...decoded.entries] : [];
	} catch {
		return [];
	}
};

const writeIndex = (
	directory: Directory,
	entries: readonly MediaCacheEntry[],
) => {
	const file = new File(directory, INDEX_NAME);
	if (!file.exists) file.create({ intermediates: true, overwrite: true });
	file.write(JSON.stringify({ entries } satisfies MediaCacheIndex));
};

const deleteEntryFile = (
	directory: Directory,
	entry: MediaCacheEntry,
): void => {
	const file = new File(directory, entry.fileName);
	if (file.exists) file.delete();
};

const pruneEntries = (
	directory: Directory,
	entries: readonly MediaCacheEntry[],
	now: number,
): MediaCacheEntry[] => {
	const present = entries.filter((entry) => {
		const missing = !new File(directory, entry.fileName).exists;
		return !missing;
	});
	const evictions = selectMediaCacheEvictions(present, {
		now,
		maxBytes: CACHE_LIMIT_BYTES,
		maxAgeMs: CACHE_MAX_AGE_MS,
	});
	for (const entry of present) {
		if (evictions.has(entry.key)) deleteEntryFile(directory, entry);
	}
	return present.filter((entry) => !evictions.has(entry.key));
};

const pruneGlobalCache = async (
	root: Directory,
	now: number,
): Promise<void> => {
	if (!root.exists) return;
	const directories = root
		.list()
		.filter((item): item is Directory => item instanceof Directory);
	const byDirectory = new Map<Directory, MediaCacheEntry[]>();
	const all: Array<{
		readonly directory: Directory;
		readonly entry: MediaCacheEntry;
	}> = [];
	for (const directory of directories) {
		const entries = pruneEntries(directory, await readIndex(directory), now);
		byDirectory.set(directory, entries);
		for (const entry of entries) all.push({ directory, entry });
	}
	let total = all.reduce((sum, item) => sum + item.entry.sizeBytes, 0);
	for (const item of all.sort(
		(left, right) => left.entry.accessedAt - right.entry.accessedAt,
	)) {
		if (total <= CACHE_LIMIT_BYTES) break;
		deleteEntryFile(item.directory, item.entry);
		total -= item.entry.sizeBytes;
		const entries = byDirectory.get(item.directory) ?? [];
		byDirectory.set(
			item.directory,
			entries.filter((entry) => entry.key !== item.entry.key),
		);
	}
	for (const [directory, entries] of byDirectory) {
		writeIndex(directory, entries);
	}
};

export const readCachedMedia = async (
	connectionKey: string,
	key: string,
): Promise<{
	readonly uri: string;
	readonly mimeType: string;
	readonly originalName: string;
} | null> =>
	serialize(async () => {
		const directory = connectionDirectory(connectionKey);
		if (!directory.exists) return null;
		const now = Date.now();
		const entries = pruneEntries(directory, await readIndex(directory), now);
		const entry = entries.find((item) => item.key === key);
		if (entry === undefined) {
			writeIndex(directory, entries);
			return null;
		}
		const next = entries.map((item) =>
			item.key === key ? { ...item, accessedAt: now } : item,
		);
		writeIndex(directory, next);
		return {
			uri: new File(directory, entry.fileName).uri,
			mimeType: entry.mimeType,
			originalName: entry.originalName,
		};
	});

export const cacheMediaBytes = async (options: {
	connectionKey: string;
	key: string;
	bytes: Uint8Array;
	mimeType: string;
	originalName: string;
}): Promise<string> =>
	serialize(async () => {
		const directory = connectionDirectory(options.connectionKey);
		ensureDirectory(directory);
		const now = Date.now();
		let entries = pruneEntries(directory, await readIndex(directory), now);
		const existing = entries.find((entry) => entry.key === options.key);
		if (existing !== undefined) deleteEntryFile(directory, existing);
		entries = entries.filter((entry) => entry.key !== options.key);
		const fileName = `${safeSegment(options.key)}.${extensionFor(
			options.originalName,
			options.mimeType,
		)}`;
		const file = new File(directory, fileName);
		if (!file.exists) file.create({ intermediates: true, overwrite: true });
		file.write(options.bytes);
		entries.push({
			key: options.key,
			fileName,
			sizeBytes: options.bytes.byteLength,
			mimeType: options.mimeType,
			originalName: options.originalName,
			createdAt: now,
			accessedAt: now,
		});
		writeIndex(directory, pruneEntries(directory, entries, now));
		await pruneGlobalCache(rootDirectory(), now);
		return file.uri;
	});

export const mediaCacheSize = async (): Promise<number> =>
	serialize(async () => {
		const root = rootDirectory();
		if (!root.exists) return 0;
		return root.size ?? 0;
	});

export const clearMediaCache = async (connectionKey?: string): Promise<void> =>
	serialize(async () => {
		const directory =
			connectionKey === undefined
				? rootDirectory()
				: connectionDirectory(connectionKey);
		if (directory.exists) directory.delete();
	});

export const mediaCachePolicy = {
	maxBytes: CACHE_LIMIT_BYTES,
	maxAgeMs: CACHE_MAX_AGE_MS,
} as const;
