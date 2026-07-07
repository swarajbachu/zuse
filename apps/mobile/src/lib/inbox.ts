import type { Chat, Folder, Session, SessionStatus } from "@zuse/wire";

import type { ConnectionRecord } from "~/store/connections";
import type { ProjectBundle } from "~/store/sessions";
import {
  projectAvatarUrl,
  visibleConnectionLabel,
  visibleProjectPath,
} from "./display-names";
import { connectionSessionKey } from "./session-key";

const INITIAL_VISIBLE_CHATS = 6;
const SHOW_MORE_STEP = 10;

export type InboxChatRow = {
  key: string;
  connectionKey: string;
  connectionLabel: string;
  projectId: Folder["id"];
  projectName: string;
  projectPath: string;
  chat: Chat | null;
  session: Session;
  title: string;
  subtitle: string;
  status: SessionStatus;
  unread: boolean;
  updatedAt: number;
};

export type InboxProjectGroup = {
  key: string;
  connectionKey: string;
  connectionLabel: string;
  projectId: Folder["id"];
  title: string;
  path: string;
  displayPath: string;
  avatarUrl: string | null;
  rows: InboxChatRow[];
  unreadCount: number;
  activeCount: number;
  updatedAt: number;
};

export type InboxGroupDisplayState = {
  collapsed: boolean;
  visibleCount: number;
};

export const DEFAULT_INBOX_GROUP_DISPLAY: InboxGroupDisplayState = {
  collapsed: false,
  visibleCount: INITIAL_VISIBLE_CHATS,
};

export type InboxListItem =
  | {
      type: "header";
      key: string;
      group: InboxProjectGroup;
      collapsed: boolean;
      isFirst: boolean;
    }
  | {
      type: "chat";
      key: string;
      row: InboxChatRow;
      isLast: boolean;
    }
  | {
      type: "show-more";
      key: string;
      groupKey: string;
      hiddenCount: number;
      canShowLess: boolean;
    };

export type InboxDisplayAction = "toggle-collapsed" | "show-more" | "show-less";

export const nextInboxGroupDisplay = (
  current: InboxGroupDisplayState,
  action: InboxDisplayAction,
): InboxGroupDisplayState => {
  switch (action) {
    case "toggle-collapsed":
      return { ...current, collapsed: !current.collapsed };
    case "show-more":
      return {
        ...current,
        visibleCount: current.visibleCount + SHOW_MORE_STEP,
      };
    case "show-less":
      return DEFAULT_INBOX_GROUP_DISPLAY;
  }
};

export const buildInboxGroups = ({
  connections,
  bundlesByConnection,
  statusBySession,
  query,
}: {
  connections: readonly ConnectionRecord[];
  bundlesByConnection: Record<string, readonly ProjectBundle[]>;
  statusBySession: Record<string, SessionStatus>;
  query: string;
}): InboxProjectGroup[] => {
  const normalizedQuery = query.trim().toLowerCase();
  const groups: InboxProjectGroup[] = [];

  for (const connection of connections) {
    const bundles = bundlesByConnection[connection.key] ?? [];
    for (const bundle of bundles) {
      const rows = buildRowsForProject({
        connection,
        bundle,
        statusBySession,
      }).filter((row) => matchesQuery(row, normalizedQuery));
      if (rows.length === 0) continue;

      rows.sort(compareRows);
      groups.push({
        key: `${connection.key}:${bundle.project.id}`,
        connectionKey: connection.key,
        connectionLabel: visibleConnectionLabel(connection.label),
        projectId: bundle.project.id,
        title: bundle.project.name,
        path: bundle.project.path,
        displayPath: visibleProjectPath(bundle.project.path),
        avatarUrl: projectAvatarUrl(bundle.project.path, bundle.project.name),
        rows,
        unreadCount: rows.filter((row) => row.unread).length,
        activeCount: rows.filter((row) => isActiveStatus(row.status)).length,
        updatedAt: Math.max(...rows.map((row) => row.updatedAt), 0),
      });
    }
  }

  return groups.sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title));
};

export const buildInboxListItems = ({
  groups,
  displayStates,
  searching,
}: {
  groups: readonly InboxProjectGroup[];
  displayStates: ReadonlyMap<string, InboxGroupDisplayState>;
  searching: boolean;
}): InboxListItem[] => {
  const items: InboxListItem[] = [];
  for (const [index, group] of groups.entries()) {
    const display = displayStates.get(group.key) ?? DEFAULT_INBOX_GROUP_DISPLAY;
    const collapsed = display.collapsed && !searching;
    items.push({
      type: "header",
      key: `header:${group.key}`,
      group,
      collapsed,
      isFirst: index === 0,
    });
    if (collapsed) continue;

    const visibleCount = searching
      ? group.rows.length
      : Math.min(display.visibleCount, group.rows.length);
    const visibleRows = group.rows.slice(0, visibleCount);
    const hiddenCount = group.rows.length - visibleCount;

    for (const [rowIndex, row] of visibleRows.entries()) {
      items.push({
        type: "chat",
        key: row.key,
        row,
        isLast: rowIndex === visibleRows.length - 1 && hiddenCount === 0,
      });
    }

    if (!searching && group.rows.length > INITIAL_VISIBLE_CHATS) {
      items.push({
        type: "show-more",
        key: `show-more:${group.key}`,
        groupKey: group.key,
        hiddenCount,
        canShowLess: visibleCount > INITIAL_VISIBLE_CHATS,
      });
    }
  }
  return items;
};

const buildRowsForProject = ({
  connection,
  bundle,
  statusBySession,
}: {
  connection: ConnectionRecord;
  bundle: ProjectBundle;
  statusBySession: Record<string, SessionStatus>;
}): InboxChatRow[] => {
  const rows: InboxChatRow[] = [];
  const sessionsByChat = new Map<string, Session[]>();
  for (const session of bundle.sessions) {
    const list = sessionsByChat.get(session.chatId) ?? [];
    list.push(session);
    sessionsByChat.set(session.chatId, list);
  }

  for (const chat of bundle.chats) {
    const sessions = sessionsByChat.get(chat.id) ?? [];
    const session =
      sessions.find((item) => item.id === chat.activeSessionId) ?? sessions[0];
    if (session === undefined) continue;
    rows.push(rowForSession({ connection, bundle, session, chat, statusBySession }));
  }

  const chatIds = new Set(bundle.chats.map((chat) => chat.id));
  for (const session of bundle.sessions) {
    if (chatIds.has(session.chatId)) continue;
    rows.push(rowForSession({ connection, bundle, session, chat: null, statusBySession }));
  }

  return rows;
};

const rowForSession = ({
  connection,
  bundle,
  session,
  chat,
  statusBySession,
}: {
  connection: ConnectionRecord;
  bundle: ProjectBundle;
  session: Session;
  chat: Chat | null;
  statusBySession: Record<string, SessionStatus>;
}): InboxChatRow => {
  const status =
    statusBySession[connectionSessionKey(connection.key, session.id)] ?? session.status;
  return {
    key: `chat:${connection.key}:${chat?.id ?? session.id}`,
    connectionKey: connection.key,
    connectionLabel: visibleConnectionLabel(connection.label),
    projectId: bundle.project.id,
    projectName: bundle.project.name,
    projectPath: bundle.project.path,
    chat,
    session,
    title: chat?.title ?? session.title,
    subtitle: `${session.providerId} / ${session.model}`,
    status,
    unread: chat !== null && isUnreadChat(chat),
    updatedAt: timestampOf(chat?.lastMessageAt ?? chat?.updatedAt ?? chat?.createdAt ?? 0),
  };
};

const compareRows = (a: InboxChatRow, b: InboxChatRow): number => {
  const active = Number(isActiveStatus(b.status)) - Number(isActiveStatus(a.status));
  if (active !== 0) return active;
  const unread = Number(b.unread) - Number(a.unread);
  if (unread !== 0) return unread;
  return b.updatedAt - a.updatedAt || a.title.localeCompare(b.title);
};

const matchesQuery = (row: InboxChatRow, query: string): boolean => {
  if (query.length === 0) return true;
  return [
    row.title,
    row.projectName,
    row.projectPath,
    row.connectionLabel,
    row.subtitle,
    row.status,
    row.chat?.id,
    row.session.id,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(query);
};

const isActiveStatus = (status: SessionStatus): boolean =>
  status === "running" || status === "booting";

const isUnreadChat = (chat: Chat): boolean => {
  const lastMessageAt = timestampOf(chat.lastMessageAt);
  const lastReadAt = timestampOf(chat.lastReadAt);
  return lastMessageAt > 0 && lastReadAt > 0 && lastMessageAt > lastReadAt;
};

const timestampOf = (value: unknown): number => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" || typeof value === "number") {
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }
  return 0;
};
