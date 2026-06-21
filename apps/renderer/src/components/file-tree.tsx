import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons-pro/core-bulk-rounded";
import { Plus } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Effect } from "effect";

import type { FolderId, FsEntry } from "@memoize/wire";

import { getRpcClient } from "../lib/rpc-client.ts";
import {
  useActiveWorkspaceRoot,
  useActiveWorktreeId,
} from "../store/active-workspace.ts";
import { useComposerBridge } from "../store/composer-bridge.ts";
import { useUiStore } from "../store/ui.ts";
import { FileIcon } from "./file-icon.tsx";
import { Skeleton } from "./ui/skeleton.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip.tsx";

type DirState =
  | { status: "loading" }
  | { status: "ready"; entries: ReadonlyArray<FsEntry> }
  | { status: "error"; reason: string };

const formatError = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "_tag" in err) {
    return String((err as { _tag: unknown })._tag);
  }
  return String(err);
};

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

  // Mirror state into refs so callbacks can stay stable (and let memoized
  // children skip re-renders driven only by callback identity).
  const childStatesRef = useRef(childStates);
  childStatesRef.current = childStates;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

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
          client.fs.tree({ folderId, path: "", worktreeId }),
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
          client.fs.tree({ folderId, path, worktreeId }),
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

  const onPrefetch = useCallback(
    (entry: FsEntry) => {
      if (entry.kind !== "directory") return;
      void loadChild(entry.path);
    },
    [loadChild],
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
    return <Empty>{rootState.reason}</Empty>;
  }
  if (rootState.entries.length === 0) {
    return <Empty>Empty directory.</Empty>;
  }

  return (
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
          activePath={activePath}
        />
      ))}
    </ul>
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
  activePath: string | null;
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
    activePath,
  }: TreeNodeProps) {
    const isDir = entry.kind === "directory";
    const isOpen = isDir && expanded[entry.path] === true;
    const child = isOpen ? childStates[entry.path] : undefined;
    const chevron = isOpen ? ArrowDown01Icon : ArrowRight01Icon;
    const isActive = !isDir && activePath === entry.path;

    return (
      <li>
        <div
          className="group/row relative px-1.5"
          onMouseEnter={isDir ? () => onPrefetch(entry) : undefined}
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
                    <Plus className="size-3.5" strokeWidth={1.8} />
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
            activePath={activePath}
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
      prev.onAttach !== next.onAttach
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
  activePath,
}: {
  state: DirState;
  depth: number;
  expanded: Record<string, boolean>;
  childStates: Record<string, DirState>;
  onActivate: (entry: FsEntry) => void;
  onPrefetch: (entry: FsEntry) => void;
  onAttach: (entry: FsEntry) => void;
  activePath: string | null;
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
          activePath={activePath}
        />
      ))}
    </ul>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 py-6 text-center text-xs text-muted-foreground">
      {children}
    </p>
  );
}
