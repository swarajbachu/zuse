import { beforeEach, describe, expect, it } from "bun:test";

import type { Chat, ChatId, FolderId, Session, SessionId } from "@zuse/wire";

import {
  archiveChatWithConfirm,
  resetArchiveDirtyConfirm,
  setArchiveDirtyConfirm,
  useChatsStore,
} from "../src/store/chats.ts";
import { useSessionsStore } from "../src/store/sessions.ts";
import { useUiStore } from "../src/store/ui.ts";
import { useWorkspaceStore } from "../src/store/workspace.ts";

const projectId = "proj-1" as FolderId;
const chatId = "chat-1" as ChatId;
const sessionId = "session-1" as SessionId;
const now = new Date("2026-06-21T00:00:00.000Z");
const initialChatsState = useChatsStore.getInitialState();

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

const withConfirm = async (
  confirmed: boolean,
  fn: () => Promise<void>,
): Promise<void> => {
  setArchiveDirtyConfirm(async () => confirmed);
  try {
    await fn();
  } finally {
    resetArchiveDirtyConfirm();
  }
};

const deferred = <T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
      archiveProgressByChat: {},
      error: null,
      archive: initialChatsState.archive,
      setArchiveProgress: initialChatsState.setArchiveProgress,
      clearArchiveProgress: initialChatsState.clearArchiveProgress,
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

describe("archiveChatWithConfirm", () => {
  beforeEach(() => {
    resetArchiveDirtyConfirm();
    useChatsStore.setState({
      chatsByProject: { [projectId]: [chat] },
      selectedChatId: chatId,
      selectedChatByProject: { [projectId]: chatId },
      archiveProgressByChat: {},
      error: null,
      archive: initialChatsState.archive,
      setArchiveProgress: initialChatsState.setArchiveProgress,
      clearArchiveProgress: initialChatsState.clearArchiveProgress,
    });
  });

  it("sets archive progress during the first archive attempt and clears it on success", async () => {
    const first = deferred<{ readonly ok: true }>();
    useChatsStore.setState({
      archive: async () => first.promise,
    });

    const run = archiveChatWithConfirm(chatId);

    expect(useChatsStore.getState().archiveProgressByChat[chatId]).toBe(
      "archiving",
    );
    first.resolve({ ok: true });
    await run;
    expect(
      useChatsStore.getState().archiveProgressByChat[chatId],
    ).toBeUndefined();
  });

  it("retries dirty worktree archives with force after confirmation", async () => {
    const calls: Array<boolean | undefined> = [];
    useChatsStore.setState({
      archive: async (_chatId, force) => {
        calls.push(force);
        return force === true
          ? ({ ok: true } as const)
          : ({
              ok: false,
              dirty: true,
              reason: "Worktree has uncommitted changes.",
            } as const);
      },
    });
    await withConfirm(true, async () => {
      await archiveChatWithConfirm(chatId);
    });

    expect(calls).toEqual([undefined, true]);
  });

  it("switches progress while removing a confirmed dirty worktree", async () => {
    const forced = deferred<{ readonly ok: true }>();
    const calls: Array<boolean | undefined> = [];
    setArchiveDirtyConfirm(async () => true);
    useChatsStore.setState({
      archive: async (_chatId, force) => {
        calls.push(force);
        return force === true
          ? forced.promise
          : ({
              ok: false,
              dirty: true,
              reason: "Worktree has uncommitted changes.",
            } as const);
      },
    });

    const run = archiveChatWithConfirm(chatId);
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual([undefined, true]);
    expect(useChatsStore.getState().archiveProgressByChat[chatId]).toBe(
      "removing-dirty-worktree",
    );
    forced.resolve({ ok: true });
    try {
      await run;
    } finally {
      resetArchiveDirtyConfirm();
    }
    expect(
      useChatsStore.getState().archiveProgressByChat[chatId],
    ).toBeUndefined();
  });

  it("stops quietly when dirty archive removal is declined", async () => {
    const calls: Array<boolean | undefined> = [];
    useChatsStore.setState({
      error: null,
      archive: async (_chatId, force) => {
        calls.push(force);
        return {
          ok: false,
          dirty: true,
          reason: "Worktree has uncommitted changes.",
        } as const;
      },
    });
    await withConfirm(false, async () => {
      await archiveChatWithConfirm(chatId);
    });

    expect(calls).toEqual([undefined]);
    expect(useChatsStore.getState().error).toBeNull();
    expect(
      useChatsStore.getState().archiveProgressByChat[chatId],
    ).toBeUndefined();
  });

  it("clears progress and throws when forced dirty removal fails", async () => {
    useChatsStore.setState({
      archive: async (_chatId, force) =>
        force === true
          ? ({
              ok: false,
              dirty: false,
              reason: "git worktree remove failed",
            } as const)
          : ({
              ok: false,
              dirty: true,
              reason: "Worktree has uncommitted changes.",
            } as const),
    });

    await expect(
      withConfirm(true, async () => archiveChatWithConfirm(chatId)),
    ).rejects.toThrow("git worktree remove failed");
    expect(
      useChatsStore.getState().archiveProgressByChat[chatId],
    ).toBeUndefined();
  });
});
