import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert01Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowTurnDownIcon,
  Loading02Icon,
  MinusSignIcon,
  Tick02Icon,
  UndoIcon,
  Upload01Icon,
} from "@hugeicons-pro/core-bulk-rounded";
import { Effect } from "effect";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";

import { UnresolvedFile } from "@pierre/diffs/react";
import type { MergeConflictResolution } from "@pierre/diffs";

import { classifyGit } from "../lib/git-rpc.ts";
import { UnifiedPatchDiff } from "./inline-diff.tsx";

import type {
  FolderId,
  GitChange,
  GitChangeKind,
  WorktreeId,
} from "@zuse/contracts";

import { getRpcClient } from "../lib/rpc-client.ts";
import { gitChangesKey, useGitChangesStore } from "../store/git-changes.ts";
import { gitStatusKey, useGitStatusStore } from "../store/git-status.ts";
import { prDetailsKey, usePrDetailsStore } from "../store/pr-details.ts";
import { prStateKey, usePrStateStore } from "../store/pr-state.ts";
import { useUiStore } from "../store/ui.ts";
import { GitInitCta } from "./git-init-cta.tsx";
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
import {
  Frame,
  FrameFooter,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "./ui/frame.tsx";

const basename = (path: string): string => {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
};

const dirname = (path: string): string => {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
};

/**
 * `gh pr view` doesn't tell us whether a PR file was added vs deleted vs
 * modified — only the line counts. Infer from the deltas: pure +N → added,
 * pure −N → deleted, both → modified. Used for the PR file rows' kind box.
 */
const prFileKind = (additions: number, deletions: number): GitChangeKind => {
  if (additions > 0 && deletions === 0) return "added";
  if (deletions > 0 && additions === 0) return "deleted";
  return "modified";
};

type RevertRequest =
  | { readonly type: "all" }
  | {
      readonly type: "file";
      readonly path: string;
      readonly kind: GitChangeKind;
      readonly oldPath: string | null;
    };

/**
 * Right-pane "Changes" tab. Combines the working-tree change list (with a
 * real commit composer at the bottom) and, when a PR is open, the PR's
 * files-changed list. Clicking any file opens it in the main file editor —
 * same flow as the file tree. Worktree-aware: every store lookup and RPC
 * call is keyed by `(folderId, worktreeId)` so a session running inside a
 * worktree sees its own branch's changes, not the main checkout.
 */
export function DiffPane({
  folderId,
  worktreeId,
}: {
  folderId: FolderId | null;
  worktreeId: WorktreeId | null;
}) {
  const status = useGitStatusStore((s) =>
    folderId ? (s.byKey[gitStatusKey(folderId, worktreeId)] ?? null) : null,
  );
  const pr = usePrStateStore((s) =>
    folderId ? (s.byKey[prStateKey(folderId, worktreeId)] ?? null) : null,
  );
  const prDetails = usePrDetailsStore((s) =>
    folderId ? (s.byKey[prDetailsKey(folderId, worktreeId)] ?? null) : null,
  );
  const changes = useGitChangesStore((s) =>
    folderId ? (s.byKey[gitChangesKey(folderId, worktreeId)] ?? null) : null,
  );
  const changesLoading = useGitChangesStore((s) =>
    folderId
      ? s.loadingByKey[gitChangesKey(folderId, worktreeId)] === true
      : false,
  );
  const changesError = useGitChangesStore((s) =>
    folderId
      ? (s.errorByKey[gitChangesKey(folderId, worktreeId)] ?? null)
      : null,
  );
  const changesErrorTag = useGitChangesStore((s) =>
    folderId
      ? (s.errorTagByKey[gitChangesKey(folderId, worktreeId)] ?? null)
      : null,
  );
  const refreshChanges = useGitChangesStore((s) => s.refresh);
  const refreshStatus = useGitStatusStore((s) => s.refresh);
  const refreshPrState = usePrStateStore((s) => s.refresh);
  const refreshPrDetails = usePrDetailsStore((s) => s.refresh);

  // Paths the user has unchecked for the next commit (see `committable` below).
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [revertRequest, setRevertRequest] = useState<RevertRequest | null>(
    null,
  );
  const [revertBusy, setRevertBusy] = useState(false);

  // Poll the working tree on the same 5s cadence the top bar uses for
  // `git status`, so the Changes tab stays in sync with the dirty-count badge.
  useEffect(() => {
    if (folderId === null) return;
    void refreshChanges(folderId, worktreeId);
    const id = window.setInterval(
      () => void refreshChanges(folderId, worktreeId),
      5000,
    );
    return () => window.clearInterval(id);
  }, [folderId, worktreeId, refreshChanges]);

  if (folderId === null) {
    return <Empty>Select a project to see its changes.</Empty>;
  }

  const refreshAll = async () => {
    await Promise.all([
      refreshChanges(folderId, worktreeId),
      refreshStatus(folderId, worktreeId),
      refreshPrState(folderId, worktreeId),
      refreshPrDetails(folderId, worktreeId),
    ]);
  };

  const conflicts = (changes ?? []).filter((c) => c.kind === "unmerged");
  const tracked = (changes ?? []).filter(
    (c) =>
      c.kind !== "untracked" && c.kind !== "ignored" && c.kind !== "unmerged",
  );
  const untracked = (changes ?? []).filter((c) => c.kind === "untracked");

  const prFiles = prDetails?.files ?? [];

  const requestRevertFile = (
    path: string,
    kind: GitChangeKind,
    oldPath?: string | null,
  ) => {
    setRevertRequest({
      type: "file",
      path,
      kind,
      oldPath: oldPath ?? null,
    });
  };

  const requestRevertAll = () => setRevertRequest({ type: "all" });

  const confirmRevert = async () => {
    const request = revertRequest;
    if (request === null || revertBusy) return;
    setRevertBusy(true);
    try {
      const client = await getRpcClient();
      if (request.type === "all") {
        await Effect.runPromise(client["git.revertAll"]({ folderId, worktreeId }));
      } else {
        await Effect.runPromise(
          client["git.revertFile"]({
            folderId,
            worktreeId,
            path: request.path,
            oldPath: request.oldPath,
            kind: request.kind,
          }),
        );
      }
      setRevertRequest(null);
      await refreshAll();
    } catch (err) {
      window.alert(`Couldn't revert: ${formatErr(err)}`);
    } finally {
      setRevertBusy(false);
    }
  };

  // Which files are included in the next commit. We track an *exclude* set
  // (paths the user unchecked) so newly-appeared files default to selected and
  // the selection survives the 5s poll without re-adding every path.
  const committable = [...tracked, ...untracked];
  const committablePaths = committable.map((c) => c.path);
  const selectedEntries = committable.filter((c) => !excluded.has(c.path));
  const selectedCount = selectedEntries.length;
  // The pathspec handed to `git commit` — renames need their old path too so
  // the deletion side of the move lands in the same commit.
  const commitPaths = selectedEntries.flatMap((c) =>
    c.oldPath !== null && c.oldPath !== c.path ? [c.path, c.oldPath] : [c.path],
  );
  const allSelected =
    committablePaths.length > 0 && selectedCount === committablePaths.length;
  const someSelected = selectedCount > 0 && !allSelected;

  const togglePath = (path: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const toggleAll = () =>
    setExcluded(allSelected ? new Set(committablePaths) : new Set());

  const onAfterCommit = async () => {
    setExcluded(new Set());
    await refreshAll();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-3 text-xs">
        {conflicts.length > 0 ? (
          <Section title="Conflicts" counter={conflicts.length} tone="warning">
            <p className="text-muted-foreground">
              Expand a file to resolve it inline — pick Ours, Theirs, or Both
              for each conflict — then commit.
            </p>
            <ul className="flex flex-col divide-y divide-border/45">
              {conflicts.map((c) => (
                <ConflictRow
                  key={c.path}
                  folderId={folderId}
                  worktreeId={worktreeId}
                  path={c.path}
                />
              ))}
            </ul>
          </Section>
        ) : null}

        <Section
          title="Uncommitted"
          counter={
            changesErrorTag === "GitNotARepoError" ||
            (changesLoading && changes === null)
              ? null
              : tracked.length + untracked.length
          }
          leading={
            committable.length > 0 ? (
              <CheckBox
                checked={allSelected}
                indeterminate={someSelected}
                onClick={toggleAll}
                title={allSelected ? "Deselect all" : "Select all"}
              />
            ) : null
          }
          action={
            committable.length > 0 ? (
              <button
                type="button"
                onClick={requestRevertAll}
                className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-destructive"
                title="Discard every uncommitted change"
              >
                <HugeiconsIcon
                  icon={UndoIcon}
                  className="size-2.5"
                  strokeWidth={2}
                />
                Revert all
              </button>
            ) : null
          }
        >
          {changesErrorTag === "GitNotARepoError" ? (
            <GitInitCta folderId={folderId} worktreeId={worktreeId} />
          ) : changesError !== null ? (
            <p className="text-destructive">
              Couldn't read git status: {changesError}
            </p>
          ) : changesLoading && changes === null ? (
            <Indicator title="Reading working tree…" />
          ) : tracked.length + untracked.length === 0 ? (
            <Indicator
              title={
                conflicts.length > 0 ? "No other changes" : "Working tree clean"
              }
              body={
                conflicts.length > 0
                  ? "Resolve the conflicts above to continue."
                  : "Nothing to commit."
              }
            />
          ) : (
            <ChangeList
              folderId={folderId}
              worktreeId={worktreeId}
              entries={committable}
              onRevert={requestRevertFile}
              isSelected={(path) => !excluded.has(path)}
              onToggleSelect={togglePath}
              expandable
            />
          )}
        </Section>

        {prFiles.length > 0 ? (
          <Section
            title={
              pr !== null && pr.number !== null
                ? `In PR #${pr.number}`
                : "In this PR"
            }
            counter={prFiles.length}
          >
            <ul className="flex flex-col divide-y divide-border/45">
              {prFiles.map((f) => (
                <FileRow
                  key={f.path}
                  folderId={folderId}
                  worktreeId={worktreeId}
                  path={f.path}
                  kind={prFileKind(f.additions, f.deletions)}
                  additions={f.additions}
                  deletions={f.deletions}
                />
              ))}
            </ul>
          </Section>
        ) : null}
      </div>

      <CommitComposer
        folderId={folderId}
        worktreeId={worktreeId}
        branch={status?.branch ?? null}
        ahead={status?.ahead ?? 0}
        paths={commitPaths}
        selectedCount={selectedCount}
        totalCount={committablePaths.length}
        canPush={(status?.ahead ?? 0) > 0}
        onAfterCommit={onAfterCommit}
        onAfterPush={refreshAll}
      />
      <RevertChangesDialog
        request={revertRequest}
        busy={revertBusy}
        onOpenChange={(open) => {
          if (!open && !revertBusy) setRevertRequest(null);
        }}
        onConfirm={() => void confirmRevert()}
      />
    </div>
  );
}

function ChangeList({
  folderId,
  worktreeId,
  entries,
  onRevert,
  isSelected,
  onToggleSelect,
  expandable = false,
}: {
  folderId: FolderId;
  worktreeId: WorktreeId | null;
  entries: ReadonlyArray<GitChange>;
  onRevert?: (
    path: string,
    kind: GitChangeKind,
    oldPath?: string | null,
  ) => void;
  isSelected?: (path: string) => boolean;
  onToggleSelect?: (path: string) => void;
  // When set, each row can expand to show its Pierre diff inline (working-tree
  // changes only), so the Changes tab is a proper review surface.
  expandable?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <ul className="flex flex-col divide-y divide-border/45">
        {entries.map((c) => (
          <FileRow
            key={c.path}
            folderId={folderId}
            worktreeId={worktreeId}
            path={c.path}
            oldPath={c.oldPath}
            kind={c.kind}
            expandable={expandable}
            onRevert={
              onRevert ? () => onRevert(c.path, c.kind, c.oldPath) : undefined
            }
            selected={isSelected ? isSelected(c.path) : undefined}
            onToggleSelect={
              onToggleSelect ? () => onToggleSelect(c.path) : undefined
            }
          />
        ))}
      </ul>
    </div>
  );
}

function RevertChangesDialog({
  request,
  busy,
  onOpenChange,
  onConfirm,
}: {
  request: RevertRequest | null;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const isFile = request?.type === "file";
  const isUntracked = isFile && request.kind === "untracked";
  const title =
    request?.type === "all"
      ? "Revert all changes?"
      : isUntracked
        ? "Delete untracked file?"
        : "Revert file changes?";
  const description =
    request?.type === "all"
      ? "This discards every uncommitted change and deletes untracked files. This cannot be undone."
      : isUntracked
        ? `"${basename(request.path)}" will be removed from disk. This cannot be undone.`
        : request !== null
          ? `Uncommitted changes in "${basename(request.path)}" will be discarded. This cannot be undone.`
          : "";
  const actionLabel =
    request?.type === "all"
      ? "Revert all"
      : isUntracked
        ? "Delete file"
        : "Revert file";

  return (
    <AlertDialog open={request !== null} onOpenChange={onOpenChange}>
      <AlertDialogPopup className="max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose
            render={
              <Button type="button" variant="ghost" disabled={busy}>
                Cancel
              </Button>
            }
          />
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "Reverting..." : actionLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function FileRow({
  folderId,
  worktreeId,
  path,
  oldPath,
  kind,
  additions,
  deletions,
  onRevert,
  selected,
  onToggleSelect,
  expandable = false,
}: {
  folderId: FolderId;
  worktreeId: WorktreeId | null;
  path: string;
  oldPath?: string | null;
  kind: GitChangeKind;
  additions?: number;
  deletions?: number;
  onRevert?: () => void;
  selected?: boolean;
  onToggleSelect?: () => void;
  expandable?: boolean;
}) {
  const openFileInTab = useUiStore((s) => s.openFileInTab);
  const [expanded, setExpanded] = useState(false);
  const renamed = oldPath !== null && oldPath !== undefined && oldPath !== path;
  const tooltip = renamed ? `${oldPath} → ${path}` : path;
  return (
    <li className="group flex flex-col">
      <div className="-mx-3 flex w-[calc(100%+1.5rem)] items-center gap-2 px-3 py-2 transition-colors hover:bg-muted/35">
        {expandable ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            title={expanded ? "Hide diff" : "Show diff"}
            aria-expanded={expanded}
          >
            <HugeiconsIcon
              icon={expanded ? ArrowDown01Icon : ArrowRight01Icon}
              className="size-3.5"
            />
          </button>
        ) : null}
        {onToggleSelect ? (
          <CheckBox
            checked={selected === true}
            onClick={onToggleSelect}
            title={selected ? "Exclude from commit" : "Include in commit"}
          />
        ) : null}
        <button
          type="button"
          onClick={() =>
            openFileInTab({
              kind: "text",
              folderId,
              worktreeId,
              path,
              name: basename(path),
              view: "diff",
            })
          }
          className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left"
          title={tooltip}
        >
          {renamed ? (
            <RenameLabel oldPath={oldPath!} newPath={path} />
          ) : (
            <PathLabel path={path} />
          )}
        </button>
        <span className="flex shrink-0 items-center gap-1.5">
          {typeof additions === "number" || typeof deletions === "number" ? (
            <span className="font-mono text-[11px]">
              {typeof additions === "number" && additions > 0 ? (
                <span className="text-success">+{additions}</span>
              ) : null}
              {typeof additions === "number" &&
              typeof deletions === "number" &&
              additions > 0 &&
              deletions > 0
                ? " "
                : null}
              {typeof deletions === "number" && deletions > 0 ? (
                <span className="text-destructive">−{deletions}</span>
              ) : null}
            </span>
          ) : null}
          {onRevert ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRevert();
              }}
              className="flex size-[14px] shrink-0 items-center justify-center rounded-[3px] text-muted-foreground opacity-0 transition hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
              title={
                kind === "untracked"
                  ? "Delete this untracked file"
                  : "Revert changes to this file"
              }
            >
              <HugeiconsIcon
                icon={UndoIcon}
                className="size-3"
                strokeWidth={2}
              />
            </button>
          ) : null}
          <KindBox kind={kind} />
        </span>
      </div>
      {expandable && expanded ? (
        <div className="mb-2 ml-4 overflow-hidden rounded-md border border-border/50">
          <InlineFileDiff
            folderId={folderId}
            worktreeId={worktreeId}
            path={path}
          />
        </div>
      ) : null}
    </li>
  );
}

type InlineDiffState =
  | { status: "loading" }
  | { status: "empty"; note: string }
  | { status: "ready"; patch: string }
  | { status: "error"; reason: string };

/**
 * Lazily fetches a working-tree file's unified diff and renders it inline in
 * the Changes tab through the shared `@pierre/diffs` viewer (`UnifiedPatchDiff`)
 * — the same renderer used by the chat timeline and the file-editor Diff tab.
 */
function InlineFileDiff({
  folderId,
  worktreeId,
  path,
}: {
  folderId: FolderId;
  worktreeId: WorktreeId | null;
  path: string;
}) {
  const [state, setState] = useState<InlineDiffState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void (async () => {
      const client = await getRpcClient();
      const result = await classifyGit(
        client["git.diff"]({ folderId, worktreeId, path }),
      );
      if (cancelled) return;
      if (!result.ok) {
        setState({ status: "error", reason: result.message });
        return;
      }
      const { mode, patch } = result.value;
      if (mode === "binary") {
        setState({ status: "empty", note: "Binary file — no preview." });
      } else if (mode === "unchanged" || patch.length === 0) {
        setState({ status: "empty", note: "No textual change." });
      } else {
        setState({ status: "ready", patch });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [folderId, worktreeId, path]);

  if (state.status === "loading") {
    return (
      <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
        Loading diff…
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="px-2 py-1.5 text-[11px] text-destructive">
        {state.reason}
      </div>
    );
  }
  if (state.status === "empty") {
    return (
      <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
        {state.note}
      </div>
    );
  }
  return <UnifiedPatchDiff path={path} patch={state.patch} />;
}

/**
 * A single unmerged file in the Conflicts section. Expands to an inline
 * `@pierre/diffs` `UnresolvedFile` — Pierre's conflict resolver with built-in
 * Ours / Theirs / Both actions per conflict. Resolving the last conflict writes
 * the marker-free file and `git add`s it via `git.resolveConflict`, so the row
 * leaves the unmerged state.
 */
function ConflictRow({
  folderId,
  worktreeId,
  path,
}: {
  folderId: FolderId;
  worktreeId: WorktreeId | null;
  path: string;
}) {
  const openFileInTab = useUiStore((s) => s.openFileInTab);
  const [expanded, setExpanded] = useState(false);
  return (
    <li className="group flex flex-col">
      <div className="-mx-3 flex w-[calc(100%+1.5rem)] items-center gap-2 px-3 py-2 transition-colors hover:bg-muted/35">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
          title={expanded ? "Hide conflict" : "Resolve conflict"}
          aria-expanded={expanded}
        >
          <HugeiconsIcon
            icon={expanded ? ArrowDown01Icon : ArrowRight01Icon}
            className="size-3.5"
          />
        </button>
        <button
          type="button"
          onClick={() =>
            openFileInTab({
              kind: "text",
              folderId,
              worktreeId,
              path,
              name: basename(path),
              view: "diff",
            })
          }
          className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left"
          title={path}
        >
          <PathLabel path={path} />
        </button>
        <KindBox kind="unmerged" />
      </div>
      {expanded ? (
        <div className="mb-2 ml-4 overflow-hidden rounded-md border border-border/50">
          <ConflictBody
            folderId={folderId}
            worktreeId={worktreeId}
            path={path}
          />
        </div>
      ) : null}
    </li>
  );
}

type ConflictState =
  | { status: "loading" }
  | { status: "unsupported"; note: string }
  | { status: "error"; reason: string }
  | { status: "ready"; contents: string };

function ConflictBody({
  folderId,
  worktreeId,
  path,
}: {
  folderId: FolderId;
  worktreeId: WorktreeId | null;
  path: string;
}) {
  const [state, setState] = useState<ConflictState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void (async () => {
      try {
        const client = await getRpcClient();
        const file = await Effect.runPromise(
          client["fs.readFile"]({ folderId, path, worktreeId }),
        );
        if (cancelled) return;
        if (file.kind !== "text") {
          setState({
            status: "unsupported",
            note: "Binary file — resolve it manually.",
          });
          return;
        }
        setState({ status: "ready", contents: file.content });
      } catch (err) {
        if (cancelled) return;
        setState({
          status: "error",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [folderId, worktreeId, path]);

  if (state.status === "loading") {
    return (
      <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
        Loading conflict…
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="px-2 py-1.5 text-[11px] text-destructive">
        {state.reason}
      </div>
    );
  }
  if (state.status === "unsupported") {
    return (
      <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
        {state.note}
      </div>
    );
  }

  return (
    <div className="fz-diff overflow-auto" style={{ maxHeight: 480 }}>
      <UnresolvedFile
        file={{ name: basename(path), contents: state.contents }}
        disableWorkerPool
        renderMergeConflictUtility={(action, getInstance) => {
          const apply = (resolution: MergeConflictResolution) => {
            const inst = getInstance();
            if (inst === undefined) return;
            const res = inst.resolveConflict(action.conflictIndex, resolution);
            if (res === undefined) return;
            // Re-render the conflict UI with the resolved side applied.
            inst.render({
              file: res.file,
              actions: res.actions,
              markerRows: res.markerRows,
            });
            // When every conflict in the file is resolved, persist + stage.
            if (res.actions.filter(Boolean).length === 0) {
              void (async () => {
                const client = await getRpcClient();
                await Effect.runPromise(
                  client["git.resolveConflict"]({
                    folderId,
                    worktreeId,
                    path,
                    contents: res.file.contents,
                  }),
                );
                void useGitChangesStore
                  .getState()
                  .refresh(folderId, worktreeId);
              })();
            }
          };
          return (
            <div className="flex items-center gap-1 p-1">
              <ConflictActionButton onClick={() => apply("current")}>
                Ours
              </ConflictActionButton>
              <ConflictActionButton onClick={() => apply("incoming")}>
                Theirs
              </ConflictActionButton>
              <ConflictActionButton onClick={() => apply("both")}>
                Both
              </ConflictActionButton>
            </div>
          );
        }}
      />
    </div>
  );
}

function ConflictActionButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-sm border border-border/70 bg-background px-2 py-0.5 text-[11px] text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
    >
      {children}
    </button>
  );
}

function PathLabel({ path }: { path: string }) {
  const dir = dirname(path);
  return (
    <span className="flex min-w-0 items-baseline font-mono text-xs">
      {dir.length > 0 ? (
        <span className="truncate text-muted-foreground">{dir}/</span>
      ) : null}
      <span className="shrink-0 text-foreground">{basename(path)}</span>
    </span>
  );
}

/**
 * Renders an "old → new" label for a renamed file. Collapses the unchanged
 * path prefix where possible so a `src/foo/bar.ts → src/foo/baz.ts` rename
 * only shows the part that actually moved (`bar.ts → baz.ts`), with the
 * shared parent directory faded after.
 */
function RenameLabel({
  oldPath,
  newPath,
}: {
  oldPath: string;
  newPath: string;
}) {
  const oldDir = dirname(oldPath);
  const newDir = dirname(newPath);
  const oldName = basename(oldPath);
  const newName = basename(newPath);
  const sameDir = oldDir === newDir;
  return (
    <>
      <span className="flex min-w-0 items-baseline gap-1 truncate font-mono text-xs text-foreground">
        <span className="truncate">{oldName}</span>
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          className="size-3 shrink-0 text-muted-foreground"
        />
        <span className="truncate">{newName}</span>
      </span>
      <span className="truncate font-mono text-[11px] text-muted-foreground">
        {sameDir
          ? newDir
          : `${oldDir.length > 0 ? oldDir : "."} → ${newDir.length > 0 ? newDir : "."}`}
      </span>
    </>
  );
}

/**
 * Square 14×14 status box: green `+` for additions, warm red `−` for
 * deletions, amber dot for "both" (modified / renamed / copied / type
 * changed), warm red `!` for unmerged. Mirrors the look of GitHub's diff
 * gutter so the file kind reads at a glance without a letter to decode.
 */
function KindBox({ kind }: { kind: GitChangeKind }) {
  switch (kind) {
    case "added":
    case "untracked":
      return (
        <Box tone="emerald">
          <Plus className="size-2.5" strokeWidth={2} />
        </Box>
      );
    case "deleted":
      return (
        <Box tone="rose">
          <HugeiconsIcon
            icon={MinusSignIcon}
            className="size-2.5"
            strokeWidth={3}
          />
        </Box>
      );
    case "modified":
    case "type_changed":
    case "renamed":
    case "copied":
      return (
        <Box tone="amber">
          <span className="size-1 rounded-full bg-current" />
        </Box>
      );
    case "unmerged":
      return (
        <Box tone="rose">
          <HugeiconsIcon
            icon={Alert01Icon}
            className="size-2.5"
            strokeWidth={2.5}
          />
        </Box>
      );
    case "ignored":
      return (
        <Box tone="zinc">
          <span className="size-1 rounded-full bg-current" />
        </Box>
      );
  }
}

const BOX_TONE: Record<"emerald" | "rose" | "amber" | "zinc", string> = {
  emerald: "border-success text-success",
  rose: "border-destructive text-destructive",
  amber: "border-warning text-warning",
  zinc: "border-muted-foreground text-muted-foreground",
};

function Box({
  tone,
  children,
}: {
  tone: keyof typeof BOX_TONE;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`flex size-[14px] shrink-0 items-center justify-center rounded-[3px] border ${BOX_TONE[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * Small square checkbox used to pick which files go into the commit. Filled
 * monochrome (foreground) when checked, a dash when the header box is in the
 * "some selected" indeterminate state.
 */
function CheckBox({
  checked,
  indeterminate,
  onClick,
  title,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onClick: () => void;
  title?: string;
}) {
  const on = checked || indeterminate === true;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`flex size-[13px] shrink-0 items-center justify-center rounded-[3px] border transition-colors ${
        on
          ? "border-foreground bg-foreground text-background"
          : "border-muted-foreground/50 text-transparent hover:border-foreground"
      }`}
    >
      {indeterminate ? (
        <HugeiconsIcon
          icon={MinusSignIcon}
          className="size-2"
          strokeWidth={3.5}
        />
      ) : (
        <HugeiconsIcon icon={Tick02Icon} className="size-2" strokeWidth={3.5} />
      )}
    </button>
  );
}

/**
 * Commit composer modeled on GitHub Desktop's bottom-of-pane control: branch
 * indicator, an upstream/Push button, the message input, and a "Commit" CTA.
 * Only the files checked in the list (`paths`) are staged + committed, so the
 * user controls exactly what goes into each commit.
 */
function CommitComposer({
  folderId,
  worktreeId,
  branch,
  ahead,
  paths,
  selectedCount,
  totalCount,
  canPush,
  onAfterCommit,
  onAfterPush,
}: {
  folderId: FolderId;
  worktreeId: WorktreeId | null;
  branch: string | null;
  ahead: number;
  paths: ReadonlyArray<string>;
  selectedCount: number;
  totalCount: number;
  canPush: boolean;
  onAfterCommit: () => Promise<void>;
  onAfterPush: () => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<null | "commit" | "push">(null);
  const [error, setError] = useState<string | null>(null);

  const canCommit = selectedCount > 0;

  const onCommit = async () => {
    const trimmed = message.trim();
    if (trimmed.length === 0 || !canCommit || busy !== null) return;
    setBusy("commit");
    setError(null);
    try {
      const client = await getRpcClient();
      await Effect.runPromise(
        client["git.commit"]({ folderId, worktreeId, message: trimmed, paths }),
      );
      setMessage("");
      await onAfterCommit();
    } catch (err) {
      setError(formatErr(err));
    } finally {
      setBusy(null);
    }
  };

  const onPush = async () => {
    if (busy !== null) return;
    setBusy("push");
    setError(null);
    try {
      const client = await getRpcClient();
      await Effect.runPromise(client["git.push"]({ folderId, worktreeId }));
      await onAfterPush();
    } catch (err) {
      setError(formatErr(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="shrink-0 border-t border-border bg-background/20 p-2">
      <Frame>
        <FrameHeader className="flex-row items-center justify-between gap-2 px-3 py-2">
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="truncate font-mono text-foreground">
              {branch ?? "(detached)"}
            </span>
            {ahead > 0 ? (
              <span className="font-mono text-[10px] text-info">↑{ahead}</span>
            ) : null}
          </span>
          <button
            type="button"
            onClick={onPush}
            disabled={!canPush || busy !== null}
            className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            title={
              canPush
                ? "Push commits to origin"
                : "No commits ahead of upstream"
            }
          >
            {busy === "push" ? (
              <HugeiconsIcon
                icon={Loading02Icon}
                className="size-3 animate-spin"
              />
            ) : (
              <HugeiconsIcon icon={Upload01Icon} className="size-3" />
            )}
            Push
          </button>
        </FrameHeader>
        <FramePanel className="p-0">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void onCommit();
              }
            }}
            placeholder="Commit message"
            rows={2}
            disabled={!canCommit || busy === "commit"}
            className="block min-h-16 w-full resize-none rounded-md bg-transparent px-3 py-2 font-mono text-[11px] leading-5 text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
          />
        </FramePanel>
        <FrameFooter className="flex flex-row items-center justify-between gap-2 px-3 py-2">
          <span className="min-w-0 truncate text-[10px] text-muted-foreground">
            {error !== null ? (
              <span className="text-destructive">{error}</span>
            ) : totalCount === 0 ? (
              <>Nothing to commit</>
            ) : (
              <>
                {selectedCount} of {totalCount} selected · ⌘↵
              </>
            )}
          </span>
          <button
            type="button"
            onClick={onCommit}
            disabled={
              !canCommit || message.trim().length === 0 || busy === "commit"
            }
            className="flex shrink-0 items-center gap-1.5 rounded-sm bg-success/15 px-2 py-1 text-[11px] font-medium text-success transition-colors hover:bg-success/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy === "commit" ? (
              <HugeiconsIcon
                icon={Loading02Icon}
                className="size-3 animate-spin"
              />
            ) : (
              <HugeiconsIcon icon={ArrowTurnDownIcon} className="size-3" />
            )}
            {selectedCount > 0 ? `Commit ${selectedCount}` : "Commit"}
          </button>
        </FrameFooter>
      </Frame>
    </div>
  );
}

const formatErr = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "reason" in err) {
    return String((err as { reason: unknown }).reason);
  }
  if (typeof err === "object" && err !== null && "_tag" in err) {
    return String((err as { _tag: unknown })._tag);
  }
  return String(err);
};

function Section({
  title,
  counter,
  tone,
  leading,
  action,
  children,
}: {
  title: string;
  counter?: number | null;
  tone?: "warning";
  leading?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Frame>
      <FrameHeader className="flex-row items-center justify-between gap-2 px-3 py-2">
        <FrameTitle
          className={`flex items-center gap-1.5 text-[10px] uppercase tracking-wide ${
            tone === "warning" ? "text-warning" : "text-muted-foreground"
          }`}
        >
          {leading ?? null}
          {tone === "warning" ? (
            <HugeiconsIcon
              icon={Alert01Icon}
              className="size-3"
              strokeWidth={2.5}
            />
          ) : null}
          {title}
          {typeof counter === "number" ? (
            <span className="font-mono text-[10px] text-muted-foreground">
              {counter}
            </span>
          ) : null}
        </FrameTitle>
        {action ?? null}
      </FrameHeader>
      <FramePanel className="p-0">
        <div className="flex flex-col gap-2 px-3 py-2">{children}</div>
      </FramePanel>
    </Frame>
  );
}

function Indicator({ title, body }: { title: string; body?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-medium text-foreground">{title}</span>
      {body !== undefined ? (
        <span className="text-muted-foreground">{body}</span>
      ) : null}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 py-6 text-center text-xs text-muted-foreground">
      {children}
    </p>
  );
}
