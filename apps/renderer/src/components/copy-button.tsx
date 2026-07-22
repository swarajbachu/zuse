import { HugeiconsIcon } from "@hugeicons/react";
import { Copy01Icon, Tick02Icon } from "@hugeicons-pro/core-solid-rounded";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip.tsx";

export function CopyButton({
	text,
	label = "Copy",
	className,
}: {
	readonly text: string;
	readonly label?: string;
	readonly className?: string;
}) {
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		if (!copied) return;
		const id = window.setTimeout(() => setCopied(false), 1500);
		return () => window.clearTimeout(id);
	}, [copied]);

	const onCopy = () => {
		void navigator.clipboard?.writeText(text).then(() => setCopied(true));
	};

	const icon = copied ? Tick02Icon : Copy01Icon;
	const title = copied ? "Copied" : label;

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						onClick={onCopy}
						aria-label={title}
						className={cn(
							"inline-grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground/70 outline-none",
							"hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
							className,
						)}
					>
						<HugeiconsIcon
							icon={icon}
							className="size-3.5"
							aria-hidden="true"
						/>
					</button>
				}
			/>
			<TooltipPopup>{title}</TooltipPopup>
		</Tooltip>
	);
}
