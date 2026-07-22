import { HugeiconsIcon } from "@hugeicons/react";
import Loading03Icon from "@hugeicons-pro/core-solid-rounded/Loading03Icon";
import type React from "react";
import { cn } from "~/lib/utils";

export function Spinner({
	className,
	...props
}: Omit<
	React.ComponentProps<typeof HugeiconsIcon>,
	"icon"
>): React.ReactElement {
	return (
		<HugeiconsIcon
			icon={Loading03Icon}
			aria-label="Loading"
			className={cn("animate-spin", className)}
			role="status"
			{...props}
		/>
	);
}
