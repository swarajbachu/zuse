export type ChangesTreeFile<F> = {
	readonly type: "file";
	readonly path: string;
	readonly name: string;
	readonly depth: number;
	readonly file: F;
};

export type ChangesTreeFolder<F> = {
	readonly type: "folder";
	/** Full folder path, used as the stable collapse key. */
	readonly path: string;
	/** Display name; single-child folder chains are compacted (`src/lib`). */
	readonly name: string;
	readonly depth: number;
	readonly additions: number;
	readonly deletions: number;
	readonly fileCount: number;
	readonly children: ReadonlyArray<ChangesTreeNode<F>>;
};

export type ChangesTreeNode<F> = ChangesTreeFile<F> | ChangesTreeFolder<F>;

type StatFile = {
	readonly path: string;
	readonly additions: number;
	readonly deletions: number;
};

type MutableFolder<F> = {
	readonly folders: Map<string, MutableFolder<F>>;
	readonly files: Array<{ readonly name: string; readonly file: F }>;
};

const emptyFolder = <F>(): MutableFolder<F> => ({
	folders: new Map(),
	files: [],
});

/**
 * Group changed files into a folder tree. Folders sort before files, both by
 * name, and folders that only contain one folder are merged into one row.
 */
export const buildChangesTree = <F extends StatFile>(
	files: readonly F[],
): ReadonlyArray<ChangesTreeNode<F>> => {
	const root = emptyFolder<F>();
	for (const file of files) {
		const parts = file.path.split("/");
		const name = parts.pop() ?? file.path;
		let folder = root;
		for (const part of parts) {
			let next = folder.folders.get(part);
			if (next === undefined) {
				next = emptyFolder();
				folder.folders.set(part, next);
			}
			folder = next;
		}
		folder.files.push({ name, file });
	}
	return toNodes(root, "", 0);
};

const toNodes = <F extends StatFile>(
	folder: MutableFolder<F>,
	parentPath: string,
	depth: number,
): Array<ChangesTreeNode<F>> => {
	const folders = [...folder.folders.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, child]): ChangesTreeFolder<F> => {
			let label = name;
			let node = child;
			while (node.files.length === 0 && node.folders.size === 1) {
				const only = node.folders.entries().next().value;
				if (only === undefined) break;
				label = `${label}/${only[0]}`;
				node = only[1];
			}
			const path = parentPath === "" ? label : `${parentPath}/${label}`;
			const children = toNodes(node, path, depth + 1);
			let additions = 0;
			let deletions = 0;
			let fileCount = 0;
			for (const entry of children) {
				if (entry.type === "file") {
					additions += entry.file.additions;
					deletions += entry.file.deletions;
					fileCount += 1;
				} else {
					additions += entry.additions;
					deletions += entry.deletions;
					fileCount += entry.fileCount;
				}
			}
			return {
				type: "folder",
				path,
				name: label,
				depth,
				additions,
				deletions,
				fileCount,
				children,
			};
		});
	const files = [...folder.files]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map(
			({ name, file }): ChangesTreeFile<F> => ({
				type: "file",
				path: file.path,
				name,
				depth,
				file,
			}),
		);
	return [...folders, ...files];
};

/** Depth-first rows for rendering, skipping the contents of collapsed folders. */
export const flattenChangesTree = <F>(
	nodes: ReadonlyArray<ChangesTreeNode<F>>,
	collapsed: ReadonlySet<string>,
): Array<ChangesTreeNode<F>> => {
	const rows: Array<ChangesTreeNode<F>> = [];
	const visit = (list: ReadonlyArray<ChangesTreeNode<F>>) => {
		for (const node of list) {
			rows.push(node);
			if (node.type === "folder" && !collapsed.has(node.path))
				visit(node.children);
		}
	};
	visit(nodes);
	return rows;
};

/** Case-insensitive path filter; whitespace-only queries keep every file. */
export const filterChangedFiles = <F extends { readonly path: string }>(
	files: readonly F[],
	query: string,
): readonly F[] => {
	const needle = query.trim().toLowerCase();
	if (needle.length === 0) return files;
	return files.filter((file) => file.path.toLowerCase().includes(needle));
};
