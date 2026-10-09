import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, ArrowDown01Icon } from "@zuse/icons/solid-rounded";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";
import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from "../ui/collapsible.tsx";
import { DOCK_LABEL_CLASS } from "./text.ts";

/** Collapsible dock section separated by a hairline rather than a card. */
export function DockDisclosureSection({
	label,
	count,
	action,
	defaultOpen = true,
	className,
	children,
}: {
	label: ReactNode;
	count?: number;
	action?: ReactNode;
	defaultOpen?: boolean;
	className?: string;
	children: ReactNode;
}) {
	return (
		<Collapsible
			defaultOpen={defaultOpen}
			className={cn("border-t border-border/50", className)}
		>
			<div className="flex h-9 items-center gap-2 px-4">
				<CollapsibleTrigger className="group flex h-7 min-w-0 flex-1 items-center gap-1.5 text-left outline-none focus-visible:underline">
					<span className="truncate text-xs font-medium text-foreground">
						{label}
					</span>
					{count !== undefined ? (
						<span className="tabular-nums text-[11px] text-muted-foreground">
							{count}
						</span>
					) : null}
					<HugeiconsIcon
						icon={ArrowDown01Icon}
						className="size-3 shrink-0 -rotate-90 text-muted-foreground/70 transition-transform duration-150 group-data-[panel-open]:rotate-0"
					/>
				</CollapsibleTrigger>
				{action}
			</div>
			<CollapsiblePanel>
				<div className="px-4 pb-3">{children}</div>
			</CollapsiblePanel>
		</Collapsible>
	);
}

/** Label/value line with a fixed label column, used for PR facts. */
export function DockMetaRow({
	icon,
	label,
	children,
}: {
	icon?: ReactNode;
	label: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="flex min-w-0 items-start gap-3 py-0.5 text-xs">
			<span
				className={cn(
					"flex h-6 w-24 shrink-0 items-center gap-1.5",
					DOCK_LABEL_CLASS,
				)}
			>
				{icon}
				<span className="truncate font-normal">{label}</span>
			</span>
			<div className="flex min-h-6 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-foreground">
				{children}
			</div>
		</div>
	);
}

/** Quiet amber note for degraded data — the panel keeps showing what it has. */
export function DockWarningNote({
	children,
	action,
	className,
}: {
	children: ReactNode;
	action?: ReactNode;
	className?: string;
}) {
	return (
		<div
			role="status"
			className={cn(
				"flex min-w-0 items-center gap-2 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-1.5 text-xs text-foreground",
				className,
			)}
		>
			<HugeiconsIcon
				icon={Alert02Icon}
				className="size-3.5 shrink-0 text-warning"
			/>
			<span className="min-w-0 flex-1">{children}</span>
			{action}
		</div>
	);
}
