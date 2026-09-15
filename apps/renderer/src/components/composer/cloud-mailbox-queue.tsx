import "@zuse/i18n/english/chat";
import type { PendingCommand } from "@zuse/client-runtime/resource-state";
import { CommandId, type Message } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { useState } from "react";
import { cancelSessionCommand } from "../../lib/session-timeline-client-bus.ts";

/** Displays the durable mailbox without introducing a second delivery queue. */
export function CloudMailboxQueue({
	messages,
	commands,
	waitingForCloud = false,
}: {
	readonly messages: readonly Message[];
	readonly commands: readonly PendingCommand[];
	readonly waitingForCloud?: boolean;
}) {
	const { message } = useMessages(["chat", "common"]);
	const [error, setError] = useState(false);
	const [cancelling, setCancelling] = useState<string | null>(null);
	if (messages.length === 0) return null;
	return (
		<div>
			<div className="border-b border-border/40 px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
				{message(
					waitingForCloud
						? "chat:cloud_queue_waiting_for_cloud"
						: "chat:cloud_queue_waiting_for_agent",
				)}
			</div>
			{messages.map((item) => {
				const commandId = CommandId.make(`message-send:${item.id}`);
				const command = commands.find(
					(command) => command.commandId === commandId,
				);
				const content = item.content;
				if (content._tag !== "user" && content._tag !== "user_rich")
					return null;
				return (
					<div
						key={item.id}
						className="flex items-start gap-2 border-b border-border/40 px-3 py-2 text-xs"
					>
						<div className="min-w-0 flex-1">
							<p className="line-clamp-3 whitespace-pre-wrap break-words">
								{content.text}
							</p>
							{content._tag === "user_rich" &&
							content.attachments.length > 0 ? (
								<p className="truncate text-muted-foreground">
									{content.attachments
										.map((file) => file.originalName)
										.join(", ")}
								</p>
							) : null}
						</div>
						{command?.cancellable ? (
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
						) : null}
					</div>
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
