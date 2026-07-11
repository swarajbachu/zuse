import {
  AgentDefinition,
  Chat,
  type ChatId,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_RUNTIME_MODE,
  type FolderId,
  Message,
  MessageContent,
  MessageId,
  type MessageRole,
  PermissionMode,
  ResumeStrategy,
  RuntimeMode,
  Session,
  SessionId,
  type WorktreeId,
} from "@zuse/contracts";
import type { MessageReadRecord } from "@zuse/domain/projectors/read-model";
import type { SqlSessionReadRecord } from "@zuse/domain/queries/sql-session-queries";
import { Option, Schema } from "effect";

export interface SessionRow {
  readonly id: string;
  readonly project_id: string;
  readonly title: string;
  readonly provider_id: string;
  readonly model: string;
  readonly status: string;
  readonly archived_at: string | null;
  readonly cursor: string | null;
  readonly resume_strategy: string;
  readonly runtime_mode: string;
  readonly agents_json: string | null;
  readonly worktree_id: string | null;
  readonly chat_id: string;
  readonly forked_from_session_id: string | null;
  readonly forked_from_message_id: string | null;
  readonly permission_mode: string;
  readonly tool_search: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ChatRow {
  readonly id: string;
  readonly project_id: string;
  readonly worktree_id: string | null;
  readonly title: string;
  readonly active_session_id: string | null;
  readonly origin_session_id: string | null;
  readonly archived_at: string | null;
  readonly archived_worktree_json: string | null;
  readonly last_message_at: string | null;
  readonly last_read_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface MessageRow {
  readonly id: string;
  readonly session_id: string;
  readonly role: string;
  readonly kind: string;
  readonly content_json: string;
  readonly parent_item_id: string | null;
  readonly created_at: string;
}

export interface ArchivedWorktreeSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly path: string;
  readonly name: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly createdAt: string;
}

const ArchivedWorktreeSnapshotSchema = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  path: Schema.String,
  name: Schema.String,
  branch: Schema.String,
  baseBranch: Schema.String,
  createdAt: Schema.String,
});
const decodeArchivedWorktreeSnapshot = Schema.decodeUnknownOption(
  Schema.fromJsonString(ArchivedWorktreeSnapshotSchema),
);
const decodeAgents = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, AgentDefinition)),
);
const decodeMessageContent = Schema.decodeUnknownSync(
  Schema.fromJsonString(MessageContent),
);

export const parseArchivedWorktreeSnapshot = (
  raw: string | null,
): ArchivedWorktreeSnapshot | null =>
  raw === null || raw.length === 0
    ? null
    : Option.getOrNull(decodeArchivedWorktreeSnapshot(raw));

export const parseAgents = (
  raw: string | null,
): Readonly<Record<string, typeof AgentDefinition.Type>> | null =>
  raw === null || raw.length === 0 ? null : Option.getOrNull(decodeAgents(raw));

const runtimeModeFromRow = (raw: string): typeof RuntimeMode.Type =>
  Option.getOrElse(
    Schema.decodeUnknownOption(RuntimeMode)(raw),
    () => DEFAULT_RUNTIME_MODE,
  );

const permissionModeFromRow = (raw: string): typeof PermissionMode.Type =>
  Option.getOrElse(
    Schema.decodeUnknownOption(PermissionMode)(raw),
    () => DEFAULT_PERMISSION_MODE,
  );

const resumeStrategyFromRow = (raw: string): typeof ResumeStrategy.Type =>
  Option.getOrElse(
    Schema.decodeUnknownOption(ResumeStrategy)(raw),
    () => "none" as const,
  );

export const sessionFromRow = (row: SessionRow): Session =>
  Session.make({
    id: SessionId.make(row.id),
    projectId: row.project_id as FolderId,
    title: row.title,
    providerId: row.provider_id as Session["providerId"],
    model: row.model,
    status: row.status as Session["status"],
    archivedAt: row.archived_at === null ? null : new Date(row.archived_at),
    cursor: row.cursor,
    resumeStrategy: resumeStrategyFromRow(row.resume_strategy),
    runtimeMode: runtimeModeFromRow(row.runtime_mode),
    worktreeId:
      row.worktree_id === null ? null : (row.worktree_id as WorktreeId),
    chatId: row.chat_id as ChatId,
    forkedFromSessionId:
      row.forked_from_session_id === null
        ? null
        : SessionId.make(row.forked_from_session_id),
    forkedFromMessageId:
      row.forked_from_message_id === null
        ? null
        : MessageId.make(row.forked_from_message_id),
    permissionMode: permissionModeFromRow(row.permission_mode),
    toolSearch: row.tool_search === 1,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  });

export const sessionFromRecord = (record: SqlSessionReadRecord): Session =>
  Session.make({
    id: SessionId.make(record.sessionId),
    projectId: record.projectId as FolderId,
    title: record.title,
    providerId: record.providerId as Session["providerId"],
    model: record.model,
    status: record.status,
    archivedAt: record.archivedAt === null ? null : new Date(record.archivedAt),
    cursor: record.cursor,
    resumeStrategy: resumeStrategyFromRow(record.resumeStrategy),
    runtimeMode: runtimeModeFromRow(record.runtimeMode),
    worktreeId:
      record.worktreeId === null ? null : (record.worktreeId as WorktreeId),
    chatId: record.chatId as ChatId,
    forkedFromSessionId:
      record.forkedFromSessionId === null
        ? null
        : SessionId.make(record.forkedFromSessionId),
    forkedFromMessageId:
      record.forkedFromMessageId === null
        ? null
        : MessageId.make(record.forkedFromMessageId),
    permissionMode: permissionModeFromRow(record.permissionMode),
    toolSearch: record.toolSearch,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  });

export const chatFromRow = (row: ChatRow): Chat =>
  Chat.make({
    id: row.id as ChatId,
    projectId: row.project_id as FolderId,
    worktreeId:
      row.worktree_id === null ? null : (row.worktree_id as WorktreeId),
    title: row.title,
    activeSessionId:
      row.active_session_id === null
        ? null
        : SessionId.make(row.active_session_id),
    originSessionId:
      row.origin_session_id === null
        ? null
        : SessionId.make(row.origin_session_id),
    archivedAt: row.archived_at === null ? null : new Date(row.archived_at),
    lastMessageAt:
      row.last_message_at === null ? null : new Date(row.last_message_at),
    lastReadAt: row.last_read_at === null ? null : new Date(row.last_read_at),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  });

const normalizeMessageContent = (content: MessageContent): MessageContent =>
  content._tag === "context_compaction" && content.status === undefined
    ? { ...content, status: "completed" }
    : content;

export const messageFromRow = (row: MessageRow): Message =>
  Message.make({
    id: MessageId.make(row.id),
    sessionId: SessionId.make(row.session_id),
    role: row.role as MessageRole,
    content: normalizeMessageContent(decodeMessageContent(row.content_json)),
    createdAt: new Date(row.created_at),
  });

export const messageFromRecord = (record: MessageReadRecord): Message =>
  Message.make({
    id: MessageId.make(record.messageId),
    sessionId: SessionId.make(record.sessionId),
    role: record.role as MessageRole,
    content: normalizeMessageContent(decodeMessageContent(record.contentJson)),
    createdAt: new Date(record.createdAt),
  });
