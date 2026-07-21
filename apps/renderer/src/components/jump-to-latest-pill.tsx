import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon } from "@hugeicons-pro/core-solid-rounded";

import { cn } from "~/lib/utils";

/**
 * "Jump to latest" affordance rendered inside the floating row directly
 * above the composer. Appears once the reader has scrolled away from the
 * live edge (principle 9); while a response is still streaming out of view
 * it shows a pulsing activity dot (principle 8). Fades/slides in with a CSS
 * transition that respects `prefers-reduced-motion`.
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
				"pointer-events-none",
				"animate-in fade-in slide-in-from-bottom-1 duration-150 motion-reduce:animate-none",
			)}
		>
			<button
				type="button"
				onClick={onClick}
				aria-label="Jump to latest"
				className={cn(
					"pointer-events-auto inline-flex items-center gap-1.5 rounded-lg",
					"border border-border/60 bg-card px-3 py-1 text-xs text-muted-foreground shadow-overlay-sm",
					"transition-colors hover:border-border hover:bg-card hover:text-foreground",
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
