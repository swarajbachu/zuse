import { Context, type Effect, type Stream } from "effect";

import type {
  AgentDefinition,
  AgentItemId,
  AttachmentRef,
  Chat,
  ChatAlreadyStartedError,
  ChatArchiveResult,
  ChatArchiveScriptError,
  ChatArchiveTimeoutError,
  ChatArchiveWorktreeError,
  ChatId,
  ChatNotFoundError,
  ChatUnarchiveResult,
  CodeAnnotation,
  ComposerInput,
  FileRef,
  FolderId,
  GoalUnsupportedError,
  Message,
  MessageEnvelope,
  MessageId,
  PermissionMode,
  ProviderId,
  QueueState,
  QueuedMessage,
  RuntimeMode,
  Session,
  SessionAlreadyStartedError,
  SessionId,
  SessionNotFoundError,
  SessionStartError,
  SessionStatus,
  SkillRef,
  ThreadGoal,
  ThreadGoalSetInput,
  UserQuestionAnswer,
  WorktreeId,
} from "@zuse/wire";

/**
 * Persistence-backed orchestration of chat sessions and their message log.
 * Wraps `ProviderService` so RPC handlers and the renderer talk to one
 * coherent surface — `agent.*` RPCs stay live for low-level access but the
 * chat UI never reaches past `MessageStore`.
 *
 * Invariants:
 * - `Session.id` matches the provider's in-memory `AgentSessionId`.
 * - Every persisted `Message` corresponds to either a user submit or an
 *   `AgentEvent` that produced renderable content; lifecycle events
 *   (`Started`, `Status`, `Completed`) update the session row but are not
 *   persisted as messages.
 * - `streamMessages` emits the full backfill before any live row.
 */
export interface CreateSessionInput {
  /**
   * The chat (sidebar container) this session belongs to. Project +
   * worktree are derived from the chat — clients no longer pass either
   * directly to session create.
   */
  readonly chatId: ChatId;
  readonly providerId: ProviderId;
  readonly model: string;
  readonly title?: string;
  readonly initialPrompt?: string;
  readonly runtimeMode?: RuntimeMode;
  /**
   * Sub-agents the main agent may delegate to. Stored on the session row
   * as JSON so a resumed session re-passes the same roster into
   * `provider.start`. Empty/omitted means no sub-agents.
   */
  readonly agents?: Readonly<Record<string, AgentDefinition>>;
  /**
   * Master toggle for sub-agent delegation on this session. Defaults true
   * when `agents` is non-empty; the driver only adds `Agent` to
   * `allowedTools` when the effective value is true.
   */
  readonly enableSubagents?: boolean;
  /**
   * SDK lifecycle mode. `'plan'` starts the session in plan mode; the
   * agent is restricted to read-only tools and ends its turn by calling
   * `ExitPlanMode`. Defaults to `'default'`.
   */
  readonly permissionMode?: PermissionMode;
  /**
   * Persist the deferred-tools toggle on the session row. No-op today
   * (the AskUserQuestion server is the only MCP server and is small);
   * the flag is here so 0.04's code-index MCP servers can ride on it.
   */
  readonly toolSearch?: boolean;
  /**
   * Defer `provider.start` to a background fiber and return as soon as the
   * row is inserted. The returned `Session` has `status = "booting"`; a
   * status pubsub event fires when boot finishes (`idle`/`running`) or
   * fails (`error`). Used by the `session.create` RPC so a new in-chat tab
   * appears in ~hundreds of ms instead of ~60s. `chat.create` keeps the
   * default synchronous behavior so its existing staged loading panel
   * timing is preserved.
   */
  readonly background?: boolean;
}

export interface CreateChatInput {
  readonly projectId: FolderId;
  readonly providerId: ProviderId;
  readonly model: string;
  readonly title?: string;
  readonly initialPrompt?: string;
  readonly runtimeMode?: RuntimeMode;
  readonly worktreeId?: WorktreeId | null;
  readonly agents?: Readonly<Record<string, AgentDefinition>>;
  readonly enableSubagents?: boolean;
  readonly permissionMode?: PermissionMode;
  readonly toolSearch?: boolean;
}

export interface MessageStoreShape {
  readonly listSessions: (
    projectId: FolderId,
    includeArchived: boolean,
  ) => Effect.Effect<ReadonlyArray<Session>>;

  readonly getSession: (
    sessionId: SessionId,
  ) => Effect.Effect<Session, SessionNotFoundError>;

  readonly createSession: (
    input: CreateSessionInput,
  ) => Effect.Effect<Session, SessionStartError>;

  readonly renameSession: (
    sessionId: SessionId,
    title: string,
  ) => Effect.Effect<void, SessionNotFoundError>;

  readonly setModel: (
    sessionId: SessionId,
    model: string,
  ) => Effect.Effect<void, SessionNotFoundError>;

  /**
   * Switch a session's provider and model. Allowed only before the first
   * user message has been recorded — fails with `SessionAlreadyStartedError`
   * otherwise, because the new CLI cannot read the prior CLI's transcript.
   * Also clears the resume cursor since it's provider-specific.
   */
  readonly setProvider: (
    sessionId: SessionId,
    providerId: ProviderId,
    model: string,
  ) => Effect.Effect<void, SessionNotFoundError | SessionAlreadyStartedError>;

  /**
   * Update the per-session permission posture. The change applies to the
   * next tool call — running `canUseTool` callbacks observe the new value
   * via the runtime-mode getter `ProviderService` hands the driver.
   */
  readonly setRuntimeMode: (
    sessionId: SessionId,
    runtimeMode: RuntimeMode,
  ) => Effect.Effect<void, SessionNotFoundError>;

  /**
   * Switch the SDK lifecycle mode (plan / default / acceptEdits) on a
   * live session. Forwards to `ProviderService.setPermissionMode` and
   * persists the new value so resume restarts in the same mode.
   */
  readonly setPermissionMode: (
    sessionId: SessionId,
    mode: PermissionMode,
  ) => Effect.Effect<void, SessionNotFoundError>;

  /**
   * Resolve a pending in-process AskUserQuestion call by `itemId`.
   * Persists a `user_question_answer` row before forwarding to the
   * driver so the renderer's view stays consistent if the SDK turn
   * unwinds before the row reaches the live stream.
   */
  readonly answerQuestion: (
    sessionId: SessionId,
    itemId: AgentItemId,
    answers: ReadonlyArray<UserQuestionAnswer>,
  ) => Effect.Effect<void, SessionNotFoundError>;

  /**
   * Switch the worktree this session runs in. Allowed only before the first
   * user message has been recorded — fails with `SessionAlreadyStartedError`
   * otherwise. `null` means "run in the main checkout."
   */
  readonly setWorktree: (
    sessionId: SessionId,
    worktreeId: WorktreeId | null,
  ) => Effect.Effect<void, SessionNotFoundError | SessionAlreadyStartedError>;

  readonly archiveSession: (
    sessionId: SessionId,
  ) => Effect.Effect<void, SessionNotFoundError>;

  readonly unarchiveSession: (
    sessionId: SessionId,
  ) => Effect.Effect<void, SessionNotFoundError>;

  readonly deleteSession: (
    sessionId: SessionId,
  ) => Effect.Effect<void, SessionNotFoundError>;

  // -------------------------------------------------------------------------
  // Chats — sidebar containers; each chat hosts ≥1 session as a tab.
  // -------------------------------------------------------------------------

  readonly listChats: (
    projectId: FolderId,
    includeArchived: boolean,
  ) => Effect.Effect<ReadonlyArray<Chat>>;

  readonly getChat: (chatId: ChatId) => Effect.Effect<Chat, ChatNotFoundError>;

  /**
   * Creates the chat row AND its initial session in one transaction.
   * Returns both so the renderer lands directly on the new session, plus
   * the persisted initial user message (when `initialPrompt` was supplied)
   * so the renderer can seed its messages store and skip the empty-state
   * flash while the live stream connects.
   */
  readonly createChat: (input: CreateChatInput) => Effect.Effect<
    {
      readonly chat: Chat;
      readonly initialSession: Session;
      readonly initialMessage: Message | null;
    },
    SessionStartError
  >;

  readonly renameChat: (
    chatId: ChatId,
    title: string,
  ) => Effect.Effect<void, ChatNotFoundError>;

  /**
   * Mark a chat read by stamping `last_read_at` to "now". Returns the
   * refreshed chat. Idempotent.
   */
  readonly markChatRead: (
    chatId: ChatId,
  ) => Effect.Effect<Chat, ChatNotFoundError>;

  /**
   * Live feed of chat-row changes (title / worktree) for one project. Emits
   * only live patches — no backfill — so the renderer keeps its `chat.list`
   * snapshot and applies updates (e.g. the background auto-namer rewriting a
   * title) on top. Never fails.
   */
  readonly streamChatChanges: (projectId: FolderId) => Stream.Stream<Chat>;

  /**
   * Update the chat's worktree. Allowed only when no session in the chat
   * has any user message yet. Mirrors the new value onto every member
   * session's `worktreeId` in the same transaction.
   */
  readonly setChatWorktree: (
    chatId: ChatId,
    worktreeId: WorktreeId | null,
  ) => Effect.Effect<Chat, ChatNotFoundError | ChatAlreadyStartedError>;

  /**
   * Persist the user's last-active tab inside the chat. Called whenever
   * the user switches tabs in the strip so a future click on the chat's
   * sidebar row restores the right one.
   */
  readonly setChatActiveSession: (
    chatId: ChatId,
    sessionId: SessionId,
  ) => Effect.Effect<void, ChatNotFoundError>;

  readonly archiveChat: (
    chatId: ChatId,
    force: boolean,
  ) => Effect.Effect<
    ChatArchiveResult,
    | ChatNotFoundError
    | ChatArchiveScriptError
    | ChatArchiveTimeoutError
    | ChatArchiveWorktreeError
  >;

  readonly unarchiveChat: (
    chatId: ChatId,
  ) => Effect.Effect<
    ChatUnarchiveResult,
    ChatNotFoundError | ChatArchiveWorktreeError
  >;

  readonly deleteChat: (
    chatId: ChatId,
  ) => Effect.Effect<void, ChatNotFoundError>;

  readonly resumeSession: (
    sessionId: SessionId,
  ) => Effect.Effect<Session, SessionNotFoundError | SessionStartError>;

  readonly listMessages: (
    sessionId: SessionId,
  ) => Effect.Effect<ReadonlyArray<Message>, SessionNotFoundError>;

  readonly streamMessages: (
    sessionId: SessionId,
    sinceSequence?: number,
  ) => Stream.Stream<MessageEnvelope, SessionNotFoundError>;

  /**
   * Live status feed. Emits the current `Session.status` immediately and
   * publishes every transition (`idle` → `running` → `closed` / `error`).
   * The renderer uses this to keep its in-flight indicator stable across
   * the whole tool-call loop instead of inferring from message content.
   */
  readonly streamStatus: (
    sessionId: SessionId,
  ) => Stream.Stream<
    { readonly sessionId: SessionId; readonly status: SessionStatus },
    SessionNotFoundError
  >;

  readonly getGoal: (
    sessionId: SessionId,
  ) => Effect.Effect<
    ThreadGoal | null,
    SessionNotFoundError | GoalUnsupportedError
  >;

  readonly setGoal: (
    sessionId: SessionId,
    goal: ThreadGoalSetInput,
  ) => Effect.Effect<
    ThreadGoal,
    SessionNotFoundError | SessionStartError | GoalUnsupportedError
  >;

  readonly clearGoal: (
    sessionId: SessionId,
  ) => Effect.Effect<void, SessionNotFoundError | GoalUnsupportedError>;

  readonly streamGoal: (
    sessionId: SessionId,
  ) => Stream.Stream<
    { readonly sessionId: SessionId; readonly goal: ThreadGoal | null },
    SessionNotFoundError | GoalUnsupportedError
  >;

  readonly sendMessage: (
    sessionId: SessionId,
    text: string,
    attachments?: ReadonlyArray<AttachmentRef>,
    fileRefs?: ReadonlyArray<FileRef>,
    skillRefs?: ReadonlyArray<SkillRef>,
    annotations?: ReadonlyArray<CodeAnnotation>,
    asGoal?: boolean,
    clientMessageId?: MessageId,
  ) => Effect.Effect<void, SessionNotFoundError>;

  readonly interruptSession: (
    sessionId: SessionId,
  ) => Effect.Effect<void, SessionNotFoundError>;

  readonly listQueuedMessages: (
    sessionId: SessionId,
  ) => Effect.Effect<QueueState, SessionNotFoundError>;

  readonly streamQueuedMessages: (
    sessionId: SessionId,
  ) => Stream.Stream<QueueState, SessionNotFoundError>;

  readonly addQueuedMessage: (
    sessionId: SessionId,
    input: ComposerInput,
  ) => Effect.Effect<QueuedMessage, SessionNotFoundError>;

  readonly updateQueuedMessage: (
    sessionId: SessionId,
    queueId: string,
    input: ComposerInput,
  ) => Effect.Effect<QueuedMessage, SessionNotFoundError>;

  readonly deleteQueuedMessage: (
    sessionId: SessionId,
    queueId: string,
  ) => Effect.Effect<void, SessionNotFoundError>;

  readonly sendQueuedMessageNow: (
    sessionId: SessionId,
    queueId: string,
  ) => Effect.Effect<void, SessionNotFoundError>;

  readonly reorderQueuedMessages: (
    sessionId: SessionId,
    queueIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<QueuedMessage>, SessionNotFoundError>;

  readonly flushQueuedMessages: (
    sessionId: SessionId,
  ) => Effect.Effect<void, SessionNotFoundError>;

  readonly resumeQueuedMessages: (
    sessionId: SessionId,
  ) => Effect.Effect<void, SessionNotFoundError>;
}

export class MessageStore extends Context.Tag("memoize/MessageStore")<
  MessageStore,
  MessageStoreShape
>() {}
