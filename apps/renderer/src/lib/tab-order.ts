import type { ChatId, Session, SessionId } from "@zuse/contracts";

/**
 * Shared tab-strip ordering. The main-pane tab strip (`main-tabs.tsx`) and the
 * keyboard navigation handlers (`commands.ts`) both need the exact same notion
 * of "which sessions are tabs of the active chat, and in what order" — keeping
 * it here means `Cmd+Shift+]` lands on the same tab the user sees to the right.
 */

/**
 * The chat whose sessions fill the tab strip. Prefer the chat owning the
 * active session (it reflects the surface the user is actually looking at);
 * fall back to the sidebar's selected chat during transitions. Mirrors the
 * derivation in `main-tabs.tsx`.
 */
export function activeChatId(
  sessions: ReadonlyArray<Session>,
  selectedSessionId: SessionId | null,
  selectedChatId: ChatId | null,
): ChatId | null {
  if (selectedSessionId !== null) {
    const row = sessions.find((s) => s.id === selectedSessionId);
    if (row !== undefined) return row.chatId;
  }
  return selectedChatId;
}

/**
 * Non-archived sessions in `chatId`, ordered by creation time so the user's
 * mental left-to-right order stays stable.
 */
export function orderedChatTabs(
  sessions: ReadonlyArray<Session>,
  chatId: ChatId | null,
): ReadonlyArray<Session> {
  if (chatId === null) return [];
  return sessions
    .filter((row) => row.chatId === chatId && row.archivedAt === null)
    .slice()
    .sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
}
