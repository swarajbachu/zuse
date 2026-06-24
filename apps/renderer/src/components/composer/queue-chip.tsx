import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Chat01Icon,
  CornerDownRightIcon,
  Delete02Icon,
  DragDropVerticalIcon,
  MoreHorizontalIcon,
  PencilIcon,
  SentIcon,
  Tick01Icon,
} from "@hugeicons-pro/core-bulk-rounded";
import { X } from "lucide-react";
import { useState } from "react";

import { ComposerInput, type QueuedMessage, type SessionId } from "@memoize/wire";

import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "~/components/ui/menu";
import {
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useMessagesStore } from "../../store/messages.ts";
import { TrayPill, trayPillActionClass } from "./tray-pill.tsx";

const previewText = (q: QueuedMessage): string => {
  const t = q.input.text.trim();
  if (t.length === 0) {
    if (q.input.attachments.length > 0) return `(${q.input.attachments.length} file)`;
    return "(empty)";
  }
  return t.replace(/\s+/g, " ");
};

const refSubtitle = (q: QueuedMessage): string | undefined => {
  const a = q.input.attachments.length;
  const r = q.input.fileRefs.length + q.input.skillRefs.length;
  if (a === 0 && r === 0) return undefined;
  const parts: string[] = [];
  if (a > 0) parts.push(`${a} file${a === 1 ? "" : "s"}`);
  if (r > 0) parts.push(`${r} ref${r === 1 ? "" : "s"}`);
  return parts.join(" · ");
};

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
  const subtitle = refSubtitle(item);

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

  const icon = (
    <HugeiconsIcon
      icon={Chat01Icon}
      className="size-3.5"
      aria-hidden="true"
    />
  );

  if (editing) {
    return (
      <TrayPill
        flush
        icon={icon}
        title={
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
            className="max-h-28 min-h-7 w-full resize-y rounded-sm border border-border/40 bg-background px-2 py-1 text-[13px] leading-snug text-foreground outline-none focus:border-ring/50"
          />
        }
        actions={
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={save}
                    className={trayPillActionClass}
                    aria-label="Save"
                  >
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
              className={trayPillActionClass}
              aria-label="Cancel"
            >
              <X className="size-3.5" strokeWidth={1.8} />
            </button>
          </>
        }
      />
    );
  }

  return (
    <TrayPill
      flush
      icon={icon}
      title={text}
      subtitle={subtitle}
      className={cn("group", dragging && "bg-muted/55")}
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
      leading={
        <button
          type="button"
          className="-ml-1 flex size-4 shrink-0 cursor-grab items-center justify-center text-muted-foreground/60 opacity-0 hover:text-foreground group-hover:opacity-100 active:cursor-grabbing"
          aria-label="Drag queued message"
        >
          <HugeiconsIcon icon={DragDropVerticalIcon} className="size-3.5" />
        </button>
      }
      actions={
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => void steer(sessionId, item.id)}
                  className={cn(
                    trayPillActionClass,
                    "w-auto gap-1 px-1.5 hover:text-foreground",
                  )}
                  aria-label="Steer (send now, interrupting current turn)"
                >
                  <HugeiconsIcon icon={CornerDownRightIcon} className="size-3.5" />
                  <span className="text-[11px]">Steer</span>
                </button>
              }
            />
            <TooltipPopup>Steer (interrupt and run now)</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => drop(sessionId, item.id)}
                  className={trayPillActionClass}
                  aria-label="Delete queued message"
                >
                  <HugeiconsIcon icon={Delete02Icon} className="size-3.5" />
                </button>
              }
            />
            <TooltipPopup>Delete</TooltipPopup>
          </Tooltip>
          <Menu>
            <MenuTrigger
              render={
                <button
                  type="button"
                  className={trayPillActionClass}
                  aria-label="More queue actions"
                >
                  <HugeiconsIcon icon={MoreHorizontalIcon} className="size-3.5" />
                </button>
              }
            />
            <MenuPopup align="end" sideOffset={4}>
              <MenuItem
                onClick={() => setEditing(true)}
                disabled={editing}
              >
                <HugeiconsIcon icon={PencilIcon} />
                Edit
              </MenuItem>
              <MenuItem
                onClick={() => void steer(sessionId, item.id)}
              >
                <HugeiconsIcon icon={SentIcon} />
                Send now
              </MenuItem>
              <MenuItem
                onClick={() => onMove(index, index - 1)}
                disabled={index === 0}
              >
                <HugeiconsIcon icon={ArrowUp01Icon} />
                Move up
              </MenuItem>
              <MenuItem
                onClick={() => onMove(index, index + 1)}
                disabled={index >= count - 1}
              >
                <HugeiconsIcon icon={ArrowDown01Icon} />
                Move down
              </MenuItem>
            </MenuPopup>
          </Menu>
        </>
      }
    />
  );
}
