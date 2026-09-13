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
				"flex h-7 min-w-0 items-center gap-0.5 rounded-md bg-muted/55 p-0.5",
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
							"flex h-6 min-w-0 items-center justify-center gap-1.5 rounded-[5px] px-2.5 font-medium text-[11px] outline-none transition-[background-color,box-shadow,color] duration-150 focus-visible:ring-2 focus-visible:ring-ring/70 disabled:pointer-events-none disabled:opacity-50",
							equalWidth ? "flex-1" : "shrink-0",
							selected
								? "bg-background text-foreground shadow-xs"
								: "text-muted-foreground hover:bg-background/45 hover:text-foreground",
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
