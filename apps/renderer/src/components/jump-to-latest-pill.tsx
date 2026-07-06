import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon } from "@hugeicons-pro/core-bulk-rounded";

import { cn } from "~/lib/utils";

/**
 * Floating "Jump to latest" affordance, pinned to the center-right of the
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
  if (!visible) return null;

  return (
    <div
      className={cn(
        "pointer-events-none absolute top-1/2 right-4 z-50 flex -translate-y-1/2 opacity-100",
        "transition-all duration-150 ease-out motion-reduce:transition-none",
      )}
    >
      <button
        type="button"
        onClick={onClick}
        aria-label="Jump to latest"
        className={cn(
          "pointer-events-auto inline-flex items-center gap-1.5 rounded-full",
          "border border-border/60 bg-popover/95 px-3 py-1.5 text-xs text-muted-foreground",
          "backdrop-blur dark:shadow-[0_2px_8px_color-mix(in_oklch,black_28%,transparent)]",
          "hover:text-foreground hover:bg-popover",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
        <span>Jump to latest</span>
      </button>
    </div>
  );
}
