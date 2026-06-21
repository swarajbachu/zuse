import { useEffect, useRef, useState } from "react";

import type { FolderId, WorktreeId } from "@memoize/wire";

import {
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "~/components/ui/tooltip.tsx";
import { useUiStore } from "~/store/ui";

interface HoverState {
  readonly rect: DOMRect;
  readonly relPath: string;
  readonly absPath: string;
  readonly entryKind: "file" | "directory";
}

const HIDE_DELAY_MS = 80;

const basename = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
};

/**
 * Overlay that adds two behaviours to file chips inside the composer:
 *
 *   - **hover** → a Base UI tooltip anchored to the chip showing
 *     `Open <relPath>` (or `View <relPath>` for directories).
 *   - **click** → opens the file in the right pane's file editor.
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

    const findChip = (target: EventTarget | null): HTMLElement | null => {
      if (!(target instanceof HTMLElement)) return null;
      return target.closest<HTMLElement>('.fz-chip[data-kind="file"]');
    };

    const onOver = (e: MouseEvent) => {
      const chip = findChip(e.target);
      if (chip === null) return;
      const relPath = chip.dataset.relPath;
      const absPath = chip.dataset.absPath;
      const entryKind = chip.dataset.entryKind;
      if (relPath === undefined || absPath === undefined) return;
      cancelHide();
      setState({
        rect: chip.getBoundingClientRect(),
        relPath,
        absPath,
        entryKind: entryKind === "directory" ? "directory" : "file",
      });
    };

    const onOut = (e: MouseEvent) => {
      const chip = findChip(e.target);
      if (chip === null) return;
      const next = e.relatedTarget;
      if (
        next instanceof HTMLElement &&
        next.closest('.fz-chip[data-kind="file"]')
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
      const chip = findChip(e.target);
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

  const label =
    state.entryKind === "directory"
      ? `View ${state.relPath}`
      : `Open ${state.relPath}`;
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
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
