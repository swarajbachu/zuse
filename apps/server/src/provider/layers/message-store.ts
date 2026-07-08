import { SqlClient } from "@effect/sql";
import { Effect, Fiber, Layer, PubSub, Ref, Runtime, Stream } from "effect";
import { spawn } from "node:child_process";

import {
  Chat,
  ChatAlreadyStartedError,
  ChatArchiveScriptError,
  ChatArchiveTimeoutError,
  ChatArchiveWorktreeError,
  type ChatId,
  ChatNotFoundError,
  ComposerInput,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_RUNTIME_MODE,
  Message,
  MessageEnvelope,
  MessageId,
  MODELS_BY_PROVIDER,
  defaultModelFor,
  visibleModelsForProvider,
  type PermissionMode,
  SessionAlreadyStartedError,
  type AgentDefinition,
  type AgentEvent,
  AgentSessionNotFoundError,
  type AttachmentRef,
  type BrowserAnnotation,
  type CodeAnnotation,
  type ComposerAnnotation,
  type FileRef,
  type FolderId,
  GoalUnsupportedError,
  type MessageContent,
  type MessageId as MessageIdType,
  type MessageOrigin,
  type MessageRole,
  type ProviderId,
  QueueState,
  QueuedMessage,
  type ResumeStrategy,
  type RuntimeMode,
  Session,
  SessionId,
  SessionNotFoundError,
  SessionStartError,
  type SkillRef,
  ThreadGoal,
  type ThreadGoalSetInput,
  type Worktree,
  type WorktreeCreateSource,
  WorktreeId,
  type AutonomyLevel,
  autonomyEnablesOrchestration,
} from "@zuse/wire";

import {
  buildOrchestrationTools,
  type OrchestrationSessionTools,
  type OrchestrationToolDeps,
} from "../drivers/orchestration-tools.ts";

import { WorktreeService } from "../../worktree/services/worktree-service.ts";

import { ConfigStoreService } from "../../config-store/services/config-store-service.ts";
import { GitService } from "../../git/services/git-service.ts";
import { makeEventStore } from "../../persistence/event-store.ts";
import { NdjsonLogger } from "../../persistence/ndjson-logger.ts";
import { PtyService } from "../../pty/services/pty-service.ts";
import { RelayActivityPublisher } from "../../relay/activity-publisher.ts";
import { RepositorySettingsService } from "../../repository-settings/services/repository-settings-service.ts";
import {
  TitleGenerator,
  buildConversationText,
  formatBranchName,
  isTrivialUserMessage,
  shouldDeferAutoName,
} from "../title-generator.ts";
import { isIgnorableGrokAuthNoise } from "../drivers/acp/grok-auth-noise.ts";
import {
  MessageStore,
  type CreateChatInput,
  type CreateSessionInput,
  type MessageStoreShape,
} from "../services/message-store.ts";
import {
  ProviderService,
  type GetRuntimeMode,
} from "../services/provider-service.ts";

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

const SESSION_COLUMNS =
  "id, project_id, title, provider_id, model, status, " +
  "archived_at, cursor, resume_strategy, runtime_mode, " +
  "agents_json, worktree_id, chat_id, forked_from_session_id, " +
  "forked_from_message_id, permission_mode, tool_search, created_at, updated_at";

const CHAT_COLUMNS =
  "id, project_id, worktree_id, title, active_session_id, origin_session_id, " +
  "archived_at, archived_worktree_json, last_message_at, last_read_at, created_at, updated_at";

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

interface QueuedMessageRow {
  readonly id: string;
  readonly session_id: string;
  readonly queue_order: number;
  readonly input_json: string;
  readonly created_at: string;
  readonly updated_at: string;
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

/**
 * Best-effort human string for a failed orchestration tool call. The control
 * plane never throws to the agent — failures come back as
 * `{ ok: false, error }`, and this turns a typed Effect error (or anything)
 * into the `error` string. Prefers a `reason` field, then `_tag`.
 */
const orchestrationErrorText = (err: unknown): string => {
  if (typeof err === "object" && err !== null) {
    const e = err as Record<string, unknown>;
    if (typeof e.reason === "string") return e.reason;
    if (typeof e._tag === "string") return e._tag;
  }
  return "Operation failed.";
};

/**
 * Flatten a persisted message's content to a single line for `read_thread`,
 * so a spawning agent can skim what a thread has done without the full
 * structured payload.
 */
const messageContentToText = (content: MessageContent): string => {
  switch (content._tag) {
    case "user":
    case "user_rich":
    case "assistant":
    case "thinking":
      return content.text;
    case "tool_use":
      return `[tool_use: ${content.tool}]`;
    case "tool_result":
      return String(content.output);
    case "error":
      return `[error: ${content.message}]`;
    case "subagent_summary":
      return content.summary;
    default:
      return `[${content._tag}]`;
  }
};

/**
 * Message kinds that are pure telemetry / lifecycle noise — excluded from a
 * forked transcript copy and from the exported Markdown so the handed-off
 * context reads like a conversation, not a metrics dump.
 */
const TRANSCRIPT_SKIP_KINDS: ReadonlySet<string> = new Set([
  "usage",
  "context_usage",
  "context_compaction",
  "usage_limit",
]);

/** Trim a serialised tool payload so a transcript export stays readable. */
const clampBlock = (value: string, max = 2000): string =>
  value.length > max
    ? `${value.slice(0, max)}\n… (${value.length - max} more chars truncated)`
    : value;

const stringifyUnknown = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

/**
 * Render a session transcript to Markdown. Used for the "Attach transcript"
 * handoff and the copy-mode fork context file. Skips telemetry rows and
 * truncates large tool payloads.
 */
const transcriptToMarkdown = (
  title: string,
  messages: ReadonlyArray<Message>,
): string => {
  const lines: string[] = [`# Transcript — ${title}`, ""];
  for (const m of messages) {
    const c = m.content;
    if (TRANSCRIPT_SKIP_KINDS.has(c._tag)) continue;
    switch (c._tag) {
      case "user":
      case "user_rich":
        lines.push("## User", "", c.text.trim(), "");
        break;
      case "assistant":
        lines.push("## Assistant", "", c.text.trim(), "");
        break;
      case "thinking":
        if (!c.redacted && c.text.trim().length > 0) {
          lines.push(
            "> _(thinking)_ " + c.text.trim().replace(/\n/g, "\n> "),
            "",
          );
        }
        break;
      case "tool_use":
        lines.push(
          `### 🛠 ${c.tool}`,
          "",
          "```json",
          clampBlock(stringifyUnknown(c.input)),
          "```",
          "",
        );
        break;
      case "tool_result":
        lines.push(
          c.isError ? "### ⚠ Tool result (error)" : "### Tool result",
          "",
          "```",
          clampBlock(stringifyUnknown(c.output)),
          "```",
          "",
        );
        break;
      case "error":
        lines.push(`> **Error:** ${c.message}`, "");
        break;
      case "interrupted":
        lines.push("> _(interrupted by user)_", "");
        break;
      case "subagent_summary":
        lines.push(`### Sub-agent ${c.agentName}`, "", c.summary.trim(), "");
        break;
      default:
        break;
    }
  }
  return (
    lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
};

const queuedMessageFromRow = (row: QueuedMessageRow): QueuedMessage =>
  QueuedMessage.make({
    id: row.id,
    sessionId: SessionId.make(row.session_id),
    input: ComposerInput.make(JSON.parse(row.input_json)),
    position: row.queue_order,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  });

/**
 * Pull `parentItemId` off a content payload for the dedicated SQL column.
 * The same value is also embedded in `content_json`; the column exists for
 * indexed lookups (e.g. "all rows nested under item X").
 */
const parentItemIdOfContent = (content: MessageContent): string | null => {
  switch (content._tag) {
    case "assistant":
    case "thinking":
    case "tool_use":
    case "tool_result":
    case "usage":
    case "user_question":
    case "user_question_answer":
      return content.parentItemId ?? null;
    case "context_usage":
    case "context_compaction":
    case "usage_limit":
      return null;
    case "subagent_summary":
      // The summary row IS the wrapper; it sits at the top level next to
      // its `Agent` tool_use. No parent.
      return null;
    default:
      return null;
  }
};

const roleForContent = (content: MessageContent): MessageRole => {
  switch (content._tag) {
    case "user":
    case "user_rich":
    case "user_question_answer":
      return "user";
    case "assistant":
    case "thinking":
    case "tool_use":
    case "subagent_summary":
    case "user_question":
      return "assistant";
    case "tool_result":
      return "tool";
    case "error":
    case "interrupted":
    case "usage":
    case "context_usage":
    case "context_compaction":
    case "usage_limit":
      return "system";
  }
};

/**
 * Translate a provider event into the persisted message payload, or `null` if
 * the event is lifecycle-only (Started / Status / Completed / Auth / Version /
 * Capabilities / PermissionRequest). Only renderable content reaches the
 * messages table — lifecycle events drive `sessions.status` instead.
 */
const eventToContent = (event: AgentEvent): MessageContent | null => {
  switch (event._tag) {
    case "AssistantMessage":
      return {
        _tag: "assistant",
        text: event.text,
        parentItemId: event.parentItemId,
      };
    case "Thinking":
      return {
        _tag: "thinking",
        itemId: event.itemId,
        text: event.text,
        redacted: event.redacted,
        parentItemId: event.parentItemId,
      };
    case "ToolUse":
      return {
        _tag: "tool_use",
        itemId: event.itemId,
        tool: event.tool,
        input: event.input,
        parentItemId: event.parentItemId,
      };
    case "ToolResult":
      return {
        _tag: "tool_result",
        itemId: event.itemId,
        output: event.output,
        isError: event.isError,
        parentItemId: event.parentItemId,
      };
    case "SubagentSummary":
      return {
        _tag: "subagent_summary",
        itemId: event.itemId,
        agentName: event.agentName,
        model: event.model,
        turns: event.turns,
        durationMs: event.durationMs,
        summary: event.summary,
        isError: event.isError,
      };
    case "UsageDelta":
      return {
        _tag: "usage",
        parentItemId: event.parentItemId,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens,
        cacheCreationTokens: event.cacheCreationTokens,
        model: event.model,
      };
    case "ContextUsage":
      return {
        _tag: "context_usage",
        providerId: event.providerId,
        usedTokens: event.usedTokens,
        windowTokens: event.windowTokens,
        precision: event.precision,
        source: event.source,
      };
    case "ContextCompaction":
      return {
        _tag: "context_compaction",
        itemId: event.itemId,
        providerId: event.providerId,
        startedAt: event.startedAt,
        durationMs: event.durationMs,
        beforeTokens: event.beforeTokens,
        afterTokens: event.afterTokens,
        status: event.status,
      };
    case "UsageLimit":
      return {
        _tag: "usage_limit",
        providerId: event.providerId,
        label: event.label,
        usedPercent: event.usedPercent,
        resetsAt: event.resetsAt,
        windowMinutes: event.windowMinutes,
      };
    case "Error":
      return { _tag: "error", message: event.message };
    case "Interrupted":
      return { _tag: "interrupted" };
    case "UserQuestion":
      return {
        _tag: "user_question",
        itemId: event.itemId,
        questions: event.questions,
        parentItemId: event.parentItemId,
      };
    default:
      return null;
  }
};

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

const originPromptPreamble = (origin: MessageOrigin): string =>
  `[Zuse: this message was sent by another agent (provider "${origin.providerId}", session ${origin.sessionId}) from a different chat thread via the zuse-orchestration MCP server — it is not from the human user.]`;

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

export const MessageStoreLive = Layer.scoped(
  MessageStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventStore = makeEventStore(sql);
    const provider = yield* ProviderService;
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
    const runtime = yield* Effect.runtime<never>();
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
            Effect.catchAll(() =>
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

    // One pubsub per session, lazily created. Re-used across multiple
    // `streamMessages` subscribers so a single provider event fans out to
    // every connected renderer view of that session.
    const pubsubs = yield* Ref.make<
      ReadonlyMap<SessionId, PubSub.PubSub<MessageEnvelope>>
    >(new Map());
    const fibers = yield* Ref.make<
      ReadonlyMap<SessionId, Fiber.RuntimeFiber<unknown, unknown>>
    >(new Map());

    type StatusEvent = {
      readonly sessionId: SessionId;
      readonly status: Session["status"];
    };
    const statusPubsubs = yield* Ref.make<
      ReadonlyMap<SessionId, PubSub.PubSub<StatusEvent>>
    >(new Map());
    const queuePubsubs = yield* Ref.make<
      ReadonlyMap<SessionId, PubSub.PubSub<QueueState>>
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
    // Unlike the per-session message/status pubsubs, chats are few and updates
    // rare, so one project-filtered hub keeps it simple. The renderer seeds
    // from `chat.list`; this stream carries live changes after subscription,
    // so a Zuse-orchestrated spawn appears in the sidebar without
    // requiring a full app reload.
    const chatChangesHub = yield* PubSub.unbounded<Chat>();
    const broadcastChat = (chat: Chat): Effect.Effect<void> =>
      PubSub.publish(chatChangesHub, chat).pipe(Effect.asVoid);

    // Chats whose LLM auto-name is in flight — cleared when the fiber ends.
    const autoNamingInFlight = new Set<string>();
    // Chats that already received a successful LLM title this process lifetime.
    const autoNamedChats = new Set<string>();

    const getOrMakePubsub = (sessionId: SessionId) =>
      Effect.gen(function* () {
        const map = yield* Ref.get(pubsubs);
        const existing = map.get(sessionId);
        if (existing !== undefined) return existing;
        const pubsub = yield* PubSub.unbounded<MessageEnvelope>();
        yield* Ref.update(pubsubs, (m) => {
          const next = new Map(m);
          next.set(sessionId, pubsub);
          return next;
        });
        return pubsub;
      });

    const getOrMakeStatusPubsub = (sessionId: SessionId) =>
      Effect.gen(function* () {
        const map = yield* Ref.get(statusPubsubs);
        const existing = map.get(sessionId);
        if (existing !== undefined) return existing;
        const pubsub = yield* PubSub.unbounded<StatusEvent>();
        yield* Ref.update(statusPubsubs, (m) => {
          const next = new Map(m);
          next.set(sessionId, pubsub);
          return next;
        });
        return pubsub;
      });

    const getOrMakeQueuePubsub = (sessionId: SessionId) =>
      Effect.gen(function* () {
        const map = yield* Ref.get(queuePubsubs);
        const existing = map.get(sessionId);
        if (existing !== undefined) return existing;
        const pubsub = yield* PubSub.unbounded<QueueState>();
        yield* Ref.update(queuePubsubs, (m) => {
          const next = new Map(m);
          next.set(sessionId, pubsub);
          return next;
        });
        return pubsub;
      });

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
        const rows = yield* sql<SessionRow>`
          SELECT id, project_id, title, provider_id, model, status,
                 archived_at, cursor, resume_strategy, runtime_mode,
                 agents_json, worktree_id, chat_id, forked_from_session_id,
                 forked_from_message_id, permission_mode, tool_search,
                 created_at, updated_at
          FROM sessions WHERE id = ${sessionId} LIMIT 1
        `.pipe(Effect.orDie);
        if (rows.length === 0) {
          return yield* Effect.fail(new SessionNotFoundError({ sessionId }));
        }
        const row = rows[0]!;
        // Hydrate the agents cache from the row on first sight after boot
        // so resume / lazy-restart pick up the same roster the session was
        // created with.
        if (!agentsBySession.has(sessionId)) {
          const parsed = parseAgents(row.agents_json);
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
        return sessionFromRow(row);
      });

    const agentsFor = (sessionId: SessionId) => agentsBySession.get(sessionId);

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
        const nowIso = now.toISOString();
        const parentItemId = parentItemIdOfContent(content);
        // All chat writes flow through the event log; the projection inside
        // `appendEvent` performs the historical INSERT INTO messages +
        // sessions.updated_at + chats.last_message_at writes atomically and
        // assigns the global `sequence` clients resume from.
        const sequence = yield* eventStore
          .appendEvent({
            streamKind: "session",
            streamId: sessionId,
            type: "MessagePersisted",
            actor: null,
            payload: {
              messageId: id,
              sessionId,
              role,
              kind: content._tag,
              contentJson: JSON.stringify(content),
              parentItemId,
              createdAt: nowIso,
            },
          })
          .pipe(Effect.orDie);
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

    const flushingQueues = yield* Ref.make<ReadonlySet<SessionId>>(new Set());
    let flushQueueAfterIdle: (
      sessionId: SessionId,
    ) => Effect.Effect<void> = () => Effect.void;

    const setStatus = (
      sessionId: SessionId,
      status: Session["status"],
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* sql`
          UPDATE sessions SET status = ${status}, updated_at = ${new Date().toISOString()}
          WHERE id = ${sessionId}
        `.pipe(Effect.asVoid, Effect.orDie);
        const pubsub = yield* getOrMakeStatusPubsub(sessionId);
        yield* PubSub.publish(pubsub, { sessionId, status });
        if (status === "idle" || status === "closed") {
          yield* Effect.forkDaemon(flushQueueAfterIdle(sessionId));
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
          Effect.catchAll((error) =>
            Effect.logDebug(
              `[MessageStore] relay activity publish failed: ${error.reason}`,
            ),
          ),
        );

    const broadcastMessage = (
      sessionId: SessionId,
      persisted: PersistedMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        // Publish AFTER the append transaction committed (persistMessage
        // returned) — a subscriber must never observe an event that later
        // rolls back. The sinceSequence cursor closes any
        // crash-between-commit-and-publish gap.
        const pubsub = yield* getOrMakePubsub(sessionId);
        yield* PubSub.publish(
          pubsub,
          MessageEnvelope.make({
            sequence: persisted.sequence,
            message: persisted.message,
          }),
        );
      });

    // The queued_messages schema (and sessions.queue_paused) are owned by
    // migrations 0015/0016/0019 — the migrator runs upstream of this layer,
    // so the lazy re-creation this file used to do is gone.
    const listQueuedRows = (
      sessionId: SessionId,
    ): Effect.Effect<ReadonlyArray<QueuedMessage>> =>
      Effect.gen(function* () {
        const rows = yield* sql<QueuedMessageRow>`
          SELECT id, session_id, queue_order, input_json, created_at, updated_at
          FROM queued_messages
          WHERE session_id = ${sessionId}
          ORDER BY queue_order ASC, created_at ASC
        `.pipe(Effect.orDie);
        return rows.map(queuedMessageFromRow);
      });

    const isQueuePaused = (sessionId: SessionId): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly queue_paused: number }>`
          SELECT queue_paused
          FROM sessions
          WHERE id = ${sessionId}
          LIMIT 1
        `.pipe(Effect.orDie);
        return (rows[0]?.queue_paused ?? 0) !== 0;
      });

    const queueState = (sessionId: SessionId): Effect.Effect<QueueState> =>
      Effect.gen(function* () {
        const [items, paused] = yield* Effect.all([
          listQueuedRows(sessionId),
          isQueuePaused(sessionId),
        ]);
        return QueueState.make({ items, paused });
      });

    const broadcastQueue = (sessionId: SessionId): Effect.Effect<void> =>
      Effect.gen(function* () {
        const state = yield* queueState(sessionId);
        const pubsub = yield* getOrMakeQueuePubsub(sessionId);
        yield* PubSub.publish(pubsub, state);
      });

    const setQueuePaused = (
      sessionId: SessionId,
      paused: boolean,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* sql`
          UPDATE sessions
          SET queue_paused = ${paused ? 1 : 0},
              updated_at = ${new Date().toISOString()}
          WHERE id = ${sessionId}
        `.pipe(Effect.asVoid, Effect.orDie);
        yield* broadcastQueue(sessionId);
      });

    const clearQueuePauseIfEmpty = (
      sessionId: SessionId,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const queue = yield* listQueuedRows(sessionId);
        if (queue.length > 0 || !(yield* isQueuePaused(sessionId))) return;
        yield* setQueuePaused(sessionId, false);
      });

    const normalizeQueuePositions = (
      sessionId: SessionId,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly id: string }>`
          SELECT id FROM queued_messages
          WHERE session_id = ${sessionId}
          ORDER BY queue_order ASC, created_at ASC
        `.pipe(Effect.orDie);
        for (let i = 0; i < rows.length; i += 1) {
          yield* sql`
            UPDATE queued_messages SET queue_order = ${i}
            WHERE id = ${rows[i]!.id} AND session_id = ${sessionId}
          `.pipe(Effect.orDie);
        }
      });

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
        const fiber = yield* Effect.forkDaemon(
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
                  if (event.status === "idle") {
                    yield* maybeForkAutoName(session.chatId, sessionId);
                  }
                }
                return;
              }
              if (event._tag === "Completed") {
                yield* setStatus(
                  sessionId,
                  event.reason === "error" ? "error" : "closed",
                );
                yield* publishRelayActivity(
                  sessionId,
                  event.reason === "error" ? "error" : "completed",
                );
                if (event.reason !== "error") {
                  yield* maybeForkAutoName(session.chatId, sessionId);
                }
                return;
              }
              if (event._tag === "SessionCursor") {
                yield* sql`
                  UPDATE sessions
                     SET cursor = ${event.cursor},
                         resume_strategy = ${event.strategy},
                         updated_at = ${new Date().toISOString()}
                  WHERE id = ${sessionId}
                `.pipe(Effect.asVoid, Effect.orDie);
                return;
              }
              if (event._tag === "PermissionModeChanged") {
                // SDK flipped its lifecycle mode (typically because
                // ExitPlanMode just ran successfully). Persist + cache
                // so the chat-header chip auto-untoggles and a future
                // `provider.start` resume passes the new mode through.
                yield* sql`
                  UPDATE sessions
                     SET permission_mode = ${event.mode},
                         updated_at = ${new Date().toISOString()}
                  WHERE id = ${sessionId}
                `.pipe(Effect.asVoid, Effect.orDie);
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
              const persisted = yield* persistMessage(sessionId, content);
              yield* broadcastMessage(sessionId, persisted);
              yield* ndjsonAppend(sessionId, persisted);
              // A provider `Error` event terminates the turn but, unlike a
              // `Completed`, carries no lifecycle reason of its own — so
              // without this the session is left pinned at `running` and the
              // composer / setup card spin forever (this is the "stuck on the
              // loading screen" symptom for auth failures, which surface as a
              // mid-stream Error with no trailing result message). Flip to
              // `error` so the renderer shows the error bubble + login CTA.
              if (event._tag === "Error") {
                yield* publishRelayActivity(sessionId, "error");
                yield* setStatus(sessionId, "error");
              }
            }),
          ).pipe(
            Effect.catchAllCause((cause) =>
              Effect.logDebug("[MessageStore] event stream ended").pipe(
                Effect.zipRight(Effect.logDebug(cause)),
              ),
            ),
          ),
        );
        yield* Ref.update(fibers, (m) => {
          const next = new Map(m);
          next.set(sessionId, fiber);
          return next;
        });
      });

    // Interrupt only the provider → pubsub event-pump fiber, leaving the
    // message and status PubSubs alive. The renderer's `messages.stream`
    // and `session.streamStatus` subscriptions stay connected; the next
    // `sendMessage` lazy-restarts the provider and a fresh pump-fiber
    // publishes to the same pubsubs. Use this for setModel / setProvider /
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
        const pubsubMap = yield* Ref.get(pubsubs);
        const pubsub = pubsubMap.get(sessionId);
        if (pubsub !== undefined) {
          yield* PubSub.shutdown(pubsub);
          yield* Ref.update(pubsubs, (m) => {
            const next = new Map(m);
            next.delete(sessionId);
            return next;
          });
        }
        const statusMap = yield* Ref.get(statusPubsubs);
        const statusPubsub = statusMap.get(sessionId);
        if (statusPubsub !== undefined) {
          yield* PubSub.shutdown(statusPubsub);
          yield* Ref.update(statusPubsubs, (m) => {
            const next = new Map(m);
            next.delete(sessionId);
            return next;
          });
        }
        const queueMap = yield* Ref.get(queuePubsubs);
        const queuePubsub = queueMap.get(sessionId);
        if (queuePubsub !== undefined) {
          yield* PubSub.shutdown(queuePubsub);
          yield* Ref.update(queuePubsubs, (m) => {
            const next = new Map(m);
            next.delete(sessionId);
            return next;
          });
        }
      });

    // Boot recovery: any session left in `running` is stale (the previous
    // run's provider session died with the process). Demote to `idle` so the
    // sidebar reflects reality, but DO NOT pollute the message timeline with
    // synthetic rows — `sendMessage` will lazily restart the provider on the
    // next user turn (see below).
    yield* sql`
      UPDATE sessions SET status = 'idle' WHERE status = 'running'
    `.pipe(Effect.orDie);
    // Sessions left in `booting` from a crashed daemon never finished the
    // provider handshake — surface them as failed starts so the renderer
    // shows a closable tab instead of a stuck spinner.
    yield* sql`
      UPDATE sessions SET status = 'error' WHERE status = 'booting'
    `.pipe(Effect.orDie);

    const listSessions: MessageStoreShape["listSessions"] = (
      projectId,
      includeArchived,
    ) =>
      Effect.gen(function* () {
        const rows = includeArchived
          ? yield* sql<SessionRow>`
              SELECT id, project_id, title, provider_id, model, status,
                     archived_at, cursor, resume_strategy, runtime_mode,
                     agents_json, worktree_id, chat_id, forked_from_session_id,
                     forked_from_message_id, permission_mode, tool_search,
                     created_at, updated_at
              FROM sessions WHERE project_id = ${projectId}
              ORDER BY updated_at DESC
            `.pipe(Effect.orDie)
          : yield* sql<SessionRow>`
              SELECT id, project_id, title, provider_id, model, status,
                     archived_at, cursor, resume_strategy, runtime_mode,
                     agents_json, worktree_id, chat_id, forked_from_session_id,
                     forked_from_message_id, permission_mode, tool_search,
                     created_at, updated_at
              FROM sessions
              WHERE project_id = ${projectId} AND archived_at IS NULL
              ORDER BY updated_at DESC
            `.pipe(Effect.orDie);
        // Defensive filter — `chat_id` is NOT NULL since migration 0012, but
        // any row that somehow slips through with NULL would crash the
        // Session schema decode and take the entire sidebar / fs / terminal
        // down with it. Drop and log instead.
        const usable: SessionRow[] = [];
        let dropped = 0;
        for (const row of rows) {
          if (row.chat_id === null) {
            dropped += 1;
            continue;
          }
          usable.push(row);
        }
        if (dropped > 0) {
          yield* Effect.logWarning(
            `[MessageStore] listSessions: dropped ${dropped} row(s) with NULL chat_id (project ${projectId})`,
          );
        }
        return usable.map(sessionFromRow);
      });

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
     * Build the session-bound control-plane (orchestration) tool bundle,
     * gated on the project's autonomy level. Returns `null` when autonomy is
     * `"off"` so providers register no spawn tools and memoize behaves
     * exactly as before. Each tool bridges back into these Effect methods via
     * `Runtime.runPromise`, mapping every typed failure to a
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
        // Fail closed: if settings can't be read, register no control-plane
        // tools (autonomy = off) rather than dying the whole session boot.
        const settings = yield* configStore
          .getSettings()
          .pipe(Effect.catchAllCause(() => Effect.succeed(null)));
        const level: AutonomyLevel = settings?.defaultAutonomyLevel ?? "off";
        if (!autonomyEnablesOrchestration(level)) return null;
        const run = Runtime.runPromise(runtime);
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
                Effect.catchAll((err) =>
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
                }).pipe(Effect.either);
                if (chat._tag === "Left") {
                  return {
                    ok: false as const,
                    error: `${orchestrationErrorText(chat.left)}; orphaned worktreeId: ${wt.id as string}`,
                  };
                }
                return {
                  ok: true as const,
                  chatId: chat.right.chatId,
                  sessionId: chat.right.sessionId,
                  title: chat.right.title,
                  worktreeId: wt.id as string,
                  path: wt.path,
                  branch: wt.branch,
                };
              }).pipe(
                Effect.catchAll((err) =>
                  Effect.succeed({
                    ok: false as const,
                    error: orchestrationErrorText(err),
                  }),
                ),
              ),
            ),
          createChat: (input) =>
            run(
              Effect.gen(function* () {
                const explicitWorktreeId =
                  input.worktreeId !== undefined
                    ? (input.worktreeId as WorktreeId)
                    : undefined;
                const worktreeId =
                  explicitWorktreeId !== undefined
                    ? explicitWorktreeId
                    : ctx.worktreeId;
                if (explicitWorktreeId !== undefined) {
                  const wt = yield* worktrees.get(explicitWorktreeId);
                  if (wt === null) {
                    return {
                      ok: false as const,
                      error: `worktreeId ${input.worktreeId} not found`,
                    };
                  }
                  if ((wt.projectId as string) !== (ctx.projectId as string)) {
                    return {
                      ok: false as const,
                      error: `worktreeId ${input.worktreeId} does not belong to this project`,
                    };
                  }
                }
                return yield* createOrchestrationChat({
                  task: input.task,
                  title: input.title,
                  worktreeId,
                  providerId: input.providerId,
                  model: input.model,
                });
              }).pipe(
                Effect.catchAll((err) =>
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
                Effect.catchAll((err) =>
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
                Effect.catchAll((err) =>
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
                Effect.catchAll((err) =>
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

    const createSession: MessageStoreShape["createSession"] = (
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
        const sessionId = SessionId.make(
          `s_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
        );
        const newSessionRuntimeMode: GetRuntimeMode = () =>
          getRuntimeModeFor(sessionId);
        const effectiveEnableSubagents =
          input.enableSubagents ??
          (input.agents !== undefined && Object.keys(input.agents).length > 0);
        const cwdOverride = yield* cwdForWorktree(worktreeId);
        const initialPermissionMode =
          input.permissionMode ?? DEFAULT_PERMISSION_MODE;
        const initialToolSearch = input.toolSearch ?? false;
        const initialRuntimeMode = input.runtimeMode ?? DEFAULT_RUNTIME_MODE;
        runtimeModeBySession.set(sessionId, initialRuntimeMode);
        permissionModeBySession.set(sessionId, initialPermissionMode);
        // Control-plane orchestration tools — null unless the project's
        // autonomy level opts in. Passed to `provider.start` so the agent can
        // spawn + steer its own worktrees/threads.
        const orchestrationTools = yield* buildOrchestrationForSession({
          sessionId,
          chatId: input.chatId,
          projectId,
          worktreeId,
          providerId: input.providerId,
          model: input.model,
        });
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
        const nowIso = now.toISOString();
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
        let origin: MessageOrigin | undefined = undefined;
        if (hasInitial && chatRow.origin_session_id !== null) {
          const originRows = yield* sql<{
            readonly chat_id: string;
            readonly provider_id: string;
          }>`
            SELECT chat_id, provider_id FROM sessions WHERE id = ${chatRow.origin_session_id}
          `.pipe(Effect.orDie);
          const originRow = originRows[0];
          if (originRow !== undefined) {
            origin = {
              chatId: originRow.chat_id as ChatId,
              sessionId: chatRow.origin_session_id as SessionId,
              providerId: originRow.provider_id as ProviderId,
            };
          }
        }
        const promptForProvider =
          origin !== undefined && input.initialPrompt !== undefined
            ? `[Zuse: this task was assigned by an orchestrating agent (provider "${origin.providerId}", session ${origin.sessionId}) in a different chat thread via the zuse-orchestration MCP server — it is not from the human user.]\n\n${input.initialPrompt}`
            : input.initialPrompt;
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
        // Synchronous mode (chat.create) inserts with the final post-boot
        // status because it waits for `provider.start` below — the row is
        // never visible to the renderer in `booting`. Background mode
        // (session.create) inserts as `booting`; the daemon flips it.
        const rowStatus: Session["status"] = background
          ? "booting"
          : postBootStatus;
        if (background) {
          yield* sql`
            INSERT INTO sessions
              (id, project_id, title, provider_id, model, status, runtime_mode,
               agents_json, worktree_id, chat_id, permission_mode,
               tool_search, cursor, resume_strategy, forked_from_session_id,
               forked_from_message_id, created_at, updated_at)
            VALUES
              (${sessionId}, ${projectId}, ${title}, ${input.providerId},
               ${input.model}, ${rowStatus}, ${initialRuntimeMode},
               ${agentsJson}, ${worktreeId}, ${input.chatId},
               ${initialPermissionMode}, ${initialToolSearch ? 1 : 0},
               ${resumeCursor}, ${resumeStrategy}, ${forkedFromSessionId},
               ${forkedFromMessageId}, ${nowIso}, ${nowIso})
          `.pipe(Effect.orDie);
          yield* sql`
            UPDATE chats
            SET active_session_id = ${sessionId}, updated_at = ${nowIso}
            WHERE id = ${input.chatId}
          `.pipe(Effect.asVoid, Effect.orDie);
          if (hasInitial) {
            yield* persistMessage(sessionId, {
              _tag: "user",
              text: input.initialPrompt!,
              goal: false,
              ...(origin !== undefined ? { origin } : {}),
            });
          }
          // Detach the boot so the RPC reply happens immediately. The status
          // pubsub fans the eventual transition out to the renderer via
          // `session.streamStatus`; on failure we mark `error` and log so
          // the user sees a closable failed tab instead of a stuck spinner.
          yield* Effect.forkDaemon(
            provider
              .start(
                {
                  folderId: projectId,
                  providerId: input.providerId,
                  mode: "sdk",
                  sessionId,
                  initialPrompt: promptForProvider,
                  model: input.model,
                  agents: input.agents,
                  enableSubagents: effectiveEnableSubagents,
                  cwdOverride,
                  permissionMode: initialPermissionMode,
                  modelOptions: input.modelOptions,
                  toolSearch: initialToolSearch,
                  forkFromResume,
                },
                resumeCursor,
                newSessionRuntimeMode,
                orchestrationTools,
              )
              .pipe(
                Effect.flatMap(() =>
                  Effect.gen(function* () {
                    yield* setStatus(sessionId, postBootStatus);
                    yield* startSubscription(sessionId);
                  }),
                ),
                Effect.catchAll((err) =>
                  Effect.gen(function* () {
                    yield* Effect.logWarning(
                      `[MessageStore] provider.start failed for session ${sessionId} (${input.providerId}): ${err.reason}`,
                    );
                    // Persist the failure as an error message so the renderer
                    // can render it (and classify auth failures into the inline
                    // "Sign in" CTA) instead of leaving the session stuck on the
                    // booting spinner with no explanation.
                    const persistedError = yield* persistMessage(sessionId, {
                      _tag: "error",
                      message: err.reason,
                    });
                    yield* broadcastMessage(sessionId, persistedError);
                    yield* ndjsonAppend(sessionId, persistedError);
                    yield* setStatus(sessionId, "error");
                  }),
                ),
              ),
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
        yield* provider
          .start(
            {
              folderId: projectId,
              providerId: input.providerId,
              mode: "sdk",
              sessionId,
              initialPrompt: promptForProvider,
              model: input.model,
              agents: input.agents,
              enableSubagents: effectiveEnableSubagents,
              cwdOverride,
              permissionMode: initialPermissionMode,
              modelOptions: input.modelOptions,
              toolSearch: initialToolSearch,
              forkFromResume,
            },
            resumeCursor,
            newSessionRuntimeMode,
            orchestrationTools,
          )
          .pipe(
            Effect.mapError((err) =>
              err._tag === "ProviderNotAvailableError"
                ? new SessionStartError({
                    providerId: input.providerId,
                    reason: err.reason,
                  })
                : new SessionStartError({
                    providerId: err.providerId,
                    reason: err.reason,
                  }),
            ),
          );
        yield* sql`
          INSERT INTO sessions
            (id, project_id, title, provider_id, model, status, runtime_mode,
             agents_json, worktree_id, chat_id, permission_mode,
             tool_search, cursor, resume_strategy, forked_from_session_id,
             forked_from_message_id, created_at, updated_at)
          VALUES
            (${sessionId}, ${projectId}, ${title}, ${input.providerId},
             ${input.model}, ${rowStatus}, ${initialRuntimeMode},
             ${agentsJson}, ${worktreeId}, ${input.chatId},
             ${initialPermissionMode}, ${initialToolSearch ? 1 : 0},
             ${resumeCursor}, ${resumeStrategy}, ${forkedFromSessionId},
             ${forkedFromMessageId}, ${nowIso}, ${nowIso})
        `.pipe(Effect.orDie);
        yield* sql`
          UPDATE chats
          SET active_session_id = ${sessionId}, updated_at = ${nowIso}
          WHERE id = ${input.chatId}
        `.pipe(Effect.asVoid, Effect.orDie);
        if (hasInitial) {
          yield* persistMessage(sessionId, {
            _tag: "user",
            text: input.initialPrompt!,
            goal: false,
            ...(origin !== undefined ? { origin } : {}),
          });
        }
        yield* startSubscription(sessionId);
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

    const renameSession: MessageStoreShape["renameSession"] = (
      sessionId,
      title,
    ) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        yield* sql`
          UPDATE sessions SET title = ${title}, updated_at = ${new Date().toISOString()}
          WHERE id = ${sessionId}
        `.pipe(Effect.orDie);
      });

    /**
     * Update the per-session runtime mode. Persists immediately. The driver's
     * `canUseTool` callback observes the new value via `provider.start`'s
     * runtime-mode getter on the next tool call — no need to restart the SDK.
     */
    const setRuntimeMode: MessageStoreShape["setRuntimeMode"] = (
      sessionId,
      runtimeMode,
    ) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        const nowIso = new Date().toISOString();
        yield* sql`
          UPDATE sessions SET runtime_mode = ${runtimeMode}, updated_at = ${nowIso}
          WHERE id = ${sessionId}
        `.pipe(Effect.orDie);
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
    const setPermissionMode: MessageStoreShape["setPermissionMode"] = (
      sessionId,
      mode,
    ) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        const nowIso = new Date().toISOString();
        yield* sql`
          UPDATE sessions SET permission_mode = ${mode}, updated_at = ${nowIso}
          WHERE id = ${sessionId}
        `.pipe(Effect.orDie);
        permissionModeBySession.set(sessionId, mode);
        yield* provider.setPermissionMode(sessionId, mode).pipe(
          // The SDK session may have been closed (idle / closed status).
          // Persisting the mode is enough — when the renderer hits Send,
          // `restartProviderSession` will pass the persisted value back
          // into `provider.start`'s Options.
          Effect.catchAll(() => Effect.void),
        );
      });

    /**
     * Resolve a pending AskUserQuestion. Persist the answer first so a
     * crash mid-flight doesn't leave the renderer with no record; then
     * forward to the driver, which resolves the deferred Promise and
     * lets the SDK turn unwind with the answers as the tool result.
     */
    const answerQuestion: MessageStoreShape["answerQuestion"] = (
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
        yield* broadcastMessage(sessionId, persisted);
        yield* ndjsonAppend(sessionId, persisted);
        yield* provider
          .answerQuestion(sessionId, itemId, answers)
          .pipe(Effect.catchAll(() => Effect.void));
      });

    /**
     * Switch the worktree the session runs in. Allowed only before the
     * first user message is recorded — cwd cannot move under a running
     * agent. The renderer guards via `messagesCount > 0`, but we re-check
     * server-side so a stale client can't race past the lock.
     */
    const setWorktree: MessageStoreShape["setWorktree"] = (
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
        const nowIso = new Date().toISOString();
        yield* sql`
          UPDATE sessions
          SET worktree_id = ${worktreeId},
              cursor = NULL,
              resume_strategy = 'none',
              updated_at = ${nowIso}
          WHERE id = ${sessionId}
        `.pipe(Effect.orDie);
        yield* provider
          .close(sessionId)
          .pipe(Effect.catchAll(() => Effect.void));
        yield* interruptProviderFiber(sessionId);
        yield* setStatus(sessionId, "idle");
      });

    /**
     * Persist a new model on the session row and tear down the in-memory
     * provider session so the next user turn lazy-restarts the SDK with the
     * new model. Existing message history stays attached to the same row.
     */
    const setModel: MessageStoreShape["setModel"] = (sessionId, model) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        const nowIso = new Date().toISOString();
        yield* sql`
          UPDATE sessions SET model = ${model}, updated_at = ${nowIso}
          WHERE id = ${sessionId}
        `.pipe(Effect.orDie);
        // Drop the provider's in-memory session and interrupt the event pump
        // fiber; the message + status pubsubs stay alive so the renderer's
        // streams remain connected. sendMessage's "send fails → restart"
        // path reads sessions.model so the next turn picks up the new model.
        yield* provider
          .close(sessionId)
          .pipe(Effect.catchAll(() => Effect.void));
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
    const setProvider: MessageStoreShape["setProvider"] = (
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
        const nowIso = new Date().toISOString();
        yield* sql`
          UPDATE sessions
          SET provider_id = ${providerId},
              model = ${model},
              cursor = NULL,
              resume_strategy = 'none',
              updated_at = ${nowIso}
          WHERE id = ${sessionId}
        `.pipe(Effect.orDie);
        // See setModel: keep the pubsubs alive so the renderer's streams
        // stay connected across the provider swap.
        yield* provider
          .close(sessionId)
          .pipe(Effect.catchAll(() => Effect.void));
        yield* interruptProviderFiber(sessionId);
        yield* setStatus(sessionId, "idle");
      });

    const archiveSession: MessageStoreShape["archiveSession"] = (sessionId) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        const nowIso = new Date().toISOString();
        yield* sql`
          UPDATE sessions SET archived_at = ${nowIso}, updated_at = ${nowIso}
          WHERE id = ${sessionId}
        `.pipe(Effect.orDie);
      });

    const unarchiveSession: MessageStoreShape["unarchiveSession"] = (
      sessionId,
    ) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        const nowIso = new Date().toISOString();
        yield* sql`
          UPDATE sessions SET archived_at = NULL, updated_at = ${nowIso}
          WHERE id = ${sessionId}
        `.pipe(Effect.orDie);
      });

    const deleteSession: MessageStoreShape["deleteSession"] = (sessionId) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        // Best-effort: provider may not know the id (already closed) — that's
        // not an error from the user's perspective.
        yield* provider
          .close(sessionId)
          .pipe(Effect.catchAll(() => Effect.void));
        yield* teardownSubscription(sessionId);
        yield* sql`DELETE FROM sessions WHERE id = ${sessionId}`.pipe(
          Effect.orDie,
        );
        // ON DELETE CASCADE removes messages.
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

    const listChats: MessageStoreShape["listChats"] = (
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

    const getChat: MessageStoreShape["getChat"] = (chatId) =>
      lookupChat(chatId);

    /**
     * Create a chat row AND its initial session in one effect. Both rows
     * land or neither does — we INSERT the chat first, attempt the
     * provider boot, and if the boot fails we DELETE the chat to leave
     * the DB clean.
     */
    const createChat: MessageStoreShape["createChat"] = (
      input: CreateChatInput,
    ) =>
      Effect.gen(function* () {
        const now = new Date();
        const nowIso = now.toISOString();
        const chatId = crypto.randomUUID() as unknown as ChatId;
        const title =
          input.title?.trim() || deriveProvisionalTitle(input.initialPrompt);
        const worktreeId = input.worktreeId ?? null;
        const originSessionId = input.originSessionId ?? null;
        yield* sql`
          INSERT INTO chats
            (id, project_id, worktree_id, title, active_session_id, origin_session_id,
             archived_at, last_message_at, last_read_at, created_at, updated_at)
          VALUES
            (${chatId}, ${input.projectId}, ${worktreeId}, ${title}, NULL,
             ${originSessionId}, NULL, NULL, ${nowIso}, ${nowIso}, ${nowIso})
        `.pipe(Effect.asVoid, Effect.orDie);
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
            sql`DELETE FROM chats WHERE id = ${chatId}`.pipe(
              Effect.asVoid,
              Effect.orDie,
            ),
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
        // Path 1: the chat was created WITH its first message (the common
        // composer flow). Kick off the background auto-name when there is
        // enough context (trivial-only greetings wait for a follow-up).
        if (hasInitial && input.initialPrompt !== undefined) {
          yield* maybeForkAutoName(chat.id, initialSession.id);
        }
        return { chat, initialSession, initialMessage };
      });

    const continueExternalThread: MessageStoreShape["continueExternalThread"] =
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

    const importExternalMessages: MessageStoreShape["importExternalMessages"] =
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

    const exportTranscript: MessageStoreShape["exportTranscript"] = (
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

    const latestPlan: MessageStoreShape["latestPlan"] = (sessionId) =>
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

    const forkSession: MessageStoreShape["forkSession"] = (input) =>
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
          .filter((m) => !TRANSCRIPT_SKIP_KINDS.has(m.content._tag))
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
            Effect.catchAll(() => Effect.succeed([])),
          );
        }

        return { chat, session, forkMode };
      });

    const renameChat: MessageStoreShape["renameChat"] = (chatId, title) =>
      Effect.gen(function* () {
        yield* lookupChat(chatId);
        const nowIso = new Date().toISOString();
        yield* sql`
          UPDATE chats SET title = ${title}, updated_at = ${nowIso}
          WHERE id = ${chatId}
        `.pipe(Effect.asVoid, Effect.orDie);
        // Push the new title to any renderer subscribed via
        // `chat.streamChanges` so the sidebar updates without a refetch.
        const updated = yield* lookupChat(chatId);
        yield* broadcastChat(updated);
      });

    const markChatRead: MessageStoreShape["markChatRead"] = (chatId) =>
      Effect.gen(function* () {
        yield* lookupChat(chatId);
        const nowIso = new Date().toISOString();
        // Read state only — leave `updated_at` (sidebar ordering) untouched.
        yield* sql`
          UPDATE chats SET last_read_at = ${nowIso} WHERE id = ${chatId}
        `.pipe(Effect.asVoid, Effect.orDie);
        return yield* lookupChat(chatId);
      });

    const streamChatChanges: MessageStoreShape["streamChatChanges"] = (
      projectId,
    ) =>
      Stream.unwrapScoped(
        Effect.gen(function* () {
          const sub = yield* chatChangesHub.subscribe;
          return Stream.fromQueue(sub).pipe(
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
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const chat = yield* lookupChat(chatId).pipe(
          Effect.catchAll(() => Effect.succeed(null)),
        );
        if (chat === null) return;

        const context = yield* collectAutoNameContext(chatId);
        if (shouldDeferAutoName(context.userTexts, context.assistantTexts)) {
          return;
        }

        const session = yield* lookupSession(sessionId).pipe(
          Effect.catchAll(() => Effect.succeed(null)),
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
        yield* renameChat(chatId, title);
        yield* sql`
          UPDATE sessions SET title = ${title} WHERE chat_id = ${chatId}
        `.pipe(Effect.ignoreLogged);
        autoNamedChats.add(chatId);

        if (chat.worktreeId === null) return;
        const worktreeId = chat.worktreeId;
        const wt = yield* worktrees.get(worktreeId);
        if (wt === null) return;

        const settings = yield* configStore.getSettings();
        const username = yield* git
          .getUserName(chat.projectId)
          .pipe(Effect.catchAll(() => Effect.succeed("")));
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
          Effect.catchAll(() => Effect.void),
        );
      }).pipe(Effect.catchAllCause(() => Effect.void));

    const maybeForkAutoName = (
      chatId: ChatId,
      sessionId: SessionId,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (autoNamedChats.has(chatId) || autoNamingInFlight.has(chatId)) {
          return;
        }
        autoNamingInFlight.add(chatId);
        yield* Effect.forkDaemon(
          autoNameChat(chatId, sessionId).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                autoNamingInFlight.delete(chatId);
              }),
            ),
          ),
        );
      });

    /**
     * Worktrees are immutable past the first user message in any of the
     * chat's sessions. Mirrors `session.setWorktree`'s pre-message check
     * but lifted to the chat scope.
     */
    const setChatWorktree: MessageStoreShape["setChatWorktree"] = (
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
        const nowIso = new Date().toISOString();
        yield* sql`
          UPDATE chats SET worktree_id = ${worktreeId}, updated_at = ${nowIso}
          WHERE id = ${chatId}
        `.pipe(Effect.asVoid, Effect.orDie);
        // Mirror onto every member session so renderer reads of
        // session.worktreeId stay accurate without a second round-trip.
        yield* sql`
          UPDATE sessions
          SET worktree_id = ${worktreeId},
              cursor = NULL,
              resume_strategy = 'none',
              updated_at = ${nowIso}
          WHERE chat_id = ${chatId}
        `.pipe(Effect.asVoid, Effect.orDie);
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
          const sid = row.id as SessionId;
          yield* provider.close(sid).pipe(Effect.catchAll(() => Effect.void));
          yield* interruptProviderFiber(sid);
          yield* setStatus(sid, "idle");
        }
        return yield* lookupChat(chatId);
      });

    const setChatActiveSession: MessageStoreShape["setChatActiveSession"] = (
      chatId,
      sessionId,
    ) =>
      Effect.gen(function* () {
        yield* lookupChat(chatId);
        const nowIso = new Date().toISOString();
        // Defensive: only update if the session belongs to this chat.
        // Stale renderer state shouldn't be able to scramble the memo.
        yield* sql`
          UPDATE chats
          SET active_session_id = ${sessionId}, updated_at = ${nowIso}
          WHERE id = ${chatId}
            AND EXISTS (
              SELECT 1 FROM sessions
              WHERE id = ${sessionId} AND chat_id = ${chatId}
            )
        `.pipe(Effect.asVoid, Effect.orDie);
      });

    const archiveChat: MessageStoreShape["archiveChat"] = (chatId, force) =>
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
          yield* provider
            .close(sessionId)
            .pipe(Effect.catchAll(() => Effect.void));
          yield* interruptProviderFiber(sessionId);
        }
        if (worktree !== null) {
          yield* ptys
            .closeByCwdPrefix(worktree.path)
            .pipe(Effect.catchAll(() => Effect.void));
        }

        let cleanup: { readonly ran: boolean; readonly output: string } | null =
          null;
        const script = settings.archiveCleanupScript?.trim() ?? "";
        if (worktree !== null && script.length > 0) {
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

        const nowIso = new Date().toISOString();
        yield* sql`
          UPDATE chats
          SET archived_at = ${nowIso},
              archived_worktree_json = ${snapshotJson},
              updated_at = ${nowIso}
          WHERE id = ${chatId}
        `.pipe(Effect.asVoid, Effect.orDie);
        yield* sql`
          UPDATE sessions SET archived_at = ${nowIso}, updated_at = ${nowIso}
          WHERE chat_id = ${chatId} AND archived_at IS NULL
        `.pipe(Effect.asVoid, Effect.orDie);
        return { chat: yield* lookupChat(chatId), cleanup };
      });

    const unarchiveChat: MessageStoreShape["unarchiveChat"] = (chatId) =>
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

        const nowIso = new Date().toISOString();
        yield* sql`
          UPDATE chats
          SET archived_at = NULL,
              worktree_id = ${restoredWorktreeId},
              archived_worktree_json = NULL,
              updated_at = ${nowIso}
          WHERE id = ${chatId}
        `.pipe(Effect.asVoid, Effect.orDie);
        if (restoredWorktreeId !== null) {
          yield* sql`
            UPDATE sessions
            SET worktree_id = ${restoredWorktreeId}, updated_at = ${nowIso}
            WHERE chat_id = ${chatId}
          `.pipe(Effect.asVoid, Effect.orDie);
        }
        if (chatRow.archived_at !== null) {
          yield* sql`
            UPDATE sessions
            SET archived_at = NULL, updated_at = ${nowIso}
            WHERE chat_id = ${chatId}
              AND archived_at = ${chatRow.archived_at}
          `.pipe(Effect.asVoid, Effect.orDie);
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

    const deleteChat: MessageStoreShape["deleteChat"] = (chatId) =>
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
          yield* provider
            .close(sessionId)
            .pipe(Effect.catchAll(() => Effect.void));
          yield* teardownSubscription(sessionId);
        }
        yield* sql`DELETE FROM chats WHERE id = ${chatId}`.pipe(
          Effect.asVoid,
          Effect.orDie,
        );
        // ON DELETE CASCADE handles sessions + messages.
      });

    const listMessages: MessageStoreShape["listMessages"] = (sessionId) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        const rows = yield* sql<MessageRow>`
          SELECT id, session_id, role, kind, content_json, parent_item_id, created_at
          FROM messages WHERE session_id = ${sessionId}
          ORDER BY created_at ASC
        `.pipe(Effect.orDie);
        return rows.map(messageFromRow);
      });

    const streamMessages: MessageStoreShape["streamMessages"] = (
      sessionId,
      sinceSequence,
    ) =>
      Stream.unwrapScoped(
        Effect.gen(function* () {
          yield* lookupSession(sessionId);
          const since = sinceSequence ?? 0;
          // Subscribe to the live pubsub *before* reading the replay so a
          // message persisted between SELECT and Stream.fromQueue is still
          // delivered. The cursor makes dedup structural: replay covers
          // everything ≤ lastReplayed, the live tail admits only envelopes
          // past it — no seen-Set, O(1) memory, gap-free resume.
          const pubsub = yield* getOrMakePubsub(sessionId);
          const dequeue = yield* pubsub.subscribe;
          const rows = yield* sql<MessageRow & { readonly sequence: number }>`
            SELECT id, session_id, role, kind, content_json, parent_item_id,
                   created_at, sequence
            FROM messages
            WHERE session_id = ${sessionId} AND sequence > ${since}
            ORDER BY sequence ASC
          `.pipe(Effect.orDie);
          const replay = rows.map((row) =>
            MessageEnvelope.make({
              sequence: row.sequence,
              message: messageFromRow(row),
            }),
          );
          const lastReplayed =
            replay.length > 0 ? replay[replay.length - 1]!.sequence : since;
          const live = Stream.fromQueue(dequeue).pipe(
            Stream.filter((envelope) => envelope.sequence > lastReplayed),
          );
          return Stream.concat(Stream.fromIterable(replay), live);
        }),
      );

    const streamStatus: MessageStoreShape["streamStatus"] = (sessionId) =>
      Stream.unwrapScoped(
        Effect.gen(function* () {
          const session = yield* lookupSession(sessionId);
          // Mirror streamMessages: subscribe before reading the persisted row
          // so transitions during the SELECT window are still delivered.
          const pubsub = yield* getOrMakeStatusPubsub(sessionId);
          const dequeue = yield* pubsub.subscribe;
          const initial: {
            readonly sessionId: SessionId;
            readonly status: Session["status"];
          } = {
            sessionId,
            status: session.status,
          };
          return Stream.concat(
            Stream.succeed(initial),
            Stream.fromQueue(dequeue),
          );
        }),
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
            Effect.zipRight(provider.setGoal(session.id, goalInput)),
            Effect.catchTag(
              "AgentSessionNotFoundError",
              mapProviderSessionNotFound(session.id),
            ),
          ),
        ),
      );
    };

    const getGoal: MessageStoreShape["getGoal"] = (sessionId) =>
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

    const setGoal: MessageStoreShape["setGoal"] = (sessionId, goalInput) =>
      Effect.gen(function* () {
        const session = yield* ensureGoalSession(sessionId);
        const goal = yield* setGoalWithLiveProvider(session, goalInput);
        yield* publishGoal(sessionId, goal);
        return goal;
      });

    const clearGoal: MessageStoreShape["clearGoal"] = (sessionId) =>
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

    const streamGoal: MessageStoreShape["streamGoal"] = (sessionId) =>
      Stream.unwrapScoped(
        Effect.gen(function* () {
          yield* ensureGoalSession(sessionId);
          const pubsub = yield* getOrMakeGoalPubsub(sessionId);
          const dequeue = yield* pubsub.subscribe;
          const cached = goalsBySession.get(sessionId);
          const initialGoal =
            cached !== undefined
              ? cached
              : yield* provider
                  .getGoal(sessionId)
                  .pipe(Effect.catchAll(() => Effect.succeed(null)));
          if (cached === undefined) goalsBySession.set(sessionId, initialGoal);
          return Stream.concat(
            Stream.succeed({ sessionId, goal: initialGoal }),
            Stream.fromQueue(dequeue),
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

    const resumeSession: MessageStoreShape["resumeSession"] = (sessionId) =>
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
        // a fresh handle attached to the same DB row. Keep the pubsubs
        // alive so renderer subscriptions stay connected across the
        // resume — only the event-pump fiber needs to restart.
        yield* provider
          .close(sessionId)
          .pipe(Effect.catchAll(() => Effect.void));
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
          origin !== undefined ? originPromptPreamble(origin) : null,
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
          `.pipe(Effect.ignoreLogged);
        }
        yield* broadcastMessage(sessionId, persisted);
        const chat = yield* lookupChat(session.chatId).pipe(
          Effect.mapError(() => new SessionNotFoundError({ sessionId })),
        );
        // Provisional title: update chat + session immediately for real tasks
        // so the sidebar/tab never sit on "New chat" while the LLM pass runs.
        const provisional = deriveProvisionalTitle(text);
        if (provisional !== "New chat") {
          if (session.title === "New chat") {
            yield* sql`
              UPDATE sessions SET title = ${provisional}
              WHERE id = ${sessionId} AND title = 'New chat'
            `.pipe(Effect.orDie);
          }
          if (chat.title === "New chat") {
            yield* renameChat(session.chatId, provisional).pipe(
              Effect.mapError(() => new SessionNotFoundError({ sessionId })),
            );
          }
        }
        // Try LLM auto-name when there is enough context (trivial-only
        // greetings wait until the assistant replies or the user sends more).
        if (text.trim().length > 0) {
          yield* maybeForkAutoName(session.chatId, sessionId);
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
            yield* broadcastMessage(sessionId, persistedError);
            yield* ndjsonAppend(sessionId, persistedError);
            return false;
          }
          const goal = yield* setGoalWithLiveProvider(session, {
            objective,
            status: "active",
          }).pipe(
            Effect.catchAll((err) =>
              Effect.gen(function* () {
                const message =
                  err._tag === "SessionStartError"
                    ? `Goal mode could not start ${session.providerId}: ${err.reason}`
                    : `Goal mode could not start ${session.providerId} for this session.`;
                const persistedError = yield* persistMessage(sessionId, {
                  _tag: "error",
                  message,
                });
                yield* broadcastMessage(sessionId, persistedError);
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
          `[message-store.sendMessage] sessionId=${sessionId} cleanAttachments=${cleanAttachments.length} (orig=${
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
            .pipe(Effect.catchAll(() => Effect.void));
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
              `[message-store.sendMessage] provider.send failed with auth error for ${sessionId}; skipping restart`,
            );
            const persistedError = yield* persistMessage(sessionId, {
              _tag: "error",
              message: sendResult.reason,
            });
            yield* broadcastMessage(sessionId, persistedError);
            yield* ndjsonAppend(sessionId, persistedError);
            yield* setStatus(sessionId, "error");
            return false;
          }

          console.log(
            `[message-store.sendMessage] provider.send failed; restarting provider session for ${sessionId}`,
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
            yield* broadcastMessage(sessionId, persistedError);
            yield* ndjsonAppend(sessionId, persistedError);
            yield* setStatus(sessionId, "idle");
            return false;
          }
        }
        yield* setStatus(sessionId, "running");
        return true;
      });

    const sendMessage: MessageStoreShape["sendMessage"] = (
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
        yield* submitUserMessage(
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
      });

    const listQueuedMessages: MessageStoreShape["listQueuedMessages"] = (
      sessionId,
    ) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        return yield* queueState(sessionId);
      });

    const streamQueuedMessages: MessageStoreShape["streamQueuedMessages"] = (
      sessionId,
    ) =>
      Stream.unwrapScoped(
        Effect.gen(function* () {
          yield* lookupSession(sessionId);
          const pubsub = yield* getOrMakeQueuePubsub(sessionId);
          const dequeue = yield* pubsub.subscribe;
          const initial = yield* queueState(sessionId);
          return Stream.concat(
            Stream.succeed(initial),
            Stream.fromQueue(dequeue),
          );
        }),
      );

    const addQueuedMessage: MessageStoreShape["addQueuedMessage"] = (
      sessionId,
      input,
    ) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        const maxRows = yield* sql<{ readonly max_position: number | null }>`
          SELECT MAX(queue_order) AS max_position
          FROM queued_messages
          WHERE session_id = ${sessionId}
        `.pipe(Effect.orDie);
        const position = (maxRows[0]?.max_position ?? -1) + 1;
        const now = new Date();
        const nowIso = now.toISOString();
        const id = `q_${crypto.randomUUID()}`;
        yield* sql`
          INSERT INTO queued_messages
            (id, session_id, queue_order, input_json, created_at, updated_at)
          VALUES
            (${id}, ${sessionId}, ${position}, ${JSON.stringify(input)},
             ${nowIso}, ${nowIso})
        `.pipe(Effect.orDie);
        const item = QueuedMessage.make({
          id,
          sessionId,
          input,
          position,
          createdAt: now,
          updatedAt: now,
        });
        yield* broadcastQueue(sessionId);
        return item;
      });

    const updateQueuedMessage: MessageStoreShape["updateQueuedMessage"] = (
      sessionId,
      queueId,
      input,
    ) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        const nowIso = new Date().toISOString();
        yield* sql`
          UPDATE queued_messages
          SET input_json = ${JSON.stringify(input)}, updated_at = ${nowIso}
          WHERE session_id = ${sessionId} AND id = ${queueId}
        `.pipe(Effect.orDie);
        const rows = yield* sql<QueuedMessageRow>`
          SELECT id, session_id, queue_order, input_json, created_at, updated_at
          FROM queued_messages
          WHERE session_id = ${sessionId} AND id = ${queueId}
          LIMIT 1
        `.pipe(Effect.orDie);
        const item =
          rows[0] === undefined
            ? yield* addQueuedMessage(sessionId, input)
            : queuedMessageFromRow(rows[0]);
        yield* broadcastQueue(sessionId);
        return item;
      });

    const deleteQueuedMessage: MessageStoreShape["deleteQueuedMessage"] = (
      sessionId,
      queueId,
    ) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        yield* sql`
          DELETE FROM queued_messages
          WHERE session_id = ${sessionId} AND id = ${queueId}
        `.pipe(Effect.orDie);
        yield* normalizeQueuePositions(sessionId);
        yield* clearQueuePauseIfEmpty(sessionId);
        yield* broadcastQueue(sessionId);
      });

    const reorderQueuedMessages: MessageStoreShape["reorderQueuedMessages"] = (
      sessionId,
      queueIds,
    ) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        const existing = yield* listQueuedRows(sessionId);
        const byId = new Map(existing.map((item) => [item.id, item]));
        const ordered = [
          ...queueIds.flatMap((id) => {
            const item = byId.get(id);
            if (item === undefined) return [];
            byId.delete(id);
            return [item];
          }),
          ...existing.filter((item) => byId.has(item.id)),
        ];
        const nowIso = new Date().toISOString();
        for (let i = 0; i < ordered.length; i += 1) {
          yield* sql`
            UPDATE queued_messages
            SET queue_order = ${i}, updated_at = ${nowIso}
            WHERE session_id = ${sessionId} AND id = ${ordered[i]!.id}
          `.pipe(Effect.orDie);
        }
        const next = yield* listQueuedRows(sessionId);
        yield* broadcastQueue(sessionId);
        return next;
      });

    const claimQueuedMessage = (
      sessionId: SessionId,
      queueId: string,
    ): Effect.Effect<QueuedMessage | null> =>
      Effect.gen(function* () {
        const rows = yield* sql<QueuedMessageRow>`
          SELECT id, session_id, queue_order, input_json, created_at, updated_at
          FROM queued_messages
          WHERE session_id = ${sessionId} AND id = ${queueId}
          LIMIT 1
        `.pipe(Effect.orDie);
        const row = rows[0];
        if (row === undefined) return null;
        const item = queuedMessageFromRow(row);
        yield* sql`
          DELETE FROM queued_messages
          WHERE session_id = ${sessionId} AND id = ${queueId}
        `.pipe(Effect.orDie);
        yield* normalizeQueuePositions(sessionId);
        yield* broadcastQueue(sessionId);
        return item;
      });

    const restoreQueuedMessage = (item: QueuedMessage): Effect.Effect<void> =>
      Effect.gen(function* () {
        const existing = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM queued_messages
          WHERE session_id = ${item.sessionId} AND id = ${item.id}
        `.pipe(Effect.orDie);
        if ((existing[0]?.count ?? 0) > 0) return;
        yield* sql`
          INSERT INTO queued_messages
            (id, session_id, queue_order, input_json, created_at, updated_at)
          VALUES
            (${item.id}, ${item.sessionId}, ${item.position},
             ${JSON.stringify(item.input)}, ${item.createdAt.toISOString()},
             ${new Date().toISOString()})
        `.pipe(Effect.orDie);
        yield* normalizeQueuePositions(item.sessionId);
        yield* broadcastQueue(item.sessionId);
      });

    const sendClaimedQueuedMessage = (
      item: QueuedMessage,
    ): Effect.Effect<void, SessionNotFoundError> =>
      Effect.gen(function* () {
        const ok = yield* submitUserMessage(
          item.sessionId,
          item.input.text,
          item.input.attachments,
          item.input.fileRefs,
          item.input.skillRefs,
          item.input.annotations,
        );
        if (!ok) {
          yield* restoreQueuedMessage(item);
        }
      });

    const sendQueuedMessageNow: MessageStoreShape["sendQueuedMessageNow"] = (
      sessionId,
      queueId,
    ) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        yield* setQueuePaused(sessionId, false);
        const item = yield* claimQueuedMessage(sessionId, queueId);
        if (item === null) return;
        yield* sendClaimedQueuedMessage(item);
      });

    const flushQueuedMessages: MessageStoreShape["flushQueuedMessages"] = (
      sessionId,
    ) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        const current = yield* Ref.get(flushingQueues);
        if (current.has(sessionId)) return;
        yield* Ref.update(flushingQueues, (set) => {
          const next = new Set(set);
          next.add(sessionId);
          return next;
        });
        try {
          const session = yield* lookupSession(sessionId);
          if (session.status === "running" || session.status === "booting") {
            return;
          }
          if (yield* isQueuePaused(sessionId)) {
            return;
          }
          const queue = yield* listQueuedRows(sessionId);
          const head = queue[0];
          if (head === undefined) return;
          const claimed = yield* claimQueuedMessage(sessionId, head.id);
          if (claimed === null) return;
          yield* sendClaimedQueuedMessage(claimed);
        } finally {
          yield* Ref.update(flushingQueues, (set) => {
            const next = new Set(set);
            next.delete(sessionId);
            return next;
          });
        }
      });

    flushQueueAfterIdle = (sessionId) =>
      flushQueuedMessages(sessionId).pipe(Effect.catchAll(() => Effect.void));

    const resumeQueuedMessages: MessageStoreShape["resumeQueuedMessages"] = (
      sessionId,
    ) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        yield* setQueuePaused(sessionId, false);
        yield* flushQueuedMessages(sessionId);
      });

    const interruptSession: MessageStoreShape["interruptSession"] = (
      sessionId,
    ) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        yield* provider
          .interrupt(sessionId)
          .pipe(Effect.mapError(() => new SessionNotFoundError({ sessionId })));
        const queue = yield* listQueuedRows(sessionId);
        if (queue.length > 0) {
          yield* setQueuePaused(sessionId, true);
        }
        yield* setStatus(sessionId, "idle");
      });

    const getSession: MessageStoreShape["getSession"] = (sessionId) =>
      lookupSession(sessionId);

    return {
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
      listChats,
      getChat,
      createChat,
      continueExternalThread,
      importExternalMessages,
      forkSession,
      exportTranscript,
      latestPlan,
      renameChat,
      markChatRead,
      streamChatChanges,
      setChatWorktree,
      setChatActiveSession,
      archiveChat,
      unarchiveChat,
      deleteChat,
      resumeSession,
      listMessages,
      streamMessages,
      streamStatus,
      getGoal,
      setGoal,
      clearGoal,
      streamGoal,
      sendMessage,
      interruptSession,
      listQueuedMessages,
      streamQueuedMessages,
      addQueuedMessage,
      updateQueuedMessage,
      deleteQueuedMessage,
      sendQueuedMessageNow,
      reorderQueuedMessages,
      flushQueuedMessages,
      resumeQueuedMessages,
    } as const;
  }),
);
