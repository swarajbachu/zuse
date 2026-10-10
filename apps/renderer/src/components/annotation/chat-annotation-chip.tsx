import { HugeiconsIcon } from "@hugeicons/react";
import type { ChatAnnotation } from "@zuse/contracts";
import { QuoteDownIcon } from "@zuse/icons/solid-rounded";
import { cn } from "~/lib/utils";

/** The quoted transcript text a chat annotation refers to. */
export function ChatAnnotationChip({
	annotation,
	className,
}: {
	readonly annotation: ChatAnnotation;
	readonly className?: string;
}) {
	return (
		<span
			className={cn(
				"inline-flex min-w-0 max-w-full items-center gap-1.5 text-[11px] text-muted-foreground",
				className,
			)}
			title={annotation.quote}
		>
			<HugeiconsIcon
				icon={QuoteDownIcon}
				className="size-3 shrink-0 text-primary"
				aria-hidden="true"
			/>
			<span className="truncate italic">{annotation.quote}</span>
		</span>
	);
}
