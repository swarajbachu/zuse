import { spawn } from "node:child_process";
import { canonicalizeToolInput } from "@zuse/agents/kernel/tool-input";
import {
  type AgentDefinition,
  type AgentEvent,
  type AgentSessionNotFoundError,
  type AttachmentRef,
  type AutonomyLevel,
  type BrowserAnnotation,
  Chat,
  ChatAlreadyStartedError,
  ChatArchiveScriptError,
  ChatArchiveTimeoutError,
  ChatArchiveWorktreeError,
  type ChatArchiveResult,
  ChatId,
  ChatNotFoundError,
  type CodeAnnotation,
  type ComposerAnnotation,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_RUNTIME_MODE,
  defaultModelFor,
  type FileRef,
  type FolderId,
  GoalUnsupportedError,
  Message,
  type MessageContent,
  MessageId,
  type MessageId as MessageIdType,
  type MessageOrigin,
  type MessageRole,
  MODELS_BY_PROVIDER,
  type PermissionMode,
  type ProviderId,
  type ResumeStrategy,
  type RuntimeMode,
  Session,
  SessionAlreadyStartedError,
  SessionId,
  SessionNotFoundError,
  SessionStartError,
  type SkillRef,
  ThreadGoal,
  type ThreadGoalSetInput,
  visibleModelsForProvider,
  type Worktree,
  type WorktreeCreateSource,
  WorktreeId,
} from "@zuse/contracts";
import type { ChatCommand } from "@zuse/domain/chat/commands";
import { ChatEvent } from "@zuse/domain/chat/events";
import type { SessionCommand } from "@zuse/domain/core/commands";
import { ChatDomain } from "@zuse/domain/engine/chat-domain";
import type { StoredEvent } from "@zuse/domain/engine/dispatch";
import { ReactorRunner } from "@zuse/domain/engine/reactor-runner";
import { SessionDomain } from "@zuse/domain/engine/session-domain";
import {
  makeSqlConsumerStorage,
  type SqlConsumerStorageError,
} from "@zuse/domain/engine/sql-consumer-storage";
import type { MessageReadRecord } from "@zuse/domain/projectors/read-model";
import {
  type AutoNameCommand,
  autoNameReactorDefinition,
  type ChatArchiveCommand,
  chatArchiveReactorDefinition,
  type ChatDeleteCommand,
  chatDeleteReactorDefinition,
  type ProviderStartCommand,
  providerStartReactorDefinition,
  type ProviderStopCommand,
  providerStopReactorDefinition,
} from "@zuse/domain/reactors/conversation";
import {
  SqlSessionQueries,
  type SqlSessionReadRecord,
} from "@zuse/domain/queries/sql-session-queries";
import { GitService } from "@zuse/git/git-service";
import { WorktreeService } from "@zuse/git/worktree-service";
import {
  Context,
  DateTime,
  Effect,
  Fiber,
  Layer,
  PubSub,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ConfigStoreService } from "../../config-store/services/config-store-service.ts";
import { NdjsonLogger } from "../../persistence/ndjson-logger.ts";
import { PtyService } from "../../pty/services/pty-service.ts";
import { RelayActivityPublisher } from "../../relay/activity-publisher.ts";
import { RepositorySettingsService } from "../../repository-settings/services/repository-settings-service.ts";
import { isIgnorableGrokAuthNoise } from "../drivers/acp/grok-auth-noise.ts";
import {
  eventToContent,
  messageContentToText,
  orchestrationErrorText,
  parentItemIdOfContent,
  roleForContent,
  shouldIncludeInTranscript,
  transcriptToMarkdown,
} from "../conversation-message-mapping.ts";
import { makeReactorEffectJournal } from "../reactor-effect-journal.ts";
import {
  buildOrchestrationTools,
  type OrchestrationSessionTools,
  type OrchestrationToolDeps,
} from "../drivers/orchestration-tools.ts";
import {
  ChatService,
  type ChatServiceShape,
  type ConversationOperations,
  type CreateChatInput,
  type CreateSessionInput,
  MessageService,
  type MessageServiceShape,
  QueueService,
  SessionService,
  type SessionServiceShape,
  TranscriptService,
  type TranscriptServiceShape,
} from "../services/conversation-services.ts";
import {
  type GetRuntimeMode,
  ProviderService,
} from "../services/provider-service.ts";
import {
  buildConversationText,
  formatBranchName,
  isTrivialUserMessage,
  shouldDeferAutoName,
  TitleGenerator,
} from "../title-generator.ts";
import { makeQueueServiceRuntime } from "./queue-service-runtime.ts";

interface SessionRow {
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

interface ChatRow {
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

const ARCHIVE_SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;
const ARCHIVE_OUTPUT_LIMIT = 12_000;

interface ArchivedWorktreeSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly path: string;
  readonly name: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly createdAt: string;
}

const truncateArchiveOutput = (value: string): string => {
  if (value.length <= ARCHIVE_OUTPUT_LIMIT) return value;
  return `…${value.slice(value.length - ARCHIVE_OUTPUT_LIMIT)}`;
};

const parseArchivedWorktreeSnapshot = (
  raw: string | null,
): ArchivedWorktreeSnapshot | null => {
  if (raw === null || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ArchivedWorktreeSnapshot>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.projectId !== "string" ||
      typeof parsed.path !== "string" ||
      typeof parsed.name !== "string" ||
      typeof parsed.branch !== "string" ||
      typeof parsed.baseBranch !== "string" ||
      typeof parsed.createdAt !== "string"
    ) {
      return null;
    }
    return {
      id: parsed.id,
      projectId: parsed.projectId,
      path: parsed.path,
      name: parsed.name,
      branch: parsed.branch,
      baseBranch: parsed.baseBranch,
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
};

const parseAgents = (
  raw: string | null,
): Readonly<Record<string, AgentDefinition>> | null => {
  if (raw === null || raw.length === 0) return null;
  try {
    return JSON.parse(raw) as Record<string, AgentDefinition>;
  } catch {
    return null;
  }
};

const RUNTIME_MODES: ReadonlySet<RuntimeMode> = new Set([
  "approval-required",
  "auto-accept-edits",
  "auto-accept-edits-and-bash",
  "full-access",
]);

const runtimeModeFromRow = (raw: string): RuntimeMode =>
  RUNTIME_MODES.has(raw as RuntimeMode)
    ? (raw as RuntimeMode)
    : DEFAULT_RUNTIME_MODE;

const PERMISSION_MODES: ReadonlySet<PermissionMode> = new Set([
  "default",
  "plan",
  "acceptEdits",
]);

const permissionModeFromRow = (raw: string): PermissionMode =>
  PERMISSION_MODES.has(raw as PermissionMode)
    ? (raw as PermissionMode)
    : DEFAULT_PERMISSION_MODE;

const RESUME_STRATEGIES: ReadonlySet<Session["resumeStrategy"]> = new Set([
  "none",
  "claude-session-id",
  "codex-thread-id",
  "grok-session-id",
  "cursor-session-id",
  "gemini-session-id",
  "opencode-session-id",
]);

const resumeStrategyFromRow = (raw: string): Session["resumeStrategy"] =>
  RESUME_STRATEGIES.has(raw as Session["resumeStrategy"])
    ? (raw as Session["resumeStrategy"])
    : "none";

interface MessageRow {
  readonly id: string;
  readonly session_id: string;
  readonly role: string;
  readonly kind: string;
  readonly content_json: string;
  readonly parent_item_id: string | null;
  readonly created_at: string;
}

const sessionFromRow = (row: SessionRow): Session =>
  Session.make({
    id: SessionId.make(row.id),
    projectId: row.project_id as FolderId,
    title: row.title,
    providerId: row.provider_id as ProviderId,
    model: row.model,
    status: row.status as Session["status"],
    archivedAt: row.archived_at === null ? null : new Date(row.archived_at),
    cursor: row.cursor,
    resumeStrategy: resumeStrategyFromRow(row.resume_strategy),
    runtimeMode: runtimeModeFromRow(row.runtime_mode),
    worktreeId:
      row.worktree_id === null
        ? null
        : (row.worktree_id as unknown as WorktreeId),
    chatId: row.chat_id as unknown as ChatId,
    forkedFromSessionId:
      row.forked_from_session_id === null
        ? null
        : SessionId.make(row.forked_from_session_id),
    forkedFromMessageId:
      row.forked_from_message_id === null
        ? null
        : (row.forked_from_message_id as MessageIdType),
    permissionMode: permissionModeFromRow(row.permission_mode),
    toolSearch: row.tool_search === 1,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  });

const sessionFromRecord = (record: SqlSessionReadRecord): Session =>
  Session.make({
    id: SessionId.make(record.sessionId),
    projectId: record.projectId as FolderId,
    title: record.title,
    providerId: record.providerId as ProviderId,
    model: record.model,
    status: record.status,
    archivedAt: record.archivedAt === null ? null : new Date(record.archivedAt),
    cursor: record.cursor,
    resumeStrategy: resumeStrategyFromRow(record.resumeStrategy),
    runtimeMode: runtimeModeFromRow(record.runtimeMode),
    worktreeId:
      record.worktreeId === null
        ? null
        : (record.worktreeId as unknown as WorktreeId),
    chatId: record.chatId as unknown as ChatId,
    forkedFromSessionId:
      record.forkedFromSessionId === null
        ? null
        : SessionId.make(record.forkedFromSessionId),
    forkedFromMessageId:
      record.forkedFromMessageId === null
        ? null
        : (record.forkedFromMessageId as MessageIdType),
    permissionMode: permissionModeFromRow(record.permissionMode),
    toolSearch: record.toolSearch,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  });

const chatFromRow = (row: ChatRow): Chat =>
  Chat.make({
    id: row.id as unknown as ChatId,
    projectId: row.project_id as FolderId,
    worktreeId:
      row.worktree_id === null
        ? null
        : (row.worktree_id as unknown as WorktreeId),
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

const normalizeMessageContent = (content: MessageContent): MessageContent => {
  if (content._tag === "context_compaction" && content.status === undefined) {
    return { ...content, status: "completed" };
  }
  return content;
};

const messageFromRow = (row: MessageRow): Message => {
  const content = normalizeMessageContent(
    JSON.parse(row.content_json) as MessageContent,
  );
  return Message.make({
    id: MessageId.make(row.id),
    sessionId: SessionId.make(row.session_id),
    role: row.role as MessageRole,
    content,
    createdAt: new Date(row.created_at),
  });
};

const messageFromRecord = (record: MessageReadRecord): Message =>
  Message.make({
    id: MessageId.make(record.messageId),
    sessionId: SessionId.make(record.sessionId),
    role: record.role as MessageRole,
    content: normalizeMessageContent(
      JSON.parse(record.contentJson) as MessageContent,
    ),
    createdAt: new Date(record.createdAt),
  });

/**
 * Derive a starting title from the first line of the user's prompt. Phase 3
 * tracks the placeholder so PR 7's "auto-title" pass can still rewrite blank
 * titles after the assistant replies.
 */
const titleFromInitial = (prompt: string | undefined): string => {
  if (prompt === undefined) return "New chat";
  const firstLine = prompt.trim().split("\n")[0] ?? "";
  const truncated = firstLine.slice(0, 60).trim();
  return truncated.length > 0 ? truncated : "New chat";
};

/** Provisional sidebar title before the LLM auto-namer runs. */
const deriveProvisionalTitle = (prompt: string | undefined): string => {
  if (prompt === undefined) return "New chat";
  if (isTrivialUserMessage(prompt)) return "New chat";
  return titleFromInitial(prompt);
};

const textFromMessageContent = (content: MessageContent): string | null => {
  if (content._tag === "user" || content._tag === "user_rich") {
    return content.text;
  }
  if (content._tag === "assistant") {
    return content.text;
  }
  return null;
};

/**
 * Render stacked code annotations into the numbered list the model receives.
 * Each entry is `path:lineRange — comment`; the agent's cwd is the workspace
 * root, so the relative path resolves when it reads the file. Pure string fn —
 * no I/O.
 */
const isBrowserAnnotation = (
  annotation: ComposerAnnotation,
): annotation is BrowserAnnotation =>
  "_tag" in annotation && annotation._tag === "browser";

const serializeCodeAnnotations = (
  annotations: ReadonlyArray<CodeAnnotation>,
): string => {
  const lines = annotations.map((a, i) => {
    const range =
      a.startLine === a.endLine
        ? `${a.startLine}`
        : `${a.startLine}-${a.endLine}`;
    return `${i + 1}. ${a.relPath}:${range} — ${a.comment}`;
  });
  return ["Code annotations:", ...lines].join("\n");
};

const serializeBrowserAnnotations = (
  annotations: ReadonlyArray<BrowserAnnotation>,
): string => {
  const lines = annotations.map((a, i) => {
    const targetCount = a.elements.length + a.regions.length + a.strokes.length;
    const firstElement = a.elements[0];
    const target =
      firstElement !== undefined
        ? `<${firstElement.tagName}> ${firstElement.label}`.trim()
        : `${targetCount} visual ${targetCount === 1 ? "target" : "targets"}`;
    const title =
      a.pageTitle !== null && a.pageTitle.trim().length > 0
        ? ` (${a.pageTitle.trim()})`
        : "";
    const screenshot =
      a.screenshotAttachment !== null ? " Screenshot attached." : "";
    return `${i + 1}. ${a.pageUrl}${title} — ${target}; ${a.comment}.${screenshot}`;
  });
  return ["Browser annotations:", ...lines].join("\n");
};

const serializeAnnotations = (
  annotations: ReadonlyArray<ComposerAnnotation>,
): string => {
  const code = annotations.filter(
    (annotation): annotation is CodeAnnotation =>
      !isBrowserAnnotation(annotation),
  );
  const browser = annotations.filter(isBrowserAnnotation);
  return [
    code.length > 0 ? serializeCodeAnnotations(code) : "",
    browser.length > 0 ? serializeBrowserAnnotations(browser) : "",
  ]
    .filter((section) => section.length > 0)
    .join("\n\n");
};

const formatProviderFailure = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message;
  if (cause !== null && typeof cause === "object") {
    const record = cause as Record<string, unknown>;
    const tag = typeof record["_tag"] === "string" ? record["_tag"] : null;
    const reason =
      typeof record["reason"] === "string" ? record["reason"] : null;
    const providerId =
      typeof record["providerId"] === "string" ? record["providerId"] : null;
    const sessionId =
      typeof record["sessionId"] === "string" ? record["sessionId"] : null;
    if (reason !== null && reason.length > 0) {
      const provider = providerId !== null ? `${providerId}: ` : "";
      return tag !== null
        ? `${tag}: ${provider}${reason}`
        : `${provider}${reason}`;
    }
    if (sessionId !== null) {
      return tag !== null
        ? `${tag}: ${sessionId}`
        : `No active provider process for session ${sessionId}.`;
    }
    try {
      return JSON.stringify(cause, null, 2);
    } catch {
      return String(cause);
    }
  }
  return String(cause);
};

// Auth failures (expired/missing OAuth, `401 Invalid authentication
// credentials`, `Please run /login`) are not recoverable by re-spawning the
// provider — restarting just hits the same 401, which is what left sessions
// retrying forever and eventually surfacing an unrelated transient (e.g. a
// Cloudflare 522). When the failure looks like auth we skip the restart and
// surface the error so the renderer can show the inline "Sign in" button.
const looksLikeAuthFailure = (reason: string): boolean =>
  /\b401\b|\bunauthorized\b|invalid authentication credentials|please run \/login|please log ?in|invalid api key|authentication failed|authorizationrequired/i.test(
    reason,
  );

/**
 * A persisted message together with the global event-log `sequence` its
 * `MessagePersisted` event was assigned — the cursor clients resume from.
 */
interface PersistedMessage {
  readonly message: Message;
  readonly sequence: number;
}

const ProviderStartRequest = Schema.Struct({
  initialPrompt: Schema.NullOr(Schema.String),
  modelOptionsJson: Schema.NullOr(Schema.String),
  enableSubagents: Schema.Boolean,
  forkFromResume: Schema.Boolean,
  background: Schema.Boolean,
  postBootStatus: Schema.Literals(["idle", "running"]),
});
type ProviderStartRequest = typeof ProviderStartRequest.Type;
const decodeProviderStartRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProviderStartRequest),
);
const decodeProviderModelOptions = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);
const decodeArchiveCleanupDetail = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ output: Schema.String })),
);
const decodeChatEvent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ChatEvent),
);
type ChatArchiveError =
  | ChatNotFoundError
  | ChatArchiveScriptError
  | ChatArchiveTimeoutError
  | ChatArchiveWorktreeError;

export const ConversationServicesLive = Layer.effectContext(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sessionQueries = yield* SqlSessionQueries;
    const sessionDomain = yield* SessionDomain;
    const chatDomain = yield* ChatDomain;
    const reactorEffects = makeReactorEffectJournal(sql);
    const currentTimestamp = DateTime.nowAsDate.pipe(
      Effect.map((now) => now.getTime()),
    );
    const dispatchSessionCommand = (
      sessionId: SessionId,
      command: SessionCommand,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* sessionDomain
          .dispatch({
            commandId: crypto.randomUUID(),
            streamId: sessionId,
            command,
          })
          .pipe(Effect.orDie);
        yield* runSessionReactors;
      });
    const dispatchChatCommand = (
      chatId: ChatId,
      command: ChatCommand,
      commandId: string = crypto.randomUUID(),
    ): Effect.Effect<void> =>
      chatDomain
        .dispatch({
          commandId,
          streamId: chatId,
          command,
        })
        .pipe(Effect.asVoid, Effect.orDie);
    let runSessionReactors: Effect.Effect<void> = Effect.void;
    let runProviderStartReactor: Effect.Effect<void, SessionStartError> =
      Effect.void;
    let runProviderStopReactor: Effect.Effect<void> = Effect.void;
    let runChatArchiveReactor: Effect.Effect<void, ChatArchiveError> =
      Effect.void;
    let runChatDeleteReactor: Effect.Effect<void, ChatNotFoundError> =
      Effect.void;
    const sessionReactorSemaphore = yield* Semaphore.make(1);
    const providerStartReactorSemaphore = yield* Semaphore.make(1);
    const providerStopReactorSemaphore = yield* Semaphore.make(1);
    const chatArchiveReactorSemaphore = yield* Semaphore.make(1);
    const chatDeleteReactorSemaphore = yield* Semaphore.make(1);
    const provider = yield* ProviderService;
    const attachProvider = (sessionId: SessionId, providerId: ProviderId) =>
      Effect.gen(function* () {
        yield* dispatchSessionCommand(sessionId, {
          _tag: "AttachProvider",
          providerId,
          attachedAt: yield* currentTimestamp,
        });
      });
    const closeProvider = (sessionId: SessionId) =>
      Effect.gen(function* () {
        yield* dispatchSessionCommand(sessionId, {
          _tag: "RequestProviderStop",
          requestedAt: yield* currentTimestamp,
        });
        yield* runProviderStopReactor;
      });
    const ndjson = yield* NdjsonLogger;
    const worktrees = yield* WorktreeService;
    const repositorySettings = yield* RepositorySettingsService;
    const ptys = yield* PtyService;
    const git = yield* GitService;
    const titleGen = yield* TitleGenerator;
    const configStore = yield* ConfigStoreService;
    // Captured once so the control-plane orchestration tools — which the
    // Claude SDK invokes as plain async functions — can bridge back into
    // these Effect methods via `Runtime.runPromise`. Same shape as the
    // browser-bridge tool binding in ProviderService.
    const runtime = yield* Effect.context<never>();
    const relayActivity = yield* RelayActivityPublisher;

    const chatColumns = yield* sql<{ readonly name: string }>`
      PRAGMA table_info(chats)
    `.pipe(Effect.orDie);
    const hasChatColumn = (name: string): boolean =>
      chatColumns.some((column) => column.name === name);
    if (!hasChatColumn("archived_worktree_json")) {
      yield* sql`
        ALTER TABLE chats
          ADD COLUMN archived_worktree_json TEXT
      `.pipe(Effect.orDie);
    }

    /**
     * Resolve the cwd a session should run in. NULL `worktreeId` falls
     * through to the project's main checkout (handled by `provider.start`
     * when `cwdOverride` is omitted). Missing rows also fall through.
     */
    const cwdForWorktree = (
      worktreeId: WorktreeId | null,
    ): Effect.Effect<string | undefined> =>
      worktreeId === null
        ? Effect.succeed(undefined)
        : Effect.map(worktrees.get(worktreeId), (wt) => wt?.path ?? undefined);

    const projectPath = (projectId: FolderId): Effect.Effect<string | null> =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly path: string }>`
          SELECT path FROM projects WHERE id = ${projectId} LIMIT 1
        `.pipe(Effect.orDie);
        return rows[0]?.path ?? null;
      });

    const runArchiveScript = ({
      chatId,
      script,
      cwd,
      env,
    }: {
      readonly chatId: ChatId;
      readonly script: string;
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
    }) =>
      Effect.tryPromise({
        try: () =>
          new Promise<{ readonly output: string }>((resolve, reject) => {
            let output = "";
            let timedOut = false;
            const child = spawn("/bin/zsh", ["-lc", script], {
              cwd,
              env: { ...(process.env as Record<string, string>), ...env },
              stdio: ["ignore", "pipe", "pipe"],
            });

            const append = (chunk: unknown) => {
              output = truncateArchiveOutput(output + String(chunk));
            };
            child.stdout?.on("data", append);
            child.stderr?.on("data", append);

            const timer = setTimeout(() => {
              timedOut = true;
              try {
                child.kill("SIGKILL");
              } catch {
                // already exited
              }
            }, ARCHIVE_SCRIPT_TIMEOUT_MS);

            child.on("error", (err) => {
              clearTimeout(timer);
              reject(
                new ChatArchiveScriptError({
                  chatId,
                  exitCode: null,
                  signal: null,
                  output: truncateArchiveOutput(
                    output ||
                      (err instanceof Error ? err.message : String(err)),
                  ),
                }),
              );
            });

            child.on("close", (code, signal) => {
              clearTimeout(timer);
              const finalOutput = truncateArchiveOutput(output);
              if (timedOut) {
                reject(
                  new ChatArchiveTimeoutError({
                    chatId,
                    timeoutMs: ARCHIVE_SCRIPT_TIMEOUT_MS,
                    output: finalOutput,
                  }),
                );
                return;
              }
              if (code !== 0) {
                reject(
                  new ChatArchiveScriptError({
                    chatId,
                    exitCode: code,
                    signal,
                    output: finalOutput,
                  }),
                );
                return;
              }
              resolve({ output: finalOutput });
            });
          }),
        catch: (err) =>
          err instanceof ChatArchiveScriptError ||
          err instanceof ChatArchiveTimeoutError
            ? err
            : new ChatArchiveScriptError({
                chatId,
                exitCode: null,
                signal: null,
                output: err instanceof Error ? err.message : String(err),
              }),
      });

    // Project-id cache so the per-message NDJSON append doesn't hit the DB
    // for every event. Populated lazily on first append per session.
    const projectIdBySession = new Map<SessionId, FolderId>();

    /**
     * Live runtime-mode cache. The driver reads this through the getter we
     * hand to `provider.start`, so a renderer-driven `setRuntimeMode` takes
     * effect on the next tool call without restarting the SDK. Populated on
     * every `provider.start` and on `setRuntimeMode`.
     */
    const runtimeModeBySession = new Map<SessionId, RuntimeMode>();
    const getRuntimeModeFor = (sessionId: SessionId): RuntimeMode =>
      runtimeModeBySession.get(sessionId) ?? DEFAULT_RUNTIME_MODE;

    /**
     * Live permission-mode cache. Persisted alongside the row so resume
     * brings the session back in the same mode; the in-memory map is the
     * fast path the chip uses to render without a round-trip.
     */
    const permissionModeBySession = new Map<SessionId, PermissionMode>();

    /**
     * Sub-agents config cached per session. Populated on `createSession`
     * and on the first `lookupSession` after boot; consumed by
     * `restartProviderSession` and `resumeSession` so the resumed SDK
     * session sees the same `agents` map the original creation chose.
     */
    const agentsBySession = new Map<
      SessionId,
      {
        agents: Readonly<Record<string, AgentDefinition>>;
        enableSubagents: boolean;
      }
    >();
    const turnIdsBySession = new Map<SessionId, string>();

    const beginTurn = (sessionId: SessionId): Effect.Effect<string> => {
      const existing = turnIdsBySession.get(sessionId);
      if (existing !== undefined) return Effect.succeed(existing);
      const turnId = `turn_${crypto.randomUUID()}`;
      return Effect.gen(function* () {
        const startedAt = yield* currentTimestamp;
        yield* dispatchSessionCommand(sessionId, {
          _tag: "StartTurn",
          turnId,
          startedAt,
        });
        turnIdsBySession.set(sessionId, turnId);
        return turnId;
      });
    };

    const settleActiveTurn = (
      sessionId: SessionId,
      outcome: "completed" | "interrupted" | "error",
    ): Effect.Effect<void> =>
      Effect.flatMap(currentTimestamp, (settledAt) =>
        dispatchSessionCommand(sessionId, {
          _tag: "SettleActiveTurn",
          outcome,
          settledAt,
        }),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            turnIdsBySession.delete(sessionId);
          }),
        ),
      );

    const ndjsonAppend = (
      sessionId: SessionId,
      persisted: PersistedMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const message = persisted.message;
        let projectId = projectIdBySession.get(sessionId);
        if (projectId === undefined) {
          const rows = yield* sql<{ readonly project_id: string }>`
            SELECT project_id FROM sessions WHERE id = ${sessionId} LIMIT 1
          `.pipe(
            Effect.catch(() =>
              Effect.succeed(
                [] as ReadonlyArray<{ readonly project_id: string }>,
              ),
            ),
          );
          if (rows.length === 0) return;
          projectId = rows[0]!.project_id as FolderId;
          projectIdBySession.set(sessionId, projectId);
        }
        yield* ndjson.append(sessionId, projectId, message);
      });

    const fibers = yield* Ref.make<
      ReadonlyMap<SessionId, Fiber.Fiber<unknown, unknown>>
    >(new Map());
    const goalPubsubs = yield* Ref.make<
      ReadonlyMap<
        SessionId,
        PubSub.PubSub<{
          readonly sessionId: SessionId;
          readonly goal: ThreadGoal | null;
        }>
      >
    >(new Map());
    const goalsBySession = new Map<string, ThreadGoal | null>();

    // Single hub for chat-row changes (create / title / worktree binding).
    // Chats are few and updates rare, so one project-filtered hub keeps it
    // simple. The renderer seeds
    // from `chat.list`; this stream carries live changes after subscription,
    // so a Zuse-orchestrated spawn appears in the sidebar without
    // requiring a full app reload.
    const chatChangesHub = yield* PubSub.unbounded<Chat>();
    const broadcastChat = (chat: Chat): Effect.Effect<void> =>
      PubSub.publish(chatChangesHub, chat).pipe(Effect.asVoid);

    // Chats whose LLM auto-name is in flight — cleared when the fiber ends.
    // Chats that already received a successful LLM title this process lifetime.

    const getOrMakeGoalPubsub = (sessionId: SessionId) =>
      Effect.gen(function* () {
        const map = yield* Ref.get(goalPubsubs);
        const existing = map.get(sessionId);
        if (existing !== undefined) return existing;
        const pubsub = yield* PubSub.unbounded<{
          readonly sessionId: SessionId;
          readonly goal: ThreadGoal | null;
        }>();
        yield* Ref.update(goalPubsubs, (m) => {
          const next = new Map(m);
          next.set(sessionId, pubsub);
          return next;
        });
        return pubsub;
      });

    const publishGoal = (
      sessionId: SessionId,
      goal: ThreadGoal | null,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        goalsBySession.set(sessionId, goal);
        const pubsub = yield* getOrMakeGoalPubsub(sessionId);
        yield* PubSub.publish(pubsub, { sessionId, goal }).pipe(Effect.asVoid);
      });

    const latestGoalUserMessageMatches = (
      sessionId: SessionId,
      text: string,
    ): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly content_json: string }>`
          SELECT content_json FROM messages
          WHERE session_id = ${sessionId} AND role = 'user'
          ORDER BY created_at DESC
          LIMIT 1
        `.pipe(Effect.orDie);
        const raw = rows[0]?.content_json;
        if (raw === undefined) return false;
        try {
          const content = JSON.parse(raw) as MessageContent;
          if (content._tag !== "user" && content._tag !== "user_rich") {
            return false;
          }
          return content.goal === true && content.text.trim() === text.trim();
        } catch {
          return false;
        }
      });

    const lookupSession = (
      sessionId: SessionId,
    ): Effect.Effect<Session, SessionNotFoundError> =>
      Effect.gen(function* () {
        const record = yield* sessionQueries
          .get(sessionId)
          .pipe(
            Effect.catch((error) =>
              error._tag === "SessionQueryNotFound"
                ? Effect.fail(new SessionNotFoundError({ sessionId }))
                : Effect.die(error),
            ),
          );
        // Hydrate the agents cache from the row on first sight after boot
        // so resume / lazy-restart pick up the same roster the session was
        // created with.
        if (!agentsBySession.has(sessionId)) {
          const parsed = parseAgents(record.agentsJson);
          if (parsed !== null && "agents" in parsed) {
            const hydrated = parsed as unknown as {
              agents: Record<string, AgentDefinition>;
              enableSubagents?: boolean;
            };
            agentsBySession.set(sessionId, {
              agents: hydrated.agents,
              enableSubagents: hydrated.enableSubagents ?? true,
            });
          }
        }
        return sessionFromRecord(record);
      });

    const agentsFor = (sessionId: SessionId) => agentsBySession.get(sessionId);

    const toolUseFingerprint = (
      content: Extract<MessageContent, { readonly _tag: "tool_use" }>,
    ): string => {
      try {
        return JSON.stringify({
          itemId: content.itemId,
          tool: content.tool,
          input: canonicalizeToolInput(content.input),
          parentItemId: content.parentItemId ?? null,
        });
      } catch {
        return `${content.itemId}:${content.tool}:${String(content.input)}:${content.parentItemId ?? ""}`;
      }
    };

    const isDuplicateToolUse = (
      sessionId: SessionId,
      content: Extract<MessageContent, { readonly _tag: "tool_use" }>,
    ): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly content_json: string }>`
          SELECT content_json FROM messages
          WHERE session_id = ${sessionId} AND kind = 'tool_use'
          ORDER BY sequence DESC
        `.pipe(Effect.orDie);
        const nextFingerprint = toolUseFingerprint(content);
        for (const row of rows) {
          try {
            const existing = JSON.parse(row.content_json) as MessageContent;
            if (
              existing._tag === "tool_use" &&
              existing.itemId === content.itemId &&
              toolUseFingerprint(existing) === nextFingerprint
            ) {
              return true;
            }
          } catch {
            // Ignore malformed legacy rows; the normal schema path keeps JSON valid.
          }
        }
        return false;
      });

    const persistMessage = (
      sessionId: SessionId,
      content: MessageContent,
      idOverride?: MessageId,
    ): Effect.Effect<PersistedMessage> =>
      Effect.gen(function* () {
        // `idOverride` is the renderer-minted `clientMessageId` for an
        // optimistic user message — reuse it so the live-stream echo carries
        // the same id the renderer already inserted. All other persists
        // (assistant/tool/error/goal) omit it and get a fresh server id.
        const id = idOverride ?? MessageId.make(crypto.randomUUID());
        const role = roleForContent(content);
        const now = new Date();
        const parentItemId = parentItemIdOfContent(content);
        yield* sessionDomain
          .dispatch({
            commandId: `message:persist:${id}`,
            streamId: sessionId,
            command: {
              _tag: "PersistMessage",
              messageId: id,
              turnId: turnIdsBySession.get(sessionId) ?? null,
              role,
              kind: content._tag,
              contentJson: JSON.stringify(content),
              parentItemId,
              createdAt: now.getTime(),
            },
          })
          .pipe(Effect.orDie);
        const projected = yield* sql<{ readonly sequence: number }>`
          SELECT sequence FROM messages WHERE id = ${id} LIMIT 1
        `.pipe(Effect.orDie);
        const sequence = projected[0]?.sequence;
        if (sequence === undefined) {
          return yield* Effect.die(
            new Error(`message projection missing after dispatch: ${id}`),
          );
        }
        return {
          message: Message.make({
            id,
            sessionId,
            role,
            content,
            createdAt: now,
          }),
          sequence,
        };
      });

    let flushQueueAfterIdle: (
      sessionId: SessionId,
    ) => Effect.Effect<void> = () => Effect.void;
    let shutdownQueueSession: (
      sessionId: SessionId,
    ) => Effect.Effect<void> = () => Effect.void;

    const setStatus = (
      sessionId: SessionId,
      status: Session["status"],
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* dispatchSessionCommand(sessionId, {
          _tag: "SetStatus",
          status,
          updatedAt: yield* currentTimestamp,
        });
        if (status === "idle" || status === "closed") {
          yield* Effect.forkDetach(flushQueueAfterIdle(sessionId));
        }
      });

    const publishRelayActivity = (
      sessionId: SessionId,
      kind:
        | "approval-needed"
        | "question-needed"
        | "completed"
        | "error"
        | "running",
    ): Effect.Effect<void> =>
      relayActivity
        .publish({ sessionId, kind })
        .pipe(
          Effect.catch((error) =>
            Effect.logDebug(
              `[ConversationServices] relay activity publish failed: ${error.reason}`,
            ),
          ),
        );

    /**
     * Fork a daemon that consumes the provider's event stream for one
     * session and persists each renderable event into `messages` while
     * fanning a copy out to live subscribers. Lifecycle events drive
     * `sessions.status`. Failure paths are swallowed at the daemon
     * boundary — the alternative is a runaway error that bubbles into the
     * RPC server and tears down the whole transport.
     */
    const startSubscription = (sessionId: SessionId): Effect.Effect<void> =>
      Effect.gen(function* () {
        const session = yield* lookupSession(sessionId).pipe(Effect.orDie);
        const fiber = yield* Effect.forkDetach(
          Stream.runForEach(provider.events(sessionId), (event) =>
            Effect.gen(function* () {
              if (event._tag === "Status") {
                if (
                  event.status === "running" ||
                  event.status === "closed" ||
                  event.status === "error" ||
                  event.status === "idle"
                ) {
                  yield* setStatus(sessionId, event.status);
                  if (event.status === "running") {
                    yield* publishRelayActivity(sessionId, "running");
                  }
                }
                return;
              }
              if (event._tag === "Completed") {
                yield* settleActiveTurn(
                  sessionId,
                  event.reason === "interrupted"
                    ? "interrupted"
                    : event.reason === "error"
                      ? "error"
                      : "completed",
                );
                yield* setStatus(
                  sessionId,
                  event.reason === "error" ? "error" : "closed",
                );
                yield* publishRelayActivity(
                  sessionId,
                  event.reason === "error" ? "error" : "completed",
                );
                return;
              }
              if (event._tag === "SessionCursor") {
                yield* dispatchSessionCommand(sessionId, {
                  _tag: "SetResume",
                  cursor: event.cursor,
                  resumeStrategy: event.strategy,
                  updatedAt: yield* currentTimestamp,
                });
                return;
              }
              if (event._tag === "PermissionModeChanged") {
                // SDK flipped its lifecycle mode (typically because
                // ExitPlanMode just ran successfully). Persist + cache
                // so the chat-header chip auto-untoggles and a future
                // `provider.start` resume passes the new mode through.
                yield* dispatchSessionCommand(sessionId, {
                  _tag: "SetPermissionMode",
                  permissionMode: event.mode,
                  updatedAt: yield* currentTimestamp,
                });
                permissionModeBySession.set(sessionId, event.mode);
                return;
              }
              if (event._tag === "GoalUpdated") {
                yield* publishGoal(sessionId, ThreadGoal.make(event.goal));
                return;
              }
              if (event._tag === "GoalCleared") {
                yield* publishGoal(sessionId, null);
                return;
              }
              if (
                session.providerId === "grok" &&
                event._tag === "Error" &&
                isIgnorableGrokAuthNoise(event.message)
              ) {
                return;
              }
              if (event._tag === "PermissionRequest") {
                yield* publishRelayActivity(sessionId, "approval-needed");
              }
              if (event._tag === "UserQuestion") {
                yield* publishRelayActivity(sessionId, "question-needed");
              }
              const content = eventToContent(event);
              if (content === null) return;
              if (
                content._tag === "tool_use" &&
                (yield* isDuplicateToolUse(sessionId, content))
              ) {
                return;
              }
              const persisted = yield* persistMessage(sessionId, content);
              yield* ndjsonAppend(sessionId, persisted);
              // A provider `Error` event terminates the turn but, unlike a
              // `Completed`, carries no lifecycle reason of its own — so
              // without this the session is left pinned at `running` and the
              // composer / setup card spin forever (this is the "stuck on the
              // loading screen" symptom for auth failures, which surface as a
              // mid-stream Error with no trailing result message). Flip to
              // `error` so the renderer shows the error bubble + login CTA.
              if (event._tag === "Error") {
                yield* settleActiveTurn(sessionId, "error");
                yield* publishRelayActivity(sessionId, "error");
                yield* setStatus(sessionId, "error");
              }
              if (event._tag === "Interrupted") {
                yield* settleActiveTurn(sessionId, "interrupted");
                yield* setStatus(sessionId, "idle");
              }
            }),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                if (turnIdsBySession.has(sessionId)) {
                  yield* settleActiveTurn(sessionId, "error").pipe(
                    Effect.catchCause(() => Effect.void),
                  );
                }
                yield* Effect.logDebug(
                  "[ConversationServices] event stream ended",
                );
                yield* Effect.logDebug(cause);
              }),
            ),
          ),
        );
        yield* Ref.update(fibers, (m) => {
          const next = new Map(m);
          next.set(sessionId, fiber);
          return next;
        });
      });

    // Interrupt only the provider event-pump fiber. Durable session-event
    // subscribers stay connected while `sendMessage` lazily restarts the
    // provider and installs a fresh pump. Use this for setModel / setProvider /
    // resumeSession — anything that swaps the provider session out and
    // back in. Use `teardownSubscription` instead when the session itself
    // is going away (deleteSession).
    const interruptProviderFiber = (
      sessionId: SessionId,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const fiberMap = yield* Ref.get(fibers);
        const fiber = fiberMap.get(sessionId);
        if (fiber === undefined) return;
        yield* Fiber.interrupt(fiber);
        yield* Ref.update(fibers, (m) => {
          const next = new Map(m);
          next.delete(sessionId);
          return next;
        });
      });

    const teardownSubscription = (sessionId: SessionId): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* interruptProviderFiber(sessionId);
        yield* shutdownQueueSession(sessionId);
      });

    // Boot recovery: any session left in `running` is stale (the previous
    // run's provider session died with the process). Demote to `idle` so the
    // sidebar reflects reality, but DO NOT pollute the message timeline with
    // synthetic rows — `sendMessage` will lazily restart the provider on the
    // next user turn (see below).
    const staleSessions = yield* sql<{
      readonly id: string;
      readonly status: "running" | "booting";
    }>`
      SELECT id, status FROM sessions
      WHERE status IN ('running', 'booting') AND archived_at IS NULL
    `.pipe(Effect.orDie);
    for (const stale of staleSessions) {
      if (stale.status === "running") {
        yield* settleActiveTurn(SessionId.make(stale.id), "error");
      }
      yield* dispatchSessionCommand(SessionId.make(stale.id), {
        _tag: "SetStatus",
        status: stale.status === "running" ? "idle" : "error",
        updatedAt: yield* currentTimestamp,
      });
    }

    const listSessions: ConversationOperations["listSessions"] = (
      projectId,
      includeArchived,
    ) =>
      sessionQueries.list({ projectId, includeArchived }).pipe(
        Effect.map((records) => records.map(sessionFromRecord)),
        Effect.orDie,
      );

    /**
     * Resolve a chat row for createSession. Failures surface as
     * SessionStartError so the renderer treats unknown / archived chat ids
     * the same as provider boot failures.
     */
    const lookupChatForSession = (
      chatId: ChatId,
      providerId: ProviderId,
    ): Effect.Effect<ChatRow, SessionStartError> =>
      Effect.gen(function* () {
        const rows = yield* sql<ChatRow>`
          SELECT id, project_id, worktree_id, title, active_session_id, origin_session_id,
                 archived_at, archived_worktree_json, last_message_at, last_read_at, created_at, updated_at
          FROM chats WHERE id = ${chatId} LIMIT 1
        `.pipe(Effect.orDie);
        const row = rows[0];
        if (row === undefined) {
          return yield* Effect.fail(
            new SessionStartError({
              providerId,
              reason: `chat ${chatId} not found`,
            }),
          );
        }
        if (row.archived_at !== null) {
          return yield* Effect.fail(
            new SessionStartError({
              providerId,
              reason: "cannot create a session in an archived chat",
            }),
          );
        }
        return row;
      });

    /**
     * Build the session-bound control-plane (orchestration) tool bundle. The
     * tools are built in for every managed session; mutating calls still go
     * through the normal provider permission gate. Each tool bridges back into
     * these Effect methods via `Runtime.runPromise`, mapping every typed failure to a
     * `{ ok: false, error }` result so provider MCP handlers never throw.
     *
     * Spawned threads carry `originSessionId = ctx.sessionId` for lineage, and
     * inherit this session's provider/model unless the agent overrides them.
     */
    const buildOrchestrationForSession = (ctx: {
      readonly sessionId: SessionId;
      readonly chatId: ChatId;
      readonly projectId: FolderId;
      readonly worktreeId: WorktreeId | null;
      readonly providerId: ProviderId;
      readonly model: string;
    }): Effect.Effect<OrchestrationSessionTools | null> =>
      Effect.gen(function* () {
        const settings = yield* configStore
          .getSettings()
          .pipe(Effect.catchCause(() => Effect.succeed(null)));
        const level: AutonomyLevel = "approval-gated";
        const run = Effect.runPromiseWith(runtime);
        const providerModelFor = (input: {
          readonly providerId?: string;
          readonly model?: string;
        }): { readonly providerId: ProviderId; readonly model: string } => {
          const providerId =
            (input.providerId as ProviderId | undefined) ?? ctx.providerId;
          const model =
            input.model ??
            (providerId === ctx.providerId
              ? ctx.model
              : (settings?.defaultModelByProvider[providerId] ??
                defaultModelFor(providerId)));
          return { providerId, model };
        };
        const sourceForBaseBranch = (
          baseBranch: string | undefined,
        ): WorktreeCreateSource | undefined =>
          baseBranch !== undefined
            ? { _tag: "branch", branch: baseBranch, remote: null }
            : undefined;
        const createWorktreeForOrchestration = (baseBranch?: string) =>
          worktrees.create(ctx.projectId, sourceForBaseBranch(baseBranch));
        const createOrchestrationChat = (input: {
          readonly task: string;
          readonly title?: string;
          readonly worktreeId: WorktreeId | null;
          readonly providerId?: string;
          readonly model?: string;
        }) => {
          const { providerId, model } = providerModelFor(input);
          return createChat({
            projectId: ctx.projectId,
            providerId,
            model,
            title: input.title,
            initialPrompt: input.task,
            worktreeId: input.worktreeId,
            originSessionId: ctx.sessionId,
          }).pipe(
            Effect.map((res) => ({
              ok: true as const,
              chatId: res.chat.id as string,
              sessionId: res.initialSession.id as string,
              title: res.chat.title,
              worktreeId:
                res.chat.worktreeId === null
                  ? null
                  : (res.chat.worktreeId as string),
            })),
          );
        };
        const createOrchestrationSession = (input: {
          readonly task: string;
          readonly title?: string;
          readonly chatId: ChatId;
          readonly providerId?: string;
          readonly model?: string;
        }) => {
          const { providerId, model } = providerModelFor(input);
          return createSession({
            chatId: input.chatId,
            providerId,
            model,
            title: input.title,
            initialPrompt: input.task,
            originSessionId: ctx.sessionId,
            background: true,
          }).pipe(
            Effect.map((session) => ({
              ok: true as const,
              chatId: session.chatId as string,
              sessionId: session.id as string,
              title: session.title,
              worktreeId:
                session.worktreeId === null
                  ? null
                  : (session.worktreeId as string),
            })),
          );
        };
        const deps: OrchestrationToolDeps = {
          createWorktree: (input) =>
            run(
              createWorktreeForOrchestration(input.baseBranch).pipe(
                Effect.map((wt) => ({
                  ok: true as const,
                  worktreeId: wt.id as string,
                  path: wt.path,
                  branch: wt.branch,
                })),
                Effect.catch((err) =>
                  Effect.succeed({
                    ok: false as const,
                    error: orchestrationErrorText(err),
                  }),
                ),
              ),
            ),
          createThread: (input) =>
            run(
              Effect.gen(function* () {
                const wt = yield* createWorktreeForOrchestration(
                  input.baseBranch,
                );
                const chat = yield* createOrchestrationChat({
                  task: input.task,
                  title: input.title,
                  worktreeId: wt.id,
                  providerId: input.providerId,
                  model: input.model,
                }).pipe(Effect.result);
                if (chat._tag === "Failure") {
                  return {
                    ok: false as const,
                    error: `${orchestrationErrorText(chat.failure)}; orphaned worktreeId: ${wt.id as string}`,
                  };
                }
                return {
                  ok: true as const,
                  chatId: chat.success.chatId,
                  sessionId: chat.success.sessionId,
                  title: chat.success.title,
                  worktreeId: wt.id as string,
                  path: wt.path,
                  branch: wt.branch,
                };
              }).pipe(
                Effect.catch((err) =>
                  Effect.succeed({
                    ok: false as const,
                    error: orchestrationErrorText(err),
                  }),
                ),
              ),
            ),
          createSession: (input) =>
            run(
              Effect.gen(function* () {
                const chatId =
                  input.chatId !== undefined
                    ? (input.chatId as ChatId)
                    : ctx.chatId;
                const chat = yield* lookupChat(chatId).pipe(Effect.result);
                if (chat._tag === "Failure") {
                  return {
                    ok: false as const,
                    error: `chatId ${chatId as string} not found`,
                  };
                }
                if (
                  (chat.success.projectId as string) !==
                  (ctx.projectId as string)
                ) {
                  return {
                    ok: false as const,
                    error: `chatId ${chatId as string} does not belong to this project`,
                  };
                }
                if (chat.success.archivedAt !== null) {
                  return {
                    ok: false as const,
                    error: `chatId ${chatId as string} is archived`,
                  };
                }
                return yield* createOrchestrationSession({
                  task: input.task,
                  title: input.title,
                  chatId,
                  providerId: input.providerId,
                  model: input.model,
                });
              }).pipe(
                Effect.catch((err) =>
                  Effect.succeed({
                    ok: false as const,
                    error: orchestrationErrorText(err),
                  }),
                ),
              ),
            ),
          sendToThread: (input) =>
            run(
              Effect.gen(function* () {
                const target = yield* getSession(input.sessionId as SessionId);
                yield* sendMessage(
                  input.sessionId as SessionId,
                  input.text,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  {
                    chatId: ctx.chatId,
                    sessionId: ctx.sessionId,
                    providerId: ctx.providerId,
                  },
                );
                return {
                  ok: true as const,
                  queued: false,
                  chatId: target.chatId as string,
                };
              }).pipe(
                Effect.catch((err) =>
                  Effect.succeed({
                    ok: false as const,
                    error: orchestrationErrorText(err),
                  }),
                ),
              ),
            ),
          readThread: (input) =>
            run(
              Effect.gen(function* () {
                const session = yield* getSession(input.sessionId as SessionId);
                const msgs = yield* listMessages(input.sessionId as SessionId);
                const limit = input.limit ?? 20;
                const messages = msgs.slice(-limit).map((m) => ({
                  role: m.role,
                  text: messageContentToText(m.content),
                }));
                return {
                  ok: true as const,
                  status: session.status,
                  messages,
                };
              }).pipe(
                Effect.catch((err) =>
                  Effect.succeed({
                    ok: false as const,
                    error: orchestrationErrorText(err),
                  }),
                ),
              ),
            ),
          listThreads: (input) =>
            run(
              Effect.gen(function* () {
                const includeArchived = input.includeArchived ?? false;
                const chats = yield* listChats(ctx.projectId, includeArchived);
                const sessions = yield* listSessions(
                  ctx.projectId,
                  includeArchived,
                );
                const statusBySession = new Map(
                  sessions.map((s) => [s.id as string, s.status as string]),
                );
                const threads = chats.map((c) => ({
                  chatId: c.id as string,
                  sessionId: (c.activeSessionId ?? "") as string,
                  title: c.title,
                  worktreeId:
                    c.worktreeId === null ? null : (c.worktreeId as string),
                  status:
                    c.activeSessionId !== null
                      ? (statusBySession.get(c.activeSessionId as string) ??
                        "unknown")
                      : "unknown",
                  spawnedByMe: c.originSessionId === ctx.sessionId,
                }));
                return { ok: true as const, threads };
              }).pipe(
                Effect.catch((err) =>
                  Effect.succeed({
                    ok: false as const,
                    error: orchestrationErrorText(err),
                  }),
                ),
              ),
            ),
          listModels: (input) =>
            Promise.resolve().then(() => {
              const allProviderIds = Object.keys(
                MODELS_BY_PROVIDER,
              ) as ProviderId[];
              const providerIds =
                input.providerId !== undefined
                  ? allProviderIds.includes(input.providerId as ProviderId)
                    ? [input.providerId as ProviderId]
                    : []
                  : allProviderIds;
              if (input.providerId !== undefined && providerIds.length === 0) {
                return {
                  ok: false as const,
                  error: `Unknown providerId: ${input.providerId}`,
                };
              }
              const providers = providerIds.map((providerId) => {
                const defaultModel =
                  settings?.defaultModelByProvider[providerId] ??
                  defaultModelFor(providerId);
                const models = visibleModelsForProvider(
                  providerId,
                  settings?.modelEnabledByProvider,
                  { includeModelId: defaultModel },
                ).map((model) => ({
                  id: model.id,
                  label: model.label,
                  defaultModel: model.id === defaultModel,
                }));
                return {
                  providerId,
                  defaultModel,
                  models,
                };
              });
              return { ok: true as const, providers };
            }),
          whoami: () =>
            Promise.resolve({
              sessionId: ctx.sessionId as string,
              chatId: ctx.chatId as string,
              projectId: ctx.projectId as string,
              worktreeId:
                ctx.worktreeId === null ? null : (ctx.worktreeId as string),
              providerId: ctx.providerId as string,
              model: ctx.model,
              autonomyLevel: level,
            }),
        };
        return {
          deps,
          claudeTools: buildOrchestrationTools(deps),
        };
      });

    const createSession: ConversationOperations["createSession"] = (
      input: CreateSessionInput,
    ) =>
      Effect.gen(function* () {
        // Project + worktree are inherited from the chat row — clients no
        // longer pass them at session-create time. Fail-fast on missing /
        // archived chats so we never leave a stray provider session behind.
        const chatRow = yield* lookupChatForSession(
          input.chatId,
          input.providerId,
        );
        const projectId = chatRow.project_id as FolderId;
        const worktreeId: WorktreeId | null =
          chatRow.worktree_id === null
            ? null
            : (chatRow.worktree_id as unknown as WorktreeId);
        // Mint the session id up-front so the row + caches exist BEFORE
        // `provider.start` runs. Background-mode callers (`session.create`)
        // can then return immediately and let the slow CLI boot flip the
        // status out of `"booting"` from a daemon fiber.
        const sessionId = SessionId.make(`s_${crypto.randomUUID()}`);
        const effectiveEnableSubagents =
          input.enableSubagents ??
          (input.agents !== undefined && Object.keys(input.agents).length > 0);
        const initialPermissionMode =
          input.permissionMode ?? DEFAULT_PERMISSION_MODE;
        const initialToolSearch = input.toolSearch ?? false;
        const initialRuntimeMode = input.runtimeMode ?? DEFAULT_RUNTIME_MODE;
        runtimeModeBySession.set(sessionId, initialRuntimeMode);
        permissionModeBySession.set(sessionId, initialPermissionMode);
        if (
          input.agents !== undefined &&
          Object.keys(input.agents).length > 0
        ) {
          agentsBySession.set(sessionId, {
            agents: input.agents,
            enableSubagents: effectiveEnableSubagents,
          });
        }
        const now = new Date();
        const title =
          input.title?.trim() || deriveProvisionalTitle(input.initialPrompt);
        const agentsJson =
          input.agents !== undefined && Object.keys(input.agents).length > 0
            ? JSON.stringify({
                agents: input.agents,
                enableSubagents: effectiveEnableSubagents,
              })
            : null;
        const hasInitial =
          input.initialPrompt !== undefined &&
          input.initialPrompt.trim().length > 0;
        // Lineage: when this chat was spawned by another agent (orchestration
        // sets chats.origin_session_id), stamp the initial user message with
        // the origin so the renderer can attribute + link it. Skip silently
        // if the origin session row is gone.
        let origin: MessageOrigin | undefined;
        const originSessionId =
          input.originSessionId ?? chatRow.origin_session_id;
        if (hasInitial && originSessionId !== null) {
          const originRows = yield* sql<{
            readonly chat_id: string;
            readonly provider_id: string;
          }>`
            SELECT chat_id, provider_id FROM sessions WHERE id = ${originSessionId}
          `.pipe(Effect.orDie);
          const originRow = originRows[0];
          if (originRow !== undefined) {
            origin = {
              chatId: originRow.chat_id as ChatId,
              sessionId: originSessionId as SessionId,
              providerId: originRow.provider_id as ProviderId,
            };
          }
        }
        const promptForProvider = input.initialPrompt;
        const background = input.background === true;
        const resumeCursor = input.resumeCursor ?? null;
        const resumeStrategy: ResumeStrategy =
          resumeCursor === null ? "none" : (input.resumeStrategy ?? "none");
        const forkedFromSessionId = input.forkedFromSessionId ?? null;
        const forkedFromMessageId = input.forkedFromMessageId ?? null;
        // Only fork the transcript when we actually have a cursor to fork.
        const forkFromResume =
          input.forkFromResume === true && resumeCursor !== null;
        const postBootStatus: Session["status"] = hasInitial
          ? "running"
          : "idle";
        const providerStart: ProviderStartRequest = {
          initialPrompt: promptForProvider ?? null,
          modelOptionsJson:
            input.modelOptions === undefined
              ? null
              : JSON.stringify(input.modelOptions),
          enableSubagents: effectiveEnableSubagents,
          forkFromResume,
          background,
          postBootStatus,
        };
        // Synchronous mode (chat.create) inserts with the final post-boot
        // status because it waits for `provider.start` below — the row is
        // never visible to the renderer in `booting`. Background mode
        // (session.create) inserts as `booting`; the daemon flips it.
        const rowStatus: Session["status"] = background
          ? "booting"
          : postBootStatus;
        const createSessionRecord = sessionDomain
          .dispatch({
            commandId: `session:create:${sessionId}`,
            streamId: sessionId,
            command: {
              _tag: "CreateSession",
              sessionId,
              chatId: input.chatId,
              projectId,
              title,
              providerId: input.providerId,
              model: input.model,
              status: rowStatus,
              cursor: resumeCursor,
              resumeStrategy,
              runtimeMode: initialRuntimeMode,
              agentsJson,
              worktreeId,
              forkedFromSessionId,
              forkedFromMessageId,
              permissionMode: initialPermissionMode,
              toolSearch: initialToolSearch,
              providerStartJson: JSON.stringify(providerStart),
              createdAt: now.getTime(),
            },
          })
          .pipe(Effect.orDie);
        yield* createSessionRecord;
        yield* lookupChat(input.chatId).pipe(
          Effect.flatMap(broadcastChat),
          Effect.catch(() => Effect.void),
        );
        if (hasInitial) {
          yield* beginTurn(sessionId);
          yield* persistMessage(sessionId, {
            _tag: "user",
            text: input.initialPrompt!,
            goal: false,
            ...(origin !== undefined ? { origin } : {}),
          });
        }
        if (background) {
          // Detach the boot so the RPC reply happens immediately. The status
          // durable event feed carries the eventual transition to clients;
          // on failure we mark `error` and log so
          // the user sees a closable failed tab instead of a stuck spinner.
          yield* Effect.forkDetach(
            runProviderStartReactor.pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  `[ConversationServices] provider start reactor failed: ${String(cause)}`,
                ),
              ),
            ),
            { startImmediately: true },
          );
          return Session.make({
            id: sessionId,
            projectId,
            title,
            providerId: input.providerId,
            model: input.model,
            status: "booting",
            archivedAt: null,
            cursor: resumeCursor,
            resumeStrategy,
            runtimeMode: initialRuntimeMode,
            worktreeId,
            chatId: input.chatId,
            forkedFromSessionId,
            forkedFromMessageId,
            permissionMode: initialPermissionMode,
            toolSearch: initialToolSearch,
            createdAt: now,
            updatedAt: now,
          });
        }
        // Synchronous boot — used by `chat.create` so its existing staged
        // loading panel (which animates over the full ~60s wait) stays in
        // lockstep with the actual provider handshake. Boot failures bubble
        // back as `SessionStartError`; the caller (`createChat`) rolls back
        // the chat row in that case.
        yield* runProviderStartReactor;
        return Session.make({
          id: sessionId,
          projectId,
          title,
          providerId: input.providerId,
          model: input.model,
          status: postBootStatus,
          archivedAt: null,
          cursor: resumeCursor,
          resumeStrategy,
          runtimeMode: initialRuntimeMode,
          worktreeId,
          chatId: input.chatId,
          forkedFromSessionId,
          forkedFromMessageId,
          permissionMode: initialPermissionMode,
          toolSearch: initialToolSearch,
          createdAt: now,
          updatedAt: now,
        });
      });

    const renameSession: ConversationOperations["renameSession"] = (
      sessionId,
      title,
    ) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        yield* dispatchSessionCommand(sessionId, {
          _tag: "SetTitle",
          title,
          updatedAt: yield* currentTimestamp,
        });
      });

    /**
     * Update the per-session runtime mode. Persists immediately. The driver's
     * `canUseTool` callback observes the new value via `provider.start`'s
     * runtime-mode getter on the next tool call — no need to restart the SDK.
     */
    const setRuntimeMode: ConversationOperations["setRuntimeMode"] = (
      sessionId,
      runtimeMode,
    ) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        yield* dispatchSessionCommand(sessionId, {
          _tag: "SetRuntimeMode",
          runtimeMode,
          updatedAt: yield* currentTimestamp,
        });
        // Poke the in-memory cache so the next `canUseTool` invocation picks
        // up the new mode without restarting the SDK.
        runtimeModeBySession.set(sessionId, runtimeMode);
      });

    /**
     * Switch SDK lifecycle mode mid-session. Persists, updates the cache,
     * then forwards to `provider.setPermissionMode` which calls
     * `Query.setPermissionMode` on the live SDK handle and emits a
     * `PermissionModeChanged` event the renderer subscribes to.
     */
    const setPermissionMode: ConversationOperations["setPermissionMode"] = (
      sessionId,
      mode,
    ) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        yield* dispatchSessionCommand(sessionId, {
          _tag: "SetPermissionMode",
          permissionMode: mode,
          updatedAt: yield* currentTimestamp,
        });
        permissionModeBySession.set(sessionId, mode);
        yield* provider.setPermissionMode(sessionId, mode).pipe(
          // The SDK session may have been closed (idle / closed status).
          // Persisting the mode is enough — when the renderer hits Send,
          // `restartProviderSession` will pass the persisted value back
          // into `provider.start`'s Options.
          Effect.catch(() => Effect.void),
        );
      });

    /**
     * Resolve a pending AskUserQuestion. Persist the answer first so a
     * crash mid-flight doesn't leave the renderer with no record; then
     * forward to the driver, which resolves the deferred Promise and
     * lets the SDK turn unwind with the answers as the tool result.
     */
    const answerQuestion: ConversationOperations["answerQuestion"] = (
      sessionId,
      itemId,
      answers,
    ) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        const persisted = yield* persistMessage(sessionId, {
          _tag: "user_question_answer",
          itemId,
          answers,
        });
        // Broadcast so the renderer sees the answer arrive on
        // `messages.stream` and the ChatComposer's `pendingQuestion`
        // selector flips to null — switching the composer slot back
        // from the QuestionCard to the regular editor. Without this,
        // the row sits in the DB until the next hydrate.
        yield* ndjsonAppend(sessionId, persisted);
        yield* provider
          .answerQuestion(sessionId, itemId, answers)
          .pipe(Effect.catch(() => Effect.void));
      });

    /**
     * Switch the worktree the session runs in. Allowed only before the
     * first user message is recorded — cwd cannot move under a running
     * agent. The renderer guards via `messagesCount > 0`, but we re-check
     * server-side so a stale client can't race past the lock.
     */
    const setWorktree: ConversationOperations["setWorktree"] = (
      sessionId,
      worktreeId,
    ) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        const existing = yield* sql<{ readonly id: string }>`
          SELECT id FROM messages
          WHERE session_id = ${sessionId} AND role = 'user'
          LIMIT 1
        `.pipe(Effect.orDie);
        if (existing.length > 0) {
          return yield* Effect.fail(
            new SessionAlreadyStartedError({ sessionId }),
          );
        }
        yield* dispatchSessionCommand(sessionId, {
          _tag: "SetWorktree",
          worktreeId,
          updatedAt: yield* currentTimestamp,
        });
        yield* closeProvider(sessionId);
        yield* interruptProviderFiber(sessionId);
        yield* setStatus(sessionId, "idle");
      });

    /**
     * Persist a new model on the session row and tear down the in-memory
     * provider session so the next user turn lazy-restarts the SDK with the
     * new model. Existing message history stays attached to the same row.
     */
    const setModel: ConversationOperations["setModel"] = (sessionId, model) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        yield* dispatchSessionCommand(sessionId, {
          _tag: "SetModel",
          model,
          updatedAt: yield* currentTimestamp,
        });
        // Drop the provider's in-memory session and interrupt the event pump
        // fiber; durable session-event subscriptions remain connected.
        // sendMessage's "send fails → restart"
        // path reads sessions.model so the next turn picks up the new model.
        yield* closeProvider(sessionId);
        yield* interruptProviderFiber(sessionId);
        yield* setStatus(sessionId, "idle");
      });

    /**
     * Switch a session's provider (and the model it runs under) before any
     * user message has been sent. The new CLI can't read the prior CLI's
     * transcript, so this is fresh-session-only — mid-chat callers get
     * `SessionAlreadyStartedError`. Resets `cursor` / `resume_strategy`
     * since both are provider-specific.
     */
    const setProvider: ConversationOperations["setProvider"] = (
      sessionId,
      providerId,
      model,
    ) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        const existing = yield* sql<{ readonly id: string }>`
          SELECT id FROM messages
          WHERE session_id = ${sessionId} AND role = 'user'
          LIMIT 1
        `.pipe(Effect.orDie);
        if (existing.length > 0) {
          return yield* Effect.fail(
            new SessionAlreadyStartedError({ sessionId }),
          );
        }
        yield* dispatchSessionCommand(sessionId, {
          _tag: "SetProvider",
          providerId,
          model,
          updatedAt: yield* currentTimestamp,
        });
        // See setModel: the durable stream stays connected across the swap.
        yield* closeProvider(sessionId);
        yield* interruptProviderFiber(sessionId);
        yield* setStatus(sessionId, "idle");
      });

    const archiveSession: ConversationOperations["archiveSession"] = (
      sessionId,
    ) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        yield* dispatchSessionCommand(sessionId, {
          _tag: "ArchiveSession",
          archivedAt: yield* currentTimestamp,
        });
      });

    const unarchiveSession: ConversationOperations["unarchiveSession"] = (
      sessionId,
    ) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        yield* dispatchSessionCommand(sessionId, {
          _tag: "UnarchiveSession",
          unarchivedAt: yield* currentTimestamp,
        });
      });

    const deleteSession: ConversationOperations["deleteSession"] = (
      sessionId,
    ) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        // Best-effort: provider may not know the id (already closed) — that's
        // not an error from the user's perspective.
        yield* closeProvider(sessionId);
        yield* teardownSubscription(sessionId);
        yield* dispatchSessionCommand(sessionId, {
          _tag: "DeleteSession",
          deletedAt: yield* currentTimestamp,
        });
      });

    // -------------------------------------------------------------------------
    // Chats — sidebar containers. Each chat hosts ≥ 1 session as a tab.
    // -------------------------------------------------------------------------

    const lookupChat = (
      chatId: ChatId,
    ): Effect.Effect<Chat, ChatNotFoundError> =>
      Effect.gen(function* () {
        const rows = yield* sql<ChatRow>`
          SELECT id, project_id, worktree_id, title, active_session_id, origin_session_id,
                 archived_at, archived_worktree_json, last_message_at, last_read_at, created_at, updated_at
          FROM chats WHERE id = ${chatId} LIMIT 1
        `.pipe(Effect.orDie);
        if (rows.length === 0) {
          return yield* Effect.fail(new ChatNotFoundError({ chatId }));
        }
        return chatFromRow(rows[0]!);
      });

    const listChats: ConversationOperations["listChats"] = (
      projectId,
      includeArchived,
    ) =>
      Effect.gen(function* () {
        const rows = includeArchived
          ? yield* sql<ChatRow>`
              SELECT id, project_id, worktree_id, title, active_session_id, origin_session_id,
                     archived_at, archived_worktree_json, last_message_at, last_read_at, created_at, updated_at
              FROM chats WHERE project_id = ${projectId}
              ORDER BY updated_at DESC
            `.pipe(Effect.orDie)
          : yield* sql<ChatRow>`
              SELECT id, project_id, worktree_id, title, active_session_id, origin_session_id,
                     archived_at, archived_worktree_json, last_message_at, last_read_at, created_at, updated_at
              FROM chats
              WHERE project_id = ${projectId} AND archived_at IS NULL
              ORDER BY updated_at DESC
            `.pipe(Effect.orDie);
        return rows.map(chatFromRow);
      });

    const getChat: ConversationOperations["getChat"] = (chatId) =>
      lookupChat(chatId);

    /**
     * Create a chat row AND its initial session in one effect. Both rows
     * land or neither does — we INSERT the chat first, attempt the
     * provider boot, and if the boot fails we DELETE the chat to leave
     * the DB clean.
     */
    const createChat: ConversationOperations["createChat"] = (
      input: CreateChatInput,
    ) =>
      Effect.gen(function* () {
        const createdAt = yield* currentTimestamp;
        const chatId = crypto.randomUUID() as unknown as ChatId;
        const title =
          input.title?.trim() || deriveProvisionalTitle(input.initialPrompt);
        const worktreeId = input.worktreeId ?? null;
        const originSessionId = input.originSessionId ?? null;
        yield* dispatchChatCommand(chatId, {
          _tag: "CreateChat",
          chatId,
          projectId: input.projectId,
          worktreeId,
          title,
          originSessionId,
          lastReadAt: createdAt,
          createdAt,
        });
        const initialSession = yield* createSession({
          chatId,
          providerId: input.providerId,
          model: input.model,
          title: input.title,
          initialPrompt: input.initialPrompt,
          runtimeMode: input.runtimeMode,
          agents: input.agents,
          enableSubagents: input.enableSubagents,
          permissionMode: input.permissionMode,
          modelOptions: input.modelOptions,
          toolSearch: input.toolSearch,
          resumeCursor: input.resumeCursor,
          resumeStrategy: input.resumeStrategy,
          forkedFromSessionId: input.forkedFromSessionId,
          forkedFromMessageId: input.forkedFromMessageId,
          forkFromResume: input.forkFromResume,
        }).pipe(
          Effect.tapError(() =>
            // Roll back the chat row if the provider failed to boot —
            // otherwise the sidebar would show an empty container the
            // user can't escape from.
            dispatchChatCommand(chatId, {
              _tag: "DeleteChat",
              deletedAt: createdAt,
            }),
          ),
        );
        const chat = yield* lookupChat(chatId).pipe(Effect.orDie);
        yield* broadcastChat(chat);
        // Fetch the initial user message (if any) so the renderer can seed
        // its messages store and skip the empty-state flash while the live
        // message stream is connecting. `createSession` writes the row
        // synchronously when `initialPrompt` is supplied, so by here it
        // exists in the table.
        const hasInitial =
          input.initialPrompt !== undefined &&
          input.initialPrompt.trim().length > 0;
        const initialMessage = hasInitial
          ? yield* sql<MessageRow>`
              SELECT id, session_id, role, kind, content_json, parent_item_id, created_at
              FROM messages
              WHERE session_id = ${initialSession.id} AND role = 'user'
              ORDER BY created_at ASC
              LIMIT 1
            `.pipe(
              Effect.orDie,
              Effect.map((rows) =>
                rows.length > 0 ? messageFromRow(rows[0]!) : null,
              ),
            )
          : null;
        yield* broadcastChat(chat);
        return { chat, initialSession, initialMessage };
      });

    const continueExternalThread: ConversationOperations["continueExternalThread"] =
      (input) =>
        Effect.gen(function* () {
          const result = yield* createChat({
            ...input,
            resumeCursor: input.resumeCursor,
            resumeStrategy: input.resumeStrategy,
          });
          return {
            chat: result.chat,
            initialSession: result.initialSession,
          };
        });

    const importExternalMessages: ConversationOperations["importExternalMessages"] =
      (sessionId, messages) =>
        Effect.gen(function* () {
          yield* lookupSession(sessionId);
          const imported: Message[] = [];
          for (const content of messages) {
            const persisted = yield* persistMessage(sessionId, content);
            imported.push(persisted.message);
          }
          return imported;
        });

    const exportTranscript: ConversationOperations["exportTranscript"] = (
      sessionId,
      uptoMessageId,
    ) =>
      Effect.gen(function* () {
        const session = yield* lookupSession(sessionId);
        const rows = yield* sql<MessageRow>`
          SELECT id, session_id, role, kind, content_json, parent_item_id, created_at
          FROM messages WHERE session_id = ${sessionId}
          ORDER BY created_at ASC, sequence ASC
        `.pipe(Effect.orDie);
        let slice = rows;
        if (uptoMessageId !== undefined) {
          const idx = rows.findIndex((r) => r.id === uptoMessageId);
          if (idx !== -1) slice = rows.slice(0, idx + 1);
        }
        return transcriptToMarkdown(session.title, slice.map(messageFromRow));
      });

    const latestPlan: ConversationOperations["latestPlan"] = (sessionId) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        const rows = yield* sql<MessageRow>`
          SELECT id, session_id, role, kind, content_json, parent_item_id, created_at
          FROM messages
          WHERE session_id = ${sessionId} AND kind = 'tool_use'
          ORDER BY created_at DESC, sequence DESC
        `.pipe(Effect.orDie);
        for (const row of rows) {
          const c = messageFromRow(row).content;
          if (c._tag === "tool_use" && c.tool === "ExitPlanMode") {
            const input = c.input;
            if (
              typeof input === "object" &&
              input !== null &&
              "plan" in input &&
              typeof (input as { plan?: unknown }).plan === "string"
            ) {
              return (input as { plan: string }).plan;
            }
          }
        }
        return null;
      });

    const forkSession: ConversationOperations["forkSession"] = (input) =>
      Effect.gen(function* () {
        // Source must exist; `lookupSession` fails `SessionNotFoundError`.
        const source = yield* lookupSession(input.sourceSessionId);

        const rows = yield* sql<MessageRow>`
          SELECT id, session_id, role, kind, content_json, parent_item_id, created_at
          FROM messages WHERE session_id = ${input.sourceSessionId}
          ORDER BY created_at ASC, sequence ASC
        `.pipe(Effect.orDie);
        const forkIdx = rows.findIndex((r) => r.id === input.fromMessageId);
        if (forkIdx === -1) {
          return yield* Effect.fail(
            new SessionStartError({
              providerId: source.providerId,
              reason: `fork message ${input.fromMessageId} not found in session ${input.sourceSessionId}`,
            }),
          );
        }

        const providerId = input.providerId ?? source.providerId;
        const model = input.model ?? source.model;
        // Real provider memory is only possible when the fork point is the
        // conversation tail, the provider is the SAME as the source (a fork
        // resumes the source's own transcript), the provider supports native
        // fork, and we have a cursor to fork from. Otherwise we replay the
        // visible transcript into a fresh session (`copy`).
        const isTail = forkIdx === rows.length - 1;
        const providerCanFork =
          providerId === "claude" || providerId === "codex";
        const forkMode: "resume" | "copy" =
          isTail &&
          providerId === source.providerId &&
          providerCanFork &&
          source.cursor !== null &&
          source.resumeStrategy !== "none"
            ? "resume"
            : "copy";

        const title =
          input.title?.trim() || `Fork of ${source.title}`.slice(0, 120);

        // Visible transcript up to (and including) the fork message — shown in
        // the new session's chat view for BOTH modes. In `resume` mode the
        // provider also carries real KV memory; the copied rows are display
        // only and are never re-sent to the model.
        const transcript = rows
          .slice(0, forkIdx + 1)
          .map(messageFromRow)
          .filter((message) => shouldIncludeInTranscript(message.content))
          .map((m) => m.content);

        const resumeCursor = forkMode === "resume" ? source.cursor : null;
        const resumeStrategy: ResumeStrategy =
          forkMode === "resume" ? source.resumeStrategy : "none";

        let chat: Chat;
        let session: Session;
        if (input.destination === "tab") {
          session = yield* createSession({
            chatId: source.chatId,
            providerId,
            model,
            title,
            runtimeMode: source.runtimeMode,
            permissionMode: source.permissionMode,
            toolSearch: source.toolSearch,
            background: true,
            resumeCursor,
            resumeStrategy,
            forkedFromSessionId: input.sourceSessionId,
            forkedFromMessageId: input.fromMessageId,
            forkFromResume: forkMode === "resume",
          });
          chat = yield* lookupChat(source.chatId).pipe(Effect.orDie);
        } else {
          const created = yield* createChat({
            projectId: source.projectId,
            providerId,
            model,
            title,
            worktreeId: input.worktreeId ?? null,
            runtimeMode: source.runtimeMode,
            permissionMode: source.permissionMode,
            toolSearch: source.toolSearch,
            resumeCursor,
            resumeStrategy,
            forkedFromSessionId: input.sourceSessionId,
            forkedFromMessageId: input.fromMessageId,
            forkFromResume: forkMode === "resume",
          });
          chat = created.chat;
          session = created.initialSession;
        }

        // Seed the new session's visible history. Failures here are
        // non-fatal — the branch still exists and is usable.
        if (transcript.length > 0) {
          yield* importExternalMessages(session.id, transcript).pipe(
            Effect.catch(() => Effect.succeed([])),
          );
        }

        return { chat, session, forkMode };
      });

    const renameChatWithCommandId = (
      chatId: ChatId,
      title: string,
      commandId: string,
    ) =>
      Effect.gen(function* () {
        yield* lookupChat(chatId);
        yield* dispatchChatCommand(
          chatId,
          {
            _tag: "RenameChat",
            title,
            updatedAt: yield* currentTimestamp,
          },
          commandId,
        );
        // Push the new title to any renderer subscribed via
        // `chat.streamChanges` so the sidebar updates without a refetch.
        const updated = yield* lookupChat(chatId);
        yield* broadcastChat(updated);
      });

    const renameChat: ConversationOperations["renameChat"] = (chatId, title) =>
      renameChatWithCommandId(chatId, title, crypto.randomUUID());

    const markChatRead: ConversationOperations["markChatRead"] = (chatId) =>
      Effect.gen(function* () {
        yield* lookupChat(chatId);
        yield* dispatchChatCommand(chatId, {
          _tag: "MarkChatRead",
          readAt: yield* currentTimestamp,
        });
        return yield* lookupChat(chatId);
      });

    const streamChatChanges: ConversationOperations["streamChatChanges"] = (
      projectId,
    ) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const sub = yield* PubSub.subscribe(chatChangesHub);
          return Stream.fromSubscription(sub).pipe(
            Stream.filter((chat) => chat.projectId === projectId),
          );
        }),
      );

    /**
     * LLM auto-name: summarize recent user/assistant turns into a short title
     * and rename the chat (always) plus the worktree git branch (when the chat
     * has its own worktree). Runs on a background fiber so the agent turn is
     * never delayed; swallows every failure so a flaky title call can't wedge
     * the session.
     */
    const collectAutoNameContext = (
      chatId: ChatId,
    ): Effect.Effect<{
      readonly userTexts: string[];
      readonly assistantTexts: string[];
      readonly conversationText: string;
    }> =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          readonly role: string;
          readonly content_json: string;
        }>`
          SELECT m.role, m.content_json
          FROM messages m
          INNER JOIN sessions s ON s.id = m.session_id
          WHERE s.chat_id = ${chatId}
            AND m.role IN ('user', 'assistant')
          ORDER BY m.created_at ASC
          LIMIT 24
        `.pipe(Effect.orDie);
        const turns: Array<{ role: "user" | "assistant"; text: string }> = [];
        const userTexts: string[] = [];
        const assistantTexts: string[] = [];
        for (const row of rows) {
          try {
            const content = JSON.parse(row.content_json) as MessageContent;
            const text = textFromMessageContent(content);
            if (text === null || text.trim().length === 0) continue;
            if (row.role === "user") {
              userTexts.push(text);
              turns.push({ role: "user", text });
            } else if (row.role === "assistant") {
              assistantTexts.push(text);
              turns.push({ role: "assistant", text });
            }
          } catch {
            // Skip malformed rows — title gen can still fall back.
          }
        }
        return {
          userTexts,
          assistantTexts,
          conversationText: buildConversationText(turns),
        };
      });

    const autoNameChat = (
      chatId: ChatId,
      sessionId: SessionId,
      commandId: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (yield* reactorEffects.isCompleted(commandId)) return;
        const chat = yield* lookupChat(chatId).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (chat === null) return;

        const context = yield* collectAutoNameContext(chatId);
        if (shouldDeferAutoName(context.userTexts, context.assistantTexts)) {
          return;
        }

        const session = yield* lookupSession(sessionId).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (session === null) return;
        const title = yield* titleGen.generate({
          folderId: chat.projectId,
          providerId: session.providerId,
          model: session.model,
          conversationText: context.conversationText,
        });
        if (title.length === 0 || title === "New chat") return;

        // Title first — cheap, and the user sees the sidebar update even if
        // the branch rename below is skipped or fails.
        yield* renameChatWithCommandId(chatId, title, commandId);
        const memberSessions = yield* sql<{ readonly id: string }>`
          SELECT id FROM sessions WHERE chat_id = ${chatId}
        `.pipe(Effect.orDie);
        yield* Effect.forEach(
          memberSessions,
          ({ id }) =>
            Effect.gen(function* () {
              yield* sessionDomain.dispatch({
                commandId: `${commandId}:session:${id}`,
                streamId: SessionId.make(id),
                command: {
                  _tag: "SetTitle",
                  title,
                  updatedAt: yield* currentTimestamp,
                },
              });
            }).pipe(Effect.ignore),
          { discard: true },
        );

        const markComplete = reactorEffects.complete(commandId);
        if (chat.worktreeId === null) {
          yield* markComplete;
          return;
        }
        const worktreeId = chat.worktreeId;
        const wt = yield* worktrees.get(worktreeId);
        if (wt === null) {
          yield* markComplete;
          return;
        }

        const settings = yield* configStore.getSettings();
        const username = yield* git
          .getUserName(chat.projectId)
          .pipe(Effect.catch(() => Effect.succeed("")));
        const branch = formatBranchName(
          title,
          username,
          settings.branchNamingStyle,
          settings.branchNamingPrefix,
        );
        // Rename the git branch, then mirror it onto the worktree row so the
        // DB and git agree. updateBranch only runs if the rename succeeded.
        yield* git.renameBranch(chat.projectId, branch, worktreeId).pipe(
          Effect.flatMap(() => worktrees.updateBranch(worktreeId, branch)),
          Effect.catch(() => Effect.void),
        );

        yield* markComplete;
      }).pipe(Effect.catchCause(() => Effect.void));

    const providerStartReactor = new ReactorRunner<
      StoredEvent,
      ProviderStartCommand,
      SqlConsumerStorageError,
      never,
      SessionStartError
    >(
      makeSqlConsumerStorage(sql),
      (reactorInput) =>
        Effect.gen(function* () {
          if (yield* reactorEffects.isCompleted(reactorInput.commandId)) return;

          const sessionId = SessionId.make(reactorInput.streamId);
          const session = yield* lookupSession(sessionId).pipe(
            Effect.catch(() => Effect.succeed(null)),
          );
          if (session === null) return;
          const request = yield* decodeProviderStartRequest(
            reactorInput.command.providerStartJson,
          ).pipe(
            Effect.mapError(
              (cause) =>
                new SessionStartError({
                  providerId: session.providerId,
                  reason: `Invalid provider start request: ${String(cause)}`,
                }),
            ),
          );
          const modelOptions =
            request.modelOptionsJson === null
              ? undefined
              : yield* decodeProviderModelOptions(
                  request.modelOptionsJson,
                ).pipe(
                  Effect.mapError(
                    (cause) =>
                      new SessionStartError({
                        providerId: session.providerId,
                        reason: `Invalid provider model options: ${String(cause)}`,
                      }),
                  ),
                );
          const subagents = agentsFor(sessionId);
          const cwdOverride = yield* cwdForWorktree(session.worktreeId);
          const orchestrationTools = yield* buildOrchestrationForSession({
            sessionId,
            chatId: session.chatId,
            projectId: session.projectId,
            worktreeId: session.worktreeId,
            providerId: session.providerId,
            model: session.model,
          });
          const start = provider
            .start(
              {
                folderId: session.projectId,
                providerId: session.providerId,
                mode: "sdk",
                sessionId,
                initialPrompt: request.initialPrompt ?? undefined,
                model: session.model,
                agents: subagents?.agents,
                enableSubagents: request.enableSubagents,
                cwdOverride,
                permissionMode: session.permissionMode,
                modelOptions,
                toolSearch: session.toolSearch,
                forkFromResume: request.forkFromResume,
              },
              session.cursor,
              () => getRuntimeModeFor(sessionId),
              orchestrationTools,
            )
            .pipe(
              Effect.mapError((error) =>
                error._tag === "ProviderNotAvailableError"
                  ? new SessionStartError({
                      providerId: session.providerId,
                      reason: error.reason,
                    })
                  : new SessionStartError({
                      providerId: error.providerId,
                      reason: error.reason,
                    }),
              ),
              Effect.flatMap(() =>
                attachProvider(sessionId, session.providerId),
              ),
              Effect.flatMap(() =>
                setStatus(sessionId, request.postBootStatus),
              ),
              Effect.flatMap(() => startSubscription(sessionId)),
            );
          if (request.background) {
            yield* start.pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  yield* Effect.logWarning(
                    `[ConversationServices] provider.start failed for session ${sessionId} (${session.providerId}): ${error.reason}`,
                  );
                  const persistedError = yield* persistMessage(sessionId, {
                    _tag: "error",
                    message: error.reason,
                  });
                  yield* ndjsonAppend(sessionId, persistedError);
                  yield* setStatus(sessionId, "error");
                }),
              ),
            );
          } else {
            yield* start;
          }
          yield* reactorEffects.complete(reactorInput.commandId);
        }),
      providerStartReactorDefinition,
    );
    runProviderStartReactor = Effect.suspend(() => {
      return providerStartReactorSemaphore.withPermits(1)(
        providerStartReactor.catchUp().pipe(
          Effect.asVoid,
          Effect.catch((error) =>
            error._tag === "SessionStartError"
              ? Effect.fail(error)
              : Effect.die(error),
          ),
        ),
      );
    });
    yield* runProviderStartReactor;

    const providerStopReactor = new ReactorRunner<
      StoredEvent,
      ProviderStopCommand,
      SqlConsumerStorageError
    >(
      makeSqlConsumerStorage(sql),
      (reactorInput) =>
        Effect.gen(function* () {
          if (yield* reactorEffects.isCompleted(reactorInput.commandId)) return;
          const sessionId = SessionId.make(reactorInput.streamId);
          yield* provider
            .close(sessionId)
            .pipe(Effect.catch(() => Effect.void));
          yield* sessionDomain
            .dispatch({
              commandId: `${reactorInput.commandId}:detach`,
              streamId: sessionId,
              command: {
                _tag: "DetachProvider",
                detachedAt: reactorInput.command.requestedAt,
              },
            })
            .pipe(Effect.orDie);
          yield* reactorEffects.complete(reactorInput.commandId);
        }),
      providerStopReactorDefinition,
    );
    runProviderStopReactor = Effect.suspend(() =>
      providerStopReactorSemaphore.withPermits(1)(
        providerStopReactor.catchUp().pipe(Effect.asVoid, Effect.orDie),
      ),
    );
    yield* runProviderStopReactor;

    const autoNameReactor = new ReactorRunner<
      StoredEvent,
      AutoNameCommand,
      SqlConsumerStorageError
    >(
      makeSqlConsumerStorage(sql),
      (input) =>
        Effect.gen(function* () {
          const sessionId = SessionId.make(input.streamId);
          const session = yield* lookupSession(sessionId).pipe(Effect.orDie);
          yield* autoNameChat(session.chatId, sessionId, input.commandId);
        }),
      autoNameReactorDefinition,
    );
    runSessionReactors = Effect.suspend(() => {
      return sessionReactorSemaphore.withPermits(1)(
        autoNameReactor.catchUp().pipe(Effect.asVoid, Effect.orDie),
      );
    });
    yield* runSessionReactors;

    /**
     * Worktrees are immutable past the first user message in any of the
     * chat's sessions. Mirrors `session.setWorktree`'s pre-message check
     * but lifted to the chat scope.
     */
    const setChatWorktree: ConversationOperations["setChatWorktree"] = (
      chatId,
      worktreeId,
    ) =>
      Effect.gen(function* () {
        yield* lookupChat(chatId);
        const existing = yield* sql<{ readonly id: string }>`
          SELECT m.id FROM messages m
          INNER JOIN sessions s ON s.id = m.session_id
          WHERE s.chat_id = ${chatId} AND m.role = 'user'
          LIMIT 1
        `.pipe(Effect.orDie);
        if (existing.length > 0) {
          return yield* Effect.fail(new ChatAlreadyStartedError({ chatId }));
        }
        const updatedAt = yield* currentTimestamp;
        yield* dispatchChatCommand(chatId, {
          _tag: "SetChatWorktree",
          worktreeId,
          updatedAt,
        });
        // Background-booted sessions (chat.create → session.create with
        // background=true) already spawned a provider CLI in the OLD cwd
        // before the user got a chance to pick a worktree. Kill those so
        // the next `sendMessage` lazy-restarts via `restartProviderSession`,
        // which reads the now-updated `session.worktreeId` and resolves
        // `cwdForWorktree` to the new path. Without this teardown the
        // first user message would land in the wrong working tree.
        const memberSessions = yield* sql<{ readonly id: string }>`
          SELECT id FROM sessions
          WHERE chat_id = ${chatId} AND archived_at IS NULL
        `.pipe(Effect.orDie);
        for (const row of memberSessions) {
          const sid = SessionId.make(row.id);
          yield* dispatchSessionCommand(sid, {
            _tag: "SetWorktree",
            worktreeId,
            updatedAt,
          });
          yield* closeProvider(sid);
          yield* interruptProviderFiber(sid);
          yield* setStatus(sid, "idle");
        }
        return yield* lookupChat(chatId);
      });

    const setChatActiveSession: ConversationOperations["setChatActiveSession"] =
      (chatId, sessionId) =>
        Effect.gen(function* () {
          yield* lookupChat(chatId);
          const member = yield* sql<{ readonly id: string }>`
          SELECT id FROM sessions
          WHERE id = ${sessionId} AND chat_id = ${chatId}
          LIMIT 1
        `.pipe(Effect.orDie);
          if (member.length === 0) return;
          yield* dispatchChatCommand(chatId, {
            _tag: "SetActiveSession",
            sessionId,
            updatedAt: yield* currentTimestamp,
          });
        });

    const performChatArchive = (
      chatId: ChatId,
      force: boolean,
      commandId: string,
    ) =>
      Effect.gen(function* () {
        const chat = yield* lookupChat(chatId);
        if (chat.archivedAt !== null) {
          return { chat, cleanup: null };
        }

        const settings = yield* repositorySettings.get(chat.projectId);
        const worktree =
          chat.worktreeId === null
            ? null
            : yield* worktrees.get(chat.worktreeId);
        const snapshot =
          worktree === null
            ? null
            : {
                id: worktree.id,
                projectId: worktree.projectId,
                path: worktree.path,
                name: worktree.name,
                branch: worktree.branch,
                baseBranch: worktree.baseBranch,
                createdAt: worktree.createdAt.toISOString(),
              };
        const snapshotJson =
          snapshot === null ? null : JSON.stringify(snapshot);

        const liveSessions = yield* sql<{ readonly id: string }>`
          SELECT id FROM sessions
          WHERE chat_id = ${chatId} AND archived_at IS NULL
        `.pipe(Effect.orDie);
        for (const row of liveSessions) {
          const sessionId = SessionId.make(row.id);
          yield* closeProvider(sessionId);
          yield* interruptProviderFiber(sessionId);
        }
        if (worktree !== null) {
          yield* ptys
            .closeByCwdPrefix(worktree.path)
            .pipe(Effect.catch(() => Effect.void));
        }

        let cleanup: { readonly ran: boolean; readonly output: string } | null =
          null;
        const script = settings.archiveCleanupScript?.trim() ?? "";
        if (worktree !== null && script.length > 0) {
          const steps = yield* sql<{
            readonly status: "started" | "completed";
            readonly detail_json: string | null;
          }>`
            SELECT status, detail_json FROM reactor_effect_steps
            WHERE effect_id = ${commandId} AND step = 'cleanup-script'
            LIMIT 1
          `.pipe(Effect.orDie);
          const step = steps[0];
          if (step?.status === "completed") {
            const detail =
              step.detail_json === null
                ? { output: "" }
                : yield* decodeArchiveCleanupDetail(step.detail_json).pipe(
                    Effect.mapError(
                      (cause) =>
                        new ChatArchiveScriptError({
                          chatId,
                          exitCode: null,
                          signal: null,
                          output: `Stored cleanup result is invalid: ${String(cause)}`,
                        }),
                    ),
                  );
            cleanup = {
              ran: true,
              output: detail.output,
            };
          } else if (step?.status === "started") {
            // The process died after claiming this non-idempotent step. We
            // cannot know whether the script ran, so preserve `started` as an
            // auditable indeterminate state and never fabricate completion or
            // run the user's script twice.
            cleanup = null;
          } else {
            yield* sql`
              INSERT INTO reactor_effect_steps
                (effect_id, step, status, detail_json, updated_at)
              VALUES
                (${commandId}, 'cleanup-script', 'started', NULL,
                 ${new Date().toISOString()})
            `.pipe(Effect.orDie);
            const rootPath = yield* projectPath(chat.projectId);
            const result = yield* runArchiveScript({
              chatId,
              script: settings.archiveCleanupScript ?? "",
              cwd: worktree.path,
              env: {
                ZUSE_ROOT_PATH: rootPath ?? "",
                ZUSE_WORKSPACE_PATH: worktree.path,
                ZUSE_CHAT_ID: chatId,
                ZUSE_WORKTREE_ID: worktree.id,
              },
            });
            cleanup = { ran: true, output: result.output };
            yield* sql`
              UPDATE reactor_effect_steps
              SET status = 'completed',
                  detail_json = ${JSON.stringify({ output: result.output })},
                  updated_at = ${new Date().toISOString()}
              WHERE effect_id = ${commandId} AND step = 'cleanup-script'
            `.pipe(Effect.orDie);
          }
        } else if (worktree !== null) {
          cleanup = { ran: false, output: "" };
        }

        if (worktree !== null && settings.archiveRemoveWorktree) {
          yield* worktrees.remove(worktree.id, force).pipe(
            Effect.mapError(
              (err) =>
                new ChatArchiveWorktreeError({
                  chatId,
                  reason:
                    "reason" in err && typeof err.reason === "string"
                      ? err.reason
                      : err._tag,
                }),
            ),
          );
        }

        const archivedAt = yield* currentTimestamp;
        yield* Effect.forEach(
          liveSessions,
          ({ id }) =>
            dispatchSessionCommand(SessionId.make(id), {
              _tag: "ArchiveSession",
              archivedAt,
            }),
          { discard: true },
        );
        yield* dispatchChatCommand(
          chatId,
          {
            _tag: "ArchiveChat",
            archivedAt,
            archivedWorktreeJson: snapshotJson,
          },
          `${commandId}:archive`,
        );
        const result = { chat: yield* lookupChat(chatId), cleanup };
        yield* reactorEffects.complete(commandId);
        return result;
      });

    const chatArchiveResults = yield* Ref.make<
      ReadonlyMap<ChatId, ChatArchiveResult>
    >(new Map());
    const chatArchiveReactor = new ReactorRunner<
      StoredEvent<typeof ChatEvent.Type>,
      ChatArchiveCommand,
      SqlConsumerStorageError,
      never,
      ChatArchiveError
    >(
      makeSqlConsumerStorage(sql, {
        streamKind: "chat",
        decodeEvent: decodeChatEvent,
      }),
      (reactorInput) =>
        Effect.gen(function* () {
          const chatId = ChatId.make(reactorInput.streamId);
          const completed = yield* reactorEffects.isCompleted(
            reactorInput.commandId,
          );
          const result = completed
            ? { chat: yield* lookupChat(chatId), cleanup: null }
            : yield* performChatArchive(
                chatId,
                reactorInput.command.force,
                reactorInput.commandId,
              );
          yield* Ref.update(chatArchiveResults, (current) => {
            const next = new Map(current);
            next.set(chatId, result);
            return next;
          });
        }),
      chatArchiveReactorDefinition,
    );
    runChatArchiveReactor = Effect.suspend(() =>
      chatArchiveReactorSemaphore.withPermits(1)(
        chatArchiveReactor.catchUp().pipe(
          Effect.asVoid,
          Effect.catch((error) =>
            error._tag === "ChatArchiveScriptError" ||
            error._tag === "ChatArchiveTimeoutError" ||
            error._tag === "ChatArchiveWorktreeError" ||
            error._tag === "ChatNotFoundError"
              ? Effect.fail(error)
              : Effect.die(error),
          ),
        ),
      ),
    );
    yield* runChatArchiveReactor;

    const archiveChat: ConversationOperations["archiveChat"] = (
      chatId,
      force,
    ) =>
      Effect.gen(function* () {
        const chat = yield* lookupChat(chatId);
        if (chat.archivedAt !== null) return { chat, cleanup: null };
        yield* dispatchChatCommand(chatId, {
          _tag: "RequestArchiveChat",
          force,
          requestedAt: yield* currentTimestamp,
        });
        yield* runChatArchiveReactor;
        const results = yield* Ref.get(chatArchiveResults);
        const result = results.get(chatId);
        if (result === undefined) {
          return yield* Effect.die(
            new Error(`chat archive reactor produced no result for ${chatId}`),
          );
        }
        return result;
      });

    const unarchiveChat: ConversationOperations["unarchiveChat"] = (chatId) =>
      Effect.gen(function* () {
        const chatRows = yield* sql<ChatRow>`
          SELECT id, project_id, worktree_id, title, active_session_id, origin_session_id,
                 archived_at, archived_worktree_json, last_message_at, last_read_at, created_at, updated_at
          FROM chats WHERE id = ${chatId} LIMIT 1
        `.pipe(Effect.orDie);
        const chatRow = chatRows[0];
        if (chatRow === undefined) {
          return yield* Effect.fail(new ChatNotFoundError({ chatId }));
        }

        const snapshot = parseArchivedWorktreeSnapshot(
          chatRow.archived_worktree_json,
        );
        let restoredWorktree: Worktree | null = null;
        let restoredWorktreeId: WorktreeId | null =
          chatRow.worktree_id === null
            ? null
            : WorktreeId.make(chatRow.worktree_id);
        if (snapshot !== null) {
          const existing = yield* worktrees.get(WorktreeId.make(snapshot.id));
          if (existing !== null) {
            restoredWorktree = existing;
            restoredWorktreeId = existing.id;
          } else if (chatRow.worktree_id === null) {
            restoredWorktree = yield* worktrees
              .restore({
                id: WorktreeId.make(snapshot.id),
                projectId: snapshot.projectId as FolderId,
                path: snapshot.path,
                name: snapshot.name,
                branch: snapshot.branch,
                baseBranch: snapshot.baseBranch,
                createdAt: new Date(snapshot.createdAt),
              })
              .pipe(
                Effect.mapError(
                  (err) =>
                    new ChatArchiveWorktreeError({
                      chatId,
                      reason: err.reason,
                    }),
                ),
              );
            restoredWorktreeId = restoredWorktree.id;
          }
        }

        const unarchivedAt = yield* currentTimestamp;
        yield* dispatchChatCommand(chatId, {
          _tag: "UnarchiveChat",
          unarchivedAt,
          worktreeId: restoredWorktreeId,
        });
        const archivedSessions = yield* sql<{
          readonly id: string;
          readonly worktree_id: string | null;
        }>`
          SELECT id, worktree_id FROM sessions WHERE chat_id = ${chatId}
        `.pipe(Effect.orDie);
        for (const row of archivedSessions) {
          const sessionId = SessionId.make(row.id);
          if (
            restoredWorktreeId !== null &&
            row.worktree_id !== restoredWorktreeId
          ) {
            yield* dispatchSessionCommand(sessionId, {
              _tag: "SetWorktree",
              worktreeId: restoredWorktreeId,
              updatedAt: unarchivedAt,
            });
          }
          if (chatRow.archived_at !== null) {
            yield* dispatchSessionCommand(sessionId, {
              _tag: "UnarchiveSession",
              unarchivedAt,
            });
          }
        }
        const sessions = yield* sql<SessionRow>`
          SELECT id, project_id, title, provider_id, model, status,
                 archived_at, cursor, resume_strategy, runtime_mode,
                 agents_json, worktree_id, chat_id, forked_from_session_id,
                 forked_from_message_id, permission_mode, tool_search,
                 created_at, updated_at
          FROM sessions
          WHERE chat_id = ${chatId} AND archived_at IS NULL
          ORDER BY updated_at DESC
        `.pipe(Effect.orDie);
        return {
          chat: yield* lookupChat(chatId),
          sessions: sessions.map(sessionFromRow),
          worktree: restoredWorktree,
        };
      });

    const performChatDelete = (chatId: ChatId, commandId: string) =>
      Effect.gen(function* () {
        yield* lookupChat(chatId);
        // Tear down each child session's provider state before the SQL
        // CASCADE wipes the rows so we don't leak an in-memory pubsub /
        // fiber after the data is gone.
        const childIds = yield* sql<{ readonly id: string }>`
          SELECT id FROM sessions WHERE chat_id = ${chatId}
        `.pipe(Effect.orDie);
        for (const { id } of childIds) {
          const sessionId = SessionId.make(id);
          yield* closeProvider(sessionId);
          yield* teardownSubscription(sessionId);
          yield* dispatchSessionCommand(sessionId, {
            _tag: "DeleteSession",
            deletedAt: yield* currentTimestamp,
          });
        }
        yield* dispatchChatCommand(
          chatId,
          {
            _tag: "DeleteChat",
            deletedAt: yield* currentTimestamp,
          },
          `${commandId}:delete`,
        );
        // ON DELETE CASCADE handles sessions + messages.
      });

    const chatDeleteReactor = new ReactorRunner<
      StoredEvent<typeof ChatEvent.Type>,
      ChatDeleteCommand,
      SqlConsumerStorageError,
      never,
      ChatNotFoundError
    >(
      makeSqlConsumerStorage(sql, {
        streamKind: "chat",
        decodeEvent: decodeChatEvent,
      }),
      (reactorInput) =>
        Effect.gen(function* () {
          const deleteCommandId = `${reactorInput.commandId}:delete`;
          const completed = yield* sql<{ readonly command_id: string }>`
            SELECT command_id FROM command_receipts
            WHERE command_id = ${deleteCommandId}
            LIMIT 1
          `.pipe(Effect.orDie);
          if (completed.length > 0) return;
          yield* performChatDelete(
            ChatId.make(reactorInput.streamId),
            reactorInput.commandId,
          );
        }),
      chatDeleteReactorDefinition,
    );
    runChatDeleteReactor = Effect.suspend(() =>
      chatDeleteReactorSemaphore.withPermits(1)(
        chatDeleteReactor.catchUp().pipe(
          Effect.asVoid,
          Effect.catch((error) =>
            error._tag === "ChatNotFoundError"
              ? Effect.fail(error)
              : Effect.die(error),
          ),
        ),
      ),
    );
    yield* runChatDeleteReactor;

    const deleteChat: ConversationOperations["deleteChat"] = (chatId) =>
      Effect.gen(function* () {
        yield* lookupChat(chatId);
        yield* dispatchChatCommand(chatId, {
          _tag: "RequestDeleteChat",
          requestedAt: yield* currentTimestamp,
        });
        yield* runChatDeleteReactor;
      });

    const listMessages: ConversationOperations["listMessages"] = (sessionId) =>
      sessionQueries.messages(sessionId).pipe(
        Effect.map((records) => records.map(messageFromRecord)),
        Effect.catch((error) =>
          error._tag === "SessionQueryNotFound"
            ? Effect.fail(new SessionNotFoundError({ sessionId }))
            : Effect.die(error),
        ),
      );

    // Providers that support goal mode. Codex backs it with `thread/goal/*`
    // RPCs; Grok forwards to its native `/goal` slash command with
    // driver-local state. Both go through `setGoalWithLiveProvider` →
    // `provider.setGoal`, which routes to the right handle.
    const goalCapableProviders = new Set<ProviderId>(["codex", "grok"]);
    const ensureGoalSession = (
      sessionId: SessionId,
    ): Effect.Effect<Session, SessionNotFoundError | GoalUnsupportedError> =>
      Effect.gen(function* () {
        const session = yield* lookupSession(sessionId);
        if (!goalCapableProviders.has(session.providerId)) {
          return yield* Effect.fail(
            new GoalUnsupportedError({ providerId: session.providerId }),
          );
        }
        return session;
      });

    const mapProviderSessionNotFound =
      (
        sessionId: SessionId,
      ): ((
        error: AgentSessionNotFoundError,
      ) => Effect.Effect<never, SessionNotFoundError>) =>
      () =>
        Effect.fail(new SessionNotFoundError({ sessionId }));

    const startProviderSessionOnly = (
      session: Session,
    ): Effect.Effect<void, SessionStartError> => {
      runtimeModeBySession.set(session.id, session.runtimeMode);
      permissionModeBySession.set(session.id, session.permissionMode);
      const subagents = agentsFor(session.id);
      return cwdForWorktree(session.worktreeId).pipe(
        Effect.flatMap((cwdOverride) =>
          provider
            .start(
              {
                folderId: session.projectId,
                providerId: session.providerId,
                mode: "sdk",
                sessionId: session.id,
                model: session.model,
                agents: subagents?.agents,
                enableSubagents: subagents?.enableSubagents,
                cwdOverride,
                permissionMode: session.permissionMode,
                toolSearch: session.toolSearch,
              },
              session.cursor,
              () => getRuntimeModeFor(session.id),
            )
            .pipe(
              Effect.tap(() => attachProvider(session.id, session.providerId)),
              Effect.flatMap(() => startSubscription(session.id)),
              Effect.mapError((err) =>
                err._tag === "ProviderNotAvailableError"
                  ? new SessionStartError({
                      providerId: session.providerId,
                      reason: err.reason,
                    })
                  : err._tag === "AgentSessionStartError"
                    ? new SessionStartError({
                        providerId: err.providerId,
                        reason: err.reason,
                      })
                    : new SessionStartError({
                        providerId: session.providerId,
                        reason: formatProviderFailure(err),
                      }),
              ),
            ),
        ),
      );
    };

    const setGoalWithLiveProvider = (
      session: Session,
      goalInput: ThreadGoalSetInput,
    ): Effect.Effect<ThreadGoal, SessionNotFoundError | SessionStartError> => {
      const attempt = provider.setGoal(session.id, goalInput);
      const retryBooting = (
        retriesLeft: number,
      ): Effect.Effect<
        ThreadGoal,
        AgentSessionNotFoundError | SessionNotFoundError
      > =>
        attempt.pipe(
          Effect.catchTag("AgentSessionNotFoundError", (err) =>
            Effect.gen(function* () {
              const latest = yield* lookupSession(session.id);
              if (retriesLeft <= 0 || latest.status !== "booting") {
                return yield* Effect.fail(err);
              }
              yield* Effect.sleep("250 millis");
              return yield* retryBooting(retriesLeft - 1);
            }),
          ),
        );
      return retryBooting(240).pipe(
        Effect.catchTag("AgentSessionNotFoundError", () =>
          startProviderSessionOnly(session).pipe(
            Effect.andThen(provider.setGoal(session.id, goalInput)),
            Effect.catchTag(
              "AgentSessionNotFoundError",
              mapProviderSessionNotFound(session.id),
            ),
          ),
        ),
      );
    };

    const getGoal: ConversationOperations["getGoal"] = (sessionId) =>
      Effect.gen(function* () {
        yield* ensureGoalSession(sessionId);
        const goal = yield* provider
          .getGoal(sessionId)
          .pipe(
            Effect.catchTag(
              "AgentSessionNotFoundError",
              mapProviderSessionNotFound(sessionId),
            ),
          );
        yield* publishGoal(sessionId, goal);
        return goal;
      });

    const setGoal: ConversationOperations["setGoal"] = (sessionId, goalInput) =>
      Effect.gen(function* () {
        const session = yield* ensureGoalSession(sessionId);
        const goal = yield* setGoalWithLiveProvider(session, goalInput);
        yield* publishGoal(sessionId, goal);
        return goal;
      });

    const clearGoal: ConversationOperations["clearGoal"] = (sessionId) =>
      Effect.gen(function* () {
        yield* ensureGoalSession(sessionId);
        yield* provider
          .clearGoal(sessionId)
          .pipe(
            Effect.catchTag(
              "AgentSessionNotFoundError",
              mapProviderSessionNotFound(sessionId),
            ),
          );
        yield* publishGoal(sessionId, null);
      });

    const streamGoal: ConversationOperations["streamGoal"] = (sessionId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* ensureGoalSession(sessionId);
          const pubsub = yield* getOrMakeGoalPubsub(sessionId);
          const dequeue = yield* PubSub.subscribe(pubsub);
          const cached = goalsBySession.get(sessionId);
          const initialGoal =
            cached !== undefined
              ? cached
              : yield* provider
                  .getGoal(sessionId)
                  .pipe(Effect.catch(() => Effect.succeed(null)));
          if (cached === undefined) goalsBySession.set(sessionId, initialGoal);
          return Stream.concat(
            Stream.succeed({ sessionId, goal: initialGoal }),
            Stream.fromSubscription(dequeue),
          );
        }),
      );

    /**
     * Restart the provider for `session` under the same persisted id so the
     * message history stays attached to the same row. Used after a process
     * restart wipes the provider's in-memory session map.
     *
     * The user's text + attachments are pushed via `provider.send` after the
     * session opens, NOT via `StartSessionInput.initialPrompt`. The
     * initialPrompt path only knows about plain text — routing through
     * `send` reuses the image-block builder so attachments survive the
     * restart instead of dropping silently.
     */
    const restartProviderSession = (
      session: Session,
      text: string,
      attachments: ReadonlyArray<AttachmentRef>,
    ): Effect.Effect<void, SessionStartError> => {
      runtimeModeBySession.set(session.id, session.runtimeMode);
      permissionModeBySession.set(session.id, session.permissionMode);
      const subagents = agentsFor(session.id);
      return buildOrchestrationForSession({
        sessionId: session.id,
        chatId: session.chatId,
        projectId: session.projectId,
        worktreeId: session.worktreeId,
        providerId: session.providerId,
        model: session.model,
      }).pipe(
        Effect.flatMap((orchestrationTools) =>
          cwdForWorktree(session.worktreeId).pipe(
            Effect.flatMap((cwdOverride) =>
              provider
                .start(
                  {
                    folderId: session.projectId,
                    providerId: session.providerId,
                    mode: "sdk",
                    sessionId: session.id,
                    model: session.model,
                    agents: subagents?.agents,
                    enableSubagents: subagents?.enableSubagents,
                    cwdOverride,
                    permissionMode: session.permissionMode,
                    toolSearch: session.toolSearch,
                  },
                  // Re-attach to the upstream conversation when we have a
                  // cursor. The driver passes it as `options.resume`; SDK
                  // reloads history and continues from there.
                  session.cursor,
                  () => getRuntimeModeFor(session.id),
                  orchestrationTools,
                )
                .pipe(
                  Effect.tap(() =>
                    attachProvider(session.id, session.providerId),
                  ),
                  Effect.flatMap(() => startSubscription(session.id)),
                  Effect.flatMap(() =>
                    provider.send(session.id, text, attachments),
                  ),
                  Effect.mapError((err) =>
                    err._tag === "ProviderNotAvailableError"
                      ? new SessionStartError({
                          providerId: session.providerId,
                          reason: err.reason,
                        })
                      : err._tag === "AgentSessionStartError"
                        ? new SessionStartError({
                            providerId: err.providerId,
                            reason: err.reason,
                          })
                        : new SessionStartError({
                            providerId: session.providerId,
                            reason: formatProviderFailure(err),
                          }),
                  ),
                ),
            ),
          ),
        ),
      );
    };

    const resumeSession: ConversationOperations["resumeSession"] = (
      sessionId,
    ) =>
      Effect.gen(function* () {
        const session = yield* lookupSession(sessionId);
        if (session.resumeStrategy === "none" || session.cursor === null) {
          return yield* Effect.fail(
            new SessionStartError({
              providerId: session.providerId,
              reason: "resume_unsupported",
            }),
          );
        }
        // Best-effort cleanup of any stale in-memory session before opening
        // a fresh handle attached to the same DB row. Renderer subscriptions
        // stay connected across the
        // resume — only the event-pump fiber needs to restart.
        yield* closeProvider(sessionId);
        yield* interruptProviderFiber(sessionId);
        runtimeModeBySession.set(session.id, session.runtimeMode);
        permissionModeBySession.set(session.id, session.permissionMode);
        const subagents = agentsFor(session.id);
        const cwdOverride = yield* cwdForWorktree(session.worktreeId);
        // Re-attach the control-plane tools so a resumed autonomous session
        // keeps its ability to spawn + steer threads.
        const orchestrationTools = yield* buildOrchestrationForSession({
          sessionId: session.id,
          chatId: session.chatId,
          projectId: session.projectId,
          worktreeId: session.worktreeId,
          providerId: session.providerId,
          model: session.model,
        });
        yield* provider
          .start(
            {
              folderId: session.projectId,
              providerId: session.providerId,
              mode: "sdk",
              sessionId: session.id,
              model: session.model,
              agents: subagents?.agents,
              enableSubagents: subagents?.enableSubagents,
              cwdOverride,
              permissionMode: session.permissionMode,
              toolSearch: session.toolSearch,
            },
            session.cursor,
            () => getRuntimeModeFor(session.id),
            orchestrationTools,
          )
          .pipe(
            Effect.mapError((err) =>
              err._tag === "ProviderNotAvailableError"
                ? new SessionStartError({
                    providerId: session.providerId,
                    reason: err.reason,
                  })
                : new SessionStartError({
                    providerId: err.providerId,
                    reason: err.reason,
                  }),
            ),
          );
        yield* attachProvider(sessionId, session.providerId);
        yield* startSubscription(sessionId);
        yield* setStatus(sessionId, "running");
        return yield* lookupSession(sessionId);
      });

    const submitUserMessage = (
      sessionId: SessionId,
      text: string,
      attachments?: ReadonlyArray<AttachmentRef>,
      fileRefs?: ReadonlyArray<FileRef>,
      skillRefs?: ReadonlyArray<SkillRef>,
      annotations?: ReadonlyArray<ComposerAnnotation>,
      asGoal?: boolean,
      clientMessageId?: MessageId,
      origin?: MessageOrigin,
    ): Effect.Effect<boolean, SessionNotFoundError> =>
      Effect.gen(function* () {
        const session = yield* lookupSession(sessionId);
        if (asGoal !== true && goalCapableProviders.has(session.providerId)) {
          const goal = goalsBySession.get(sessionId);
          const trimmed = text.trim();
          if (
            goal !== undefined &&
            goal !== null &&
            goal.status === "active" &&
            goal.objective.trim() === trimmed &&
            (yield* latestGoalUserMessageMatches(sessionId, trimmed))
          ) {
            return true;
          }
        }
        yield* beginTurn(sessionId);
        // Drop "pending-*" placeholder ids — those are renderer-side temp
        // tokens for attachments whose upload didn't finish before submit.
        // The bytes don't exist server-side, so forwarding them would just
        // make the driver log a 404 per attachment.
        const cleanAttachments = (attachments ?? []).filter(
          (a) => !a.id.startsWith("pending-"),
        );
        const annotationList = annotations ?? [];
        const hasRichSegments =
          cleanAttachments.length > 0 ||
          (fileRefs ?? []).length > 0 ||
          (skillRefs ?? []).length > 0 ||
          annotationList.length > 0;
        const content: MessageContent = hasRichSegments
          ? {
              _tag: "user_rich",
              text,
              attachments: cleanAttachments,
              fileRefs: fileRefs ?? [],
              skillRefs: skillRefs ?? [],
              annotations: annotationList,
              ...(origin !== undefined ? { origin } : {}),
              goal: asGoal === true,
            }
          : {
              _tag: "user",
              text,
              ...(origin !== undefined ? { origin } : {}),
              goal: asGoal === true,
            };
        // Annotations have no native CLI token (unlike `@file` / `/skill`),
        // so the only place the model ever sees them is the prompt text.
        // Serialise them into a numbered list here — the single injection
        // point before `provider.send`, so every driver benefits. The
        // persisted `text` above stays clean; the structured `annotations`
        // array drives the rendered bubble.
        const sendText = [
          annotationList.length > 0
            ? serializeAnnotations(annotationList)
            : null,
          text,
        ]
          .filter((part): part is string => part !== null && part.length > 0)
          .join("\n\n")
          .trim();
        const persisted = yield* persistMessage(
          sessionId,
          content,
          clientMessageId,
        );
        // Pin the attachments so the GC sweep treats them as referenced —
        // a separate row per (message, attachment) keeps the existing
        // GC join intact.
        for (const a of cleanAttachments) {
          yield* sql`
            INSERT OR IGNORE INTO message_attachments (message_id, attachment_id)
            VALUES (${persisted.message.id}, ${a.id})
          `.pipe(Effect.ignore);
        }
        const chat = yield* lookupChat(session.chatId).pipe(
          Effect.mapError(() => new SessionNotFoundError({ sessionId })),
        );
        // Provisional title: update chat + session immediately for real tasks
        // so the sidebar/tab never sit on "New chat" while the LLM pass runs.
        const provisional = deriveProvisionalTitle(text);
        if (provisional !== "New chat") {
          if (session.title === "New chat") {
            yield* renameSession(sessionId, provisional);
          }
          if (chat.title === "New chat") {
            yield* renameChat(session.chatId, provisional).pipe(
              Effect.mapError(() => new SessionNotFoundError({ sessionId })),
            );
          }
        }
        if (asGoal === true) {
          const objective = text.trim();
          if (objective.length === 0) return false;
          if (!goalCapableProviders.has(session.providerId)) {
            const persistedError = yield* persistMessage(sessionId, {
              _tag: "error",
              message:
                "Goal mode is currently only supported for Codex and Grok sessions.",
            });
            yield* ndjsonAppend(sessionId, persistedError);
            return false;
          }
          const goal = yield* setGoalWithLiveProvider(session, {
            objective,
            status: "active",
          }).pipe(
            Effect.catch((err) =>
              Effect.gen(function* () {
                const message =
                  err._tag === "SessionStartError"
                    ? `Goal mode could not start ${session.providerId}: ${err.reason}`
                    : `Goal mode could not start ${session.providerId} for this session.`;
                const persistedError = yield* persistMessage(sessionId, {
                  _tag: "error",
                  message,
                });
                yield* ndjsonAppend(sessionId, persistedError);
                yield* setStatus(sessionId, "idle");
                return null;
              }),
            ),
          );
          if (goal === null) return false;
          yield* publishGoal(sessionId, goal);
          // Grok runs goal mode by forwarding `/goal` as a real prompt turn,
          // so reflect the running turn the way a normal send does — the
          // driver emits `Status: idle` when the goal run finishes. Codex
          // drives its own status via native goal notifications, so leave it.
          if (session.providerId === "grok") {
            yield* setStatus(sessionId, "running");
          }
          return true;
        }
        // First attempt: push into the existing provider session. If that
        // session is gone (provider dropped it across an app restart) start
        // a fresh one under the same id, then push.
        console.log(
          `[conversation-services.sendMessage] sessionId=${sessionId} cleanAttachments=${cleanAttachments.length} (orig=${
            (attachments ?? []).length
          })`,
        );
        // If the session previously errored — typically an auth failure the
        // user has since fixed by signing in — the in-memory provider process
        // is stale: for Claude it was spawned without valid credentials and
        // won't re-read the keychain on its own. Drop it (mirrors setModel's
        // teardown) so the send below lazy-restarts a fresh process that picks
        // up the new login, instead of silently re-pushing into the dead one.
        const latestForSend = yield* lookupSession(sessionId).pipe(
          Effect.orDie,
        );
        if (latestForSend.status === "error") {
          yield* provider
            .close(sessionId)
            .pipe(Effect.catch(() => Effect.void));
          yield* interruptProviderFiber(sessionId);
        }
        const sendResult = yield* provider
          .send(sessionId, sendText, cleanAttachments, fileRefs, skillRefs)
          .pipe(
            Effect.matchEffect({
              onFailure: (err) =>
                Effect.succeed({
                  _tag: "retry" as const,
                  reason: formatProviderFailure(err),
                }),
              onSuccess: () => Effect.succeed("ok" as const),
            }),
          );
        if (sendResult !== "ok") {
          const isGrok = session.providerId === "grok";
          const looksLikeGrokAuthWorkerDeath =
            isGrok &&
            /Grok's agent worker rejected the session.*AuthorizationRequired/i.test(
              sendResult.reason,
            );

          if (looksLikeGrokAuthWorkerDeath) {
            yield* setStatus(sessionId, "running");
            return true;
          }

          // Auth failures aren't recoverable by restarting — re-spawning hits
          // the same 401, which is the infinite-retry / stuck-loading bug.
          // Persist the error so the renderer shows the "Sign in" CTA and stop.
          if (looksLikeAuthFailure(sendResult.reason)) {
            console.log(
              `[conversation-services.sendMessage] provider.send failed with auth error for ${sessionId}; skipping restart`,
            );
            const persistedError = yield* persistMessage(sessionId, {
              _tag: "error",
              message: sendResult.reason,
            });
            yield* ndjsonAppend(sessionId, persistedError);
            yield* setStatus(sessionId, "error");
            return false;
          }

          console.log(
            `[conversation-services.sendMessage] provider.send failed; restarting provider session for ${sessionId}`,
          );
          const restartResult = yield* restartProviderSession(
            session,
            sendText,
            cleanAttachments,
          ).pipe(
            Effect.matchEffect({
              onFailure: (err) =>
                Effect.succeed({
                  _tag: "failed" as const,
                  reason: formatProviderFailure(err),
                }),
              onSuccess: () => Effect.succeed({ _tag: "ok" as const }),
            }),
          );
          if (restartResult._tag === "failed") {
            const message =
              `Provider restart failed after send could not find an active session.\n\n` +
              `Initial send failure:\n${sendResult.reason}\n\n` +
              `Restart failure:\n${restartResult.reason}`;
            const persistedError = yield* persistMessage(sessionId, {
              _tag: "error",
              message,
            });
            yield* ndjsonAppend(sessionId, persistedError);
            yield* setStatus(sessionId, "idle");
            return false;
          }
        }
        yield* setStatus(sessionId, "running");
        return true;
      });

    const sendMessage: ConversationOperations["sendMessage"] = (
      sessionId,
      text,
      attachments,
      fileRefs,
      skillRefs,
      annotations,
      asGoal,
      clientMessageId,
      origin,
    ) =>
      Effect.gen(function* () {
        const accepted = yield* submitUserMessage(
          sessionId,
          text,
          attachments,
          fileRefs,
          skillRefs,
          annotations,
          asGoal,
          clientMessageId,
          origin,
        );
        if (!accepted) yield* settleActiveTurn(sessionId, "error");
      });

    const queueRuntime = yield* makeQueueServiceRuntime({
      sql,
      lookupSession,
      submitUserMessage: (sessionId, input) =>
        submitUserMessage(
          sessionId,
          input.text,
          input.attachments,
          input.fileRefs,
          input.skillRefs,
          input.annotations,
        ),
      settleActiveTurn,
    });
    flushQueueAfterIdle = queueRuntime.flushAfterIdle;
    shutdownQueueSession = queueRuntime.shutdown;

    const interruptSession: ConversationOperations["interruptSession"] = (
      sessionId,
    ) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        yield* provider
          .interrupt(sessionId)
          .pipe(Effect.mapError(() => new SessionNotFoundError({ sessionId })));
        yield* queueRuntime.pauseAfterInterrupt(sessionId);
        yield* settleActiveTurn(sessionId, "interrupted");
        yield* setStatus(sessionId, "idle");
      });

    const getSession: ConversationOperations["getSession"] = (sessionId) =>
      lookupSession(sessionId);

    const sessionService = {
      listSessions,
      getSession,
      createSession,
      renameSession,
      setModel,
      setProvider,
      setRuntimeMode,
      setPermissionMode,
      answerQuestion,
      setWorktree,
      archiveSession,
      unarchiveSession,
      deleteSession,
      resumeSession,
      getGoal,
      setGoal,
      clearGoal,
      streamGoal,
    } satisfies SessionServiceShape;
    const chatService = {
      listChats,
      getChat,
      createChat,
      renameChat,
      markChatRead,
      streamChatChanges,
      setChatWorktree,
      setChatActiveSession,
      archiveChat,
      unarchiveChat,
      deleteChat,
    } satisfies ChatServiceShape;
    const transcriptService = {
      continueExternalThread,
      importExternalMessages,
      forkSession,
      exportTranscript,
      latestPlan,
    } satisfies TranscriptServiceShape;
    const messageService = {
      listMessages,
      sendMessage,
      interruptSession,
    } satisfies MessageServiceShape;
    const queueService = queueRuntime.service;
    return Context.make(SessionService, sessionService).pipe(
      Context.add(ChatService, chatService),
      Context.add(TranscriptService, transcriptService),
      Context.add(MessageService, messageService),
      Context.add(QueueService, queueService),
    );
  }),
);
