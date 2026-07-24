import type { MessageId, SessionId } from "@zuse/contracts";

import { cn } from "~/lib/utils";
import { CopyButton } from "./copy-button.tsx";
import { ForkButton } from "./fork-menu.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip.tsx";

const formatMessageTime = (date: Date): string =>
	date.toLocaleTimeString([], {
		hour: "numeric",
		minute: "2-digit",
	});

const formatFullMessageTime = (date: Date): string =>
	date.toLocaleString([], {
		dateStyle: "full",
		timeStyle: "short",
	});

export function AssistantMessageActions({
	text,
	createdAt,
	elapsed,
	sessionId,
	messageId,
	showMessageCommands = false,
	className,
}: {
	readonly text: string;
	readonly createdAt?: Date;
	readonly elapsed?: string;
	readonly sessionId?: SessionId;
	readonly messageId?: MessageId;
	readonly showMessageCommands?: boolean;
	readonly className?: string;
}) {
	if (!showMessageCommands) return null;

	return (
		<div
			className={cn(
				"flex items-center gap-1 opacity-0 transition-opacity duration-150 ease-out group-hover/assistant:opacity-100 group-focus-within/assistant:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100",
				className,
			)}
		>
			<CopyButton
				text={text}
				label="Copy message"
				className="active:scale-[0.97] [@media(pointer:coarse)]:size-11"
			/>
			{sessionId !== undefined && messageId !== undefined ? (
				<ForkButton sourceSessionId={sessionId} fromMessageId={messageId} />
			) : null}
			{createdAt !== undefined ? (
				<Tooltip>
					<TooltipTrigger
						render={
							<time
								dateTime={createdAt.toISOString()}
								className="cursor-default px-1 text-[11px] tabular-nums text-muted-foreground"
							>
								{formatMessageTime(createdAt)}
							</time>
						}
					/>
					<TooltipPopup>{formatFullMessageTime(createdAt)}</TooltipPopup>
				</Tooltip>
			) : null}
			{elapsed !== undefined ? (
				<span className="cursor-default px-1 text-[11px] tabular-nums text-muted-foreground">
					{elapsed}
				</span>
			) : null}
		</div>
	);
}
