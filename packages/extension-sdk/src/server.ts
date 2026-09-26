export type {
	ExtensionProviderAdapter,
	ExtensionProviderSessionInput,
	ExtensionServerContext,
	ExtensionServerContribution,
} from "./contracts.ts";
export { defineRpc } from "./rpc.ts";

import type {
	ExtensionAttachmentSnapshot,
	ExtensionInvocationContext,
	ExtensionServerContext,
} from "./contracts.ts";
import { workspaceToolRpc, workspaceToolSearch } from "./workspace-tool.ts";
export interface WorkspaceToolDefinition {
	readonly extensions?: readonly string[];
	readonly read?: (
		text: string,
		path: string,
	) => ReadonlyArray<ExtensionAttachmentSnapshot>;
	readonly scan?: (
		text: string,
		path: string,
	) => ReadonlyArray<ExtensionAttachmentSnapshot>;
}
/** Shared selection/search behavior for independently installed workspace tools. */
export function registerWorkspaceTool(
	e: ExtensionServerContext,
	definition: WorkspaceToolDefinition,
): () => void {
	const results = new Map<string, ReadonlyArray<ExtensionAttachmentSnapshot>>();
	let catalog: {
		root: string;
		paths: readonly string[];
		truncated: boolean;
	} | null = null;
	const files = async (context: ExtensionInvocationContext) => {
		const root = context.workspace?.workspacePath;
		if (!root) throw new Error("Select a local workspace.");
		const list = await context.files.list();
		const paths = definition.extensions
			? list.paths.filter((path) =>
					definition.extensions?.some((extension) =>
						path.toLowerCase().endsWith(extension),
					),
				)
			: list.paths;
		catalog = { root, paths, truncated: list.truncated };
		return catalog;
	};
	e.handle(workspaceToolRpc, async (input, context) => {
		const root = context.workspace?.workspacePath;
		if (!root) throw new Error("Select a local workspace.");
		if (!Number.isSafeInteger(input.cursor) || input.cursor < 0)
			throw new Error("Invalid scan cursor.");
		if (input.action === "list") {
			const list = await files(context);
			return {
				paths: [...list.paths],
				items: [],
				status: definition.scan
					? "Scan when you are ready. Generated and ignored files are excluded."
					: `${list.paths.length} supported files available.`,
				truncated: list.truncated,
				nextCursor: null,
				progress: "",
			};
		}
		let items: readonly ExtensionAttachmentSnapshot[] = [];
		let nextCursor: number | null = null;
		let progress = "";
		let truncated = false;
		let skipped = 0;
		if (input.action === "read") {
			if (
				!definition.read ||
				!definition.extensions?.some((extension) =>
					input.path.toLowerCase().endsWith(extension),
				)
			)
				throw new Error("Select a supported file.");
			items = definition.read(await context.files.read(input.path), input.path);
		} else {
			if (!definition.scan)
				throw new Error("This extension does not scan files.");
			const list =
				input.cursor === 0 || catalog?.root !== root
					? await files(context)
					: catalog;
			const found: ExtensionAttachmentSnapshot[] = [];
			const end = Math.min(input.cursor + 100, list.paths.length);
			for (const path of list.paths.slice(input.cursor, end)) {
				context.signal.throwIfAborted();
				try {
					const text = await context.files.read(path);
					context.signal.throwIfAborted();
					found.push(...definition.scan(text, path));
				} catch {
					context.signal.throwIfAborted();
					skipped += 1;
				}
			}
			items = found;
			nextCursor = end < list.paths.length ? end : null;
			truncated = list.truncated;
			progress = `${end} / ${list.paths.length} files inspected.`;
		}
		const query = input.query.toLowerCase();
		items = items.filter((item) =>
			`${item.title} ${item.subtitle} ${item.text}`
				.toLowerCase()
				.includes(query),
		);
		const previous =
			input.action === "scan" && input.cursor > 0
				? (results.get(root) ?? [])
				: [];
		const room = Math.max(0, 500 - previous.length);
		if (items.length > room) {
			items = items.slice(0, room);
			truncated = true;
			nextCursor = null;
		}
		if (results.size >= 16 && !results.has(root)) {
			const first = results.keys().next().value;
			if (first) results.delete(first);
		}
		results.set(root, [...previous, ...items]);
		return {
			paths: [],
			items: [...items],
			status: `${previous.length + items.length} results loaded.${skipped > 0 ? ` ${skipped} files could not be inspected.` : ""}`,
			truncated,
			nextCursor,
			progress,
		};
	});
	e.handle(workspaceToolSearch, (input, context) => {
		const root = context.workspace?.workspacePath;
		const items = root ? results.get(root) : undefined;
		if (!items)
			throw new Error(
				"Open this extension's workspace tab and load results first.",
			);
		return items
			.filter((item) =>
				`${item.title} ${item.subtitle} ${item.text}`
					.toLowerCase()
					.includes(input.query.toLowerCase()),
			)
			.slice(0, 50);
	});
	return () => {
		results.clear();
		catalog = null;
	};
}
