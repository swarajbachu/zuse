import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export type SegmentedTabOption<Value extends string> = {
	readonly value: Value;
	readonly label: ReactNode;
	readonly ariaLabel?: string;
	disabled?: boolean;
};

/**
 * Compact tab switcher for settings and dialogs. The selected tab is raised
 * tonally instead of relying on a loud underline or a row of outlined buttons.
 */
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
				"flex h-7 min-w-0 items-center gap-0.5 rounded-lg bg-muted/55 p-0.5 shadow-[inset_0_0_0_1px_hsl(0_0%_100%/0.025)]",
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
						disabled={option.disabled}
						onClick={() => onValueChange(option.value)}
						className={cn(
							"flex h-6 min-w-0 items-center justify-center gap-1.5 rounded-[6px] px-2.5 font-medium text-[11px] outline-none transition-[background-color,color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-muted disabled:pointer-events-none disabled:opacity-50",
							equalWidth ? "flex-1" : "shrink-0",
							selected
								? "bg-background/90 text-foreground shadow-[0_1px_2px_hsl(0_0%_0%/0.16)] ring-1 ring-inset ring-foreground/10"
								: "text-muted-foreground hover:bg-foreground/[0.045] hover:text-foreground",
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
