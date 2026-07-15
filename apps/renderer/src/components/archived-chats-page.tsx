import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArchiveArrowUpIcon,
  ArchiveIcon,
} from "@hugeicons-pro/core-solid-rounded";
import type { Chat, FolderId, Message, Session } from "@zuse/contracts";
import { useEffect, useMemo } from "react";

import { cn } from "../lib/utils.ts";
import { useArchivePreviewStore } from "../store/archive-preview.ts";
import { useChatsStore } from "../store/chats.ts";
import { ArchivedChatTimeline } from "./archived-chat-timeline.tsx";
import { ProviderIcon } from "./provider-icons.tsx";
import { Button } from "./ui/button.tsx";
import { ShimmerText } from "./ui/shimmer-text.tsx";
import { Spinner } from "./ui/spinner.tsx";

const EMPTY_CHATS: ReadonlyArray<Chat> = [];
const EMPTY_SESSIONS: ReadonlyArray<Session> = [];
const EMPTY_MESSAGES: ReadonlyArray<Message> = [];

const formatDate = (date: Date): string =>
  date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year:
      date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });

export function ArchivedChatsPage({
  projectId,
  projectName,
}: {
  projectId: FolderId | null;
  projectName: string;
}) {
  const archivedChats = useArchivePreviewStore((state) =>
    projectId === null
      ? EMPTY_CHATS
      : (state.chatsByProject[projectId] ?? EMPTY_CHATS),
  );
  const selectedChatId = useArchivePreviewStore((state) =>
    projectId === null
      ? null
      : (state.selectedChatByProject[projectId] ?? null),
  );
  const projectLoading = useArchivePreviewStore((state) =>
    projectId === null ? false : state.loadingByProject[projectId] === true,
  );
  const projectError = useArchivePreviewStore((state) =>
    projectId === null ? null : (state.errorByProject[projectId] ?? null),
  );
  const selectedChat = useMemo(
    () => archivedChats.find((chat) => chat.id === selectedChatId) ?? null,
    [archivedChats, selectedChatId],
  );
  const preview = useArchivePreviewStore((state) =>
    selectedChatId === null ? undefined : state.previewsByChat[selectedChatId],
  );
  const previewLoading = useArchivePreviewStore((state) =>
    selectedChatId === null
      ? false
      : state.previewLoadingByChat[selectedChatId] === true,
  );
  const previewError = useArchivePreviewStore((state) =>
    selectedChatId === null
      ? null
      : (state.errorByChat[selectedChatId] ?? null),
  );
  const sessions = preview?.sessions ?? EMPTY_SESSIONS;
  const selectedSessionId = useArchivePreviewStore((state) =>
    selectedChatId === null
      ? null
      : (state.selectedSessionByChat[selectedChatId] ?? null),
  );
  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );
  const messages = useArchivePreviewStore((state) =>
    selectedSessionId === null
      ? EMPTY_MESSAGES
      : (state.messagesBySession[selectedSessionId] ?? EMPTY_MESSAGES),
  );
  const messagesLoading = useArchivePreviewStore((state) =>
    selectedSessionId === null
      ? false
      : state.messagesLoadingBySession[selectedSessionId] === true,
  );
  const messagesError = useArchivePreviewStore((state) =>
    selectedSessionId === null
      ? null
      : (state.errorBySession[selectedSessionId] ?? null),
  );
  const restoring = useArchivePreviewStore((state) =>
    selectedChatId === null
      ? false
      : state.restoringByChat[selectedChatId] === true,
  );
  const restoreError = useArchivePreviewStore((state) =>
    selectedChatId === null
      ? null
      : (state.restoreErrorByChat[selectedChatId] ?? null),
  );
  const loadProject = useArchivePreviewStore((state) => state.loadProject);
  const openChat = useArchivePreviewStore((state) => state.openChat);
  const selectSession = useArchivePreviewStore((state) => state.selectSession);
  const unarchive = useChatsStore((state) => state.unarchive);

  useEffect(() => {
    if (projectId !== null) void loadProject(projectId);
  }, [loadProject, projectId]);

  if (projectId === null) {
    return <CenteredState text="Select a project to view archived chats." />;
  }
  if (selectedChat === null) {
    if (projectLoading) {
      return <CenteredState text="Loading archived chats…" loading />;
    }
    if (projectError !== null) {
      return (
        <CenteredState
          text={projectError}
          action="Retry"
          onAction={() => void loadProject(projectId, true)}
        />
      );
    }
    return (
      <CenteredState
        text={
          archivedChats.length === 0
            ? `No archived chats in ${projectName}.`
            : "Choose a chat from the Archived folder to preview it."
        }
      />
    );
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background/55">
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border/50 px-5">
        <HugeiconsIcon
          icon={ArchiveIcon}
          className="size-4 shrink-0 text-muted-foreground"
        />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-medium text-foreground">
            {selectedChat.title}
          </h1>
          <p className="truncate text-[11px] text-muted-foreground">
            Archived{" "}
            {formatDate(selectedChat.archivedAt ?? selectedChat.updatedAt)}
          </p>
        </div>
      </header>

      {preview !== undefined && sessions.length > 0 ? (
        <nav
          aria-label="Archived chat sessions"
          className="flex h-11 shrink-0 items-stretch gap-1 overflow-x-auto border-b border-border/50 px-3"
        >
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => void selectSession(selectedChat.id, session.id)}
              className={cn(
                "flex min-w-0 max-w-56 items-center gap-2 border-b-2 px-3 text-xs outline-none transition-colors duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none",
                session.id === selectedSessionId
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
              aria-current={
                session.id === selectedSessionId ? "page" : undefined
              }
            >
              <ProviderIcon
                providerId={session.providerId}
                className="size-3.5"
              />
              <span className="truncate">{session.title}</span>
            </button>
          ))}
        </nav>
      ) : null}

      <div className="flex min-h-0 flex-1 px-3">
        <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col">
          {previewLoading ? (
            <CenteredState text="Loading archived chat…" loading />
          ) : previewError !== null ? (
            <CenteredState
              text={previewError}
              action="Retry"
              onAction={() => void openChat(selectedChat)}
            />
          ) : selectedSession === null ? (
            <CenteredState text="This archived chat has no sessions to preview." />
          ) : messagesLoading ? (
            <CenteredState text="Loading transcript…" loading />
          ) : messagesError !== null ? (
            <CenteredState
              text={messagesError}
              action="Retry"
              onAction={() =>
                void selectSession(selectedChat.id, selectedSession.id)
              }
            />
          ) : messages.length === 0 ? (
            <CenteredState text="No messages in this session." />
          ) : (
            <ArchivedChatTimeline
              projectId={projectId}
              sessionId={selectedSession.id}
              messages={messages}
            />
          )}
        </div>
      </div>

      <footer className="shrink-0 border-t border-border/60 bg-background/92 px-4 py-3 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-4xl items-center gap-3">
          <HugeiconsIcon
            icon={ArchiveIcon}
            className="size-4 shrink-0 text-muted-foreground"
          />
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">
              This chat is archived.
            </p>
            {restoreError !== null ? (
              <p className="mt-0.5 truncate text-[11px] text-destructive">
                {restoreError}
              </p>
            ) : null}
          </div>
          <Button
            variant="settings"
            size="sm"
            disabled={restoring}
            onClick={() => void unarchive(selectedChat.id)}
            className="min-h-11 min-w-28"
          >
            {restoring ? (
              <Spinner className="size-3.5" />
            ) : (
              <HugeiconsIcon icon={ArchiveArrowUpIcon} className="size-3.5" />
            )}
            {restoring ? "Unarchiving…" : restoreError ? "Retry" : "Unarchive"}
          </Button>
        </div>
      </footer>
    </section>
  );
}

function CenteredState({
  text,
  loading = false,
  action,
  onAction,
}: {
  readonly text: string;
  readonly loading?: boolean;
  readonly action?: string;
  readonly onAction?: () => void;
}) {
  return (
    <div className="flex h-full min-h-64 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
      {loading ? <ShimmerText>{text}</ShimmerText> : <p>{text}</p>}
      {action !== undefined && onAction !== undefined ? (
        <Button variant="outline" size="sm" onClick={onAction}>
          {action}
        </Button>
      ) : null}
    </div>
  );
}
