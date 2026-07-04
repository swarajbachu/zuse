import { Rpc } from "@effect/rpc";
import { Schema } from "effect";

import {
  AgentDefinition,
  ContextUsagePrecision,
  PermissionMode,
  ProviderId,
  RuntimeMode,
  UserQuestion,
} from "./agent.ts";
import {
  AttachmentRef,
  CodeAnnotation,
  ComposerInput,
  FileRef,
  SkillRef,
} from "./composer.ts";
import {
  AgentItemId,
  AgentSessionId,
  ChatId,
  FolderId,
  MessageId,
  WorktreeId,
} from "./ids.ts";
import { Worktree } from "./worktree.ts";

export { ChatId } from "./ids.ts";

export {
  DEFAULT_PERMISSION_MODE,
  DEFAULT_RUNTIME_MODE,
  PermissionMode,
  RuntimeMode,
} from "./agent.ts";

/**
 * A session is one chat thread inside a project. The id matches the underlying
 * provider session id (`AgentSessionId`) so the persistence layer and the
 * provider's in-memory map stay in lockstep.
 */
export const SessionId = AgentSessionId;
export type SessionId = AgentSessionId;

/**
 * Persisted lifecycle state of a session. Mirrors the `sessions.status` column.
 * `booting`  — row exists; provider boot (CLI spawn + SDK handshake) is in
 *              flight on a background fiber. Transitions to `idle`/`running`
 *              on success, `error` on failure. Stale `booting` rows from a
 *              crashed daemon are cleaned up at boot.
 * `idle`     — row exists but no provider session is currently driving it.
 * `running`  — provider session is alive; `agent.events` is being consumed.
 * `closed`   — turn ended normally or session was closed by the user.
 * `error`    — provider terminated the session with an error.
 */
export const SessionStatus = Schema.Literal(
  "booting",
  "idle",
  "running",
  "closed",
  "error",
);
export type SessionStatus = typeof SessionStatus.Type;

/**
 * How (if at all) a session can resume after the provider session is gone.
 * Captured at start time; the renderer uses it to decide whether to expose
 * a "Resumable" affordance on stopped sessions.
 *
 *   - `claude-session-id` — Claude SDK's `session_id` is stored in `cursor`
 *     and passed back as `options.resume` on the next start.
 *   - `codex-thread-id` — Codex SDK's thread id is stored in `cursor` and
 *     passed back via `Codex.resumeThread(id)`. Codex doesn't replay prior
 *     items on resume; the renderer's persisted timeline is the source of
 *     truth for what came before.
 *   - `none` — no resume; sending again starts a fresh provider session
 *     under the same DB row (existing chat-MVP behavior).
 */
export const ResumeStrategy = Schema.Literal(
  "claude-session-id",
  "codex-thread-id",
  "grok-session-id",
  "cursor-session-id",
  "gemini-session-id",
  "opencode-session-id",
  "none",
);
export type ResumeStrategy = typeof ResumeStrategy.Type;

// `RuntimeMode` and `DEFAULT_RUNTIME_MODE` are defined in `agent.ts` so the
// new `AgentDefinition.permissionMode` can reuse the same literal set
// without an import cycle. Re-exported above for back-compat with the
// existing `import { RuntimeMode } from "@zuse/wire"` callers.

export class Session extends Schema.Class<Session>("Session")({
  id: SessionId,
  projectId: FolderId,
  title: Schema.String,
  providerId: ProviderId,
  model: Schema.String,
  status: SessionStatus,
  archivedAt: Schema.NullOr(Schema.DateFromString),
  cursor: Schema.NullOr(Schema.String),
  resumeStrategy: ResumeStrategy,
  runtimeMode: RuntimeMode,
  /**
   * Optional git worktree the session runs in. When null, the session runs
   * in the project's main checkout (`projects.path`). Mirrors the owning
   * chat's `worktreeId` — sessions in a chat always share its worktree;
   * server-side `chat.setWorktree` updates both. Locked once the chat has
   * any message recorded.
   */
  worktreeId: Schema.NullOr(WorktreeId),
  /**
   * Chat (sidebar entry) this session belongs to. Every session is a tab
   * inside exactly one chat — the chat row is the container; sessions are
   * its uniform members. CASCADEs on chat delete.
   */
  chatId: ChatId,
  /**
   * If this session was forked from another, the source session id. Null
   * for sessions started fresh. Reserved for the upcoming "fork from
   * message" feature — column ships now so the future capability is a
   * pure code change.
   */
  forkedFromSessionId: Schema.NullOr(SessionId),
  /**
   * The message in the source session the fork branched from, when
   * applicable. Paired with `forkedFromSessionId`.
   */
  forkedFromMessageId: Schema.NullOr(MessageId),
  /**
   * SDK lifecycle mode. Distinct from `runtimeMode` (our own auto-allow
   * policy). `plan` means the agent is currently restricted to read-only
   * tools and is expected to end its turn by calling `ExitPlanMode`.
   */
  permissionMode: PermissionMode,
  /**
   * Whether deferred tool loading was enabled at session start. Mirrors
   * `StartSessionInput.toolSearch`. No behavioural effect today; reserved
   * for the 0.04 code-index MCP servers.
   */
  toolSearch: Schema.Boolean,
  createdAt: Schema.DateFromString,
  updatedAt: Schema.DateFromString,
}) {}

/**
 * Conventional chat-message role. `tool` is used for tool_result rows so
 * markdown renderers can pick a distinct visual treatment without sniffing
 * `content._tag`.
 */
export const MessageRole = Schema.Literal(
  "user",
  "assistant",
  "system",
  "tool",
);
export type MessageRole = typeof MessageRole.Type;

const UserContent = Schema.TaggedStruct("user", {
  text: Schema.String,
  goal: Schema.optional(Schema.Boolean),
});

/**
 * User message that carries chips: typed file/directory tags, image
 * attachments, and skill invocations. Coexists with `user` — old rows still
 * render via the plain `user` variant. The renderer prefers `user_rich` when
 * a submission has any non-text segments.
 */
const UserRichContent = Schema.TaggedStruct("user_rich", {
  text: Schema.String,
  attachments: Schema.Array(AttachmentRef),
  fileRefs: Schema.Array(FileRef),
  skillRefs: Schema.Array(SkillRef),
  // Additive + back-compat: rows persisted before code annotations existed
  // decode with an empty list rather than failing.
  annotations: Schema.optionalWith(Schema.Array(CodeAnnotation), {
    default: () => [],
  }),
  goal: Schema.optional(Schema.Boolean),
});

const AssistantContent = Schema.TaggedStruct("assistant", {
  text: Schema.String,
  parentItemId: Schema.optional(AgentItemId),
});

/**
 * Extended-thinking / reasoning text emitted by the model before its final
 * answer. `redacted` mirrors Anthropic's `redacted_thinking` blocks where
 * the content is hidden but the row still appears so users see something
 * was thought about.
 */
const ThinkingContent = Schema.TaggedStruct("thinking", {
  itemId: AgentItemId,
  text: Schema.String,
  redacted: Schema.Boolean,
  parentItemId: Schema.optional(AgentItemId),
});

const ToolUseContent = Schema.TaggedStruct("tool_use", {
  itemId: AgentItemId,
  tool: Schema.String,
  input: Schema.Unknown,
  parentItemId: Schema.optional(AgentItemId),
});

const ToolResultContent = Schema.TaggedStruct("tool_result", {
  itemId: AgentItemId,
  output: Schema.Unknown,
  isError: Schema.Boolean,
  parentItemId: Schema.optional(AgentItemId),
});

const ErrorContent = Schema.TaggedStruct("error", {
  message: Schema.String,
});

/**
 * Persisted marker for a turn the user explicitly interrupted. Rendered as a
 * small muted "Interrupted by user" badge — distinct from `error`, which is a
 * real failure. Carries no fields; its presence in the message list is the
 * whole signal.
 */
const InterruptedContent = Schema.TaggedStruct("interrupted", {});

/**
 * Closing summary persisted for a sub-agent run. Mirrors the streaming
 * `SubagentSummaryEvent` so resume parity holds: the wrapper-row footer
 * reads `summary` / `turns` / `durationMs` from this row when collapsed.
 */
const SubagentSummaryContent = Schema.TaggedStruct("subagent_summary", {
  itemId: AgentItemId,
  agentName: Schema.String,
  model: Schema.String,
  turns: Schema.Number,
  durationMs: Schema.Number,
  summary: Schema.String,
  isError: Schema.Boolean,
});

/**
 * Per-turn token usage. Persisted (rather than transient) so resume parity
 * gives us the per-agent cost footer for free. `parentItemId` set means
 * the usage belongs to a sub-agent; absent means main-agent usage.
 */
const UsageContent = Schema.TaggedStruct("usage", {
  parentItemId: Schema.optional(AgentItemId),
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  cacheCreationTokens: Schema.Number,
  model: Schema.String,
});

const ContextUsageContent = Schema.TaggedStruct("context_usage", {
  providerId: ProviderId,
  usedTokens: Schema.NullOr(Schema.Number),
  windowTokens: Schema.NullOr(Schema.Number),
  precision: ContextUsagePrecision,
  source: Schema.optional(Schema.String),
});

const ContextCompactionContent = Schema.TaggedStruct("context_compaction", {
  itemId: AgentItemId,
  providerId: ProviderId,
  startedAt: Schema.Number,
  durationMs: Schema.Number,
  beforeTokens: Schema.NullOr(Schema.Number),
  afterTokens: Schema.NullOr(Schema.Number),
  status: Schema.optionalWith(Schema.Literal("in_progress", "completed"), {
    default: () => "completed" as const,
  }),
});

const UsageLimitContent = Schema.TaggedStruct("usage_limit", {
  providerId: ProviderId,
  label: Schema.String,
  usedPercent: Schema.NullOr(Schema.Number),
  // ISO-8601 string — see `UsageLimitEvent` in agent.ts for why this isn't
  // a `Date` schema (constructor validates against the decoded `Date`).
  resetsAt: Schema.NullOr(Schema.String),
  windowMinutes: Schema.NullOr(Schema.Number),
});

/**
 * Persisted form of a `UserQuestion` event. `itemId` is the SDK's
 * `tool_use.id` for the AskUserQuestion call; the paired
 * `user_question_answer` row uses the same `itemId`.
 */
const UserQuestionContent = Schema.TaggedStruct("user_question", {
  itemId: AgentItemId,
  questions: Schema.Array(UserQuestion),
  parentItemId: Schema.optional(AgentItemId),
});

/**
 * One answer per question. `questionIndex` indexes into the original
 * `questions` array. `selected` lists picked option indices (empty when the
 * user typed free-text); `other` is the free-text "Other" entry. Either
 * field may be empty, but never both.
 */
const UserQuestionAnswerContent = Schema.TaggedStruct("user_question_answer", {
  itemId: AgentItemId,
  answers: Schema.Array(
    Schema.Struct({
      questionIndex: Schema.Number,
      selected: Schema.Array(Schema.Number),
      other: Schema.optional(Schema.String),
    }),
  ),
  parentItemId: Schema.optional(AgentItemId),
});

/**
 * Tagged-union of all renderable message payloads. Persisted as the JSON blob
 * in `messages.content_json`; the `_tag` mirrors the `messages.kind` column.
 * Keep the shape additive — new tags become new rendered variants in the
 * renderer without touching existing rows.
 */
export const MessageContent = Schema.Union(
  UserContent,
  UserRichContent,
  AssistantContent,
  ThinkingContent,
  ToolUseContent,
  ToolResultContent,
  ErrorContent,
  InterruptedContent,
  SubagentSummaryContent,
  UsageContent,
  ContextUsageContent,
  ContextCompactionContent,
  UsageLimitContent,
  UserQuestionContent,
  UserQuestionAnswerContent,
);
export type UserQuestionAnswer =
  (typeof UserQuestionAnswerContent.Type)["answers"][number];
export type MessageContent = typeof MessageContent.Type;

export class Message extends Schema.Class<Message>("Message")({
  id: MessageId,
  sessionId: SessionId,
  role: MessageRole,
  content: MessageContent,
  createdAt: Schema.DateFromString,
}) {}

/**
 * A `Message` tagged with its global monotonic `sequence` from the event log.
 * Clients record the highest `sequence` they have seen per session and pass it
 * back as `sinceSequence` on reconnect to resume gap-free (no full replay, no
 * in-memory dedup Set). This is what `messages.stream` emits.
 */
export class MessageEnvelope extends Schema.Class<MessageEnvelope>(
  "MessageEnvelope",
)({
  sequence: Schema.Number,
  message: Message,
}) {}

export class QueuedMessage extends Schema.Class<QueuedMessage>("QueuedMessage")(
  {
    id: Schema.String,
    sessionId: SessionId,
    input: ComposerInput,
    position: Schema.Number,
    createdAt: Schema.DateFromString,
    updatedAt: Schema.DateFromString,
  },
) {}

export class QueueState extends Schema.Class<QueueState>("QueueState")({
  items: Schema.Array(QueuedMessage),
  paused: Schema.Boolean,
}) {}

export class SessionNotFoundError extends Schema.TaggedError<SessionNotFoundError>()(
  "SessionNotFoundError",
  { sessionId: SessionId },
) {}

export class SessionStartError extends Schema.TaggedError<SessionStartError>()(
  "SessionStartError",
  { providerId: ProviderId, reason: Schema.String },
) {}

export class GoalUnsupportedError extends Schema.TaggedError<GoalUnsupportedError>()(
  "GoalUnsupportedError",
  { providerId: ProviderId },
) {}

export const ThreadGoalStatus = Schema.Literal(
  "active",
  "paused",
  "budgetLimited",
  "usageLimited",
  "blocked",
  "complete",
);
export type ThreadGoalStatus = typeof ThreadGoalStatus.Type;

export class ThreadGoal extends Schema.Class<ThreadGoal>("ThreadGoal")({
  threadId: Schema.String,
  objective: Schema.String,
  status: ThreadGoalStatus,
  tokenBudget: Schema.NullOr(Schema.Number),
  tokensUsed: Schema.Number,
  timeUsedSeconds: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
}) {}

export const ThreadGoalSetInput = Schema.Struct({
  objective: Schema.optional(Schema.String),
  status: Schema.optional(ThreadGoalStatus),
  tokenBudget: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type ThreadGoalSetInput = typeof ThreadGoalSetInput.Type;

/**
 * Reported by `messages.steer` if the active provider cannot interrupt the
 * running turn. Both 0.03 drivers (Claude, Codex) support steer; the error
 * is reserved for future providers.
 */
export class SteerUnsupportedError extends Schema.TaggedError<SteerUnsupportedError>()(
  "SteerUnsupportedError",
  { providerId: ProviderId },
) {}

/**
 * Raised by `session.setWorktree` when the session already has at least one
 * recorded user message. cwd cannot be changed mid-conversation — the
 * renderer collapses the picker to a read-only chip in this case.
 */
export class SessionAlreadyStartedError extends Schema.TaggedError<SessionAlreadyStartedError>()(
  "SessionAlreadyStartedError",
  { sessionId: SessionId },
) {}

// ---------------------------------------------------------------------------
// Session RPCs
// ---------------------------------------------------------------------------

export const SessionListRpc = Rpc.make("session.list", {
  payload: Schema.Struct({
    projectId: FolderId,
    includeArchived: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Array(Session),
});

export const SessionGetRpc = Rpc.make("session.get", {
  payload: Schema.Struct({ sessionId: SessionId }),
  success: Session,
  error: SessionNotFoundError,
});

export const SessionCreateRpc = Rpc.make("session.create", {
  payload: Schema.Struct({
    /**
     * The chat (sidebar entry) the new session is created in. Worktree
     * and project are inherited from the chat row — clients never pick
     * them at session-create time anymore.
     */
    chatId: ChatId,
    providerId: ProviderId,
    model: Schema.String,
    title: Schema.optional(Schema.String),
    initialPrompt: Schema.optional(Schema.String),
    runtimeMode: Schema.optional(RuntimeMode),
    // Sub-agents the new session may delegate to. The renderer reads
    // these from the user's preset settings and injects them at create
    // time so the wire stays the single source of truth.
    agents: Schema.optional(
      Schema.Record({ key: Schema.String, value: AgentDefinition }),
    ),
    enableSubagents: Schema.optional(Schema.Boolean),
    /**
     * Start the session in plan mode. The agent will explore read-only
     * and end its first turn by calling `ExitPlanMode`. Defaults to
     * `'default'` (immediate execution).
     */
    permissionMode: Schema.optional(PermissionMode),
    /**
     * Persist the deferred-tools toggle for this session. Reserved for
     * 0.04 code-index MCP servers; no-op today.
     */
    toolSearch: Schema.optional(Schema.Boolean),
  }),
  success: Session,
  error: SessionStartError,
});

/**
 * Switch the worktree a session runs in. Allowed only before the first user
 * message is recorded — `SessionAlreadyStartedError` otherwise. `null` means
 * "run in the main checkout."
 */
export const SessionSetWorktreeRpc = Rpc.make("session.setWorktree", {
  payload: Schema.Struct({
    sessionId: SessionId,
    worktreeId: Schema.NullOr(WorktreeId),
  }),
  success: Schema.Void,
  error: Schema.Union(SessionNotFoundError, SessionAlreadyStartedError),
});

export const SessionRenameRpc = Rpc.make("session.rename", {
  payload: Schema.Struct({ sessionId: SessionId, title: Schema.String }),
  success: Schema.Void,
  error: SessionNotFoundError,
});

export const SessionSetModelRpc = Rpc.make("session.setModel", {
  payload: Schema.Struct({ sessionId: SessionId, model: Schema.String }),
  success: Schema.Void,
  error: SessionNotFoundError,
});

/**
 * Switch a session's provider (and the model it runs under). Allowed only
 * before the first user message is recorded — the new CLI cannot read the
 * prior CLI's transcript, so mid-chat swaps would silently drop context.
 * Returns `SessionAlreadyStartedError` once the session has started.
 */
export const SessionSetProviderRpc = Rpc.make("session.setProvider", {
  payload: Schema.Struct({
    sessionId: SessionId,
    providerId: ProviderId,
    model: Schema.String,
  }),
  success: Schema.Void,
  error: Schema.Union(SessionNotFoundError, SessionAlreadyStartedError),
});

export const SessionArchiveRpc = Rpc.make("session.archive", {
  payload: Schema.Struct({ sessionId: SessionId }),
  success: Schema.Void,
  error: SessionNotFoundError,
});

export const SessionUnarchiveRpc = Rpc.make("session.unarchive", {
  payload: Schema.Struct({ sessionId: SessionId }),
  success: Schema.Void,
  error: SessionNotFoundError,
});

export const SessionDeleteRpc = Rpc.make("session.delete", {
  payload: Schema.Struct({ sessionId: SessionId }),
  success: Schema.Void,
  error: SessionNotFoundError,
});

// ---------------------------------------------------------------------------
// Chats (sidebar containers; each chat hosts ≥1 session as tabs)
// ---------------------------------------------------------------------------

/**
 * A chat is the sidebar-level container. It owns a workspace (project +
 * optional worktree) and a title; the actual conversations live in its
 * child sessions, every one of which carries the chat's `chatId`. The
 * chat row itself has no provider state and no messages — it's metadata.
 *
 * `activeSessionId` is the last tab the user was on, persisted server-side
 * so a future tab restore works across reloads / devices.
 */
export class Chat extends Schema.Class<Chat>("Chat")({
  id: ChatId,
  projectId: FolderId,
  worktreeId: Schema.NullOr(WorktreeId),
  title: Schema.String,
  activeSessionId: Schema.NullOr(SessionId),
  archivedAt: Schema.NullOr(Schema.DateFromString),
  /**
   * Read/unread tracking. `lastMessageAt` advances every time a message is
   * persisted in any of the chat's sessions; `lastReadAt` advances when the
   * user views the chat. A chat is unread when `lastMessageAt > lastReadAt`.
   * `lastMessageAt` is null until the first message; `lastReadAt` is seeded to
   * the creation time so a freshly created chat starts read.
   */
  lastMessageAt: Schema.NullOr(Schema.DateFromString),
  lastReadAt: Schema.NullOr(Schema.DateFromString),
  createdAt: Schema.DateFromString,
  updatedAt: Schema.DateFromString,
}) {}

export class ChatNotFoundError extends Schema.TaggedError<ChatNotFoundError>()(
  "ChatNotFoundError",
  { chatId: ChatId },
) {}

/**
 * Raised by `chat.setWorktree` when any session in the chat already has a
 * recorded user message. Worktrees are immutable past the first message —
 * mirrors the per-session `SessionAlreadyStartedError` semantics.
 */
export class ChatAlreadyStartedError extends Schema.TaggedError<ChatAlreadyStartedError>()(
  "ChatAlreadyStartedError",
  { chatId: ChatId },
) {}

export class ChatArchiveScriptError extends Schema.TaggedError<ChatArchiveScriptError>()(
  "ChatArchiveScriptError",
  {
    chatId: ChatId,
    exitCode: Schema.NullOr(Schema.Number),
    signal: Schema.NullOr(Schema.String),
    output: Schema.String,
  },
) {}

export class ChatArchiveTimeoutError extends Schema.TaggedError<ChatArchiveTimeoutError>()(
  "ChatArchiveTimeoutError",
  { chatId: ChatId, timeoutMs: Schema.Number, output: Schema.String },
) {}

export class ChatArchiveWorktreeError extends Schema.TaggedError<ChatArchiveWorktreeError>()(
  "ChatArchiveWorktreeError",
  { chatId: ChatId, reason: Schema.String },
) {}

const ChatArchiveErrors = Schema.Union(
  ChatNotFoundError,
  ChatArchiveScriptError,
  ChatArchiveTimeoutError,
  ChatArchiveWorktreeError,
);

const ArchiveCleanupSummary = Schema.Struct({
  ran: Schema.Boolean,
  output: Schema.String,
});

export const ChatArchiveResult = Schema.Struct({
  chat: Chat,
  cleanup: Schema.NullOr(ArchiveCleanupSummary),
});
export type ChatArchiveResult = typeof ChatArchiveResult.Type;

export const ChatUnarchiveResult = Schema.Struct({
  chat: Chat,
  sessions: Schema.Array(Session),
  worktree: Schema.NullOr(Worktree),
});
export type ChatUnarchiveResult = typeof ChatUnarchiveResult.Type;

export const ChatListRpc = Rpc.make("chat.list", {
  payload: Schema.Struct({
    projectId: FolderId,
    includeArchived: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Array(Chat),
});

export const ChatGetRpc = Rpc.make("chat.get", {
  payload: Schema.Struct({ chatId: ChatId }),
  success: Chat,
  error: ChatNotFoundError,
});

/**
 * Create a new chat AND its initial session in one transaction. Returns
 * both so the renderer can land on the new session immediately without a
 * follow-up round-trip. The chat's `activeSessionId` is set to the new
 * session id.
 *
 * When `initialPrompt` is supplied, `initialMessage` is the persisted user
 * message — the renderer seeds it into its messages store so the chat view
 * never flashes the empty state while the live stream is connecting.
 */
export const ChatCreateRpc = Rpc.make("chat.create", {
  payload: Schema.Struct({
    projectId: FolderId,
    providerId: ProviderId,
    model: Schema.String,
    title: Schema.optional(Schema.String),
    initialPrompt: Schema.optional(Schema.String),
    runtimeMode: Schema.optional(RuntimeMode),
    worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
    agents: Schema.optional(
      Schema.Record({ key: Schema.String, value: AgentDefinition }),
    ),
    enableSubagents: Schema.optional(Schema.Boolean),
    permissionMode: Schema.optional(PermissionMode),
    toolSearch: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({
    chat: Chat,
    initialSession: Session,
    initialMessage: Schema.NullOr(Message),
  }),
  error: SessionStartError,
});

export const ChatRenameRpc = Rpc.make("chat.rename", {
  payload: Schema.Struct({ chatId: ChatId, title: Schema.String }),
  success: Schema.Void,
  error: ChatNotFoundError,
});

/**
 * Live feed of chat-row changes (title / worktree binding) for one project.
 * Carries only live patches — no backfill — so the renderer keeps its
 * `chat.list` snapshot and patches it as updates arrive (e.g. the background
 * auto-namer rewriting a new chat's title after its first message).
 */
export const ChatStreamChangesRpc = Rpc.make("chat.streamChanges", {
  payload: Schema.Struct({ projectId: FolderId }),
  success: Chat,
  stream: true,
});

/**
 * Change the chat's worktree. Allowed only when no session in the chat has
 * any user message yet — fails with `ChatAlreadyStartedError` otherwise.
 * Updates `chat.worktreeId` AND mirrors the change onto every member
 * session's `worktreeId` so renderer reads of `session.worktreeId` stay
 * accurate without a second round-trip.
 */
/**
 * Mark a chat read by stamping `last_read_at` to "now". Returns the refreshed
 * chat so the renderer can reconcile its optimistic patch. Idempotent.
 */
export const ChatMarkReadRpc = Rpc.make("chat.markRead", {
  payload: Schema.Struct({ chatId: ChatId }),
  success: Chat,
  error: ChatNotFoundError,
});

export const ChatSetWorktreeRpc = Rpc.make("chat.setWorktree", {
  payload: Schema.Struct({
    chatId: ChatId,
    worktreeId: Schema.NullOr(WorktreeId),
  }),
  success: Chat,
  error: Schema.Union(ChatNotFoundError, ChatAlreadyStartedError),
});

/**
 * Record the user's last-active tab within this chat. Called whenever the
 * tab strip selection changes so a future click on this chat's sidebar
 * row restores the correct tab. No-op if `sessionId` doesn't belong to
 * the chat (defensive against races).
 */
export const ChatSetActiveSessionRpc = Rpc.make("chat.setActiveSession", {
  payload: Schema.Struct({ chatId: ChatId, sessionId: SessionId }),
  success: Schema.Void,
  error: ChatNotFoundError,
});

export const ChatArchiveRpc = Rpc.make("chat.archive", {
  payload: Schema.Struct({
    chatId: ChatId,
    /**
     * Force-remove the chat's worktree even when it has uncommitted or
     * untracked changes. Callers pass `true` after confirming the discard
     * with the user (mirrors `worktree.remove`'s `force`).
     */
    force: Schema.optional(Schema.Boolean),
  }),
  success: ChatArchiveResult,
  error: ChatArchiveErrors,
});

export const ChatUnarchiveRpc = Rpc.make("chat.unarchive", {
  payload: Schema.Struct({ chatId: ChatId }),
  success: ChatUnarchiveResult,
  error: Schema.Union(ChatNotFoundError, ChatArchiveWorktreeError),
});

export const ChatDeleteRpc = Rpc.make("chat.delete", {
  payload: Schema.Struct({ chatId: ChatId }),
  success: Schema.Void,
  error: ChatNotFoundError,
});

// ---------------------------------------------------------------------------
// Message RPCs
// ---------------------------------------------------------------------------

export const MessagesListRpc = Rpc.make("messages.list", {
  payload: Schema.Struct({ sessionId: SessionId }),
  success: Schema.Array(Message),
  error: SessionNotFoundError,
});

/**
 * Subscribe to a session's message log. The stream emits {@link MessageEnvelope}
 * rows in global `sequence` order — a replay of everything past `sinceSequence`
 * (0 when omitted, i.e. the full history), then live rows as the provider
 * produces events. The renderer treats it as the single source of truth — no
 * separate hydrate / live split.
 *
 * Clients record the highest `sequence` seen per session and pass it back as
 * `sinceSequence` on resubscribe: the server replays only the delta, so a
 * flaky-network reconnect is O(missed messages) and gap-free by construction.
 */
export const MessagesStreamRpc = Rpc.make("messages.stream", {
  payload: Schema.Struct({
    sessionId: SessionId,
    sinceSequence: Schema.optional(Schema.Number),
  }),
  success: MessageEnvelope,
  error: SessionNotFoundError,
  stream: true,
});

/**
 * Send a user turn. The legacy `text` field stays accepted alongside the
 * richer `input` form so the renderer can migrate the composer to
 * `ComposerInput` in a follow-up phase without a wire flag-day. Server
 * prefers `input` when both are present.
 */
export const MessagesSendRpc = Rpc.make("messages.send", {
  payload: Schema.Struct({
    sessionId: SessionId,
    text: Schema.optional(Schema.String),
    input: Schema.optional(ComposerInput),
    asGoal: Schema.optional(Schema.Boolean),
    // Optional renderer-minted id for the user message. When present the
    // server persists the row under this id instead of generating one, so the
    // renderer can insert the message optimistically and have the live-stream
    // echo dedupe against it. Omitted by non-interactive callers (queue
    // flush), which keep server-generated ids.
    clientMessageId: Schema.optional(MessageId),
  }),
  success: Schema.Void,
  error: SessionNotFoundError,
});

export const MessagesInterruptRpc = Rpc.make("messages.interrupt", {
  payload: Schema.Struct({ sessionId: SessionId }),
  success: Schema.Void,
  error: SessionNotFoundError,
});

export const MessagesQueueListRpc = Rpc.make("messages.queue.list", {
  payload: Schema.Struct({ sessionId: SessionId }),
  success: QueueState,
  error: SessionNotFoundError,
});

export const MessagesQueueStreamRpc = Rpc.make("messages.queue.stream", {
  payload: Schema.Struct({ sessionId: SessionId }),
  success: QueueState,
  error: SessionNotFoundError,
  stream: true,
});

export const MessagesQueueAddRpc = Rpc.make("messages.queue.add", {
  payload: Schema.Struct({
    sessionId: SessionId,
    input: ComposerInput,
  }),
  success: QueuedMessage,
  error: SessionNotFoundError,
});

export const MessagesQueueUpdateRpc = Rpc.make("messages.queue.update", {
  payload: Schema.Struct({
    sessionId: SessionId,
    queueId: Schema.String,
    input: ComposerInput,
  }),
  success: QueuedMessage,
  error: SessionNotFoundError,
});

export const MessagesQueueDeleteRpc = Rpc.make("messages.queue.delete", {
  payload: Schema.Struct({
    sessionId: SessionId,
    queueId: Schema.String,
  }),
  success: Schema.Void,
  error: SessionNotFoundError,
});

export const MessagesQueueSendNowRpc = Rpc.make("messages.queue.sendNow", {
  payload: Schema.Struct({
    sessionId: SessionId,
    queueId: Schema.String,
  }),
  success: Schema.Void,
  error: SessionNotFoundError,
});

export const MessagesQueueReorderRpc = Rpc.make("messages.queue.reorder", {
  payload: Schema.Struct({
    sessionId: SessionId,
    queueIds: Schema.Array(Schema.String),
  }),
  success: Schema.Array(QueuedMessage),
  error: SessionNotFoundError,
});

export const MessagesQueueFlushRpc = Rpc.make("messages.queue.flush", {
  payload: Schema.Struct({ sessionId: SessionId }),
  success: Schema.Void,
  error: SessionNotFoundError,
});

export const MessagesQueueResumeRpc = Rpc.make("messages.queue.resume", {
  payload: Schema.Struct({ sessionId: SessionId }),
  success: Schema.Void,
  error: SessionNotFoundError,
});

/**
 * Interrupt the running turn (if any) and immediately send `input` as the
 * next user turn. The driver drains the post-interrupt cleanup messages
 * before issuing the new query so the message stream stays linear.
 */
export const MessagesSteerRpc = Rpc.make("messages.steer", {
  payload: Schema.Struct({
    sessionId: SessionId,
    input: ComposerInput,
  }),
  success: Schema.Void,
  error: Schema.Union(SessionNotFoundError, SteerUnsupportedError),
});

/**
 * Re-open a stopped session against the provider. For Claude this passes
 * the persisted `cursor` to the SDK's `resume`; for Codex it currently
 * fails with `SessionStartError({ reason: "resume_unsupported" })` and the
 * renderer offers "Start new session" instead.
 */
export const SessionResumeRpc = Rpc.make("session.resume", {
  payload: Schema.Struct({ sessionId: SessionId }),
  success: Session,
  error: Schema.Union(SessionNotFoundError, SessionStartError),
});

/**
 * Set the per-session permission posture. Takes effect on the next tool call —
 * if a turn is in flight when the toggle changes, the running canUseTool
 * callbacks observe the new mode without restarting the SDK.
 */
export const SessionSetRuntimeModeRpc = Rpc.make("session.setRuntimeMode", {
  payload: Schema.Struct({
    sessionId: SessionId,
    runtimeMode: RuntimeMode,
  }),
  success: Schema.Void,
  error: SessionNotFoundError,
});

/**
 * Switch the SDK lifecycle mode (plan / default / acceptEdits) on a live
 * session. Calls `Query.setPermissionMode` under the hood; the driver
 * emits a `PermissionModeChanged` event so the renderer chip stays in
 * sync without polling.
 */
export const SessionSetPermissionModeRpc = Rpc.make(
  "session.setPermissionMode",
  {
    payload: Schema.Struct({
      sessionId: SessionId,
      mode: PermissionMode,
    }),
    success: Schema.Void,
    error: SessionNotFoundError,
  },
);

/**
 * Resolve the pending `AskUserQuestion` tool call identified by `itemId`.
 * The driver returns the answers as the tool result, the SDK turn unwinds,
 * and the renderer paints a paired `user_question_answer` row.
 */
export const SessionAnswerQuestionRpc = Rpc.make("session.answerQuestion", {
  payload: Schema.Struct({
    sessionId: SessionId,
    itemId: Schema.String,
    answers: Schema.Array(
      Schema.Struct({
        questionIndex: Schema.Number,
        selected: Schema.Array(Schema.Number),
        other: Schema.optional(Schema.String),
      }),
    ),
  }),
  success: Schema.Void,
  error: SessionNotFoundError,
});

/**
 * Live status feed for a session. Mirrors the message stream pattern: emits
 * the current status immediately, then every transition. The renderer uses
 * it to keep the composer's "running" indicator stable across the whole
 * tool-call loop instead of inferring from the last message.
 */
export const SessionStatusStreamRpc = Rpc.make("session.streamStatus", {
  payload: Schema.Struct({ sessionId: SessionId }),
  success: Schema.Struct({ sessionId: SessionId, status: SessionStatus }),
  error: SessionNotFoundError,
  stream: true,
});

export const SessionGoalGetRpc = Rpc.make("session.goal.get", {
  payload: Schema.Struct({ sessionId: SessionId }),
  success: Schema.NullOr(ThreadGoal),
  error: Schema.Union(SessionNotFoundError, GoalUnsupportedError),
});

export const SessionGoalSetRpc = Rpc.make("session.goal.set", {
  payload: Schema.Struct({
    sessionId: SessionId,
    goal: ThreadGoalSetInput,
  }),
  success: ThreadGoal,
  error: Schema.Union(
    SessionNotFoundError,
    SessionStartError,
    GoalUnsupportedError,
  ),
});

export const SessionGoalClearRpc = Rpc.make("session.goal.clear", {
  payload: Schema.Struct({ sessionId: SessionId }),
  success: Schema.Void,
  error: Schema.Union(SessionNotFoundError, GoalUnsupportedError),
});

export const SessionGoalStreamRpc = Rpc.make("session.goal.stream", {
  payload: Schema.Struct({ sessionId: SessionId }),
  success: Schema.Struct({
    sessionId: SessionId,
    goal: Schema.NullOr(ThreadGoal),
  }),
  error: Schema.Union(SessionNotFoundError, GoalUnsupportedError),
  stream: true,
});
