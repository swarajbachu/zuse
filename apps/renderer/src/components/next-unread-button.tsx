import { ArrowRight01Icon } from "@hugeicons-pro/core-solid-rounded";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo } from "react";

import type { Chat } from "@zuse/contracts";

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
  const chatsByProject = useChatsStore((s) => s.chatsByProject);
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
  }, [chatsByProject, selectedChatId]);

  if (nextUnread === null) return null;

  return (
    <Button
      variant="outline"
      size="xs"
      className="pointer-events-auto text-muted-foreground"
      onClick={() => selectChat(nextUnread.id)}
      title="Jump to the next chat with unread activity"
    >
      Next
      <HugeiconsIcon icon={ArrowRight01Icon} className="size-3.5" />
    </Button>
  );
}
