import { docs } from "collections/server";
import type { Folder, Root } from "fumadocs-core/page-tree";
import { loader } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/plugins/lucide-icons";

export const source = loader({
	baseUrl: "/",
	source: docs.toFumadocsSource(),
	plugins: [lucideIconsPlugin()],
});

function findSection(tree: Root, id: string): Folder {
	const section = tree.children.find(
		(node): node is Folder => node.type === "folder" && node.$id === id,
	);

	if (!section) {
		throw new Error(`Missing documentation section: ${id}`);
	}

	return section;
}

const howToSection = findSection(source.pageTree, "how-to");
const startSection = findSection(source.pageTree, "start");

function makeDisclosureFolder(folder: Folder): Folder {
	const children = folder.children.map((node) =>
		node.type === "folder" ? makeDisclosureFolder(node) : node,
	);

	if (folder.index) {
		children.unshift({ ...folder.index, name: "Overview" });
	}

	return {
		...folder,
		index: undefined,
		children,
	};
}

/**
 * Split task recipes from product reference without changing public URLs.
 * Root folders are Fumadocs' native boundary for both layout tabs and the
 * page tree rendered beneath the selector.
 */
export const documentationTree: Root = {
	...source.pageTree,
	children: [
		{
			$id: "documentation-reference",
			type: "folder",
			name: "Reference",
			description: "Features, concepts, and exact behavior",
			root: true,
			index: startSection.index,
			children: source.pageTree.children
				.filter((node) => node !== howToSection)
				.map((node) =>
					node.type === "folder" ? makeDisclosureFolder(node) : node,
				),
		},
		{
			...howToSection,
			$id: "documentation-how-to",
			name: "How to",
			description: "Complete a specific task in Zuse",
			root: true,
		},
	],
};
