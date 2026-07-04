import { PatchDiff } from "@pierre/diffs/react";
import { createPatch, structuredPatch } from "diff";
import { useMemo } from "react";

import { FileIcon } from "./file-icon.tsx";
import { isPatchDiffRenderable } from "../lib/patch-diff.ts";

const UNIFIED_DIFF_OPTIONS = { diffStyle: "unified" } as const;

export interface FileEdit {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
  readonly mode: "edit" | "create";
}

export interface PatchEntry {
  readonly file_path: string;
  readonly kind?: string;
  readonly patch: string;
}

/**
 * Best-effort extraction of a `(path, old, new)` triple from a Claude
 * `Edit` / `Write` / `MultiEdit` tool input. Tools we can't parse fall back
 * to the JSON view at the call site — never throws.
 */
export const extractEdits = (
  tool: string,
  input: unknown,
): ReadonlyArray<FileEdit> => {
  if (input === null || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;
  const path = typeof obj.file_path === "string" ? obj.file_path : null;

  // Shared parser for an `edits: [{ old_string, new_string }]` array (MultiEdit,
  // and Grok's SearchReplace which can apply several hunks in one Edit call).
  const editsList = (raw: unknown, p: string): FileEdit[] => {
    const edits = Array.isArray(raw) ? raw : [];
    const out: FileEdit[] = [];
    for (const e of edits) {
      if (e === null || typeof e !== "object") continue;
      const r = e as Record<string, unknown>;
      out.push({
        path: p,
        oldText: typeof r.old_string === "string" ? r.old_string : "",
        newText: typeof r.new_string === "string" ? r.new_string : "",
        mode: "edit",
      });
    }
    return out;
  };

  if (tool === "Edit") {
    if (path === null) return [];
    // Grok's SearchReplace can carry multiple hunks under `edits`; prefer
    // that when present, else the single old_string/new_string pair.
    if (Array.isArray(obj.edits)) return editsList(obj.edits, path);
    const oldText = typeof obj.old_string === "string" ? obj.old_string : "";
    const newText = typeof obj.new_string === "string" ? obj.new_string : "";
    return [{ path, oldText, newText, mode: "edit" }];
  }

  if (tool === "Write") {
    if (path === null) return [];
    const newText = typeof obj.content === "string" ? obj.content : "";
    return [{ path, oldText: "", newText, mode: "create" }];
  }

  if (tool === "MultiEdit") {
    if (path === null) return [];
    return editsList(obj.edits, path);
  }

  return [];
};

/**
 * Total +/- line counts across a set of edits, without rendering the diff.
 * For a `Write` (mode === "create") we count every line in newText as an
 * addition and skip subtraction.
 */
export const diffStats = (
  edits: ReadonlyArray<FileEdit>,
): { added: number; removed: number } => {
  let added = 0;
  let removed = 0;
  for (const edit of edits) {
    if (edit.mode === "create") {
      added += edit.newText === "" ? 0 : edit.newText.split("\n").length;
      continue;
    }
    const patch = structuredPatch(
      edit.path,
      edit.path,
      edit.oldText,
      edit.newText,
      "",
      "",
      { context: 0 },
    );
    for (const hunk of patch.hunks) {
      for (const raw of hunk.lines) {
        const m = raw.charAt(0);
        if (m === "+") added += 1;
        else if (m === "-") removed += 1;
      }
    }
  }
  return { added, removed };
};

export const extractPatchEntries = (
  input: unknown,
): ReadonlyArray<PatchEntry> => {
  if (input === null || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;
  const patches = Array.isArray(obj.patches) ? obj.patches : null;
  if (patches !== null) {
    return patches
      .map((raw): PatchEntry | null => {
        if (raw === null || typeof raw !== "object") return null;
        const patch = raw as Record<string, unknown>;
        const filePath =
          typeof patch.file_path === "string" ? patch.file_path : null;
        const text = typeof patch.patch === "string" ? patch.patch : null;
        if (filePath === null || text === null) return null;
        return {
          file_path: filePath,
          kind: typeof patch.kind === "string" ? patch.kind : undefined,
          patch: text,
        };
      })
      .filter((entry): entry is PatchEntry => entry !== null);
  }
  const path = typeof obj.file_path === "string" ? obj.file_path : null;
  const patch = typeof obj.patch === "string" ? obj.patch : null;
  if (path === null || patch === null) return [];
  return [
    {
      file_path: path,
      kind: typeof obj.kind === "string" ? obj.kind : undefined,
      patch,
    },
  ];
};

export const patchStats = (
  patches: ReadonlyArray<PatchEntry>,
): { added: number; removed: number } => {
  let added = 0;
  let removed = 0;
  for (const patch of patches) {
    for (const line of patch.patch.split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
    }
  }
  return { added, removed };
};

/**
 * Build a unified-diff text string from a `FileEdit`, suitable for feeding to
 * `@pierre/diffs` `PatchDiff`. For a `create` with empty old text we still pass
 * `""` as the old file so the line numbers + additions render.
 */
const editToPatch = (edit: FileEdit): string =>
  createPatch(edit.path, edit.oldText, edit.newText, "", "") ?? "";

// ---------------------------------------------------------------------------
// Polished vertical diff used for Edit/Write/MultiEdit tool results in the
// chat timeline. Matches CodeBlock chrome, has internal scroll cap, tight
// gutters (consistent with the tightened code-block-shiki rules), and app-
// native colors.
// ---------------------------------------------------------------------------

const basename = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
};

const normalizePatchForDiffViewer = (path: string, patch: string): string => {
  const trimmed = patch.trimStart();
  if (trimmed.startsWith("diff --git") || trimmed.startsWith("--- ")) {
    return patch;
  }
  if (!trimmed.startsWith("@@")) return patch;
  const displayPath = path.length > 0 ? path : "file";
  const body = patch.endsWith("\n") ? patch : `${patch}\n`;
  return [
    `diff --git a/${displayPath} b/${displayPath}`,
    `--- a/${displayPath}`,
    `+++ b/${displayPath}`,
    body,
  ].join("\n");
};

function RawPatchBlock({ patch }: { patch: string }) {
  return (
    <pre className="code-block-scroll max-h-[420px] overflow-auto whitespace-pre-wrap break-words bg-muted/15 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground/80">
      {patch}
    </pre>
  );
}

export function UnifiedPatchDiff({
  path,
  patch,
  kind = "edit",
  showHeader = false,
}: {
  path: string;
  patch: string;
  kind?: string;
  showHeader?: boolean;
}) {
  if (patch.trim().length === 0) {
    return (
      <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
        (no textual change)
      </div>
    );
  }

  const name = basename(path);
  const renderable = isPatchDiffRenderable(patch);
  const normalizedPatch = normalizePatchForDiffViewer(path, patch);
  return (
    <div className="overflow-hidden rounded-md border border-border/60">
      {showHeader ? (
        <div className="flex items-center gap-2 border-b border-border/40 bg-muted px-2 py-1 text-[11px] text-muted-foreground">
          <FileIcon
            name={name}
            kind="file"
            className="inline-flex size-3.5 shrink-0"
          />
          <span className="truncate font-mono text-foreground/80">{name}</span>
          <span className="text-muted-foreground">{kind}</span>
        </div>
      ) : null}

      <div
        className="fz-diff code-block-scroll overflow-auto bg-muted/15 text-[12px] leading-[1.45]"
        style={{ maxHeight: 420 }}
      >
        {renderable ? (
          <PatchDiff
            patch={normalizedPatch}
            options={UNIFIED_DIFF_OPTIONS}
            disableWorkerPool
          />
        ) : (
          <RawPatchBlock patch={patch} />
        )}
      </div>
    </div>
  );
}

/**
 * Render a `FileEdit` (an `Edit` / `Write` / `MultiEdit` tool input) as a
 * unified diff through `@pierre/diffs` `PatchDiff` — the same library the
 * file-editor diff tab and `UnifiedPatchDiff` use — so the inline chat diff
 * inherits the app's themed lime-add / rose-delete colors, syntax tinting, and
 * proper gutters (via the `.fz-diff` overrides in styles.css) instead of the
 * old hand-rolled rows. Wrapped in a bordered card with a filename + `+N`/`-N`
 * stats header and an internal scroll cap.
 */
export function EditDiff({
  edit,
  showHeader = false,
}: {
  edit: FileEdit;
  showHeader?: boolean;
}) {
  const patchText = useMemo(() => editToPatch(edit), [edit]);
  if (patchText.trim().length === 0 || edit.oldText === edit.newText) {
    return (
      <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
        (no textual change)
      </div>
    );
  }

  const stats = diffStats([edit]);
  const name = basename(edit.path);

  return (
    <div className="overflow-hidden rounded-md border border-border/60">
      {showHeader ? (
        <div className="flex items-center gap-2 border-b border-border/40 bg-muted px-2 py-1 text-[11px] text-muted-foreground">
          <FileIcon
            name={name}
            kind="file"
            className="inline-flex size-3.5 shrink-0"
          />
          <span className="truncate font-mono text-foreground/80">{name}</span>
          {stats.added > 0 ? (
            <span className="ml-auto text-emerald-400 tabular-nums">
              +{stats.added}
            </span>
          ) : null}
          {stats.removed > 0 ? (
            <span className="text-red-400 tabular-nums">-{stats.removed}</span>
          ) : null}
        </div>
      ) : null}

      <div
        className="fz-diff code-block-scroll overflow-auto bg-muted/15 text-[12px] leading-[1.45]"
        style={{ maxHeight: 420 }}
      >
        <PatchDiff
          patch={patchText}
          options={UNIFIED_DIFF_OPTIONS}
          disableWorkerPool
        />
      </div>
    </div>
  );
}
