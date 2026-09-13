import "@zuse/i18n/english/chat";
import type { Chat } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { ChevronRight } from "lucide-react";
import { useMemo } from "react";

import { useActiveEnvironmentEntities } from "../lib/environment-entity-hooks.ts";
import { isChatUnread, useChatsStore } from "../store/chats.ts";
import { Button } from "./ui/button";

/**
 * Jumps to the freshest chat with unread
 * activity, across every project — only renders when something other than
 * the current chat is unread. `select` switches the workspace project if
 * needed, lands on the chat's active tab, and marks it read, so repeated
 * clicks walk through the unread set. Renders nothing when there's nothing
 * unread.
 */
export function NextUnreadButton() {
	const { message: uiMessage } = useUiMessages(["chat"]);

	const { chatsByProject } = useActiveEnvironmentEntities();
	const selectedChatId = useChatsStore((s) => s.selectedChatId);
	const selectChat = useChatsStore((s) => s.select);

	const nextUnread = useMemo(() => {
		let best: Chat | null = null;
		let bestTs = -1;
		for (const list of Object.values(chatsByProject)) {
			for (const chat of list) {
				if (!isChatUnread(chat, selectedChatId)) continue;
				const ts = chat.lastMessageAt?.getTime() ?? 0;
				if (ts > bestTs) {
					best = chat;
					bestTs = ts;
				}
			}
		}
		return best;
	}, [chatsByProject, selectedChatId, uiMessage]);

	if (nextUnread === null) return null;

	return (
		<Button
			variant="outline"
			size="xs"
			className="pointer-events-auto text-muted-foreground"
			onClick={() => selectChat(nextUnread.id)}
			title={uiMessage(
				"chat:next_unread_button_jump_to_the_next_chat_with_unread_activity",
			)}
		>
			{uiMessage("chat:next_unread_button_next")}
			<ChevronRight className="size-3.5" />
		</Button>
	);
}
