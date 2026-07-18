export type FileTreeNode = {
	readonly path: string;
	readonly name: string;
	readonly kind: "file" | "directory";
	readonly children: readonly FileTreeNode[];
};

export type VisibleFileTreeNode = {
	readonly node: FileTreeNode;
	readonly depth: number;
};

type MutableNode = {
	path: string;
	name: string;
	kind: "file" | "directory";
	children: Map<string, MutableNode>;
};

const compareNodes = (left: MutableNode, right: MutableNode): number => {
	if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
	return left.name.localeCompare(right.name, undefined, {
		numeric: true,
		sensitivity: "base",
	});
};

const freezeNode = (node: MutableNode): FileTreeNode => ({
	path: node.path,
	name: node.name,
	kind: node.kind,
	children: [...node.children.values()].sort(compareNodes).map(freezeNode),
});

export const buildFileTree = (
	paths: readonly string[],
): readonly FileTreeNode[] => {
	const root: MutableNode = {
		path: "",
		name: "",
		kind: "directory",
		children: new Map(),
	};
	for (const rawPath of paths) {
		const isDirectory = rawPath.endsWith("/");
		const parts = rawPath.replace(/\/$/, "").split("/").filter(Boolean);
		let parent = root;
		for (let index = 0; index < parts.length; index += 1) {
			const name = parts[index];
			if (name === undefined) continue;
			const path = parts.slice(0, index + 1).join("/");
			const leaf = index === parts.length - 1;
			const kind = leaf && !isDirectory ? "file" : "directory";
			let node = parent.children.get(name);
			if (node === undefined) {
				node = { path, name, kind, children: new Map() };
				parent.children.set(name, node);
			} else if (leaf) {
				node.kind = kind;
			}
			parent = node;
		}
	}
	return [...root.children.values()].sort(compareNodes).map(freezeNode);
};

export const flattenFileTree = (options: {
	nodes: readonly FileTreeNode[];
	expanded: ReadonlySet<string>;
	query?: string;
}): readonly VisibleFileTreeNode[] => {
	const output: VisibleFileTreeNode[] = [];
	const query = options.query?.trim().toLocaleLowerCase() ?? "";
	const visit = (node: FileTreeNode, depth: number): boolean => {
		const children: VisibleFileTreeNode[] = [];
		let childMatch = false;
		if (
			node.kind === "directory" &&
			(query.length > 0 || options.expanded.has(node.path))
		) {
			const before = output.length;
			for (const child of node.children) {
				const childStart = output.length;
				if (visit(child, depth + 1)) childMatch = true;
				children.push(...output.splice(childStart));
			}
			output.splice(before);
		}
		const matches =
			query.length === 0 || node.path.toLocaleLowerCase().includes(query);
		if (!matches && !childMatch) return false;
		output.push({ node, depth }, ...children);
		return true;
	};
	for (const node of options.nodes) visit(node, 0);
	return output;
};
