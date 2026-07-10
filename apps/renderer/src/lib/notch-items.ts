import type {
  Chat,
  Folder,
  Message,
  PermissionRequest,
  Session,
} from "@zuse/contracts";

import {
  deriveChatAttentionState,
  derivePermissionAttention,
  mergeChatAttentionStates,
  type ChatAttentionState,
} from "./chat-attention-state.ts";
import type { NotchTrayItem, NotchTrayItemState } from "./bridge.ts";

export const NOTCH_COMPLETION_TTL_MS = 30_000;

export type RecentCompletion = {
  readonly completedAt: number;
};

export type BuildNotchItemsInput = {
  readonly folders: ReadonlyArray<Folder>;
  readonly chatsByProject: Record<string, ReadonlyArray<Chat>>;
  readonly sessionsByProject: Record<string, ReadonlyArray<Session>>;
  readonly messagesBySession: Record<string, ReadonlyArray<Message>>;
  readonly runningBySession: Record<string, boolean>;
  readonly permissionRequests: ReadonlyArray<PermissionRequest>;
  readonly recentCompletions: Readonly<Record<string, RecentCompletion>>;
  readonly now: number;
};

const statePriority: Record<NotchTrayItemState, number> = {
  running: 1,
  completed: 2,
  failed: 3,
  planReady: 4,
  question: 5,
  permission: 6,
};

const attentionToNotchState = (
  state: ChatAttentionState,
): NotchTrayItemState | null => {
  switch (state) {
    case "running":
      return "running";
    case "planReady":
      return "planReady";
    case "question":
      return "question";
    case "permission":
      return "permission";
    case "idle":
      return null;
  }
};

const labelFor = (state: NotchTrayItemState): string => {
  switch (state) {
    case "permission":
      return "Permission";
    case "question":
      return "Question";
    case "planReady":
      return "Plan";
    case "failed":
      return "Failed";
    case "completed":
      return "Done";
    case "running":
      return "Running";
  }
};

const subtitleFor = (
  state: NotchTrayItemState,
  folderName: string,
  session: Session,
): string => {
  switch (state) {
    case "permission":
      return `${folderName} needs approval`;
    case "question":
      return `${folderName} has a question`;
    case "planReady":
      return `${folderName} has a plan ready`;
    case "failed":
      return `${folderName} stopped with an error`;
    case "completed":
      return `${folderName} completed a turn`;
    case "running":
      return `${folderName} is running ${session.providerId}`;
  }
};

export const pruneRecentCompletions = (
  recent: Readonly<Record<string, RecentCompletion>>,
  now: number,
): Record<string, RecentCompletion> => {
  const next: Record<string, RecentCompletion> = {};
  for (const [sessionId, completion] of Object.entries(recent)) {
    if (now - completion.completedAt <= NOTCH_COMPLETION_TTL_MS) {
      next[sessionId] = completion;
    }
  }
  return next;
};

export const noteCompletedSessions = (
  previousRunning: Readonly<Record<string, boolean>>,
  nextRunning: Readonly<Record<string, boolean>>,
  previousRecent: Readonly<Record<string, RecentCompletion>>,
  now: number,
): Record<string, RecentCompletion> => {
  const next = pruneRecentCompletions(previousRecent, now);
  for (const [sessionId, wasRunning] of Object.entries(previousRunning)) {
    if (wasRunning && nextRunning[sessionId] !== true) {
      next[sessionId] = { completedAt: now };
    }
  }
  return next;
};

export const buildNotchItems = ({
  folders,
  chatsByProject,
  sessionsByProject,
  messagesBySession,
  runningBySession,
  permissionRequests,
  recentCompletions,
  now,
}: BuildNotchItemsInput): ReadonlyArray<NotchTrayItem> => {
  const folderById = new Map(folders.map((folder) => [folder.id, folder]));
  const chatById = new Map<string, Chat>();

  for (const chats of Object.values(chatsByProject)) {
    for (const chat of chats) {
      chatById.set(chat.id, chat);
    }
  }

  const items: NotchTrayItem[] = [];
  for (const sessions of Object.values(sessionsByProject)) {
    for (const session of sessions) {
      if (session.archivedAt !== null) continue;
      const chat = chatById.get(session.chatId);
      if (chat === undefined || chat.archivedAt !== null) continue;
      const folder = folderById.get(session.projectId);
      const attention = mergeChatAttentionStates([
        deriveChatAttentionState(
          messagesBySession[session.id] ?? [],
          runningBySession[session.id] === true || session.status === "running",
        ),
        derivePermissionAttention(permissionRequests, new Set([session.id])),
      ]);

      let state = attentionToNotchState(attention);
      let updatedAt = now;
      if (session.status === "error") {
        state = "failed";
      } else if (state === null) {
        const completed = recentCompletions[session.id];
        if (
          completed !== undefined &&
          now - completed.completedAt <= NOTCH_COMPLETION_TTL_MS
        ) {
          state = "completed";
          updatedAt = completed.completedAt;
        }
      }
      if (state === null) continue;

      const folderName = folder?.name ?? "Project";
      items.push({
        id: `${session.id}:${state}`,
        chatId: session.chatId,
        sessionId: session.id,
        title: chat.title || session.title || "Agent",
        subtitle: subtitleFor(state, folderName, session),
        state,
        label: labelFor(state),
        updatedAt,
      });
    }
  }

  return items.sort((a, b) => {
    const priorityDelta = statePriority[b.state] - statePriority[a.state];
    if (priorityDelta !== 0) return priorityDelta;
    return b.updatedAt - a.updatedAt;
  });
};
