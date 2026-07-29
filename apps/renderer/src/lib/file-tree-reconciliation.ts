import type { FsEntry } from "@zuse/contracts";

export type FileTreePathOperation =
	| { readonly type: "add"; readonly path: string }
	| { readonly type: "remove"; readonly path: string };

const stripSlash = (path: string): string => path.replace(/\/+$/u, "");

const parentPath = (path: string): string => {
	const normalized = stripSlash(path);
	const separator = normalized.lastIndexOf("/");
	return separator === -1 ? "" : normalized.slice(0, separator);
};

const treePath = (entry: FsEntry): string =>
	entry.kind === "directory" ? `${stripSlash(entry.path)}/` : entry.path;

/**
 * Reconcile only directories touched by a filesystem watcher batch.
 *
 * New directories are walked only inside themselves. Deletes remove the
 * already-known subtree locally. Ordinary saves list just their parent.
 */
export const reconcileFileTreePaths = async (input: {
	readonly changedPaths: ReadonlyArray<string>;
	readonly knownPaths: ReadonlySet<string>;
	readonly listDirectory: (path: string) => Promise<ReadonlyArray<FsEntry>>;
	readonly maxDirectories?: number;
}): Promise<{
	readonly paths: ReadonlySet<string>;
	readonly operations: ReadonlyArray<FileTreePathOperation>;
	readonly requiresFullReconciliation: boolean;
}> => {
	const next = new Set(input.knownPaths);
	const operations: FileTreePathOperation[] = [];
	const queued = new Set<string>();
	const pending: string[] = [];
	const maxDirectories = input.maxDirectories ?? 2_000;
	const childrenByParent = new Map<string, Set<string>>();

	const indexPath = (path: string): void => {
		const parent = parentPath(path);
		const siblings = childrenByParent.get(parent) ?? new Set<string>();
		siblings.add(path);
		childrenByParent.set(parent, siblings);
	};
	for (const path of next) indexPath(path);

	const removeSubtree = (path: string): void => {
		for (const child of [...(childrenByParent.get(stripSlash(path)) ?? [])]) {
			removeSubtree(child);
		}
		childrenByParent.delete(stripSlash(path));
		childrenByParent.get(parentPath(path))?.delete(path);
		if (!next.delete(path)) return;
		operations.push({ type: "remove", path });
	};

	const enqueue = (path: string): void => {
		const normalized = stripSlash(path);
		if (queued.has(normalized)) return;
		queued.add(normalized);
		pending.push(normalized);
	};

	for (const changedPath of input.changedPaths) {
		enqueue(parentPath(changedPath));
		if (next.has(`${stripSlash(changedPath)}/`)) enqueue(changedPath);
	}

	let processed = 0;
	while (pending.length > 0) {
		if (processed >= maxDirectories) {
			return {
				paths: input.knownPaths,
				operations: [],
				requiresFullReconciliation: true,
			};
		}
		processed += 1;
		const directory = pending.shift() ?? "";
		const entries = await input.listDirectory(directory);

		const serverChildren = new Map(
			entries.map((entry) => [treePath(entry), entry] as const),
		);
		for (const existing of [
			...(childrenByParent.get(stripSlash(directory)) ?? []),
		]) {
			if (serverChildren.has(existing)) continue;
			removeSubtree(existing);
		}

		for (const [path, entry] of serverChildren) {
			const added = !next.has(path);
			if (added) {
				next.add(path);
				indexPath(path);
				operations.push({ type: "add", path });
			}
			if (entry.kind === "directory" && added) enqueue(entry.path);
		}
	}

	return {
		paths: next,
		operations,
		requiresFullReconciliation: false,
	};
};
