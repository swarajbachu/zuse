import {
  ArrowDown01Icon,
  BubbleChatIcon,
  PencilEdit01Icon,
  Tick01Icon,
} from "@hugeicons-pro/core-bulk-rounded";
import { HugeiconsIcon } from "@hugeicons/react";
import { X } from "lucide-react";
import { useState } from "react";

import type {
  CodeAnnotation,
  FolderId,
  SessionId,
  WorktreeId,
} from "@memoize/wire";

import { cn } from "~/lib/utils";

import { useAnnotationsStore } from "../../store/annotations.ts";
import { useRevealAnnotation } from "../annotation/annotation-navigation.ts";
import { AnnotationFileChip } from "../file-chip.tsx";

const EMPTY: ReadonlyArray<CodeAnnotation> = [];

/**
 * Stacked code annotations docked above the composer. Draft annotations can be
 * opened in the editor, edited in-place, removed individually, or cleared as a
 * group before submit.
 */
export function AnnotationTray({
  sessionId,
  folderId,
  worktreeId,
}: {
  sessionId: SessionId;
  folderId: FolderId | null;
  worktreeId: WorktreeId | null;
}) {
  const annotations = useAnnotationsStore(
    (s) => s.bySession[sessionId] ?? EMPTY,
  );
  const remove = useAnnotationsStore((s) => s.remove);
  const updateComment = useAnnotationsStore((s) => s.updateComment);
  const clear = useAnnotationsStore((s) => s.clear);
  const [expanded, setExpanded] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const revealAnnotation = useRevealAnnotation({ folderId, worktreeId });

  if (annotations.length === 0) return null;

  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-border/50 bg-card/80 shadow-sm">
      <div className="flex w-full items-center gap-2 border-b border-border/40 bg-muted/20 px-2.5 py-1.5">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex min-h-7 flex-1 items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <HugeiconsIcon
            icon={BubbleChatIcon}
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="text-xs font-semibold text-foreground">
            Annotations
          </span>
          <span className="rounded border border-border/50 bg-background/70 px-1.5 py-px text-[10px] font-medium tabular-nums text-muted-foreground">
            {annotations.length}
          </span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            className={cn(
              "ml-auto size-4 shrink-0 text-muted-foreground transition-transform",
              expanded ? "rotate-180" : "",
            )}
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          onClick={() => clear(sessionId)}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          aria-label="Clear all annotations"
        >
          <X className="size-3.5" strokeWidth={1.8} />
        </button>
      </div>
      {expanded ? (
        <ul className="max-h-64 space-y-px overflow-y-auto p-1">
          {annotations.map((a, i) => (
            <li
              key={a.id}
              className="group/annotation flex items-stretch gap-1.5 rounded-md"
            >
              <div className="flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/55">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-[11px] font-semibold tabular-nums text-primary">
                  {i + 1}
                </span>
                <span className="grid min-w-0 flex-1 gap-1">
                  <button
                    type="button"
                    onClick={() => revealAnnotation(a)}
                    className="min-w-0 justify-self-start rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    title="Open annotation"
                  >
                    <AnnotationFileChip annotation={a} />
                  </button>
                  {editingId === a.id ? (
                    <textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          e.preventDefault();
                          setEditingId(null);
                        } else if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          updateComment(sessionId, a.id, editText);
                          setEditingId(null);
                        }
                      }}
                      rows={2}
                      className="max-h-24 min-h-12 w-full resize-y rounded-md bg-background/70 px-2 py-1.5 text-sm leading-snug text-foreground outline-none ring-1 ring-border/50 focus:ring-ring/50"
                      autoFocus
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => revealAnnotation(a)}
                      className="min-w-0 truncate rounded text-left text-sm leading-snug text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      {a.comment}
                    </button>
                  )}
                </span>
              </div>
              {editingId === a.id ? (
                <button
                  type="button"
                  onClick={() => {
                    updateComment(sessionId, a.id, editText);
                    setEditingId(null);
                  }}
                  className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-80 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  aria-label="Save annotation"
                >
                  <HugeiconsIcon icon={Tick01Icon} className="size-3.5" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setEditingId(a.id);
                    setEditText(a.comment);
                  }}
                  className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 group-hover/annotation:opacity-100"
                  aria-label="Edit annotation"
                >
                  <HugeiconsIcon icon={PencilEdit01Icon} className="size-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={() => remove(sessionId, a.id)}
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-70 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 group-hover/annotation:opacity-100"
                aria-label="Remove annotation"
              >
                <X className="size-3.5" strokeWidth={1.8} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
