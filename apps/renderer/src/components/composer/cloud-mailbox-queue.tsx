import "@zuse/i18n/english/chat";
import type { PendingCommand } from "@zuse/client-runtime/resource-state";
import { CommandId, type Message } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { type ReactNode, useState } from "react";
import type { CloudQueueStatus } from "../../lib/cloud-queue-status.ts";
import { cancelSessionCommand } from "../../lib/session-timeline-client-bus.ts";
import { ShimmerText } from "../ui/shimmer-text.tsx";
import { Spinner } from "../ui/spinner.tsx";

/** The one status line for prompts waiting on cloud compute. */
export function CloudQueueStatusHeader({
	status,
}: {
	readonly status: CloudQueueStatus;
}) {
	return (
		<div
			role="status"
			aria-live="polite"
			className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5 text-[11px] font-medium text-muted-foreground"
		>
			{status.busy ? (
				<Spinner
					className="size-3 shrink-0 motion-reduce:animate-none"
					aria-hidden="true"
					role="presentation"
				/>
			) : null}
			{status.busy ? (
				<ShimmerText tone="lime">{status.label}</ShimmerText>
			) : (
				<span>{status.label}</span>
			)}
		</div>
	);
}

/** A prompt waiting in the cloud queue, before or after the chat exists. */
export function CloudQueuedPrompt({
	text,
	attachmentNames,
	action,
}: {
	readonly text: string;
	readonly attachmentNames: readonly string[];
	readonly action?: ReactNode;
}) {
	return (
		<div className="flex items-start gap-2 border-b border-border/40 px-3 py-2 text-xs">
			<div className="min-w-0 flex-1">
				<p className="line-clamp-3 whitespace-pre-wrap break-words">{text}</p>
				{attachmentNames.length > 0 ? (
					<p className="truncate text-muted-foreground">
						{attachmentNames.join(", ")}
					</p>
				) : null}
			</div>
			{action}
		</div>
	);
}

/** Displays the durable mailbox without introducing a second delivery queue. */
export function CloudMailboxQueue({
	messages,
	commands,
	status,
}: {
	readonly messages: readonly Message[];
	readonly commands: readonly PendingCommand[];
	readonly status: CloudQueueStatus;
}) {
	const { message } = useMessages(["chat", "common"]);
	const [error, setError] = useState(false);
	const [cancelling, setCancelling] = useState<string | null>(null);
	if (messages.length === 0) return null;
	return (
		<div>
			<CloudQueueStatusHeader status={status} />
			{messages.map((item) => {
				const commandId = CommandId.make(`message-send:${item.id}`);
				const command = commands.find(
					(command) => command.commandId === commandId,
				);
				const content = item.content;
				if (content._tag !== "user" && content._tag !== "user_rich")
					return null;
				return (
					<CloudQueuedPrompt
						key={item.id}
						text={content.text}
						attachmentNames={
							content._tag === "user_rich"
								? content.attachments.map((file) => file.originalName)
								: []
						}
						action={
							command?.cancellable ? (
								<button
									type="button"
									className="h-7 shrink-0 rounded-md px-2 text-muted-foreground hover:bg-muted"
									disabled={cancelling !== null}
									onClick={() => {
										setCancelling(item.id);
										setError(false);
										void cancelSessionCommand(commandId)
											.catch(() => setError(true))
											.finally(() => setCancelling(null));
									}}
								>
									{message("common:cancel")}
								</button>
							) : null
						}
					/>
				);
			})}
			{error ? (
				<p role="alert" className="px-3 py-1.5 text-xs text-destructive">
					{message("chat:cloud_queue_cancel_failed")}
				</p>
			) : null}
		</div>
	);
}
