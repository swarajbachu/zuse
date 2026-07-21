import { HugeiconsIcon } from "@hugeicons/react";
import { Tick01Icon } from "@hugeicons-pro/core-stroke-rounded";
import { cn } from "~/lib/utils";

/**
 * Native `<input type="checkbox">` styled to match the app's checkbox look.
 * Used instead of the base-ui `Checkbox` in standalone spots (no surrounding
 * `Field`/`Form`) — base-ui's checkbox calls `useFormContext` and trips a
 * dual-React hook error there. A native input has no such dependency.
 */
export function CheckboxInput({
	checked,
	onChange,
	disabled,
	className,
}: {
	checked: boolean;
	onChange: (value: boolean) => void;
	disabled?: boolean;
	className?: string;
}) {
	return (
		<span className={cn("relative inline-flex shrink-0", className)}>
			<input
				type="checkbox"
				checked={checked}
				disabled={disabled}
				onChange={(e) => onChange(e.target.checked)}
				className="peer absolute inset-0 size-4 cursor-pointer opacity-0 disabled:cursor-not-allowed"
			/>
			<span
				aria-hidden
				className={cn(
					"flex size-4 items-center justify-center rounded-[5px] border transition-colors",
					checked
						? "border-primary bg-primary text-primary-foreground"
						: "border-input bg-background",
					disabled && "opacity-50",
				)}
			>
				{checked ? (
					<HugeiconsIcon
						icon={Tick01Icon}
						className="size-3 text-background"
						strokeWidth={3.5}
						aria-hidden
					/>
				) : null}
			</span>
		</span>
	);
}
