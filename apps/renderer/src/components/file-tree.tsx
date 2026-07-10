import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  BubbleChatIcon,
  Copy01Icon,
  Delete02Icon,
  FileAddIcon,
  FolderAddIcon,
  PencilEdit01Icon,
} from "@hugeicons-pro/core-bulk-rounded";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Effect, Fiber, Stream } from "effect";

import type { FolderId, FsEntry } from "@zuse/contracts";

import { getRpcClient } from "../lib/rpc-client.ts";
import {
  useActiveWorkspaceRoot,
  useActiveWorktreeId,
} from "../store/active-workspace.ts";
import { useComposerBridge } from "../store/composer-bridge.ts";
import { useUiStore } from "../store/ui.ts";
import { FileIcon } from "./file-icon.tsx";
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
import { Menu, MenuItem, MenuPopup, MenuSeparator } from "./ui/menu.tsx";
import { Skeleton } from "./ui/skeleton.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip.tsx";

type DirState =
  | { status: "loading" }
  | { status: "ready"; entries: ReadonlyArray<FsEntry> }
  | { status: "error"; reason: string };

type ContextTarget =
  | { kind: "empty"; path: "" }
  | { kind: "entry"; entry: FsEntry };

type ContextMenuState = {
  readonly open: boolean;
  readonly target: ContextTarget;
  readonly anchor: { getBoundingClientRect: () => DOMRect };
};

const formatError = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "_tag" in err) {
    return String((err as { _tag: unknown })._tag);
  }
  return String(err);
};

const basename = (p: string): string => {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
};

const parentPathOf = (p: string): string => {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? "" : p.slice(0, idx);
};

const joinRelPath = (base: string, name: string): string =>
  base === "" ? name : `${base}/${name}`;

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

const pointAnchor = (clientX: number, clientY: number) => ({
  getBoundingClientRect: () => new DOMRect(clientX, clientY, 0, 0),
});

/**
 * Lazy-loading directory tree. Each expanded directory fetches its own
 * one-level listing via `fs.tree`; collapsing forgets the children so the
 * server stays in charge of any new files. Hidden directories like `.git`
 * and `node_modules` are filtered server-side.
 *
 * Performance:
 * - Hover-prefetch: pointing at an unloaded directory kicks off `fs.tree` so
 *   by the time the user clicks, the children are usually already in state
 *   and the expand renders synchronously.
 * - `TreeNode` is memoized with a path-aware comparator so toggling one
 *   directory only re-renders the path from root to that directory; closed
 *   siblings (which can dominate large projects) bail out.
 */
export function FileTree({ folderId }: { folderId: FolderId }) {
  // Follow the selected session's worktree when it has one. The reset effect
  // depends on `worktreeId` so toggling worktrees re-roots the tree without
  // unmounting; passing it through `fs.tree` swaps the server-side root.
  const worktreeId = useActiveWorktreeId(folderId);
  const [rootState, setRootState] = useState<DirState>({ status: "loading" });
  const [childStates, setChildStates] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  // Entry queued for the delete confirmation dialog. The dialog renders the
  // last queued entry through its close animation, so a ref retains it after
  // `deleteTarget` clears on close.
  const [deleteTarget, setDeleteTarget] = useState<FsEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const lastDeleteEntryRef = useRef<FsEntry | null>(null);
  if (deleteTarget !== null) lastDeleteEntryRef.current = deleteTarget;

  // Mirror state into refs so callbacks can stay stable (and let memoized
  // children skip re-renders driven only by callback identity).
  const childStatesRef = useRef(childStates);
  childStatesRef.current = childStates;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const refreshDirectory = useCallback(
    async (path: string) => {
      try {
        const client = await getRpcClient();
        const entries = await Effect.runPromise(
          client["fs.tree"]({ folderId, path, worktreeId }),
        );
        if (path === "") {
          setRootState({ status: "ready", entries });
          return;
        }
        setChildStates((prev) => ({
          ...prev,
          [path]: { status: "ready", entries },
        }));
      } catch (err) {
        const next: DirState = { status: "error", reason: formatError(err) };
        if (path === "") {
          setRootState(next);
          return;
        }
        setChildStates((prev) => ({ ...prev, [path]: next }));
      }
    },
    [folderId, worktreeId],
  );

  // Reset everything when the project or active worktree changes — the
  // previous tree's paths wouldn't resolve under the new root.
  useEffect(() => {
    let cancelled = false;
    setRootState({ status: "loading" });
    setChildStates({});
    setExpanded({});
    void (async () => {
      try {
        const client = await getRpcClient();
        const entries = await Effect.runPromise(
          client["fs.tree"]({ folderId, path: "", worktreeId }),
        );
        if (cancelled) return;
        setRootState({ status: "ready", entries });
      } catch (err) {
        if (cancelled) return;
        setRootState({ status: "error", reason: formatError(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [folderId, worktreeId]);

  useEffect(() => {
    let fiber: Fiber.RuntimeFiber<unknown, unknown> | null = null;
    let cancelled = false;
    void (async () => {
      const client = await getRpcClient();
      if (cancelled) return;
      fiber = Effect.runFork(
        Stream.runForEach(
          client["fs.watchTree"]({ folderId, worktreeId })
            .pipe(Stream.catch(() => Stream.empty)),
          ({ paths }) =>
            Effect.sync(() => {
              const toRefresh = new Set<string>([""]);
              for (const path of paths) {
                if (expandedRef.current[path] === true) toRefresh.add(path);
                const parent = parentPathOf(path);
                if (parent === "" || expandedRef.current[parent] === true) {
                  toRefresh.add(parent);
                }
              }
              for (const path of toRefresh) void refreshDirectory(path);
            }),
        ),
      );
    })();
    return () => {
      cancelled = true;
      if (fiber !== null) void Effect.runPromise(Fiber.interrupt(fiber));
    };
  }, [folderId, refreshDirectory, worktreeId]);

  const loadChild = useCallback(
    async (path: string) => {
      // Idempotent — bail if a fetch is in flight or done. Hover + click can
      // both call this; we only want one round-trip per directory.
      if (childStatesRef.current[path] !== undefined) return;
      setChildStates((prev) =>
        prev[path] !== undefined
          ? prev
          : { ...prev, [path]: { status: "loading" } },
      );
      try {
        const client = await getRpcClient();
        const entries = await Effect.runPromise(
          client["fs.tree"]({ folderId, path, worktreeId }),
        );
        setChildStates((prev) => ({
          ...prev,
          [path]: { status: "ready", entries },
        }));
      } catch (err) {
        setChildStates((prev) => ({
          ...prev,
          [path]: { status: "error", reason: formatError(err) },
        }));
      }
    },
    [folderId, worktreeId],
  );

  const openFileInTab = useUiStore((s) => s.openFileInTab);
  const setActiveMainTab = useUiStore((s) => s.setActiveMainTab);
  const activePath = useUiStore((s) =>
    s.openFile?.kind === "text" ? s.openFile.path : null,
  );

  const onActivate = useCallback(
    (entry: FsEntry) => {
      if (entry.kind === "directory") {
        const isOpen = expandedRef.current[entry.path] === true;
        setExpanded((prev) => ({ ...prev, [entry.path]: !isOpen }));
        if (!isOpen) void loadChild(entry.path);
        return;
      }
      openFileInTab({
        kind: "text",
        folderId,
        path: entry.path,
        name: entry.name,
        worktreeId,
      });
    },
    [folderId, loadChild, openFileInTab, worktreeId],
  );

  // Root path used to build absolute paths for file chips attached to the
  // composer. Follows the active worktree so chip-attached file paths point
  // at the worktree, not the main checkout.
  const folderRoot = useActiveWorkspaceRoot(folderId);

  // Translates a tree row's "+" click into a composer chip insertion. The
  // composer registers `attachFile` on mount via `composer-bridge`; if no
  // session is active the bridge stays null and the button renders disabled.
  const onAttach = useCallback(
    (entry: FsEntry) => {
      const attach = useComposerBridge.getState().attachFile;
      if (attach === null) return;
      setActiveMainTab("chat");
      const absPath =
        folderRoot !== null ? `${folderRoot}/${entry.path}` : entry.path;
      attach({ relPath: entry.path, absPath, kind: entry.kind });
    },
    [folderRoot, setActiveMainTab],
  );

  const openInEditor = useCallback(
    (entry: FsEntry) => {
      if (entry.kind !== "file") return;
      openFileInTab({
        kind: "text",
        folderId,
        path: entry.path,
        name: entry.name,
        worktreeId,
      });
    },
    [folderId, openFileInTab, worktreeId],
  );

  const createInDirectory = useCallback(
    async (dirPath: string, kind: "file" | "directory") => {
      const label = kind === "file" ? "file" : "folder";
      const name = validateNewName(window.prompt(`New ${label} name`));
      if (name === null) return;
      const path = joinRelPath(dirPath, name);
      try {
        const client = await getRpcClient();
        if (kind === "file") {
          await Effect.runPromise(
            client["fs.createFile"]({ folderId, path, worktreeId }),
          );
          await refreshDirectory(dirPath);
          openFileInTab({
            kind: "text",
            folderId,
            path,
            name: basename(path),
            worktreeId,
          });
        } else {
          await Effect.runPromise(
            client["fs.createDirectory"]({ folderId, path, worktreeId }),
          );
          setExpanded((prev) =>
            dirPath === "" ? prev : { ...prev, [dirPath]: true },
          );
          await refreshDirectory(dirPath);
        }
      } catch (err) {
        window.alert(formatError(err));
      }
    },
    [folderId, openFileInTab, refreshDirectory, worktreeId],
  );

  const contextDirectoryPath = contextMenu
    ? contextMenu.target.kind === "empty"
      ? ""
      : contextMenu.target.entry.kind === "directory"
        ? contextMenu.target.entry.path
        : parentPathOf(contextMenu.target.entry.path)
    : "";

  const contextEntry =
    contextMenu?.target.kind === "entry" ? contextMenu.target.entry : null;
  const contextPath = contextMenu?.open === true ? contextEntry?.path ?? null : null;

  const onRootContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    setContextMenu({
      open: true,
      target: { kind: "empty", path: "" },
      anchor: pointAnchor(event.clientX, event.clientY),
    });
  }, []);

  const onEntryContextMenu = useCallback(
    (event: React.MouseEvent, entry: FsEntry) => {
      event.preventDefault();
      event.stopPropagation();
      setContextMenu({
        open: true,
        target: { kind: "entry", entry },
        anchor: pointAnchor(event.clientX, event.clientY),
      });
    },
    [],
  );

  const onPrefetch = useCallback(
    (entry: FsEntry) => {
      if (entry.kind !== "directory") return;
      void loadChild(entry.path);
    },
    [loadChild],
  );

  const requestDelete = useCallback((entry: FsEntry) => {
    setDeleteTarget(entry);
  }, []);

  const confirmDelete = useCallback(async () => {
    const entry = deleteTarget;
    if (entry === null) return;
    setDeleting(true);
    try {
      const client = await getRpcClient();
      await Effect.runPromise(
        client["fs.remove"]({ folderId, path: entry.path, worktreeId }),
      );
      const parent = parentPathOf(entry.path);
      setExpanded((prev) => {
        const next = { ...prev };
        delete next[entry.path];
        for (const key of Object.keys(next)) {
          if (key.startsWith(`${entry.path}/`)) delete next[key];
        }
        return next;
      });
      setChildStates((prev) => {
        const next = { ...prev };
        delete next[entry.path];
        for (const key of Object.keys(next)) {
          if (key.startsWith(`${entry.path}/`)) delete next[key];
        }
        return next;
      });
      await refreshDirectory(parent);
      setDeleteTarget(null);
    } catch (err) {
      window.alert(`Couldn't delete: ${formatError(err)}`);
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, folderId, refreshDirectory, worktreeId]);

  // Context menu + delete confirmation render in every branch below; build
  // them once so the three return paths stay in sync.
  const overlays = (
    <>
      <FileTreeContextMenu
        state={contextMenu}
        entry={contextEntry}
        directoryPath={contextDirectoryPath}
        rootPath={folderRoot}
        onOpenChange={(open) =>
          setContextMenu((prev) => (prev === null ? null : { ...prev, open }))
        }
        onOpenInEditor={openInEditor}
        onAttach={onAttach}
        onCreate={createInDirectory}
        onDelete={requestDelete}
      />
      <DeleteConfirmDialog
        entry={deleteTarget ?? lastDeleteEntryRef.current}
        open={deleteTarget !== null}
        deleting={deleting}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
        onConfirm={confirmDelete}
      />
    </>
  );

  if (rootState.status === "loading") {
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
  if (rootState.status === "error") {
    return (
      <>
        <Empty onContextMenu={onRootContextMenu}>{rootState.reason}</Empty>
        {overlays}
      </>
    );
  }
  if (rootState.entries.length === 0) {
    return (
      <>
        <Empty onContextMenu={onRootContextMenu}>Empty directory.</Empty>
        {overlays}
      </>
    );
  }

  return (
    <div className="min-h-full" onContextMenu={onRootContextMenu}>
      <ul className="flex flex-col py-1 text-sm">
        {rootState.entries.map((entry) => (
          <TreeNode
            key={entry.path}
            entry={entry}
            depth={0}
            expanded={expanded}
            childStates={childStates}
            onActivate={onActivate}
            onPrefetch={onPrefetch}
            onAttach={onAttach}
            onContextMenu={onEntryContextMenu}
            activePath={activePath}
            contextPath={contextPath}
          />
        ))}
      </ul>
      {overlays}
    </div>
  );
}

type TreeNodeProps = {
  entry: FsEntry;
  depth: number;
  expanded: Record<string, boolean>;
  childStates: Record<string, DirState>;
  onActivate: (entry: FsEntry) => void;
  onPrefetch: (entry: FsEntry) => void;
  onAttach: (entry: FsEntry) => void;
  onContextMenu: (event: React.MouseEvent, entry: FsEntry) => void;
  activePath: string | null;
  contextPath: string | null;
};

const TreeNode = memo(
  function TreeNodeImpl({
    entry,
    depth,
    expanded,
    childStates,
    onActivate,
    onPrefetch,
    onAttach,
    onContextMenu,
    activePath,
    contextPath,
  }: TreeNodeProps) {
    const isDir = entry.kind === "directory";
    const isOpen = isDir && expanded[entry.path] === true;
    const child = isOpen ? childStates[entry.path] : undefined;
    const chevron = isOpen ? ArrowDown01Icon : ArrowRight01Icon;
    const isActive =
      (!isDir && activePath === entry.path) || contextPath === entry.path;

    return (
      <li>
        <div
          className="group/row relative px-1.5"
          onMouseEnter={isDir ? () => onPrefetch(entry) : undefined}
          onContextMenu={(event) => onContextMenu(event, entry)}
        >
          <button
            type="button"
            onClick={() => onActivate(entry)}
            title={entry.path}
            style={{ paddingLeft: 8 + depth * 12 }}
            className={`flex w-full items-center gap-1.5 rounded-sm py-1 pr-14 text-left transition-colors group-hover/row:bg-sidebar-accent/60 ${
              isActive ? "bg-sidebar-accent text-foreground" : ""
            }`}
          >
            <FileIcon name={entry.name} kind={entry.kind} expanded={isOpen} />
            <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
              {entry.name}
            </span>
          </button>
          <div className="pointer-events-none absolute top-1/2 right-3 flex -translate-y-1/2 items-center gap-1">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Attach to chat"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAttach(entry);
                    }}
                    className="pointer-events-auto flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground group-hover/row:opacity-100"
                  >
                    <HugeiconsIcon icon={BubbleChatIcon} className="size-3.5" />
                  </button>
                }
              />
              <TooltipPopup>Attach to chat</TooltipPopup>
            </Tooltip>
            {isDir ? (
              <HugeiconsIcon
                icon={chevron}
                className={`size-3.5 text-muted-foreground transition-opacity ${
                  isOpen
                    ? "opacity-100"
                    : "opacity-0 group-hover/row:opacity-100"
                }`}
              />
            ) : (
              <span className="inline-block size-3.5" />
            )}
          </div>
        </div>
        {isOpen && child !== undefined && (
          <ChildList
            state={child}
            depth={depth + 1}
            expanded={expanded}
            childStates={childStates}
            onActivate={onActivate}
            onPrefetch={onPrefetch}
            onAttach={onAttach}
            onContextMenu={onContextMenu}
            activePath={activePath}
            contextPath={contextPath}
          />
        )}
      </li>
    );
  },
  // Bail when this node's render output can't have changed. Closed siblings
  // dominate every interaction in real projects — letting them skip is the
  // single biggest win.
  (prev, next) => {
    if (
      prev.entry !== next.entry ||
      prev.depth !== next.depth ||
      prev.activePath !== next.activePath ||
      prev.onActivate !== next.onActivate ||
      prev.onPrefetch !== next.onPrefetch ||
      prev.onAttach !== next.onAttach ||
      prev.onContextMenu !== next.onContextMenu ||
      prev.contextPath !== next.contextPath
    ) {
      return false;
    }
    const prevOpen = prev.expanded[prev.entry.path] === true;
    const nextOpen = next.expanded[next.entry.path] === true;
    if (prevOpen !== nextOpen) return false;
    if (!nextOpen) {
      // Closed: render doesn't depend on the maps at all.
      return true;
    }
    // Open: subtree may have changed. Map identity is the conservative check
    // — we only get a new ref when something actually mutated.
    return (
      prev.expanded === next.expanded && prev.childStates === next.childStates
    );
  },
);

function ChildList({
  state,
  depth,
  expanded,
  childStates,
  onActivate,
  onPrefetch,
  onAttach,
  onContextMenu,
  activePath,
  contextPath,
}: {
  state: DirState;
  depth: number;
  expanded: Record<string, boolean>;
  childStates: Record<string, DirState>;
  onActivate: (entry: FsEntry) => void;
  onPrefetch: (entry: FsEntry) => void;
  onAttach: (entry: FsEntry) => void;
  onContextMenu: (event: React.MouseEvent, entry: FsEntry) => void;
  activePath: string | null;
  contextPath: string | null;
}) {
  if (state.status === "loading") {
    // Render nothing during the prefetch window — a brief gap reads as
    // instant; a "Loading…" pill flashes on every expand and feels laggy.
    return null;
  }
  if (state.status === "error") {
    return (
      <p
        className="px-2 py-0.5 text-[10px] text-red-300"
        style={{ paddingLeft: 8 + depth * 12 + 18 }}
      >
        {state.reason}
      </p>
    );
  }
  if (state.entries.length === 0) {
    return (
      <p
        className="px-2 py-0.5 text-[10px] text-muted-foreground"
        style={{ paddingLeft: 8 + depth * 12 + 18 }}
      >
        Empty
      </p>
    );
  }
  return (
    <ul>
      {state.entries.map((entry) => (
        <TreeNode
          key={entry.path}
          entry={entry}
          depth={depth}
          expanded={expanded}
          childStates={childStates}
          onActivate={onActivate}
          onPrefetch={onPrefetch}
          onAttach={onAttach}
          onContextMenu={onContextMenu}
          activePath={activePath}
          contextPath={contextPath}
        />
      ))}
    </ul>
  );
}

function Empty({
  children,
  onContextMenu,
}: {
  children: React.ReactNode;
  onContextMenu?: React.MouseEventHandler;
}) {
  return (
    <p
      className="px-3 py-6 text-center text-xs text-muted-foreground"
      onContextMenu={onContextMenu}
    >
      {children}
    </p>
  );
}

function FileTreeContextMenu({
  state,
  entry,
  directoryPath,
  rootPath,
  onOpenChange,
  onOpenInEditor,
  onAttach,
  onCreate,
  onDelete,
}: {
  state: ContextMenuState | null;
  entry: FsEntry | null;
  directoryPath: string;
  rootPath: string | null;
  onOpenChange: (open: boolean) => void;
  onOpenInEditor: (entry: FsEntry) => void;
  onAttach: (entry: FsEntry) => void;
  onCreate: (dirPath: string, kind: "file" | "directory") => void;
  onDelete: (entry: FsEntry) => void;
}) {
  return (
    <Menu open={state?.open ?? false} onOpenChange={onOpenChange}>
      <MenuPopup
        anchor={state?.anchor}
        align="start"
        side="bottom"
        className="min-w-[190px]"
      >
        {entry?.kind === "file" && (
          <MenuItem onClick={() => onOpenInEditor(entry)}>
            <HugeiconsIcon icon={PencilEdit01Icon} className="size-4" />
            Open in editor
          </MenuItem>
        )}
        {entry !== null && (
          <MenuItem onClick={() => onAttach(entry)}>
            <HugeiconsIcon icon={BubbleChatIcon} className="size-4" />
            Attach to chat
          </MenuItem>
        )}
        {entry !== null && (
          <MenuItem
            onClick={() => {
              const path =
                rootPath === null ? entry.path : `${rootPath}/${entry.path}`;
              void navigator.clipboard?.writeText(path);
            }}
          >
            <HugeiconsIcon icon={Copy01Icon} className="size-4" />
            Copy path
          </MenuItem>
        )}
        {entry !== null && <MenuSeparator />}
        <MenuItem onClick={() => onCreate(directoryPath, "file")}>
          <HugeiconsIcon icon={FileAddIcon} className="size-4" />
          New File
        </MenuItem>
        <MenuItem onClick={() => onCreate(directoryPath, "directory")}>
          <HugeiconsIcon icon={FolderAddIcon} className="size-4" />
          New Folder
        </MenuItem>
        {entry !== null && (
          <>
            <MenuSeparator />
            <MenuItem
              onClick={() => onDelete(entry)}
              className="text-red-300 data-highlighted:bg-red-500/20 data-highlighted:text-red-200"
            >
              <HugeiconsIcon icon={Delete02Icon} className="size-4" />
              Delete
            </MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}

function DeleteConfirmDialog({
  entry,
  open,
  deleting,
  onOpenChange,
  onConfirm,
}: {
  entry: FsEntry | null;
  open: boolean;
  deleting: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const isDir = entry?.kind === "directory";
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
            <span className="font-mono text-foreground">{entry?.name}</span>{" "}
            will be permanently deleted. {detail} This cannot be undone.
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
