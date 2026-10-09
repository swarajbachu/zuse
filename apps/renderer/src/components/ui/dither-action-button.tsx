import { DitherButton, type DitherButtonProps } from "@repo/ui/dither";
import { cn } from "~/lib/utils";
import { Spinner } from "./spinner.tsx";

const NEUTRAL: DitherButtonProps["color"] = [92, 96, 104];

/**
 * Compact h-7 action with the dither fill. `primary` is the row's main call
 * to action; `secondary` is a quieter neutral fill for follow-up actions.
 */
export function DitherActionButton({
	tone = "primary",
	loading = false,
	disabled,
	className,
	children,
	...props
}: Omit<DitherButtonProps, "color" | "variant"> & {
	tone?: "primary" | "secondary";
	loading?: boolean;
}) {
	return (
		<DitherButton
			variant="gradient"
			color={tone === "primary" ? undefined : NEUTRAL}
			disabled={disabled || loading}
			aria-busy={loading || undefined}
			className={cn(
				"h-7 shrink-0 whitespace-nowrap px-3 text-[11px] font-medium text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.65)]",
				className,
			)}
			{...props}
		>
			{loading ? <Spinner className="size-3" /> : children}
		</DitherButton>
	);
}
