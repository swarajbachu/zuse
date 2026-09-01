import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export type SegmentedTabOption<Value extends string> = {
	readonly value: Value;
	readonly label: ReactNode;
	readonly ariaLabel?: string;
	disabled?: boolean;
};

/** Compact, low-chrome tabs for settings and dialogs. */
export function SegmentedTabs<Value extends string>({
	value,
	options,
	onValueChange,
	ariaLabel,
	equalWidth = true,
	className,
	tabClassName,
}: {
	readonly value: Value;
	readonly options: ReadonlyArray<SegmentedTabOption<Value>>;
	readonly onValueChange: (value: Value) => void;
	readonly ariaLabel: string;
	readonly equalWidth?: boolean;
	readonly className?: string;
	readonly tabClassName?: string;
}) {
	return (
		<div
			role="tablist"
			aria-label={ariaLabel}
			className={cn(
				"flex h-7 min-w-0 items-stretch gap-2 border-border/60 border-b",
				className,
			)}
		>
			{options.map((option) => {
				const selected = option.value === value;
				return (
					<button
						key={option.value}
						type="button"
						role="tab"
						aria-selected={selected}
						aria-label={option.ariaLabel}
						tabIndex={selected ? 0 : -1}
						disabled={option.disabled}
						onClick={() => onValueChange(option.value)}
						className={cn(
							"relative flex h-7 min-w-0 items-center justify-center gap-1.5 rounded-t-md px-2 font-medium text-[11px] outline-none transition-[background-color,color] duration-150 after:absolute after:inset-x-2 after:-bottom-px after:h-px after:rounded-full after:bg-transparent after:content-[''] focus-visible:bg-muted/45 focus-visible:ring-2 focus-visible:ring-ring/70 disabled:pointer-events-none disabled:opacity-50",
							equalWidth ? "flex-1" : "shrink-0",
							selected
								? "text-foreground after:bg-primary"
								: "text-muted-foreground hover:bg-muted/30 hover:text-foreground",
							tabClassName,
						)}
					>
						{option.label}
					</button>
				);
			})}
		</div>
	);
}
