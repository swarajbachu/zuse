import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, ArrowUp01Icon, Delete02Icon, DragDropVerticalIcon, PencilIcon, Tick01Icon } from "@hugeicons-pro/core-bulk-rounded";
import { X } from "lucide-react";
import { useState } from "react";

import { ComposerInput, type QueuedMessage, type SessionId } from "@memoize/wire";

import {
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useMessagesStore } from "../../store/messages.ts";

const previewText = (q: QueuedMessage): string => {
  const t = q.input.text.trim();
  if (t.length === 0) {
    if (q.input.attachments.length > 0) return `(${q.input.attachments.length} file)`;
    return "(empty)";
  }
  return t.replace(/\s+/g, " ");
};

const iconButton =
  "flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground disabled:pointer-events-none disabled:opacity-35";

export function QueueChip({
  sessionId,
  item,
  index,
  count,
  dragging,
  onMove,
  onDragStart,
  onDragOver,
  onDrop,
}: {
  sessionId: SessionId;
  item: QueuedMessage;
  index: number;
  count: number;
  dragging: boolean;
  onMove: (from: number, to: number) => void;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
}) {
  const steer = useMessagesStore((s) => s.steerFromQueue);
  const drop = useMessagesStore((s) => s.dropFromQueue);
  const update = useMessagesStore((s) => s.updateQueued);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.input.text);
  const text = previewText(item);
  const attachmentCount = item.input.attachments.length;
  const refCount = item.input.fileRefs.length + item.input.skillRefs.length;

  const save = () => {
    update(
      sessionId,
      item.id,
      new ComposerInput({
        text: draft,
        attachments: item.input.attachments,
        fileRefs: item.input.fileRefs,
        skillRefs: item.input.skillRefs,
      }),
    );
    setEditing(false);
  };

  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragOver={(event) => {
        event.preventDefault();
        onDragOver();
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      className={cn(
        "group flex min-w-0 items-start gap-2 border-b border-border/30 px-2 py-1.5 last:border-b-0",
        dragging && "bg-muted/50",
      )}
      title={text}
    >
      <button
        type="button"
        className="mt-0.5 flex size-6 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground active:cursor-grabbing"
        aria-label="Drag queued message"
      >
        <HugeiconsIcon icon={DragDropVerticalIcon} className="size-3.5" />
      </button>
      <div className="min-w-0 flex-1">
        {editing ? (
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setDraft(item.input.text);
                setEditing(false);
              }
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                save();
              }
            }}
            autoFocus
            className="max-h-28 min-h-14 w-full resize-y rounded-md border border-border/50 bg-background px-2 py-1.5 text-xs leading-relaxed text-foreground outline-none focus:border-ring/50"
          />
        ) : (
          <div className="truncate text-xs leading-6 text-foreground">
            {text}
          </div>
        )}
        {(attachmentCount > 0 || refCount > 0) && (
          <div className="mt-0.5 flex gap-1 text-[10px] text-muted-foreground">
            {attachmentCount > 0 && <span>{attachmentCount} file</span>}
            {refCount > 0 && <span>{refCount} ref</span>}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {editing ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button type="button" onClick={save} className={iconButton} aria-label="Save">
                    <HugeiconsIcon icon={Tick01Icon} className="size-3.5" />
                  </button>
                }
              />
              <TooltipPopup>Save</TooltipPopup>
            </Tooltip>
            <button
              type="button"
              onClick={() => {
                setDraft(item.input.text);
                setEditing(false);
              }}
              className={iconButton}
              aria-label="Cancel"
            >
              <X className="size-3.5" strokeWidth={1.8} />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => onMove(index, index - 1)}
              disabled={index === 0}
              className={iconButton}
              aria-label="Move up"
            >
              <HugeiconsIcon icon={ArrowUp01Icon} className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onMove(index, index + 1)}
              disabled={index >= count - 1}
              className={iconButton}
              aria-label="Move down"
            >
              <HugeiconsIcon icon={ArrowDown01Icon} className="size-3.5" />
            </button>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    className={iconButton}
                    aria-label="Edit queued message"
                  >
                    <HugeiconsIcon icon={PencilIcon} className="size-3.5" />
                  </button>
                }
              />
              <TooltipPopup>Edit</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => void steer(sessionId, item.id)}
                    className={iconButton}
                    aria-label="Send now"
                  >
                    <HugeiconsIcon icon={ArrowUp01Icon} className="size-3.5" />
                  </button>
                }
              />
              <TooltipPopup>Send now</TooltipPopup>
            </Tooltip>
            <button
              type="button"
              onClick={() => drop(sessionId, item.id)}
              className={iconButton}
              aria-label="Delete queued message"
            >
              <HugeiconsIcon icon={Delete02Icon} className="size-3.5" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
