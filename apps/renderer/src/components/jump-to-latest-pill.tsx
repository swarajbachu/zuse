import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon } from "@hugeicons-pro/core-bulk-rounded";

import { cn } from "~/lib/utils";

/**
 * Floating "Jump to latest" affordance, pinned to the bottom-center of the
 * chat pane. Appears once the reader has scrolled away from the live edge
 * (principle 9); while a response is still streaming out of view it shows a
 * pulsing activity dot (principle 8). Fades/slides in with a CSS transition
 * that respects `prefers-reduced-motion`.
 */
export function JumpToLatestPill({
  visible,
  streaming,
  onClick,
}: {
  visible: boolean;
  streaming: boolean;
  onClick: () => void;
}) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center",
        "transition-all duration-150 ease-out motion-reduce:transition-none",
        visible
          ? "translate-y-0 opacity-100"
          : "pointer-events-none translate-y-1 opacity-0",
      )}
      aria-hidden={!visible}
    >
      <button
        type="button"
        tabIndex={visible ? 0 : -1}
        onClick={onClick}
        aria-label="Jump to latest"
        className={cn(
          "pointer-events-auto inline-flex items-center gap-1.5 rounded-full",
          "border border-border/60 bg-popover/95 px-3 py-1.5 text-xs text-muted-foreground",
          "backdrop-blur dark:shadow-[0_2px_8px_color-mix(in_oklch,black_28%,transparent)]",
          "hover:text-foreground hover:bg-popover",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          !visible && "pointer-events-none",
        )}
      >
        {streaming ? (
          <span
            className="size-1.5 rounded-full bg-current motion-safe:animate-pulse"
            aria-hidden
          />
        ) : (
          <HugeiconsIcon icon={ArrowDown01Icon} className="size-3.5" />
        )}
        <span>{streaming ? "Streaming…" : "Jump to latest"}</span>
      </button>
    </div>
  );
}
