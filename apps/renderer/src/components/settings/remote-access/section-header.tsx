import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

import { FrameHeader, FrameTitle } from "../../ui/frame.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip.tsx";

export function RemoteAccessSectionHeader({
	title,
	tooltip,
	action,
	className,
}: {
	readonly title: string;
	readonly tooltip: string;
	readonly action?: ReactNode;
	readonly className?: string;
}) {
	return (
		<FrameHeader
			className={cn(
				"flex-row items-center justify-between gap-3 px-3 py-2.5",
				className,
			)}
		>
			<div className="flex min-w-0 items-center gap-1.5">
				<FrameTitle className="truncate text-[13px] font-medium">
					{title}
				</FrameTitle>
				<Tooltip>
					<TooltipTrigger
						render={
							<button
								type="button"
								aria-label={`About ${title}`}
								className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 outline-none hover:bg-muted hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
							>
								<Info className="size-3.5" aria-hidden />
							</button>
						}
					/>
					<TooltipPopup className="max-w-64">{tooltip}</TooltipPopup>
				</Tooltip>
			</div>
			{action}
		</FrameHeader>
	);
}
