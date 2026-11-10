import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { ArrowDown01Icon } from "@zuse/icons/solid-rounded";
import { type ReactNode, useState } from "react";
import { cn } from "../lib/utils.ts";
import { summaryMetaClass, summaryRowClass } from "./cloud-workspace-info.tsx";
import { ScrollArea } from "./ui/scroll-area.tsx";

/**
 * A collapsible group in the environment summary: an ordinary icon row whose
 * chevron folds the rows beneath it. Long groups scroll after five and a half
 * rows, so the clipped row signals more below and one busy section never
 * pushes the rest of the summary out of view.
 */
export function SummarySection({
	icon,
	label,
	meta,
	defaultOpen = true,
	children,
}: {
	readonly icon: IconSvgElement;
	readonly label: string;
	readonly meta?: ReactNode;
	readonly defaultOpen?: boolean;
	readonly children: ReactNode;
}) {
	const [open, setOpen] = useState(defaultOpen);
	return (
		<section aria-label={label}>
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
				className={`${summaryRowClass} hover:bg-muted/60`}
			>
				<HugeiconsIcon
					icon={icon}
					className="size-4 shrink-0 text-muted-foreground"
				/>
				<span className="min-w-0 flex-1 truncate">{label}</span>
				<span className={summaryMetaClass}>
					{meta}
					<HugeiconsIcon
						icon={ArrowDown01Icon}
						className={cn(
							"size-3 transition-transform motion-reduce:transition-none",
							!open && "-rotate-90",
						)}
					/>
				</span>
			</button>
			{open ? (
				<ScrollArea
					scrollFade
					className="h-auto [&>[data-slot=scroll-area-viewport]]:max-h-[9.625rem]"
				>
					{children}
				</ScrollArea>
			) : null}
		</section>
	);
}

/**
 * Separates the workspace rows (location, branch, changes, PR) from the
 * session activity beneath them. Collapses when no activity renders.
 */
export function SummaryActivity({
	children,
}: {
	readonly children: ReactNode;
}) {
	return (
		<div className="mt-1.5 before:mx-2.5 before:mb-1.5 before:block before:h-px before:bg-linear-to-r before:from-transparent before:via-foreground/15 before:to-transparent empty:hidden">
			{children}
		</div>
	);
}
