import { createContext, useContext } from "react";

import type { CodeAnnotation, FolderId, WorktreeId } from "@zuse/contracts";

import { cn } from "~/lib/utils";
import { useUiStore, type FileView } from "~/store/ui";
import { useWorkspaceStore } from "~/store/workspace";
import { useWorktreesStore } from "~/store/worktrees";
import { FileIcon } from "./file-icon.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip.tsx";

/**
 * Implicit workspace coordinates for the chips rendered inside a chat
 * surface. ChatView / ChatComposer wrap their subtree with this provider so
 * FileChip and FileBadge can open files in the editor tab without every
 * intermediate component threading the folder/worktree pair down by prop.
 */
const FileChipContext = createContext<{
  readonly folderId: FolderId | null;
  readonly worktreeId: WorktreeId | null;
}>({ folderId: null, worktreeId: null });

export function FileChipProvider({
  folderId,
  worktreeId,
  children,
}: {
  folderId: FolderId | null;
  worktreeId: WorktreeId | null;
  children: React.ReactNode;
}) {
  return (
    <FileChipContext.Provider value={{ folderId, worktreeId }}>
      {children}
    </FileChipContext.Provider>
  );
}

export const useFileChipContext = () => useContext(FileChipContext);

export const basename = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
};

export type FileOpenTarget = Parameters<
  ReturnType<typeof useUiStore.getState>["openFileInTab"]
>[0];

export const resolveFileOpenTarget = ({
  relPath,
  absPath,
  kind = "file",
  folderId,
  worktreeId,
  folderPath,
  worktreePath,
  view,
}: {
  readonly relPath: string;
  readonly absPath?: string;
  readonly kind?: "file" | "directory";
  readonly folderId: FolderId | null;
  readonly worktreeId: WorktreeId | null;
  readonly folderPath: string | null;
  readonly worktreePath: string | null;
  readonly view?: FileView;
}): FileOpenTarget | null => {
  const name = basename(relPath);
  const rootPath = worktreePath ?? folderPath;
  const looksAbsolute = absPath !== undefined || relPath.startsWith("/");
  const resolvedAbs = absPath ?? (relPath.startsWith("/") ? relPath : null);
  const insideWorkspace =
    rootPath !== null &&
    resolvedAbs !== null &&
    (resolvedAbs === rootPath || resolvedAbs.startsWith(`${rootPath}/`));
  const workspaceRelPath =
    insideWorkspace && resolvedAbs !== null && rootPath !== null
      ? resolvedAbs.slice(rootPath.length + 1)
      : !looksAbsolute
        ? relPath
        : null;

  if (kind !== "file") return null;
  if (folderId !== null && workspaceRelPath !== null) {
    return {
      kind: "text",
      folderId,
      path: workspaceRelPath,
      name,
      worktreeId,
      view,
    };
  }
  if (resolvedAbs !== null && !insideWorkspace) {
    return { kind: "external", absPath: resolvedAbs, name, view };
  }
  return null;
};

const annotationRangeLabel = (a: CodeAnnotation): string =>
  a.startLine === a.endLine ? `${a.startLine}` : `${a.startLine}-${a.endLine}`;

export function AnnotationFileChip({
  annotation,
  className,
}: {
  readonly annotation: CodeAnnotation;
  readonly className?: string;
}) {
  const name = basename(annotation.relPath);
  const range = annotationRangeLabel(annotation);

  return (
    <span
      className={cn(
        "inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-[0.375rem] border border-border/45 bg-[var(--chip-bg)] px-1.5 py-0.5 text-[11px] text-foreground/90 dark:shadow-[inset_0_1px_0_color-mix(in_oklch,white_4%,transparent),0_1px_2px_color-mix(in_oklch,black_22%,transparent)]",
        className,
      )}
      title={`${annotation.relPath}:${range}`}
    >
      <FileIcon
        name={name}
        kind="file"
        className="inline-flex size-3.5 shrink-0 items-center justify-center"
      />
      <span className="min-w-0 truncate font-mono">{name}</span>
      <span className="shrink-0 font-mono tabular-nums text-foreground/60">
        :{range}
      </span>
    </span>
  );
}

/**
 * Pill that pairs a file-type icon with a filename, plus a tooltip and
 * click-to-open. Single source of truth for every file/dir reference we
 * render — tool rows, chat-bubble file refs, composer chips. Clicking opens
 * the file in the right pane's file editor via `useUiStore.openFileInTab`.
 *
 * Directories render the same chip but with no click action — the file
 * editor doesn't preview directories.
 */
export function FileChip({
  relPath,
  absPath,
  kind = "file",
  view,
  diffStats,
  className,
}: {
  /** Path shown in the tooltip + used as the chip label (basename only). */
  readonly relPath: string;
  /**
   * Absolute path the editor will read. Optional — tool rows usually only
   * carry the absolute path the agent saw, so we fall back to it as the
   * `relPath` for display when the workspace-relative path isn't known.
   */
  readonly absPath?: string;
  readonly kind?: "file" | "directory";
  /**
   * Which body the file viewer should open with. Tool rows for Edit/Write/
   * MultiEdit pass `"diff"` so clicking the file goes straight to the
   * side-by-side diff; everything else defaults to the CodeMirror editor.
   */
  readonly view?: FileView;
  readonly diffStats?: { readonly added: number; readonly removed: number };
  readonly className?: string;
}) {
  const { folderId, worktreeId } = useFileChipContext();
  const openFileInTab = useUiStore((s) => s.openFileInTab);
  const folderPath = useWorkspaceStore((s) => {
    if (folderId === null) return null;
    return s.folders.find((f) => f.id === folderId)?.path ?? null;
  });
  const worktreePath = useWorktreesStore((s) => {
    if (folderId === null || worktreeId === null) return null;
    const list = s.byProject[folderId] ?? [];
    return list.find((w) => w.id === worktreeId)?.path ?? null;
  });

  // Resolve the chip's effective root + workspace-relative path. Tool rows
  // sometimes carry an absolute path from another checkout or sibling repo;
  // opening those would trigger
  // `FsPathOutsideError` on the server. Detect early, surface as a
  // non-clickable chip with an explanatory tooltip.
  const name = basename(relPath);
  const openTarget = resolveFileOpenTarget({
    relPath,
    absPath,
    kind,
    folderId,
    worktreeId,
    folderPath,
    worktreePath,
    view,
  });
  const canOpen = openTarget !== null;

  const tooltip =
    kind === "directory"
      ? `View ${relPath}`
      : canOpen
        ? `Open ${relPath}`
        : relPath;

  const onClick = () => {
    if (openTarget === null) return;
    openFileInTab(openTarget);
  };

  // Rendered as a `<span role="button">` rather than a real `<button>` so the
  // chip can sit inside parent buttons (e.g. ExpandableIconRow's collapsed
  // header). Nested <button> elements are invalid HTML and React throws a
  // hydration warning. We still wire keyboard activation (Enter / Space) so
  // a11y matches the button affordance.
  const onKeyDown = (e: React.KeyboardEvent<HTMLSpanElement>) => {
    if (!canOpen) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    }
  };
  const onChipClick = (e: React.MouseEvent<HTMLSpanElement>) => {
    if (!canOpen) return;
    // Stop the click from bubbling to a wrapping button (Read row's
    // accordion toggle) — clicking the chip should open the file, not
    // expand the row.
    e.preventDefault();
    e.stopPropagation();
    onClick();
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role={canOpen ? "button" : undefined}
            tabIndex={canOpen ? 0 : undefined}
            aria-disabled={!canOpen}
            onClick={canOpen ? onChipClick : undefined}
            onKeyDown={canOpen ? onKeyDown : undefined}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border border-border/45 bg-[var(--chip-bg)] px-1.5 py-0.5 text-[11px] text-foreground/90 transition-[background-color,color,box-shadow] dark:shadow-[inset_0_1px_0_color-mix(in_oklch,white_4%,transparent),0_1px_2px_color-mix(in_oklch,black_22%,transparent)]",
              canOpen
                ? "cursor-pointer hover:bg-[color-mix(in_oklch,var(--chip-bg)_80%,var(--foreground)_4%)] hover:text-foreground dark:hover:shadow-[inset_0_1px_0_color-mix(in_oklch,white_6%,transparent),0_2px_5px_color-mix(in_oklch,black_24%,transparent)]"
                : "cursor-default",
              className,
            )}
          >
            <FileIcon
              name={name}
              kind={kind}
              className="inline-flex size-3.5 shrink-0 items-center justify-center"
            />
            <span className="max-w-[28ch] truncate font-mono">{name}</span>
            {diffStats !== undefined && diffStats.added > 0 ? (
              <span className="shrink-0 font-mono tabular-nums text-emerald-400">
                +{diffStats.added}
              </span>
            ) : null}
            {diffStats !== undefined && diffStats.removed > 0 ? (
              <span className="shrink-0 font-mono tabular-nums text-red-400">
                -{diffStats.removed}
              </span>
            ) : null}
          </span>
        }
      />
      <TooltipPopup>{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
