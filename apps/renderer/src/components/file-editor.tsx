import { PatchDiff } from "@pierre/diffs/react";
import type {
  AnnotationSide,
  DiffLineAnnotation,
  SelectedLineRange,
} from "@pierre/diffs";
import { Effect } from "effect";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CodeAnnotation, GitDiffResult } from "@zuse/contracts";

import { cn } from "~/lib/utils";
import { ShimmerText } from "~/components/ui/shimmer-text";
import { classifyGit } from "../lib/git-rpc.ts";
import {
  bytesForImageContent,
  imageMimeForFile,
} from "../lib/image-preview.ts";
import { getRpcClient } from "../lib/rpc-client.ts";
import { GitInitCta } from "./git-init-cta.tsx";
import {
  clearAnnotationRevealInEditor,
  createEditor,
  languageCompartment,
  reconfigureEditorKeymap,
  scrollAnnotationIntoView,
  setAnnotationsInEditor,
} from "../lib/codemirror/setup.ts";
import { languageForFile } from "../lib/codemirror/languages.ts";
import { useActiveWorkspaceRoot } from "../store/active-workspace.ts";
import { useAnnotationsStore } from "../store/annotations.ts";
import { useKeybindingsStore } from "../store/keybindings.ts";
import { useSessionsStore } from "../store/sessions.ts";
import {
  isPreviewableFileName,
  useUiStore,
  type FileView,
  type OpenFile,
} from "../store/ui.ts";
import {
  ANNOTATION_WIDGET_DELETE,
  ANNOTATION_WIDGET_SAVE,
  type AnnotationWidgetDeleteDetail,
  type AnnotationWidgetSaveDetail,
} from "../lib/codemirror/annotation-reveal.ts";
import {
  measureAnnotationSelection,
  type PendingSelection,
} from "../lib/codemirror/annotation-selection.ts";
import { AnnotateOverlay } from "./annotation/annotate-overlay.tsx";
import { useAddAnnotation } from "./annotation/use-add-annotation.ts";
import { MarkdownBody } from "./markdown-body.tsx";

import type { EditorView } from "@codemirror/view";

type EditorState =
  | { status: "loading" }
  | { status: "text"; size: number }
  | { status: "binary"; size: number }
  | { status: "error"; reason: string };

type PreviewKind = "markdown" | "html";

type PreviewState =
  | { status: "loading" }
  | { status: "ready"; kind: PreviewKind; content: string; baseHref: string }
  | { status: "binary"; size: number }
  | { status: "error"; reason: string };

const isCodeAnnotation = (annotation: unknown): annotation is CodeAnnotation =>
  typeof annotation === "object" &&
  annotation !== null &&
  "relPath" in annotation &&
  "startLine" in annotation &&
  !("_tag" in annotation);

const formatError = (err: unknown): string => {
  if (typeof err === "object" && err !== null && "_tag" in err) {
    const tag = String((err as { _tag: unknown })._tag);
    if (tag === "FsPathOutsideError") {
      const p =
        "path" in (err as Record<string, unknown>)
          ? String((err as unknown as { path: unknown }).path)
          : null;
      return p === null
        ? "This file is outside the current project."
        : `This file is outside the current project (${p}).`;
    }
    if (err instanceof Error) return err.message;
    return tag;
  }
  if (err instanceof Error) return err.message;
  return String(err);
};

const tagOf = (err: unknown): string | null =>
  typeof err === "object" && err !== null && "_tag" in err
    ? String((err as { _tag: unknown })._tag)
    : null;

const previewKindForFile = (name: string): PreviewKind | null => {
  const lower = name.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (
    lower.endsWith(".md") ||
    lower.endsWith(".markdown") ||
    lower.endsWith(".mdown") ||
    lower.endsWith(".mkd")
  ) {
    return "markdown";
  }
  return null;
};

const dirname = (path: string): string => {
  const idx = path.lastIndexOf("/");
  if (idx === -1) return "";
  if (idx === 0) return "/";
  return path.slice(0, idx);
};

const joinPath = (base: string, rel: string): string =>
  base.endsWith("/") ? `${base}${rel}` : `${base}/${rel}`;

const fileUrlForDirectory = (dir: string): string => {
  const normalized = dir.endsWith("/") ? dir : `${dir}/`;
  const segments = normalized
    .split("/")
    .map((segment) => (segment === "" ? "" : encodeURIComponent(segment)));
  return `file://${segments.join("/")}`;
};

const escapeHtmlAttribute = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const htmlWithBaseHref = (html: string, baseHref: string): string => {
  const base = `<base href="${escapeHtmlAttribute(baseHref)}">`;
  if (/<head(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(?:\s[^>]*)?>/i, (match) => `${match}${base}`);
  }
  return `${base}${html}`;
};

/**
 * Top-level shell for the file tab in the main pane. Renders a Toolbar with
 * the Diff | Edit segmented control and delegates the body to either a
 * CodeMirror editor or a side-by-side `@pierre/diffs` patch view. Both
 * bodies stay mounted across toggles so unsaved CodeMirror edits survive
 * a quick peek at the diff.
 */
export function FileEditor() {
  const openFile = useUiStore((s) => s.openFile);
  const closeFileTab = useUiStore((s) => s.closeFileTab);

  if (openFile === null) {
    return <Placeholder>No file open.</Placeholder>;
  }

  if (openFile.kind === "image") {
    return <ImageBody src={openFile.src} name={openFile.name} />;
  }

  if (imageMimeForFile(openFile.name) !== null) {
    return <FileImageBody openFile={openFile} />;
  }

  const canPreview = isPreviewableFileName(openFile.name);
  // External files have no git/folder context, so they're edit/preview only.
  const isExternal = openFile.kind === "external";
  const view =
    (openFile.view === "preview" && !canPreview) ||
    (openFile.view === "diff" && isExternal)
      ? "edit"
      : openFile.view;
  const path = isExternal ? openFile.absPath : openFile.path;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar
        path={path}
        view={view}
        showDiff={!isExternal}
        showPreview={canPreview}
      />
      <CodeMirrorBody
        openFile={openFile}
        hidden={view !== "edit"}
        onClose={closeFileTab}
      />
      {openFile.kind === "text" && view === "diff" ? (
        <DiffViewBody openFile={openFile} />
      ) : null}
      {view === "preview" ? <PreviewViewBody openFile={openFile} /> : null}
    </div>
  );
}

/**
 * Inline image preview — used for attachment screenshots so clicking the
 * thumbnail keeps the user inside the app rather than punting to the OS
 * handler. No toolbar, no read RPC; the privileged `zuse://` scheme
 * (see `apps/desktop/src/main.ts`) lets the renderer fetch the bytes
 * directly.
 */
function ImageBody({ src, name }: { src: string; name: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/40 p-4">
      <img
        src={src}
        alt={name}
        className="max-h-full max-w-full object-contain"
      />
    </div>
  );
}

type FileImageState =
  | { status: "loading" }
  | { status: "ready"; src: string }
  | { status: "error"; reason: string };

/** Loads project and external images through the same path-validated fs RPC
 * as the editor, then gives the browser a short-lived local object URL. */
function FileImageBody({ openFile }: { openFile: EditableFile }) {
  const [state, setState] = useState<FileImageState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ status: "loading" });

    void (async () => {
      try {
        const client = await getRpcClient();
        const result =
          openFile.kind === "external"
            ? await Effect.runPromise(
                client["fs.readExternalFile"]({ path: openFile.absPath }),
              )
            : await Effect.runPromise(
                client["fs.readFile"]({
                  folderId: openFile.folderId,
                  path: openFile.path,
                  worktreeId: openFile.worktreeId,
                }),
              );
        if (cancelled) return;
        const mimeType = imageMimeForFile(openFile.name);
        if (mimeType === null) return;
        const bytes = bytesForImageContent(result);
        objectUrl = URL.createObjectURL(
          new Blob([bytes.slice().buffer], { type: mimeType }),
        );
        setState({ status: "ready", src: objectUrl });
      } catch (err) {
        if (!cancelled) {
          setState({ status: "error", reason: formatError(err) });
        }
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [openFile]);

  if (state.status === "loading") {
    return (
      <Placeholder>
        <ShimmerText>Loading image…</ShimmerText>
      </Placeholder>
    );
  }
  if (state.status === "error") {
    return (
      <Placeholder>
        <span className="text-destructive">{state.reason}</span>
      </Placeholder>
    );
  }
  return <ImageBody src={state.src} name={openFile.name} />;
}

// ---------------------------------------------------------------------------
// CodeMirror body — loads a file via fs.readFile, mounts the editor once,
// swaps documents on file change. Cmd+S saves via fs.writeFile.
// ---------------------------------------------------------------------------

type EditableFile = Extract<OpenFile, { kind: "text" | "external" }>;

// Stable empty reference for the annotations selector. Returning a fresh
// `[]` literal from a zustand/`useSyncExternalStore` selector fails React's
// snapshot identity check every render → "getSnapshot should be cached" and
// an infinite update loop. One shared constant keeps the reference stable.
const EMPTY_ANNOTATIONS: ReadonlyArray<CodeAnnotation> = [];

function CodeMirrorBody({
  openFile,
  hidden,
  onClose,
}: {
  openFile: EditableFile;
  hidden: boolean;
  onClose: () => void;
}) {
  const setFileDirty = useUiStore((s) => s.setFileDirty);
  const [state, setState] = useState<EditorState>({ status: "loading" });
  const [conflict, setConflict] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);
  const [selection, setSelection] = useState<PendingSelection | null>(null);
  const [cardOpen, setCardOpen] = useState(false);
  const revealedAnnotation = useUiStore((s) => s.revealedAnnotation);
  const selectedSessionId = useSessionsStore((s) => s.selectedSessionId);
  const draftAnnotations = useAnnotationsStore((s) =>
    selectedSessionId === null
      ? EMPTY_ANNOTATIONS
      : (s.bySession[selectedSessionId] ?? EMPTY_ANNOTATIONS),
  );
  const selectedSessionIdRef = useRef(selectedSessionId);
  selectedSessionIdRef.current = selectedSessionId;
  const selectionRef = useRef<PendingSelection | null>(null);
  selectionRef.current = selection;
  const addAnnotation = useAddAnnotation();

  // The annotation target path: workspace-relative for project files, absolute
  // for external ones (matches `CodeAnnotation.relPath`).
  const workspaceRoot = useActiveWorkspaceRoot(
    openFile.kind === "text" ? openFile.folderId : null,
  );
  const annotationPath =
    openFile.kind === "external" ? openFile.absPath : openFile.path;
  const annotationAbsPath =
    openFile.kind === "external"
      ? openFile.absPath
      : workspaceRoot !== null
        ? `${workspaceRoot}/${openFile.path}`
        : openFile.path;
  const matchesRevealedAnnotation =
    revealedAnnotation !== null &&
    (revealedAnnotation.relPath === annotationPath ||
      revealedAnnotation.absPath === annotationAbsPath);
  const visibleAnnotations = useMemo(
    () =>
      draftAnnotations
        .filter(isCodeAnnotation)
        .filter(
          (a) =>
            a.relPath === annotationPath || a.absPath === annotationAbsPath,
        )
        .concat(
          matchesRevealedAnnotation && revealedAnnotation !== null
            ? draftAnnotations.some((a) => a.id === revealedAnnotation.id)
              ? []
              : [revealedAnnotation]
            : [],
        ),
    [
      annotationAbsPath,
      annotationPath,
      draftAnnotations,
      matchesRevealedAnnotation,
      revealedAnnotation,
    ],
  );

  // Mutable per-file working state. Refs so save/load callbacks stay stable
  // across keystrokes.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const docRef = useRef("");
  const baselineRef = useRef("");
  const mtimeRef = useRef("");
  const savingRef = useRef(false);
  const fileRef = useRef<EditableFile | null>(openFile);
  fileRef.current = openFile;

  const save = async () => {
    const file = fileRef.current;
    if (file === null) return;
    if (savingRef.current) return;
    if (docRef.current === baselineRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const client = await getRpcClient();
      const result =
        file.kind === "external"
          ? await Effect.runPromise(
              client["fs.writeExternalFile"]({
                path: file.absPath,
                content: docRef.current,
                expectedMtime: mtimeRef.current,
              }),
            )
          : await Effect.runPromise(
              client["fs.writeFile"]({
                folderId: file.folderId,
                path: file.path,
                content: docRef.current,
                expectedMtime: mtimeRef.current,
                worktreeId: file.worktreeId,
              }),
            );
      mtimeRef.current = result.mtime;
      baselineRef.current = docRef.current;
      setFileDirty(false);
      setConflict(null);
    } catch (err) {
      const tag = tagOf(err);
      if (tag === "FsConflictError" || tag === "FsExternalConflictError") {
        setConflict(
          "File changed on disk. Reload to discard your changes, or keep editing.",
        );
      } else {
        setSaveError(formatError(err));
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onAnnotationSave = (event: Event) => {
      const sessionId = selectedSessionIdRef.current;
      if (sessionId === null) return;
      const custom = event as CustomEvent<AnnotationWidgetSaveDetail>;
      useAnnotationsStore
        .getState()
        .updateComment(sessionId, custom.detail.id, custom.detail.comment);
    };
    const onAnnotationDelete = (event: Event) => {
      const sessionId = selectedSessionIdRef.current;
      if (sessionId === null) return;
      const custom = event as CustomEvent<AnnotationWidgetDeleteDetail>;
      useAnnotationsStore.getState().remove(sessionId, custom.detail.id);
    };
    el.addEventListener(ANNOTATION_WIDGET_SAVE, onAnnotationSave);
    el.addEventListener(ANNOTATION_WIDGET_DELETE, onAnnotationDelete);
    const onSave = () => void saveRef.current();
    const onAnnotate = () => {
      const current = selectionRef.current;
      if (current !== null) {
        setCardOpen(true);
        return;
      }
      const v = viewRef.current;
      if (v === null) return;
      measureAnnotationSelection(v, (sel) => {
        if (sel === null) return;
        setSelection(sel);
        setCardOpen(true);
      });
    };
    const view = createEditor({
      parent: el,
      doc: "",
      language: null,
      onSave,
      onChange: (doc) => {
        docRef.current = doc;
        useUiStore.getState().setFileDirty(doc !== baselineRef.current);
      },
      onSelect: (sel) => {
        setSelection(sel);
        // Collapsed selection (clicked away) dismisses the card too.
        if (sel === null) setCardOpen(false);
      },
      onAnnotate,
    });
    viewRef.current = view;

    const unsubKeybindings = useKeybindingsStore.subscribe(() => {
      reconfigureEditorKeymap(view, onSave, onAnnotate);
    });

    return () => {
      el.removeEventListener(ANNOTATION_WIDGET_SAVE, onAnnotationSave);
      el.removeEventListener(ANNOTATION_WIDGET_DELETE, onAnnotationDelete);
      unsubKeybindings();
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setFileDirty(false);
    setConflict(null);
    setSaveError(null);
    void (async () => {
      try {
        const client = await getRpcClient();
        const result =
          openFile.kind === "external"
            ? await Effect.runPromise(
                client["fs.readExternalFile"]({ path: openFile.absPath }),
              )
            : await Effect.runPromise(
                client["fs.readFile"]({
                  folderId: openFile.folderId,
                  path: openFile.path,
                  worktreeId: openFile.worktreeId,
                }),
              );
        if (cancelled) return;
        if (result.kind === "binary") {
          setState({ status: "binary", size: result.size });
          return;
        }
        baselineRef.current = result.content;
        docRef.current = result.content;
        mtimeRef.current = result.mtime;
        const view = viewRef.current;
        if (view !== null) {
          view.dispatch({
            changes: {
              from: 0,
              to: view.state.doc.length,
              insert: result.content,
            },
            effects: languageCompartment.reconfigure(
              languageForFile(openFile.name) ?? [],
            ),
            selection: { anchor: 0 },
            scrollIntoView: true,
          });
        }
        setState({ status: "text", size: result.size });
      } catch (err) {
        if (cancelled) return;
        setState({ status: "error", reason: formatError(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openFile, reloadCount, setFileDirty]);

  // The editor is created once (mount effect) while its container is still
  // hidden — during the initial file read, and whenever the tab opens in
  // diff view. CodeMirror constructed inside a `display:none` subtree
  // measures zero height and paints nothing; its ResizeObserver doesn't
  // reliably fire on the later none→visible transition. Force a re-measure
  // once the editor is both visible and populated so the content shows.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null || hidden || state.status !== "text") return;
    view.requestMeasure();
  }, [hidden, state.status]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null || state.status !== "text") return;
    if (visibleAnnotations.length === 0) {
      clearAnnotationRevealInEditor(view);
      return;
    }
    setAnnotationsInEditor(view, visibleAnnotations);
  }, [visibleAnnotations, state.status, openFile]);

  useEffect(() => {
    const view = viewRef.current;
    if (
      view === null ||
      state.status !== "text" ||
      !matchesRevealedAnnotation ||
      revealedAnnotation === null
    ) {
      return;
    }
    scrollAnnotationIntoView(view, revealedAnnotation);
  }, [
    matchesRevealedAnnotation,
    revealedAnnotation?.revealToken,
    state.status,
    openFile,
  ]);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      hidden={hidden}
      aria-hidden={hidden}
    >
      {(conflict || saveError) && (
        <Banner
          message={conflict ?? saveError ?? ""}
          actionLabel={conflict ? "Reload" : null}
          onAction={() => setReloadCount((n) => n + 1)}
          onDismiss={() => {
            setConflict(null);
            setSaveError(null);
          }}
        />
      )}
      <SavingIndicator saving={saving} />
      <div
        ref={containerRef}
        className="min-h-0 flex-1 overflow-hidden"
        hidden={state.status !== "text"}
      />
      {!hidden && state.status === "text" ? (
        <AnnotateOverlay
          selection={selection}
          relPath={annotationPath}
          absPath={annotationAbsPath}
          cardOpen={cardOpen}
          onCardOpenChange={setCardOpen}
          onConfirm={(draft) => {
            const created = addAnnotation(draft);
            if (created !== null) {
              useUiStore.getState().revealAnnotation(created);
            }
            // Collapse the selection so the affordance dismisses itself.
            const v = viewRef.current;
            if (v !== null) {
              v.dispatch({
                selection: { anchor: v.state.selection.main.head },
              });
            }
            setSelection(null);
            setCardOpen(false);
          }}
        />
      ) : null}
      {state.status === "loading" && (
        <Placeholder>
          <ShimmerText>Loading…</ShimmerText>
        </Placeholder>
      )}
      {state.status === "binary" && (
        <Placeholder>
          Binary file ({state.size.toLocaleString()} bytes) — preview not
          supported.
        </Placeholder>
      )}
      {state.status === "error" && (
        <Placeholder>
          <span className="text-destructive">{state.reason}</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded bg-muted px-2 py-1 text-xs hover:bg-muted/70"
          >
            Close
          </button>
        </Placeholder>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diff body — fetches `git.diff` for the current file and feeds the unified
// patch string to `@pierre/diffs` `PatchDiff`. Handles untracked/deleted/
// binary/unchanged states with placeholders so empty diffs don't surprise.
// ---------------------------------------------------------------------------

type DiffState =
  | { status: "loading" }
  | { status: "ready"; result: GitDiffResult }
  | { status: "error"; reason: string; noRepo: boolean };

/**
 * Inline comment editor injected into the diff via Pierre's `renderAnnotation`
 * slot. Sits directly under the selected line (no floating overlay / pixel
 * math). Enter (without shift) confirms; Escape cancels. The confirmed comment
 * lands in the composer annotation tray through the shared annotations store.
 */
function InlineAnnotationEditor({
  relPath,
  range,
  onConfirm,
  onCancel,
}: {
  relPath: string;
  range: { startLine: number; endLine: number; side: AnnotationSide } | null;
  onConfirm: (comment: string) => void;
  onCancel: () => void;
}) {
  const [comment, setComment] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);
  if (range === null) return null;
  const name = relPath.slice(relPath.lastIndexOf("/") + 1);
  const label =
    range.startLine === range.endLine
      ? `${range.startLine}`
      : `${range.startLine}-${range.endLine}`;
  const submit = () => {
    const trimmed = comment.trim();
    if (trimmed.length === 0) {
      onCancel();
      return;
    }
    onConfirm(trimmed);
  };
  return (
    <div className="m-1 rounded-lg border border-border/70 bg-popover p-2 shadow-lg">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="truncate font-medium text-foreground">{name}</span>
        <span className="tabular-nums">:{label}</span>
      </div>
      <textarea
        ref={textareaRef}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={2}
        placeholder="Add a comment…"
        className="max-h-32 min-h-14 w-full resize-y rounded-md bg-background/80 px-2 py-1.5 text-xs leading-relaxed text-foreground outline-none ring-0 placeholder:text-muted-foreground/70 focus:bg-background"
      />
      <div className="mt-1.5 flex items-center justify-end gap-1">
        <button
          type="button"
          onClick={onCancel}
          className="flex h-6 items-center rounded px-2 text-xs text-muted-foreground hover:bg-background hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={comment.trim().length === 0}
          className="flex h-6 items-center rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        >
          Add
        </button>
      </div>
    </div>
  );
}

function DiffViewBody({
  openFile,
}: {
  openFile: Extract<OpenFile, { kind: "text" }>;
}) {
  const [state, setState] = useState<DiffState>({ status: "loading" });
  // Bumped after an in-place `git init` from the no-repo CTA so the diff
  // re-fetches without the user toggling Edit/Diff to force a remount.
  const [reload, setReload] = useState(0);
  const addAnnotation = useAddAnnotation();
  const workspaceRoot = useActiveWorkspaceRoot(openFile.folderId);
  const annotationAbsPath =
    workspaceRoot !== null
      ? `${workspaceRoot}/${openFile.path}`
      : openFile.path;

  // Pierre-native line selection replaces the old shadow-DOM scraping: the
  // built-in gutter "+" reports a `SelectedLineRange`, and the pending comment
  // editor is injected inline on that line via `lineAnnotations` +
  // `renderAnnotation` (a clean slot, no floating overlay or pixel math).
  const [pending, setPending] = useState<{
    startLine: number;
    endLine: number;
    side: AnnotationSide;
  } | null>(null);

  const onGutterUtilityClick = useCallback((range: SelectedLineRange) => {
    setPending({
      startLine: Math.min(range.start, range.end),
      endLine: Math.max(range.start, range.end),
      side: range.side === "deletions" ? "deletions" : "additions",
    });
  }, []);

  const diffOptions = useMemo(
    () => ({
      enableLineSelection: true,
      enableGutterUtility: true,
      lineHoverHighlight: "number" as const,
      onGutterUtilityClick,
    }),
    [onGutterUtilityClick],
  );

  const lineAnnotations = useMemo<DiffLineAnnotation<{ kind: "editor" }>[]>(
    () =>
      pending === null
        ? []
        : [
            {
              side: pending.side,
              lineNumber: pending.endLine,
              metadata: { kind: "editor" },
            },
          ],
    [pending],
  );

  const renderAnnotation = useCallback(
    () => (
      <InlineAnnotationEditor
        relPath={openFile.path}
        range={pending}
        onCancel={() => setPending(null)}
        onConfirm={(comment) => {
          if (pending === null) return;
          addAnnotation({
            relPath: openFile.path,
            absPath: annotationAbsPath,
            startLine: pending.startLine,
            endLine: pending.endLine,
            comment,
          });
          setPending(null);
        }}
      />
    ),
    [addAnnotation, annotationAbsPath, openFile.path, pending],
  );

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void (async () => {
      const client = await getRpcClient();
      const result = await classifyGit(
        client["git.diff"]({
          folderId: openFile.folderId,
          worktreeId: openFile.worktreeId,
          path: openFile.path,
        }),
      );
      if (cancelled) return;
      if (result.ok) {
        setState({ status: "ready", result: result.value });
      } else {
        setState({
          status: "error",
          reason: result.message,
          noRepo: result.tag === "GitNotARepoError",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openFile.folderId, openFile.worktreeId, openFile.path, reload]);

  if (state.status === "loading") {
    return (
      <Placeholder>
        <ShimmerText>Loading diff…</ShimmerText>
      </Placeholder>
    );
  }
  if (state.status === "error") {
    if (state.noRepo) {
      return (
        <Placeholder>
          <GitInitCta
            compact
            folderId={openFile.folderId}
            worktreeId={openFile.worktreeId}
            onInitialized={() => setReload((n) => n + 1)}
          />
        </Placeholder>
      );
    }
    return (
      <Placeholder>
        <span className="text-destructive">{state.reason}</span>
      </Placeholder>
    );
  }

  const { mode, patch, truncated } = state.result;
  if (mode === "unchanged") {
    return <Placeholder>No changes vs HEAD.</Placeholder>;
  }
  if (mode === "binary") {
    return <Placeholder>Binary file — diff preview not supported.</Placeholder>;
  }
  if (patch.length === 0) {
    return <Placeholder>No diff content.</Placeholder>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {truncated ? (
        <Banner
          message="Diff truncated — file too large to render in full."
          actionLabel={null}
          onAction={() => {}}
          onDismiss={() => {}}
        />
      ) : null}
      <div className="fz-diff min-h-0 flex-1 overflow-auto">
        <PatchDiff
          patch={patch}
          options={diffOptions}
          lineAnnotations={lineAnnotations}
          renderAnnotation={renderAnnotation}
          disableWorkerPool
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview body — reads the saved file from disk and renders markdown / HTML.
// This deliberately ignores unsaved CodeMirror edits until the user saves.
// ---------------------------------------------------------------------------

function PreviewViewBody({ openFile }: { openFile: EditableFile }) {
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  const workspaceRoot = useActiveWorkspaceRoot(
    openFile.kind === "text" ? openFile.folderId : null,
  );

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    void (async () => {
      try {
        const kind = previewKindForFile(openFile.name);
        if (kind === null) {
          setState({
            status: "error",
            reason: "Preview is only available for markdown and HTML files.",
          });
          return;
        }

        const client = await getRpcClient();
        const result =
          openFile.kind === "external"
            ? await Effect.runPromise(
                client["fs.readExternalFile"]({ path: openFile.absPath }),
              )
            : await Effect.runPromise(
                client["fs.readFile"]({
                  folderId: openFile.folderId,
                  path: openFile.path,
                  worktreeId: openFile.worktreeId,
                }),
              );
        if (cancelled) return;
        if (result.kind === "binary") {
          setState({ status: "binary", size: result.size });
          return;
        }

        const fileDir =
          openFile.kind === "external"
            ? dirname(openFile.absPath)
            : workspaceRoot !== null
              ? joinPath(workspaceRoot, dirname(openFile.path))
              : dirname(openFile.path);
        setState({
          status: "ready",
          kind,
          content: result.content,
          baseHref: fileUrlForDirectory(fileDir),
        });
      } catch (err) {
        if (!cancelled) {
          setState({ status: "error", reason: formatError(err) });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [openFile, workspaceRoot]);

  if (state.status === "loading") {
    return (
      <Placeholder>
        <ShimmerText>Loading preview…</ShimmerText>
      </Placeholder>
    );
  }
  if (state.status === "binary") {
    return (
      <Placeholder>
        Binary file ({state.size.toLocaleString()} bytes) — preview not
        supported.
      </Placeholder>
    );
  }
  if (state.status === "error") {
    return (
      <Placeholder>
        <span className="text-destructive">{state.reason}</span>
      </Placeholder>
    );
  }

  if (state.kind === "markdown") {
    return (
      <div className="min-h-0 flex-1 overflow-auto px-8 py-6">
        <MarkdownBody
          baseHref={state.baseHref}
          className="mx-auto max-w-3xl"
          children={state.content}
        />
      </div>
    );
  }

  return (
    <iframe
      title={`${openFile.name} preview`}
      sandbox=""
      srcDoc={htmlWithBaseHref(state.content, state.baseHref)}
      className="min-h-0 flex-1 border-0 bg-white"
    />
  );
}

// ---------------------------------------------------------------------------
// Toolbar — path + dirty/saving on the left, Diff/Edit segmented toggle on
// the right. The saving indicator lives inside CodeMirrorBody so it tracks
// the actual save call; the toolbar just shows path + dirty + the toggle.
// ---------------------------------------------------------------------------

function Toolbar({
  path,
  view,
  showDiff,
  showPreview,
}: {
  path: string;
  view: FileView;
  showDiff: boolean;
  showPreview: boolean;
}) {
  const dirty = useUiStore((s) => s.fileDirty);
  const setOpenFileView = useUiStore((s) => s.setOpenFileView);
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-1 text-[11px] text-muted-foreground">
      <span className="truncate" title={path}>
        {path}
      </span>
      <span className="ml-auto flex items-center gap-2">
        {dirty ? (
          <span className="text-muted-foreground">
            <span className="text-warning">●</span> modified
          </span>
        ) : null}
        {view === "edit" ? (
          <span className="opacity-60">⌘S to save</span>
        ) : null}
        {showDiff || showPreview ? (
          <ViewToggle
            value={view}
            onChange={setOpenFileView}
            showDiff={showDiff}
            showPreview={showPreview}
          />
        ) : null}
      </span>
    </div>
  );
}

function ViewToggle({
  value,
  onChange,
  showDiff,
  showPreview,
}: {
  value: FileView;
  onChange: (v: FileView) => void;
  showDiff: boolean;
  showPreview: boolean;
}) {
  return (
    <div
      role="tablist"
      className="flex items-center gap-px rounded-sm border border-border bg-background/60 p-px"
    >
      {showDiff ? (
        <ToggleButton
          active={value === "diff"}
          onClick={() => onChange("diff")}
          label="Diff"
        />
      ) : null}
      <ToggleButton
        active={value === "edit"}
        onClick={() => onChange("edit")}
        label="Edit"
      />
      {showPreview ? (
        <ToggleButton
          active={value === "preview"}
          onClick={() => onChange("preview")}
          label="Preview"
        />
      ) : null}
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "rounded-[3px] px-1.5 py-[1px] text-[10px] font-medium tracking-wide transition-colors",
        active
          ? "bg-foreground/10 text-foreground"
          : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function SavingIndicator({ saving }: { saving: boolean }) {
  if (!saving) return null;
  return (
    <div className="shrink-0 px-3 py-0.5 text-right text-[10px] text-muted-foreground">
      saving…
    </div>
  );
}

function Banner({
  message,
  actionLabel,
  onAction,
  onDismiss,
}: {
  message: string;
  actionLabel: string | null;
  onAction: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 bg-alert-warning-bg px-3 py-1.5 text-[11px] text-foreground">
      <span className="flex-1 text-muted-foreground">{message}</span>
      {actionLabel && (
        <button
          type="button"
          onClick={onAction}
          className="rounded bg-accent px-2 py-0.5 text-foreground hover:bg-accent/80"
        >
          {actionLabel}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="rounded px-1 text-muted-foreground hover:text-foreground"
      >
        ×
      </button>
    </div>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}
