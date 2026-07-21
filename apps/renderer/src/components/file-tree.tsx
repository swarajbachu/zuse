import { HugeiconsIcon } from "@hugeicons/react";
import {
	ArrowRight01Icon,
	BubbleChatIcon,
	Copy01Icon,
	Delete02Icon,
	FileAddIcon,
	FolderAddIcon,
	FolderOpenIcon,
	PencilEdit01Icon,
	Search01Icon,
} from "@hugeicons-pro/core-solid-rounded";
import type {
	ContextMenuItem as FileTreeContextMenuItem,
	ContextMenuOpenContext as FileTreeContextMenuOpenContext,
	FileTreeDropResult,
	FileTree as FileTreeModel,
	FileTreeRenameEvent,
	GitStatus,
	GitStatusEntry,
} from "@pierre/trees";
import { FileTree as PierreTree, useFileTree } from "@pierre/trees/react";
import type { FolderId, GitChange, GitChangeKind } from "@zuse/contracts";
import { Effect, Fiber, Stream } from "effect";
import fuzzysort from "fuzzysort";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { OpenTarget } from "../lib/bridge.ts";
import { getRpcClient } from "../lib/rpc-client.ts";
import { cn } from "../lib/utils.ts";
import {
	useActiveWorkspaceRoot,
	useActiveWorktreeId,
} from "../store/active-workspace.ts";
import { useComposerBridge } from "../store/composer-bridge.ts";
import { gitChangesKey, useGitChangesStore } from "../store/git-changes.ts";
import { useSettingsStore } from "../store/settings.ts";
import { useUiStore } from "../store/ui.ts";
import { FileIcon } from "./file-icon.tsx";
import { OpenTargetIcon } from "./open-target-icon.tsx";
import {
	AlertDialog,
	AlertDialogClose,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogPopup,
	AlertDialogTitle,
} from "./ui/alert-dialog.tsx";
import { Button } from "./ui/button.tsx";
import { overlaySurface } from "./ui/overlay-surface.ts";
import { Skeleton } from "./ui/skeleton.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip.tsx";

type PathsState =
	| { status: "loading" }
	| { status: "ready"; paths: ReadonlyArray<string>; truncated: boolean }
	| { status: "error"; reason: string };

const formatError = (err: unknown): string => {
	if (err instanceof Error) return err.message;
	if (typeof err === "object" && err !== null && "_tag" in err) {
		return String((err as { _tag: unknown })._tag);
	}
	return String(err);
};

const basename = (p: string): string => {
	const trimmed = p.replace(/\/+$/g, "");
	const idx = trimmed.lastIndexOf("/");
	return idx === -1 ? trimmed : trimmed.slice(idx + 1);
};

const parentPathOf = (p: string): string => {
	const trimmed = p.replace(/\/+$/g, "");
	const idx = trimmed.lastIndexOf("/");
	return idx === -1 ? "" : trimmed.slice(0, idx);
};

const joinRelPath = (base: string, name: string): string =>
	base === "" ? name : `${base}/${name}`;

const stripSlash = (p: string): string => p.replace(/\/+$/g, "");

// Injected into the tree's shadow root: hide the default chevron and use the
// Hugeicons Folder01 (closed) / Folder02 (open) glyphs instead. The mask paths
// live on the `.fz-tree` host in styles.css and pierce the shadow boundary.
const FOLDER_ICON_CSS = `
button[data-item-type='folder'] [data-item-section='icon'] svg { display: none; }
button[data-item-type='folder'] [data-item-section='icon'] {
  position: relative;
  width: 16px;
  height: 16px;
}
button[data-item-type='folder'] [data-item-section='icon']::before {
  content: '';
  position: absolute;
  inset: 0;
  background-color: currentColor;
  opacity: 0.4;
  -webkit-mask: var(--fz-folder-01) center / 15px 15px no-repeat;
  mask: var(--fz-folder-01) center / 15px 15px no-repeat;
}
button[data-item-type='folder'][aria-expanded='true'] [data-item-section='icon']::before {
  -webkit-mask-image: var(--fz-folder-02-background);
  mask-image: var(--fz-folder-02-background);
}
button[data-item-type='folder'][aria-expanded='true'] [data-item-section='icon']::after {
  content: '';
  position: absolute;
  inset: 0;
  background-color: currentColor;
  -webkit-mask: var(--fz-folder-02-foreground) center / 15px 15px no-repeat;
  mask: var(--fz-folder-02-foreground) center / 15px 15px no-repeat;
}
`;

const validateNewName = (raw: string | null): string | null => {
	const name = raw?.trim() ?? "";
	if (name.length === 0) return null;
	if (
		name.includes("/") ||
		name.includes("\\") ||
		name === "." ||
		name === ".."
	) {
		window.alert("Use a simple name without slashes.");
		return null;
	}
	return name;
};

// Map git's richer working-tree states onto the six statuses `@pierre/trees`
// renders as its built-in row badges (M / A / dot). Folders roll up
// automatically inside the tree.
const gitStatusFor = (kind: GitChangeKind): GitStatus | null => {
	switch (kind) {
		case "modified":
		case "type_changed":
		case "unmerged":
			return "modified";
		case "added":
		case "copied":
			return "added";
		case "deleted":
			return "deleted";
		case "renamed":
			return "renamed";
		case "untracked":
			return "untracked";
		case "ignored":
			return "ignored";
		default:
			return null;
	}
};

const toGitStatusEntries = (
	changes: ReadonlyArray<GitChange>,
): GitStatusEntry[] => {
	const out: GitStatusEntry[] = [];
	for (const change of changes) {
		const status = gitStatusFor(change.kind);
		if (status !== null) out.push({ path: change.path, status });
	}
	return out;
};

/**
 * Right-pane file tree, built on `@pierre/trees`. The tree is path-first — it
 * wants the whole path universe up front and virtualizes the visible window
 * itself — so we fetch the full list via `fs.listPaths`, then drive live disk
 * changes, git status, rename, drag-and-drop, and context-menu commands
 * through the model. Re-roots by remounting (`key`) when the folder/worktree
 * changes; incremental disk changes flow through `model.batch`.
 */
export function FileTree({ folderId }: { folderId: FolderId }) {
	const worktreeId = useActiveWorktreeId(folderId);
	const [state, setState] = useState<PathsState>({ status: "loading" });

	useEffect(() => {
		let cancelled = false;
		setState({ status: "loading" });
		void (async () => {
			try {
				const client = await getRpcClient();
				const result = await Effect.runPromise(
					client["fs.listPaths"]({ folderId, worktreeId }),
				);
				if (cancelled) return;
				setState({
					status: "ready",
					paths: result.paths,
					truncated: result.truncated,
				});
			} catch (err) {
				if (cancelled) return;
				setState({ status: "error", reason: formatError(err) });
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [folderId, worktreeId]);

	if (state.status === "loading") {
		return (
			<ul
				className="flex flex-col gap-1 px-2 py-1"
				aria-label="Loading project files"
			>
				{[80, 64, 72, 56, 88, 60, 76].map((w, i) => (
					<li key={i} className="flex items-center gap-1.5 px-1 py-1">
						<Skeleton className="size-3.5 shrink-0" />
						<Skeleton className="h-3" style={{ width: `${w}%` }} />
					</li>
				))}
			</ul>
		);
	}
	if (state.status === "error") {
		return (
			<p className="px-3 py-6 text-center text-xs text-muted-foreground">
				{state.reason}
			</p>
		);
	}

	return (
		<TreeView
			// Remount when the path universe is first known / re-rooted so the model
			// is rebuilt from a clean presorted list.
			key={`${folderId}:${worktreeId ?? "main"}`}
			folderId={folderId}
			worktreeId={worktreeId}
			initialPaths={state.paths}
			truncated={state.truncated}
		/>
	);
}

type DeleteState = { path: string; kind: "file" | "directory" } | null;

function TreeView({
	folderId,
	worktreeId,
	initialPaths,
	truncated,
}: {
	folderId: FolderId;
	worktreeId: ReturnType<typeof useActiveWorktreeId>;
	initialPaths: ReadonlyArray<string>;
	truncated: boolean;
}) {
	const openFileInTab = useUiStore((s) => s.openFileInTab);
	const setActiveMainTab = useUiStore((s) => s.setActiveMainTab);
	const folderRoot = useActiveWorkspaceRoot(folderId);
	const appearanceMode = useSettingsStore((s) => s.appearanceMode);

	const modelRef = useRef<FileTreeModel | null>(null);
	const knownPathsRef = useRef<Set<string>>(new Set(initialPaths));
	const [deleteTarget, setDeleteTarget] = useState<DeleteState>(null);
	const [deleting, setDeleting] = useState(false);
	const [openTargets, setOpenTargets] = useState<ReadonlyArray<OpenTarget>>([]);
	const lastDeleteRef = useRef<DeleteState>(null);
	if (deleteTarget !== null) lastDeleteRef.current = deleteTarget;

	useEffect(() => {
		if (folderRoot === null) return;
		const bridge = window.zuse?.app;
		if (bridge?.listOpenTargets === undefined) return;
		void bridge.listOpenTargets(folderRoot).then((targets) => {
			setOpenTargets(targets.filter((target) => target.available));
		});
	}, [folderRoot]);

	// Non-null while the file-search command palette is open; holds the current
	// file list (dirs excluded) captured from the live known-paths set.
	const [searchFiles, setSearchFiles] = useState<ReadonlyArray<string> | null>(
		null,
	);

	// Directory paths carry a trailing "/" in the server listing. Keep a set of
	// their canonical (slash-stripped) form so selection can tell files from
	// folders without a model round-trip.
	const dirPathsRef = useRef<Set<string>>(
		new Set(
			initialPaths.filter((p) => p.endsWith("/")).map((p) => stripSlash(p)),
		),
	);

	const openFile = useCallback(
		(path: string, name: string) => {
			openFileInTab({ kind: "text", folderId, path, name, worktreeId });
		},
		[folderId, openFileInTab, worktreeId],
	);

	// Single selection of a file row opens it — matches the old click-to-open.
	// Directory selection is a no-op; the tree toggles expansion itself.
	const onSelectionChange = useCallback(
		(paths: readonly string[]) => {
			if (paths.length !== 1) return;
			const raw = paths[0];
			if (raw === undefined) return;
			const canonical = stripSlash(raw);
			const model = modelRef.current;
			const isDir =
				model?.getItem(raw)?.isDirectory() ??
				model?.getItem(canonical)?.isDirectory() ??
				dirPathsRef.current.has(canonical);
			if (isDir) return;
			openFile(canonical, basename(canonical));
		},
		[openFile],
	);

	const persistRename = useCallback(
		({ sourcePath, destinationPath }: FileTreeRenameEvent) => {
			void (async () => {
				try {
					const client = await getRpcClient();
					await Effect.runPromise(
						client["fs.move"]({
							folderId,
							fromPath: stripSlash(sourcePath),
							toPath: stripSlash(destinationPath),
							worktreeId,
						}),
					);
				} catch (err) {
					// Revert the optimistic model change on disk failure.
					modelRef.current?.move(destinationPath, sourcePath);
					window.alert(`Couldn't rename: ${formatError(err)}`);
				}
			})();
		},
		[folderId, worktreeId],
	);

	const persistDrop = useCallback(
		({ draggedPaths, target }: FileTreeDropResult) => {
			const dir =
				target.directoryPath === null ? "" : stripSlash(target.directoryPath);
			void (async () => {
				const client = await getRpcClient();
				for (const dragged of draggedPaths) {
					const from = stripSlash(dragged);
					const to = joinRelPath(dir, basename(from));
					if (from === to) continue;
					try {
						await Effect.runPromise(
							client["fs.move"]({
								folderId,
								fromPath: from,
								toPath: to,
								worktreeId,
							}),
						);
					} catch (err) {
						modelRef.current?.move(to, from);
						window.alert(
							`Couldn't move ${basename(from)}: ${formatError(err)}`,
						);
					}
				}
			})();
		},
		[folderId, worktreeId],
	);

	const { model } = useFileTree({
		paths: initialPaths,
		// Server already emits paths in dirs-first-then-name order; preserve it so
		// the tree doesn't re-sort (and, unlike `presorted`, this never drops rows
		// if the order isn't Pierre's exact canonical form).
		sort: () => 0,
		// Seed a first batch of rows so the tree renders before the virtualizer has
		// measured the host viewport (otherwise it can paint empty).
		initialVisibleRowCount: 40,
		initialExpansion: 1,
		density: "compact",
		icons: "complete",
		// Swap the bare folder chevron for a real folder glyph (open/closed) and
		// drop the indent guides — see the `--fz-folder*` vars in styles.css.
		unsafeCSS: FOLDER_ICON_CSS,
		gitStatus: toGitStatusEntries(
			useGitChangesStore.getState().byKey[
				gitChangesKey(folderId, worktreeId)
			] ?? [],
		),
		onSelectionChange,
		renaming: {
			canRename: (item) => stripSlash(item.path) !== "",
			onRename: persistRename,
		},
		dragAndDrop: {
			canDrag: (paths) => paths.length > 0,
			canDrop: ({ target }) =>
				target.directoryPath === null ||
				!stripSlash(target.directoryPath).startsWith(".git"),
			onDropComplete: persistDrop,
		},
		composition: {
			contextMenu: {
				enabled: true,
				triggerMode: "both",
				buttonVisibility: "when-needed",
			},
		},
	});
	modelRef.current = model;

	// Live git-status lane: push the current changes into the tree and keep it in
	// sync as the working tree changes.
	const changes = useGitChangesStore(
		(s) => s.byKey[gitChangesKey(folderId, worktreeId)],
	);
	useEffect(() => {
		model.setGitStatus(toGitStatusEntries(changes ?? []));
	}, [model, changes]);

	// Live disk changes: on each debounced `fs.watchTree` batch, refetch the full
	// path list and apply the delta through `model.batch` so expansion and
	// selection are preserved (vs a full resetPaths).
	useEffect(() => {
		let fiber: Fiber.Fiber<unknown, unknown> | null = null;
		let cancelled = false;
		let scheduled = false;

		const reconcile = async () => {
			scheduled = false;
			try {
				const client = await getRpcClient();
				const result = await Effect.runPromise(
					client["fs.listPaths"]({ folderId, worktreeId }),
				);
				if (cancelled) return;
				const next = result.paths;
				const nextSet = new Set(next);
				const known = knownPathsRef.current;
				const ops: Array<
					{ type: "add"; path: string } | { type: "remove"; path: string }
				> = [];
				// Adds in presorted order so parents land before children.
				for (const path of next) {
					if (!known.has(path)) ops.push({ type: "add", path });
				}
				for (const path of known) {
					if (!nextSet.has(path)) ops.push({ type: "remove", path });
				}
				if (ops.length > 0) model.batch(ops);
				knownPathsRef.current = nextSet;
				dirPathsRef.current = new Set(
					next.filter((p) => p.endsWith("/")).map((p) => stripSlash(p)),
				);
			} catch {
				// Ignore transient listing failures; the next batch retries.
			}
		};

		const schedule = () => {
			if (scheduled) return;
			scheduled = true;
			setTimeout(() => void reconcile(), 150);
		};

		void (async () => {
			const client = await getRpcClient();
			if (cancelled) return;
			fiber = Effect.runFork(
				Stream.runForEach(
					client["fs.watchTree"]({ folderId, worktreeId }).pipe(
						Stream.catch(() => Stream.empty),
					),
					() => Effect.sync(schedule),
				),
			);
		})();
		return () => {
			cancelled = true;
			if (fiber !== null) void Effect.runPromise(Fiber.interrupt(fiber));
		};
	}, [folderId, worktreeId, model]);

	const attach = useCallback(
		(path: string, kind: "file" | "directory") => {
			const attachFile = useComposerBridge.getState().attachFile;
			if (attachFile === null) return;
			setActiveMainTab("chat");
			const rel = stripSlash(path);
			const absPath = folderRoot !== null ? `${folderRoot}/${rel}` : rel;
			attachFile({ relPath: rel, absPath, kind });
		},
		[folderRoot, setActiveMainTab],
	);

	const copyPath = useCallback(
		(path: string) => {
			const rel = stripSlash(path);
			const abs = folderRoot !== null ? `${folderRoot}/${rel}` : rel;
			void navigator.clipboard?.writeText(abs);
		},
		[folderRoot],
	);

	const openInTarget = useCallback(
		(path: string, target: OpenTarget) => {
			const rel = stripSlash(path);
			const abs = folderRoot !== null ? `${folderRoot}/${rel}` : rel;
			if (target.id === "finder") {
				void window.zuse?.app?.revealPath?.(abs);
				return;
			}
			void window.zuse?.app?.openPathInApp?.(abs, target.id);
		},
		[folderRoot],
	);

	const createInDirectory = useCallback(
		async (dirPath: string, kind: "file" | "directory") => {
			const label = kind === "file" ? "file" : "folder";
			const name = validateNewName(window.prompt(`New ${label} name`));
			if (name === null) return;
			const path = joinRelPath(stripSlash(dirPath), name);
			try {
				const client = await getRpcClient();
				if (kind === "file") {
					await Effect.runPromise(
						client["fs.createFile"]({ folderId, path, worktreeId }),
					);
					model.add(path);
					openFile(path, name);
				} else {
					await Effect.runPromise(
						client["fs.createDirectory"]({ folderId, path, worktreeId }),
					);
					model.add(`${path}/`);
				}
			} catch (err) {
				window.alert(formatError(err));
			}
		},
		[folderId, model, openFile, worktreeId],
	);

	const confirmDelete = useCallback(async () => {
		const target = deleteTarget;
		if (target === null) return;
		setDeleting(true);
		try {
			const client = await getRpcClient();
			await Effect.runPromise(
				client["fs.remove"]({
					folderId,
					path: stripSlash(target.path),
					worktreeId,
				}),
			);
			model.remove(target.path, { recursive: true });
			setDeleteTarget(null);
		} catch (err) {
			window.alert(`Couldn't delete: ${formatError(err)}`);
		} finally {
			setDeleting(false);
		}
	}, [deleteTarget, folderId, model, worktreeId]);

	const renderContextMenu = useCallback(
		(
			item: FileTreeContextMenuItem,
			context: FileTreeContextMenuOpenContext,
		) => {
			const isFile = item.kind === "file";
			const dirForCreate =
				item.kind === "directory"
					? stripSlash(item.path)
					: parentPathOf(item.path);
			const act =
				(fn: () => void, keepFocus = true) =>
				() => {
					context.close({ restoreFocus: keepFocus });
					fn();
				};
			return (
				<div className={cn("min-w-[190px] p-1.5 text-sm", overlaySurface)}>
					{isFile && (
						<MenuButton
							icon={PencilEdit01Icon}
							onClick={act(() => openFile(stripSlash(item.path), item.name))}
						>
							Open in editor
						</MenuButton>
					)}
					<MenuButton
						icon={PencilEdit01Icon}
						onClick={act(() => model.startRenaming(item.path), false)}
					>
						Rename
					</MenuButton>
					<MenuButton
						icon={BubbleChatIcon}
						onClick={act(() => attach(item.path, item.kind))}
					>
						Attach to chat
					</MenuButton>
					<MenuButton
						icon={Copy01Icon}
						onClick={act(() => copyPath(item.path))}
					>
						Copy path
					</MenuButton>
					<OpenInSubmenu
						path={item.path}
						targets={openTargets}
						onOpen={(target) => act(() => openInTarget(item.path, target))()}
					/>
					<div className="my-1 h-px bg-border" />
					<MenuButton
						icon={FileAddIcon}
						onClick={act(() => void createInDirectory(dirForCreate, "file"))}
					>
						New File
					</MenuButton>
					<MenuButton
						icon={FolderAddIcon}
						onClick={act(
							() => void createInDirectory(dirForCreate, "directory"),
						)}
					>
						New Folder
					</MenuButton>
					<div className="my-1 h-px bg-border" />
					<MenuButton
						icon={Delete02Icon}
						destructive
						onClick={act(() =>
							setDeleteTarget({
								path: item.path,
								kind: item.kind,
							}),
						)}
					>
						Delete
					</MenuButton>
				</div>
			);
		},
		[
			attach,
			copyPath,
			createInDirectory,
			model,
			openFile,
			openInTarget,
			openTargets,
		],
	);

	const openSearch = useCallback(() => {
		const files = Array.from(knownPathsRef.current)
			.filter((p) => !p.endsWith("/"))
			.sort((a, b) => a.localeCompare(b));
		setSearchFiles(files);
	}, []);

	const header = (
		<div className="flex items-center gap-1 px-2 py-1.5">
			<span className="flex-1 truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
				Files{truncated ? " (partial)" : ""}
			</span>
			<HeaderButton
				label="New File"
				icon={FileAddIcon}
				onClick={() => void createInDirectory("", "file")}
			/>
			<HeaderButton
				label="New Folder"
				icon={FolderAddIcon}
				onClick={() => void createInDirectory("", "directory")}
			/>
			<HeaderButton
				label="Search files"
				icon={Search01Icon}
				onClick={openSearch}
			/>
		</div>
	);

	return (
		<div className="fz-tree h-full min-h-0">
			<PierreTree
				model={model}
				header={header}
				renderContextMenu={renderContextMenu}
				// Pierre's host manages its own `height:100%` + internal `overflow`
				// scroller when virtualized, so only give it a bounded height — do NOT
				// set `overflow` here, or it overrides Pierre's `overflow:hidden`,
				// breaks the internal scroller, and clips the context-menu popup.
				className="h-full min-h-0"
				// Follow the app appearance so the shadow-DOM tree matches light/dark.
				data-theme-type={appearanceMode}
			/>
			<DeleteConfirmDialog
				target={deleteTarget ?? lastDeleteRef.current}
				open={deleteTarget !== null}
				deleting={deleting}
				onOpenChange={(open) => {
					if (!open && !deleting) setDeleteTarget(null);
				}}
				onConfirm={confirmDelete}
			/>
			{searchFiles !== null ? (
				<FileSearchPalette
					files={searchFiles}
					onClose={() => setSearchFiles(null)}
					onSelect={(path) => {
						setSearchFiles(null);
						openFile(path, basename(path));
					}}
				/>
			) : null}
		</div>
	);
}

/**
 * Command-palette file finder opened from the tree header's search button.
 * Fuzzy-matches the workspace's file list and opens the picked file. Separate
 * from the tree's own row filter so search is a fast global jump, not an
 * in-place filter.
 */
function FileSearchPalette({
	files,
	onSelect,
	onClose,
}: {
	files: ReadonlyArray<string>;
	onSelect: (path: string) => void;
	onClose: () => void;
}) {
	const [query, setQuery] = useState("");
	const [highlight, setHighlight] = useState(0);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const results = useMemo<ReadonlyArray<string>>(() => {
		const q = query.trim();
		if (q === "") return files.slice(0, 100);
		return fuzzysort
			.go(q, files as string[], { limit: 100, threshold: 0.4 })
			.map((r) => r.target);
	}, [files, query]);

	useEffect(() => {
		setHighlight(0);
	}, [results]);

	useEffect(() => {
		const el = listRef.current?.querySelector(`[data-idx="${highlight}"]`);
		el?.scrollIntoView({ block: "nearest" });
	}, [highlight]);

	const commit = (idx: number) => {
		const path = results[idx];
		if (path !== undefined) onSelect(path);
	};

	return (
		<div
			className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh]"
			onMouseDown={onClose}
		>
			<div
				className={cn(
					"flex max-h-[62vh] w-[min(680px,92vw)] flex-col overflow-hidden",
					overlaySurface,
				)}
				onMouseDown={(e) => e.stopPropagation()}
			>
				<div className="flex items-center gap-2 border-b border-border/60 px-3">
					<HugeiconsIcon
						icon={Search01Icon}
						className="size-4 shrink-0 text-muted-foreground"
					/>
					<input
						ref={inputRef}
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								e.preventDefault();
								onClose();
							} else if (e.key === "ArrowDown") {
								e.preventDefault();
								setHighlight((h) => Math.min(h + 1, results.length - 1));
							} else if (e.key === "ArrowUp") {
								e.preventDefault();
								setHighlight((h) => Math.max(h - 1, 0));
							} else if (e.key === "Enter") {
								e.preventDefault();
								commit(highlight);
							}
						}}
						placeholder="Search files…"
						className="flex-1 bg-transparent py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
					/>
				</div>
				<div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1">
					{results.length === 0 ? (
						<p className="px-3 py-6 text-center text-xs text-muted-foreground">
							No files match “{query}”.
						</p>
					) : (
						results.map((path, idx) => {
							const name = basename(path);
							const dir = parentPathOf(path);
							return (
								<button
									key={path}
									data-idx={idx}
									type="button"
									onMouseEnter={() => setHighlight(idx)}
									onClick={() => commit(idx)}
									className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left ${
										idx === highlight ? "bg-accent text-accent-foreground" : ""
									}`}
								>
									<FileIcon name={name} kind="file" />
									<span className="truncate font-mono text-[13px] text-foreground">
										{name}
									</span>
									{dir !== "" ? (
										<span className="truncate font-mono text-[11px] text-muted-foreground">
											{dir}
										</span>
									) : null}
								</button>
							);
						})
					)}
				</div>
			</div>
		</div>
	);
}

function MenuButton({
	icon,
	children,
	onClick,
	destructive = false,
}: {
	icon: typeof FileAddIcon;
	children: React.ReactNode;
	onClick: () => void;
	destructive?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-accent ${
				destructive ? "text-red-300 hover:bg-red-500/20 hover:text-red-200" : ""
			}`}
		>
			<HugeiconsIcon icon={icon} className="size-4" />
			{children}
		</button>
	);
}

function OpenInSubmenu({
	path,
	targets,
	onOpen,
}: {
	path: string;
	targets: ReadonlyArray<OpenTarget>;
	onOpen: (target: OpenTarget) => void;
}) {
	const finder: OpenTarget = { id: "finder", label: "Finder", available: true };
	const availableTargets = targets.length > 0 ? targets : [finder];

	return (
		<div className="group/open-in relative">
			<button
				type="button"
				aria-haspopup="menu"
				className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-accent"
			>
				<HugeiconsIcon icon={FolderOpenIcon} className="size-4" />
				<span>Open in</span>
				<HugeiconsIcon
					icon={ArrowRight01Icon}
					className="ml-auto size-3.5 text-muted-foreground"
				/>
			</button>
			<div
				role="menu"
				aria-label={`Open ${basename(path)} in`}
				className={cn(
					"invisible pointer-events-none absolute left-[calc(100%+4px)] top-0 z-10 min-w-[180px] p-1 text-sm opacity-0 transition-[opacity,visibility] group-hover/open-in:pointer-events-auto group-hover/open-in:visible group-hover/open-in:opacity-100 group-focus-within/open-in:pointer-events-auto group-focus-within/open-in:visible group-focus-within/open-in:opacity-100",
					overlaySurface,
				)}
			>
				{availableTargets.map((target) => (
					<button
						key={target.id}
						type="button"
						role="menuitem"
						onClick={() => onOpen(target)}
						className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent"
					>
						<OpenTargetIcon target={target} />
						<span className="flex-1 truncate">{target.label}</span>
					</button>
				))}
			</div>
		</div>
	);
}

function HeaderButton({
	label,
	icon,
	onClick,
}: {
	label: string;
	icon: typeof FileAddIcon;
	onClick: () => void;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						aria-label={label}
						onClick={onClick}
						className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
					>
						<HugeiconsIcon icon={icon} className="size-4" />
					</button>
				}
			/>
			<TooltipPopup>{label}</TooltipPopup>
		</Tooltip>
	);
}

function DeleteConfirmDialog({
	target,
	open,
	deleting,
	onOpenChange,
	onConfirm,
}: {
	target: DeleteState;
	open: boolean;
	deleting: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void;
}) {
	const isDir = target?.kind === "directory";
	const name = target ? basename(target.path) : "";
	const detail = isDir
		? "This deletes the folder and everything inside it."
		: "This deletes the file from disk.";
	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogPopup className="max-w-sm">
				<AlertDialogHeader>
					<AlertDialogTitle>
						Delete {isDir ? "folder" : "file"}?
					</AlertDialogTitle>
					<AlertDialogDescription>
						<span className="font-mono text-foreground">{name}</span> will be
						permanently deleted. {detail} This cannot be undone.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogClose
						render={
							<Button type="button" variant="ghost" disabled={deleting}>
								Cancel
							</Button>
						}
					/>
					<Button
						type="button"
						variant="destructive"
						loading={deleting}
						onClick={onConfirm}
					>
						Delete
					</Button>
				</AlertDialogFooter>
			</AlertDialogPopup>
		</AlertDialog>
	);
}
