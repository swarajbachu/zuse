import { formatDate as formatUiDate } from "@zuse/i18n";
import "@zuse/i18n/english/chat";
import type {
	FolderId,
	ForkDestination,
	MessageId,
	SessionId,
} from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";

import { cn } from "~/lib/utils";
import { CopyButton } from "./copy-button.tsx";
import { ForkButton } from "./fork-menu.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip.tsx";

const formatMessageTime = (date: Date): string =>
	formatUiDate(date, {
		hour: "numeric",
		minute: "2-digit",
	});

const formatFullMessageTime = (date: Date): string =>
	formatUiDate(date, {
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
	forkDestination,
	sourceProjectId,
	className,
}: {
	readonly text: string;
	readonly createdAt?: Date;
	readonly elapsed?: string;
	readonly sessionId?: SessionId;
	readonly messageId?: MessageId;
	readonly showMessageCommands?: boolean;
	readonly forkDestination?: ForkDestination;
	readonly sourceProjectId?: FolderId;
	readonly className?: string;
}) {
	if (!showMessageCommands) return null;

	return (
		<MessageActions
			text={text}
			createdAt={createdAt}
			elapsed={elapsed}
			sessionId={sessionId}
			messageId={messageId}
			forkDestination={forkDestination}
			sourceProjectId={sourceProjectId}
			className={className}
		/>
	);
}

export function MessageActions({
	text,
	createdAt,
	elapsed,
	sessionId,
	messageId,
	forkLabel = "response",
	forkDestination,
	sourceProjectId,
	className,
}: {
	readonly text: string;
	readonly createdAt?: Date;
	readonly elapsed?: string;
	readonly sessionId?: SessionId;
	readonly messageId?: MessageId;
	readonly forkLabel?: "message" | "response";
	readonly forkDestination?: ForkDestination;
	readonly sourceProjectId?: FolderId;
	readonly className?: string;
}) {
	const { message: uiMessage } = useUiMessages(["chat"]);

	return (
		<div className={cn("flex items-center gap-1", className)}>
			<CopyButton
				text={text}
				label={uiMessage("chat:assistant_message_actions_copy_message")}
				className="active:scale-[0.97] [@media(pointer:coarse)]:size-11"
			/>
			{sessionId !== undefined && messageId !== undefined ? (
				<ForkButton
					sourceSessionId={sessionId}
					fromMessageId={messageId}
					label={forkLabel}
					fixedDestination={forkDestination}
					sourceProjectId={sourceProjectId}
				/>
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
