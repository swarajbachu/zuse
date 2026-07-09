import { useEffect, useRef, useState } from "react";

import type { FolderId, WorktreeId } from "@zuse/wire";

import {
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "~/components/ui/tooltip.tsx";
import { useUiStore } from "~/store/ui";

type HoverState =
  | {
      readonly kind: "file";
      readonly rect: DOMRect;
      readonly relPath: string;
      readonly absPath: string;
      readonly entryKind: "file" | "directory";
    }
  | {
      readonly kind: "image";
      readonly rect: DOMRect;
      readonly previewUrl: string;
      readonly originalName: string;
      readonly mimeType: string;
    };

const HIDE_DELAY_MS = 80;

const basename = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
};

/**
 * Overlay that adds behaviours to atomic chips inside the composer:
 *
 *   - **file hover** → a Base UI tooltip anchored to the chip showing
 *     `Open <relPath>` (or `View <relPath>` for directories).
 *   - **file click** → opens the file in the right pane's file editor.
 *   - **image hover** → shows a constrained preview of the attachment.
 *
 * The chip widget lives inside CodeMirror's DOM (see `composer-chips.ts`)
 * so we event-delegate from the editor host rather than mounting React
 * inside the widget. The tooltip uses a virtual anchor (`getBoundingClientRect`)
 * so positioning tracks the chip without us having to portal anything into
 * the contentDOM.
 */
export function ComposerChipOverlay({
  hostRef,
  projectId,
  worktreeId,
}: {
  hostRef: React.RefObject<HTMLElement | null>;
  projectId: FolderId;
  worktreeId: WorktreeId | null;
}) {
  const [state, setState] = useState<HoverState | null>(null);
  const hideTimer = useRef<number | null>(null);
  const openFileInTab = useUiStore((s) => s.openFileInTab);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const cancelHide = (): void => {
      if (hideTimer.current !== null) {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
    };

    const findFileChip = (target: EventTarget | null): HTMLElement | null => {
      if (!(target instanceof HTMLElement)) return null;
      return target.closest<HTMLElement>('.fz-chip[data-kind="file"]');
    };
    const findImageChip = (target: EventTarget | null): HTMLElement | null => {
      if (!(target instanceof HTMLElement)) return null;
      return target.closest<HTMLElement>('.fz-chip[data-kind="image"]');
    };

    const onOver = (e: MouseEvent) => {
      const fileChip = findFileChip(e.target);
      const imageChip = findImageChip(e.target);
      const chip = fileChip ?? imageChip;
      if (chip === null) return;
      cancelHide();
      if (fileChip !== null) {
        const relPath = fileChip.dataset.relPath;
        const absPath = fileChip.dataset.absPath;
        const entryKind = fileChip.dataset.entryKind;
        if (relPath === undefined || absPath === undefined) return;
        setState({
          kind: "file",
          rect: fileChip.getBoundingClientRect(),
          relPath,
          absPath,
          entryKind: entryKind === "directory" ? "directory" : "file",
        });
        return;
      }
      if (imageChip !== null) {
        const previewUrl = imageChip.dataset.previewUrl;
        const originalName = imageChip.dataset.originalName;
        const mimeType = imageChip.dataset.mimeType;
        if (
          previewUrl === undefined ||
          previewUrl.length === 0 ||
          originalName === undefined ||
          mimeType === undefined ||
          !mimeType.startsWith("image/")
        ) {
          return;
        }
        setState({
          kind: "image",
          rect: imageChip.getBoundingClientRect(),
          previewUrl,
          originalName,
          mimeType,
        });
      }
    };

    const onOut = (e: MouseEvent) => {
      const chip = findFileChip(e.target) ?? findImageChip(e.target);
      if (chip === null) return;
      const next = e.relatedTarget;
      if (
        next instanceof HTMLElement &&
        (next.closest('.fz-chip[data-kind="file"]') !== null ||
          next.closest('.fz-chip[data-kind="image"]') !== null)
      ) {
        return;
      }
      cancelHide();
      hideTimer.current = window.setTimeout(
        () => setState(null),
        HIDE_DELAY_MS,
      );
    };

    // Open on click. We don't suppress propagation so CodeMirror still
    // routes the click as needed; openFileInTab just switches the main
    // tab to "file" and the right pane reads the new state.
    const onClick = (e: MouseEvent) => {
      const chip = findFileChip(e.target);
      if (chip === null) return;
      const relPath = chip.dataset.relPath;
      const entryKind = chip.dataset.entryKind;
      if (relPath === undefined) return;
      if (entryKind === "directory") return;
      e.preventDefault();
      e.stopPropagation();
      // The chip's dataset.relPath is already project-root-relative — that's
      // the shape `fs.readFile` expects. Passing absPath would round-trip
      // through `resolveInsideFolder` and reject with FsPathOutsideError
      // when the workspace happens to live under a different root than the
      // composer suggested.
      openFileInTab({
        kind: "text",
        folderId: projectId,
        path: relPath,
        name: basename(relPath),
        worktreeId,
      });
      setState(null);
    };

    host.addEventListener("mouseover", onOver);
    host.addEventListener("mouseout", onOut);
    host.addEventListener("click", onClick);
    return () => {
      host.removeEventListener("mouseover", onOver);
      host.removeEventListener("mouseout", onOut);
      host.removeEventListener("click", onClick);
      cancelHide();
    };
  }, [hostRef, projectId, worktreeId, openFileInTab]);

  if (state === null) return null;

  const rect = state.rect;

  return (
    <Tooltip open>
      <TooltipTrigger
        render={
          <span
            aria-hidden="true"
            data-instant=""
            style={{
              position: "fixed",
              top: rect.top,
              left: rect.left,
              width: rect.width,
              height: rect.height,
              pointerEvents: "none",
            }}
          />
        }
      />
      <TooltipPopup
        className={
          state.kind === "image"
            ? "max-w-[min(24rem,calc(100vw-2rem))] p-2"
            : undefined
        }
      >
        {state.kind === "file" ? (
          state.entryKind === "directory" ? (
            `View ${state.relPath}`
          ) : (
            `Open ${state.relPath}`
          )
        ) : (
          <div className="min-w-0">
            <img
              src={state.previewUrl}
              alt=""
              className="block max-h-72 max-w-full rounded-md object-contain"
              draggable={false}
            />
            <div className="mt-1.5 max-w-80 truncate px-0.5 text-[11px] text-muted-foreground">
              {state.originalName}
            </div>
          </div>
        )}
      </TooltipPopup>
    </Tooltip>
  );
}
