import { describe, expect, it } from "vitest";

import type { ChatId, Session, SessionId } from "@zuse/contracts";

import { activeChatId, orderedChatTabs } from "../src/lib/tab-order.ts";

// Minimal session shape — only the fields the ordering logic reads.
const session = (
  id: string,
  chatId: string,
  createdAt: string,
  archivedAt: string | null = null,
): Session =>
  ({
    id: id as SessionId,
    chatId: chatId as ChatId,
    createdAt,
    archivedAt,
  }) as unknown as Session;

describe("orderedChatTabs", () => {
  it("returns non-archived sessions of the chat, oldest first", () => {
    const sessions = [
      session("c", "chat-1", "2024-01-03T00:00:00Z"),
      session("a", "chat-1", "2024-01-01T00:00:00Z"),
      session("b", "chat-1", "2024-01-02T00:00:00Z"),
      session("other", "chat-2", "2024-01-01T00:00:00Z"),
      session("archived", "chat-1", "2024-01-04T00:00:00Z", "2024-02-01T00:00:00Z"),
    ];
    const tabs = orderedChatTabs(sessions, "chat-1" as ChatId);
    expect(tabs.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("returns empty for a null chat", () => {
    expect(orderedChatTabs([session("a", "chat-1", "2024-01-01T00:00:00Z")], null)).toEqual([]);
  });
});

describe("activeChatId", () => {
  const sessions = [
    session("a", "chat-1", "2024-01-01T00:00:00Z"),
    session("b", "chat-2", "2024-01-02T00:00:00Z"),
  ];

  it("prefers the chat owning the selected session", () => {
    expect(
      activeChatId(sessions, "b" as SessionId, "chat-1" as ChatId),
    ).toBe("chat-2");
  });

  it("falls back to the selected chat when no session is selected", () => {
    expect(activeChatId(sessions, null, "chat-1" as ChatId)).toBe("chat-1");
  });

  it("falls back to the selected chat when the session is unknown", () => {
    expect(
      activeChatId(sessions, "ghost" as SessionId, "chat-2" as ChatId),
    ).toBe("chat-2");
  });
});
