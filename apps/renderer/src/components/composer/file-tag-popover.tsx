import "@zuse/i18n/english/projects";
import "@zuse/i18n/english/plugins";
import type { EditorView } from "@codemirror/view";
import type {
	CommandId,
	EnvironmentId,
	FolderId,
	WorktreeId,
} from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useComposerAnchor } from "~/components/composer/use-composer-anchor";
import { FileIcon } from "~/components/file-icon";
import { PluginIcon } from "~/components/plugins/plugin-icon.tsx";
import { overlaySurface } from "~/components/ui/overlay-surface";
import { type ActiveTrigger, replaceWithChip } from "~/lib/codemirror/composer";
import {
	type ConnectedPlugin,
	useConnectedPlugins,
} from "~/lib/connected-plugins.ts";
import { dispatchEnvironmentShellCommand } from "~/lib/environment-shell-client-bus.ts";
import { cn } from "~/lib/utils";

export interface FileTagPopoverProps {
	readonly environmentId: EnvironmentId;
	readonly trigger: ActiveTrigger;
	readonly view: EditorView;
	readonly projectId: FolderId;
	readonly worktreeId: WorktreeId | null;
	/**
	 * Absolute path of the effective workspace root (project root or, when a
	 * worktree is selected, the worktree path). Used to drop stale results
	 * that race a session switch — anything whose absPath isn't under this
	 * root is silently dropped so the picker never shows files from another
	 * project.
	 */
	readonly workspaceRoot: string | null;
	readonly onClose: () => void;
}

interface SearchHit {
	readonly relPath: string;
	readonly absPath: string;
	readonly kind: "file" | "directory";
}

type Item =
	| { readonly kind: "plugin"; readonly plugin: ConnectedPlugin }
	| { readonly kind: "file"; readonly hit: SearchHit };

const PLUGIN_LIMIT = 4;

const basename = (p: string): string => {
	const i = p.lastIndexOf("/");
	return i === -1 ? p : p.slice(i + 1);
};

const dirname = (p: string): string | null => {
	const i = p.lastIndexOf("/");
	return i === -1 ? null : p.slice(0, i);
};

export function FileTagPopover({
	environmentId,
	trigger,
	view,
	projectId,
	worktreeId,
	workspaceRoot,
	onClose,
}: FileTagPopoverProps) {
	const { message: uiMessage } = useUiMessages(["projects", "plugins"]);

	const [hits, setHits] = useState<readonly SearchHit[]>([]);
	const plugins = useConnectedPlugins();
	const [highlight, setHighlight] = useState(0);
	const query = trigger.query;

	// Debounce searches lightly so fast typing doesn't flood the server.
	useEffect(() => {
		let cancelled = false;
		const run = async () => {
			try {
				const { result: results } = await dispatchEnvironmentShellCommand<
					{
						readonly projectId: FolderId;
						readonly query: string;
						readonly limit: number;
						readonly worktreeId: WorktreeId | null;
					},
					ReadonlyArray<SearchHit>
				>({
					environmentId,
					kind: "workspace.searchFiles",
					commandId: crypto.randomUUID() as CommandId,
					payload: {
						projectId,
						query,
						limit: 20,
						worktreeId,
					},
				});
				if (cancelled) return;
				// Belt-and-braces: drop any hit whose absPath isn't under the
				// current workspace root. The server already reroots correctly
				// when worktreeId matches, but a race where this effect fires
				// mid-session-switch could otherwise show the previous root's
				// files for a frame.
				const filtered =
					workspaceRoot === null
						? (results as readonly SearchHit[])
						: (results as readonly SearchHit[]).filter((hit) =>
								hit.absPath.startsWith(workspaceRoot),
							);
				setHits(filtered);
				setHighlight(0);
			} catch {
				if (!cancelled) setHits([]);
			}
		};
		const id = window.setTimeout(run, 60);
		return () => {
			cancelled = true;
			window.clearTimeout(id);
		};
	}, [environmentId, projectId, worktreeId, workspaceRoot, query]);

	// Connected plugins lead: there are few, and naming one is a strong intent.
	const items = useMemo<readonly Item[]>(() => {
		const needle = query.toLowerCase();
		const matchingPlugins = plugins
			.filter(
				(plugin) =>
					plugin.name.toLowerCase().includes(needle) ||
					plugin.id.includes(needle),
			)
			.slice(0, PLUGIN_LIMIT)
			.map((plugin) => ({ kind: "plugin" as const, plugin }));
		return [
			...matchingPlugins,
			...hits
				.slice(0, 12 - matchingPlugins.length)
				.map((hit) => ({ kind: "file" as const, hit })),
		];
	}, [hits, plugins, query]);
	useEffect(() => setHighlight(0), [items.length]);

	const confirm = (item: Item) => {
		if (item.kind === "plugin") {
			replaceWithChip(view, trigger.from, trigger.to, `@${item.plugin.name}`, {
				kind: "plugin",
				pluginId: item.plugin.id,
				connectionId: item.plugin.connectionId,
				name: item.plugin.name,
				domain: item.plugin.domain,
			});
		} else {
			replaceWithChip(view, trigger.from, trigger.to, `@${item.hit.relPath}`, {
				kind: "file",
				relPath: item.hit.relPath,
				absPath: item.hit.absPath,
				entryKind: item.hit.kind,
			});
		}
		onClose();
	};

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (items.length === 0) {
				if (e.key === "Escape") {
					e.preventDefault();
					onClose();
				}
				return;
			}
			if (e.key === "ArrowDown") {
				e.preventDefault();
				e.stopPropagation();
				setHighlight((h) => (h + 1) % items.length);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				e.stopPropagation();
				setHighlight((h) => (h - 1 + items.length) % items.length);
			} else if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				e.stopPropagation();
				const item = items[highlight];
				if (item) confirm(item);
			} else if (e.key === "Escape") {
				e.preventDefault();
				onClose();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
		// confirm is stable for `items[highlight]` reference per render — fine to
		// re-bind on each iteration.
	}, [items, highlight, onClose]);

	const anchor = useComposerAnchor(view);

	if (items.length === 0 || anchor === null) return null;
	const pluginCount = items.filter((item) => item.kind === "plugin").length;
	const sectionClass =
		"px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground";
	const rowClass = (active: boolean) =>
		cn(
			"flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm",
			active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
		);

	// Portaled to body: inside the composer the glass blur can't sample the
	// page (nested backdrop-filter roots), so the popup escapes it.
	return createPortal(
		<div
			role="listbox"
			className={cn("fixed z-50 w-96 overflow-hidden p-1.5", overlaySurface)}
			style={{ left: anchor.left, bottom: anchor.bottom }}
			onMouseDown={(e) => e.preventDefault()}
		>
			{items.map((item, i) => {
				const active = i === highlight;
				const heading =
					i === 0 && item.kind === "plugin" ? (
						<div className={sectionClass}>
							{uiMessage("plugins:plugins_title")}
						</div>
					) : i === pluginCount && item.kind === "file" ? (
						<div className={cn(sectionClass, i > 0 && "mt-1")}>
							{uiMessage("projects:file_tag_popover_files")}
						</div>
					) : null;
				if (item.kind === "plugin")
					return (
						<div key={`plugin:${item.plugin.id}:${item.plugin.connectionId}`}>
							{heading}
							<button
								type="button"
								role="option"
								aria-selected={active}
								onMouseEnter={() => setHighlight(i)}
								onClick={() => confirm(item)}
								className={rowClass(active)}
							>
								<PluginIcon
									name={item.plugin.name}
									domain={item.plugin.domain}
									className="size-4 rounded-[4px] text-[9px] ring-0"
								/>
								<span className="truncate font-medium">{item.plugin.name}</span>
							</button>
						</div>
					);
				const name = basename(item.hit.relPath);
				const parent = dirname(item.hit.relPath);
				return (
					<div key={item.hit.relPath}>
						{heading}
						<button
							type="button"
							role="option"
							aria-selected={active}
							onMouseEnter={() => setHighlight(i)}
							onClick={() => confirm(item)}
							className={rowClass(active)}
						>
							<FileIcon
								name={name}
								kind={item.hit.kind}
								className="inline-flex size-3.5 shrink-0 items-center justify-center"
							/>
							<span className="truncate font-medium">{name}</span>
							{parent !== null && (
								<span
									className="ml-auto truncate text-xs text-muted-foreground"
									title={item.hit.relPath}
								>
									{parent}
								</span>
							)}
						</button>
					</div>
				);
			})}
		</div>,
		document.body,
	);
}
