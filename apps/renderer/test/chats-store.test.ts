import { beforeEach, describe, expect, it } from "bun:test";

import type { Chat, ChatId, FolderId, Session, SessionId } from "@memoize/wire";

import { useChatsStore } from "../src/store/chats.ts";
import { useSessionsStore } from "../src/store/sessions.ts";
import { useUiStore } from "../src/store/ui.ts";
import { useWorkspaceStore } from "../src/store/workspace.ts";

const projectId = "proj-1" as FolderId;
const chatId = "chat-1" as ChatId;
const sessionId = "session-1" as SessionId;
const now = new Date("2026-06-21T00:00:00.000Z");

const chat: Chat = {
  id: chatId,
  projectId,
  worktreeId: null,
  title: "Lag fix",
  activeSessionId: sessionId,
  archivedAt: null,
  lastMessageAt: null,
  lastReadAt: now,
  createdAt: now,
  updatedAt: now,
};

const session: Session = {
  id: sessionId,
  projectId,
  title: "Main",
  providerId: "codex",
  model: "gpt-5.4",
  status: "idle",
  archivedAt: null,
  cursor: null,
  resumeStrategy: "none",
  runtimeMode: "approval-required",
  worktreeId: null,
  chatId,
  forkedFromSessionId: null,
  forkedFromMessageId: null,
  permissionMode: "default",
  toolSearch: false,
  createdAt: now,
  updatedAt: now,
};

describe("chats store selection", () => {
  beforeEach(() => {
    useUiStore.setState({ activeMainTab: "chat" });
    useWorkspaceStore.setState({ selectedFolderId: projectId });
    useSessionsStore.setState({
      sessionsByProject: { [projectId]: [session] },
      selectedSessionId: null,
      selectedSessionByProject: {},
    });
    useChatsStore.setState({
      chatsByProject: { [projectId]: [chat] },
      selectedChatId: null,
      selectedChatByProject: {},
      error: null,
    });
  });

  it("returns to the chat surface when selecting a chat from usage", () => {
    useUiStore.setState({ activeMainTab: "usage" });

    useChatsStore.getState().select(chatId);

    expect(useUiStore.getState().activeMainTab).toBe("chat");
    expect(useChatsStore.getState().selectedChatId).toBe(chatId);
    expect(useSessionsStore.getState().selectedSessionId).toBe(sessionId);
  });

  it("does not force the chat surface when clearing selection", () => {
    useUiStore.setState({ activeMainTab: "usage" });

    useChatsStore.getState().select(null);

    expect(useUiStore.getState().activeMainTab).toBe("usage");
    expect(useChatsStore.getState().selectedChatId).toBeNull();
    expect(useSessionsStore.getState().selectedSessionId).toBeNull();
  });
});
