import "@zuse/i18n/english/common";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMessages } from "@zuse/i18n/react";
import { Cancel01Icon, Comment01Icon } from "@zuse/icons/stroke-rounded";
import type { ReactNode } from "react";
import { useState } from "react";
import {
	PreviewCard,
	PreviewCardPopup,
	PreviewCardTrigger,
} from "./ui/preview-card.tsx";

export const contextPillClass =
	"inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-border/50 bg-muted/60 px-2.5 text-xs text-foreground";
/** Shared compact context presentation in drafts and sent messages. */
export function ContextPill({
	label,
	children,
	onRemove,
}: {
	label: string;
	children: ReactNode;
	onRemove?: () => void;
}) {
	const { message } = useMessages(["common"]);
	const [open, setOpen] = useState(false);
	return (
		<span className={contextPillClass}>
			<PreviewCard open={open} onOpenChange={setOpen}>
				<PreviewCardTrigger
					delay={200}
					render={
						<button
							type="button"
							onClick={() => setOpen((value) => !value)}
							className="flex min-w-0 items-center gap-1.5 outline-none focus-visible:underline"
						/>
					}
				>
					<HugeiconsIcon icon={Comment01Icon} className="size-3.5 shrink-0" />
					<span className="truncate">{label}</span>
				</PreviewCardTrigger>
				<PreviewCardPopup
					side="top"
					align="start"
					sideOffset={6}
					className="w-[min(26rem,calc(100vw-2rem))] p-2"
				>
					<div className="max-h-80 min-w-0 flex-1 overflow-y-auto overscroll-contain text-xs">
						{children}
					</div>
				</PreviewCardPopup>
			</PreviewCard>
			{onRemove && (
				<button
					type="button"
					className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
					aria-label={`${message("common:remove")} ${label}`}
					onClick={onRemove}
				>
					<HugeiconsIcon icon={Cancel01Icon} className="size-3" />
				</button>
			)}
		</span>
	);
}
