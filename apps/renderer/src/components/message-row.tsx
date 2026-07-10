import {
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Copy01Icon,
  DashboardSpeedIcon,
  Loading02Icon,
  PlayIcon,
  Settings01Icon,
  Tick01Icon,
} from "@hugeicons-pro/core-bulk-rounded";
import { HugeiconsIcon } from "@hugeicons/react";
import { RefreshCw as RefreshIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";
import type {
  AttachmentRef,
  BrowserAnnotation,
  CodeAnnotation,
  ComposerAnnotation,
  FileRef,
  Message,
  MessageOrigin,
  ProviderId,
  SessionId,
  SkillRef,
} from "@zuse/wire";

import { getFileIconUrl } from "~/lib/icons/material-icons";
import {
  orchestrationToolName,
  parseOrchestrationResult,
} from "~/lib/orchestration-tools";
import { openExternal, useProviderLogin } from "~/lib/use-provider-login";
import { cn } from "~/lib/utils";
import { useChatsStore } from "~/store/chats";
import {
  classifyMessage,
  lookupSessionProvider,
  useMessagesStore,
  type ChatError,
} from "~/store/messages";
import { useProvidersStore } from "~/store/providers";
import { useUiStore } from "~/store/ui";

import { CopyButton } from "./copy-button.tsx";
import { useRevealAnnotation } from "./annotation/annotation-navigation.ts";
import { useChatLookups } from "./chat-lookups.tsx";
import { AnnotationFileChip, FileChip } from "./file-chip.tsx";
import { ProviderIcon } from "./provider-icons.tsx";

const isBrowserAnnotation = (
  annotation: ComposerAnnotation,
): annotation is BrowserAnnotation =>
  "_tag" in annotation && annotation._tag === "browser";

const browserAnnotationMeta = (annotation: BrowserAnnotation): string => {
  const count =
    annotation.elements.length +
    annotation.regions.length +
    annotation.strokes.length;
  const first = annotation.elements[0];
  if (first !== undefined) return `<${first.tagName}> · ${count}`;
  try {
    return `${new URL(annotation.pageUrl).host} · ${count}`;
  } catch {
    return `Browser · ${count}`;
  }
};
import { MarkdownBody } from "./markdown-body.tsx";
import {
  ExitPlanModeRow,
  OrchestrationThreadRow,
  ThinkingRow,
  ToolRow,
  UserInputRow,
} from "./tool-row.tsx";
import { Button } from "./ui/button.tsx";
import { ShimmerText } from "./ui/shimmer-text.tsx";

export type { ToolResultRecord } from "./chat-lookups.tsx";

type MessageContent<Tag extends Message["content"]["_tag"]> = Extract<
  Message["content"],
  { readonly _tag: Tag }
>;

const stringifyJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const RECONNECTING_PATTERN =
  /^\s*Reconnecting\s*\.{3}\s*(\d+)\s*\/\s*(\d+)\s*$/i;

const parseReconnectingStatus = (
  message: string,
): { readonly attempt: number; readonly maxAttempts: number } | null => {
  const match = RECONNECTING_PATTERN.exec(message);
  if (match === null) return null;
  const attempt = Number(match[1]);
  const maxAttempts = Number(match[2]);
  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts)) return null;
  return { attempt, maxAttempts };
};

const formatDuration = (ms: number): string => {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const min = Math.floor(seconds / 60);
  const sec = seconds - min * 60;
  return `${min}m, ${sec.toFixed(1)}s`;
};

const formatTokenCount = (tokens: number): string => tokens.toLocaleString();

const formatCompactTokenDelta = (
  beforeTokens: number | null,
  afterTokens: number | null,
): string | null => {
  if (beforeTokens !== null && afterTokens !== null) {
    return `${formatTokenCount(beforeTokens)} -> ${formatTokenCount(afterTokens)} tokens`;
  }
  if (beforeTokens !== null) {
    return `${formatTokenCount(beforeTokens)} tokens before`;
  }
  if (afterTokens !== null) {
    return `${formatTokenCount(afterTokens)} tokens after`;
  }
  return null;
};

/**
 * Render a single chat row. Variants are dispatched on `content._tag` rather
 * than `role` because role collapses tool_use and assistant text into one
 * bucket, but their visual treatment differs.
 *
 * Tool and user-question pairing data lives in ChatLookups context so settled
 * text rows can be memoized without receiving fresh lookup-map props.
 */
function MessageRowImpl({
  message,
  sessionId,
}: {
  message: Message;
  sessionId?: SessionId;
}) {
  switch (message.content._tag) {
    case "user":
      return (
        <UserBubble
          text={message.content.text}
          origin={message.content.origin}
          goal={message.content.goal}
        />
      );
    case "user_rich":
      return (
        <UserBubble
          text={message.content.text}
          attachments={message.content.attachments}
          fileRefs={message.content.fileRefs}
          skillRefs={message.content.skillRefs}
          annotations={message.content.annotations}
          origin={message.content.origin}
          goal={message.content.goal}
        />
      );
    case "assistant":
      return (
        <AssistantBubble
          text={message.content.text}
          createdAt={message.createdAt}
        />
      );
    case "thinking":
      return (
        <ThinkingMessageRow
          messageId={message.id}
          sessionId={sessionId}
          text={message.content.text}
          redacted={message.content.redacted}
        />
      );
    case "tool_use":
      return <ToolUseMessageRow content={message.content} />;
    case "tool_result":
      return <ToolResultMessageRow content={message.content} />;
    case "user_question":
      return <UserQuestionMessageRow content={message.content} />;
    case "user_question_answer":
      // The paired `user_question` row above renders the answer inline, so
      // the standalone answer row is suppressed.
      return null;
    case "context_compaction":
      return (
        <CompactRow
          beforeTokens={message.content.beforeTokens}
          afterTokens={message.content.afterTokens}
          startedAt={message.content.startedAt}
          durationMs={message.content.durationMs}
          status={message.content.status ?? "completed"}
        />
      );
    case "usage":
    case "context_usage":
    case "usage_limit":
      return null;
    case "error":
      // Classify so an auth failure (expired OAuth / 401 / "Please run
      // /login") gets the "Sign in to {provider}" headline + inline login
      // button rather than a bare generic error.
      return (
        <ErrorBubble
          error={classifyMessage(
            message.content.message,
            sessionId !== undefined
              ? lookupSessionProvider(sessionId)
              : undefined,
          )}
          sessionId={sessionId}
        />
      );
    case "interrupted":
      // The user stopped the turn — a normal action, so render a small muted
      // badge rather than an error bubble.
      return (
        <div className="flex justify-center py-1">
          <span className="rounded-full bg-muted/50 px-2.5 py-0.5 text-[11px] text-muted-foreground">
            Interrupted by user
          </span>
        </div>
      );
  }
}

export const MessageRow = memo(MessageRowImpl);
MessageRow.displayName = "MessageRow";

function ThinkingMessageRow({
  messageId,
  sessionId,
  text,
  redacted,
}: {
  messageId: Message["id"];
  sessionId?: SessionId;
  text: string;
  redacted: boolean;
}) {
  // Shimmer while this thinking block is the live tip of a running turn.
  const pending = useMessagesStore((s) => {
    if (sessionId === undefined) return false;
    if (s.runningBySession[sessionId] !== true) return false;
    const msgs = s.messagesBySession[sessionId] ?? [];
    const last = msgs[msgs.length - 1];
    return last?.id === messageId;
  });
  return <ThinkingRow text={text} redacted={redacted} pending={pending} />;
}

function ToolUseMessageRow({
  content,
}: {
  content: MessageContent<"tool_use">;
}) {
  const { resultsByItemId } = useChatLookups();
  const result = resultsByItemId.get(content.itemId);
  if (content.tool === "ExitPlanMode") {
    return <ExitPlanModeRow input={content.input} result={result} />;
  }
  const orch = orchestrationToolName(content.tool);
  if (
    orch === "create_thread" ||
    orch === "create_chat" ||
    orch === "create_session" ||
    orch === "send_to_thread"
  ) {
    const parsed =
      result !== undefined ? parseOrchestrationResult(result.output) : null;
    const renderCard =
      result === undefined ||
      (!result.isError && parsed !== null && typeof parsed.chatId === "string");
    if (renderCard) {
      return <OrchestrationThreadRow variant={orch} result={result} />;
    }
  }
  return <ToolRow tool={content.tool} input={content.input} result={result} />;
}

function ToolResultMessageRow({
  content,
}: {
  content: MessageContent<"tool_result">;
}) {
  const { resultsByItemId } = useChatLookups();
  // Suppress paired results — the matching ToolRow renders them inline.
  // Only orphan errors (no tool_use found, e.g. driver dropped the use
  // event) surface as a standalone error row.
  const paired = resultsByItemId.has(content.itemId);
  if (paired) return null;
  return content.isError ? <ToolErrorRow output={content.output} /> : null;
}

function UserQuestionMessageRow({
  content,
}: {
  content: MessageContent<"user_question">;
}) {
  const { answersByItemId } = useChatLookups();
  // Pending questions live in the composer slot — ChatComposer swaps the
  // editor for a QuestionCard. Once answered, the question + the user's
  // selections render here as a `UserInputRow` accordion so the Q&A
  // stays visible in scrollback like every other tool call.
  const answers = answersByItemId.get(content.itemId);
  if (answers === undefined) return null;
  return <UserInputRow questions={content.questions} answers={answers} />;
}

function CompactRow({
  beforeTokens,
  afterTokens,
  startedAt,
  durationMs,
  status,
}: {
  readonly beforeTokens: number | null;
  readonly afterTokens: number | null;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly status: "in_progress" | "completed";
}) {
  const [now, setNow] = useState(() => Date.now());
  const inProgress = status === "in_progress";
  useEffect(() => {
    if (!inProgress) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [inProgress]);
  const elapsedMs = inProgress ? Math.max(0, now - startedAt) : durationMs;
  const tokenDelta = formatCompactTokenDelta(beforeTokens, afterTokens);
  const detail =
    tokenDelta === null
      ? formatDuration(elapsedMs)
      : `${tokenDelta} · ${formatDuration(elapsedMs)}`;

  return (
    <div className="px-4 py-2 text-muted-foreground">
      <div className="flex items-center gap-2">
        <RefreshIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 opacity-70",
            inProgress && "animate-spin",
          )}
        />
        <span className="text-sm font-medium text-foreground/90">
          {inProgress ? "Compacting..." : "Chat compacted"}
        </span>
      </div>
      <div className="mt-1 pl-5 text-[11px] tabular-nums text-muted-foreground/70">
        {detail}
      </div>
    </div>
  );
}

/**
 * Strip the inline chip tokens (`[image:<id>]`, `@<path>`, `/<skill>`) from
 * text we render in the user bubble. The chips are surfaced as visual
 * thumbnails / chips below the bubble, so showing the raw token in-line is
 * just noise. Tokens for chip kinds the row didn't receive (legacy `user`
 * content, copy-pasted text) pass through unchanged.
 */
const stripChipTokens = (
  text: string,
  attachments: ReadonlyArray<AttachmentRef>,
  fileRefs: ReadonlyArray<FileRef>,
  skillRefs: ReadonlyArray<SkillRef>,
): string => {
  let out = text;
  for (const a of attachments) {
    out = out.replaceAll(`[image:${a.id}]`, "");
  }
  // Attachments uploaded but submitted while still holding the renderer-side
  // temp id — we strip them defensively too so the bubble doesn't show
  // `[image:pending-xxx]`.
  out = out.replace(/\[image:pending-[a-z0-9]+\]/gi, "");
  for (const f of fileRefs) {
    out = out.replaceAll(`@${f.relPath}`, "");
  }
  for (const s of skillRefs) {
    out = out.replaceAll(`/${s.name}`, `/${s.name}`);
  }
  return out.replace(/[ \t]{2,}/g, " ").trim();
};

const formatMessageTime = (date: Date): string =>
  date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

function UserBubble({
  text,
  attachments,
  fileRefs,
  skillRefs,
  annotations,
  origin,
  goal = false,
}: {
  text: string;
  attachments?: ReadonlyArray<AttachmentRef>;
  fileRefs?: ReadonlyArray<FileRef>;
  skillRefs?: ReadonlyArray<SkillRef>;
  annotations?: ReadonlyArray<ComposerAnnotation>;
  origin?: MessageOrigin;
  goal?: boolean;
}) {
  const hasAnnotations = annotations !== undefined && annotations.length > 0;
  const revealAnnotation = useRevealAnnotation();
  const originChatLoaded = useChatsStore((s) =>
    origin === undefined
      ? false
      : Object.values(s.chatsByProject).some((list) =>
          list.some((c) => c.id === origin.chatId),
        ),
  );
  const hasChips =
    (attachments !== undefined && attachments.length > 0) ||
    (fileRefs !== undefined && fileRefs.length > 0) ||
    (skillRefs !== undefined && skillRefs.length > 0);
  const display = hasChips
    ? stripChipTokens(text, attachments ?? [], fileRefs ?? [], skillRefs ?? [])
    : text;
  const truncate = (name: string): string =>
    name.length > 28 ? `${name.slice(0, 25)}...` : name;
  return (
    <div className="group/message flex justify-end px-4 py-2">
      <div
        data-chat-user-bubble
        className="relative max-w-[80%] rounded-2xl rounded-tr-sm bg-user-bubble px-3 py-2 pr-9 text-sm text-user-bubble-foreground"
      >
        <CopyButton
          text={display || text}
          label="Copy message"
          className="absolute right-2 top-1.5 size-5 text-user-bubble-foreground/50 opacity-60 hover:bg-background/10 hover:text-user-bubble-foreground hover:opacity-100 focus-visible:opacity-100"
        />
        {origin !== undefined ? (
          <button
            type="button"
            disabled={!originChatLoaded}
            onClick={() => useChatsStore.getState().select(origin.chatId)}
            className="mb-1.5 flex items-center gap-1.5 text-[11px] text-user-bubble-foreground/65 hover:text-user-bubble-foreground disabled:cursor-default"
            title={
              originChatLoaded
                ? "Open the sender's chat"
                : "Sender chat not loaded"
            }
          >
            <ProviderIcon providerId={origin.providerId} className="size-3" />
            <span>
              Sent by {PROVIDER_LABEL_FOR_ERROR[origin.providerId]} from another
              chat
            </span>
          </button>
        ) : null}
        {hasAnnotations ? (
          <ol className="mb-2 space-y-1">
            {(annotations ?? []).map((a, i) => (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (!isBrowserAnnotation(a)) revealAnnotation(a);
                  }}
                  disabled={isBrowserAnnotation(a)}
                  className="flex w-full min-w-0 items-start gap-2 rounded-lg border border-user-bubble-foreground/12 bg-background/10 px-2 py-1.5 text-left text-xs hover:bg-background/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-user-bubble-foreground/30"
                  title={
                    isBrowserAnnotation(a)
                      ? "Browser annotation"
                      : "Open annotation"
                  }
                >
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-background/20 text-[10px] font-semibold tabular-nums">
                    {i + 1}
                  </span>
                  <span className="grid min-w-0 flex-1 gap-1">
                    {isBrowserAnnotation(a) ? (
                      <span className="min-w-0 truncate font-medium">
                        {browserAnnotationMeta(a)}
                      </span>
                    ) : (
                      <AnnotationFileChip annotation={a as CodeAnnotation} />
                    )}
                    <span className="min-w-0 break-words leading-snug">
                      {a.comment}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        ) : null}
        {hasChips ? (
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            {(attachments ?? []).map((a) => {
              const isImage = a.mimeType.startsWith("image/");
              const iconUrl = isImage ? null : getFileIconUrl(a.originalName);
              const src = `zuse://attachments/${a.id}`;
              const className =
                "inline-flex items-center gap-1.5 rounded-md border border-border/45 bg-[var(--chip-bg)] px-1.5 py-0.5 text-[11px] text-foreground/90 hover:bg-[color-mix(in_oklch,var(--chip-bg)_80%,var(--foreground)_4%)] hover:text-foreground dark:shadow-[inset_0_1px_0_color-mix(in_oklch,white_4%,transparent),0_1px_2px_color-mix(in_oklch,black_22%,transparent)]";
              const inner = (
                <>
                  {isImage ? (
                    <img
                      src={src}
                      alt=""
                      className="size-4 rounded object-cover"
                    />
                  ) : iconUrl !== null ? (
                    <img src={iconUrl} alt="" className="size-4" />
                  ) : null}
                  <span className="truncate">{truncate(a.originalName)}</span>
                </>
              );
              if (isImage) {
                return (
                  <button
                    key={a.id}
                    type="button"
                    title={a.originalName}
                    className={className}
                    onClick={() =>
                      useUiStore.getState().openFileInTab({
                        kind: "image",
                        src,
                        name: a.originalName,
                      })
                    }
                  >
                    {inner}
                  </button>
                );
              }
              return (
                <a
                  key={a.id}
                  href={src}
                  target="_blank"
                  rel="noreferrer"
                  title={a.originalName}
                  className={className}
                >
                  {inner}
                </a>
              );
            })}
            {(fileRefs ?? []).map((f) => (
              <FileChip
                key={f.relPath}
                relPath={f.relPath}
                absPath={f.absPath}
                kind={f.kind}
              />
            ))}
            {(skillRefs ?? []).map((s) => (
              <span
                key={s.name}
                className="inline-flex items-center rounded-md border border-border/45 bg-[var(--chip-bg)] px-1.5 py-0.5 text-[11px] text-foreground/90 dark:shadow-[inset_0_1px_0_color-mix(in_oklch,white_4%,transparent),0_1px_2px_color-mix(in_oklch,black_22%,transparent)]"
              >
                /{s.name}
              </span>
            ))}
          </div>
        ) : null}
        {display.length > 0 ? (
          <div className="whitespace-pre-wrap break-words">{display}</div>
        ) : null}
        {goal ? (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-user-bubble-foreground/65">
            <HugeiconsIcon icon={DashboardSpeedIcon} className="size-3.5" />
            <span>Sent as goal</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AssistantBubble({
  text,
  createdAt,
}: {
  text: string;
  createdAt?: Date;
}) {
  return (
    <div className="px-4 py-2">
      <div className="max-w-full">
        <MarkdownBody>{text}</MarkdownBody>
        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {createdAt !== undefined ? (
            <span className="tabular-nums">{formatMessageTime(createdAt)}</span>
          ) : null}
          <CopyButton
            text={text}
            label="Copy message"
            className="size-5 rounded opacity-70 hover:opacity-100"
          />
        </div>
      </div>
    </div>
  );
}

function ToolErrorRow({ output }: { output: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const chevron = expanded ? ArrowDown01Icon : ArrowRight01Icon;
  const text = typeof output === "string" ? output : stringifyJson(output);
  const firstLine = text.split("\n", 1)[0] ?? "";
  return (
    <div className="px-4">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="group flex w-full items-center gap-2 rounded px-1.5 py-0.5 text-left text-xs hover:bg-accent"
      >
        <div className="relative grid size-4 shrink-0 place-items-center">
          <HugeiconsIcon
            icon={AlertCircleIcon}
            strokeWidth={2}
            aria-hidden="true"
            className={cn(
              "col-start-1 row-start-1 size-3.5 text-destructive transition-opacity duration-150 ease-out",
              "group-hover:opacity-0 motion-reduce:transition-none",
            )}
          />
          <HugeiconsIcon
            icon={chevron}
            aria-hidden="true"
            className={cn(
              "col-start-1 row-start-1 size-3.5 text-muted-foreground opacity-0 transition-opacity duration-150 ease-out",
              "group-hover:opacity-100 motion-reduce:transition-none",
            )}
          />
        </div>
        <span className="font-medium text-foreground">Error</span>
        <span className="truncate text-muted-foreground">{firstLine}</span>
      </button>
      {expanded ? (
        <div className="ml-7 mt-1 border-l border-border/60 pl-3">
          <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
            {text || "(empty)"}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

type RateLimitInfo = {
  readonly resetText?: string;
  readonly period?: "weekly" | "monthly" | "daily";
};

// Parse rate-limit / usage-limit messages emitted by Claude Code, the
// Anthropic SDK, or other providers. We see them as plain strings (the
// wire ErrorEvent carries no structured metadata) so this is best-effort
// pattern matching against the human-readable text.
const parseRateLimit = (text: string): RateLimitInfo | null => {
  const isRateLimit =
    /usage limit|rate[-\s]?limit|quota|429|too many requests|overloaded|hit your limit|reached (?:your |the )?limit|agent reached limit/i.test(
      text,
    );
  if (!isRateLimit) return null;

  const resetMatch =
    text.match(
      /reset(?:s|ing)?(?:\s+at)?\s+(\d{1,2}(?::\d{2})?\s*[ap]m(?:\s*\([^)]+\))?)/i,
    ) ??
    text.match(
      /(?:try|see|check)\s+again\s+at\s+(\d{1,2}(?::\d{2})?\s*[ap]m(?:\s*(?:\([^)]+\)|[A-Z][A-Za-z_/-]*(?:\s+time)?))?)/i,
    ) ??
    text.match(/reset(?:s|ing)?(?:\s+at)?\s+(\d{4}-\d{2}-\d{2}[T0-9:.Z+\-]*)/i);

  const lower = text.toLowerCase();
  const period: RateLimitInfo["period"] = lower.includes("monthly")
    ? "monthly"
    : lower.includes("weekly")
      ? "weekly"
      : lower.includes("daily")
        ? "daily"
        : undefined;

  return { resetText: resetMatch?.[1], period };
};

const formatResetDetail = (info: RateLimitInfo): string => {
  if (info.resetText !== undefined) return `Resets ${info.resetText}`;
  if (info.period !== undefined) {
    const label = info.period.charAt(0).toUpperCase() + info.period.slice(1);
    return `${label} limit`;
  }
  return "Try again later";
};

const PROVIDER_LABEL_FOR_ERROR: Record<ProviderId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
  gemini: "Gemini",
  cursor: "Cursor",
  opencode: "OpenCode",
};

// Providers with a real in-app `agent.startLogin` handler — for these we offer
// the inline one-click sign-in directly in the auth error bubble instead of
// only pointing the user at Settings.
const PROVIDERS_WITH_LOGIN: ReadonlySet<ProviderId> = new Set<ProviderId>([
  "cursor",
  "claude",
]);

/**
 * "Authentication required" card shown when a login-capable provider (Claude,
 * Cursor) reports an auth failure. Reuses the shared `useProviderLogin` flow
 * (open browser → wait for the OAuth callback → done): on success it re-probes
 * availability and clears the bottom error.
 *
 * This card is a *persisted* message in scrollback, so it must not carry sticky
 * per-instance UI: once the provider reports `authenticated` (whether via this
 * card, another duplicate card, Settings, or the terminal) every auth card
 * resolves to nothing. That's what kills the "stuck on Signed in. Resuming…"
 * and the duplicate cards after a successful sign-in.
 */
function ProviderAuthCard({
  providerId,
  sessionId,
  onOpenSettings,
  onDismiss,
}: {
  providerId: ProviderId;
  sessionId: SessionId | undefined;
  onOpenSettings: () => void;
  onDismiss?: () => void;
}) {
  const refreshProviders = useProvidersStore((s) => s.refresh);
  const authStatus = useProvidersStore(
    (s) => s.availability.find((a) => a.providerId === providerId)?.authStatus,
  );
  const clearError = useMessagesStore((s) => s.clearError);
  const retry = useMessagesStore((s) => s.retry);
  const { state, start, cancel } = useProviderLogin(providerId, {
    onSuccess: () => {
      // Re-probe first so the keychain write has landed and this card
      // resolves (hides) before we resume — then re-send the pending message
      // so the turn the user was blocked on actually runs. The server
      // restarts the stale (unauthenticated) provider process on send, so it
      // picks up the fresh credentials.
      void (async () => {
        await refreshProviders();
        if (sessionId !== undefined) {
          clearError(sessionId);
          void retry(sessionId);
        }
      })();
    },
  });
  const label = PROVIDER_LABEL_FOR_ERROR[providerId];

  // Resolved — the provider is authenticated now, so this historical card has
  // nothing left to do. Render nothing (no nag, no spinner, no duplicate).
  if (authStatus === "authenticated") return null;

  return (
    <div className="px-4 py-2">
      <div className="w-fit max-w-[80%] rounded-lg border border-border/60 bg-card px-3 py-2.5 text-xs text-foreground">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
            <HugeiconsIcon
              icon={AlertCircleIcon}
              className="size-3.5 text-destructive"
              aria-hidden
            />
            Authentication required
          </span>
          {onDismiss !== undefined && (
            <button
              type="button"
              onClick={onDismiss}
              className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Dismiss
            </button>
          )}
        </div>

        {state.kind === "waiting" ? (
          <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
            <HugeiconsIcon
              icon={Loading02Icon}
              className="size-3.5 animate-spin"
              aria-hidden
            />
            <ShimmerText as="span">Waiting for browser sign-in…</ShimmerText>
            <button
              type="button"
              onClick={cancel}
              className="rounded px-1 py-0.5 text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        ) : state.kind === "success" ? (
          <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
            <HugeiconsIcon
              icon={Loading02Icon}
              className="size-3.5 animate-spin"
              aria-hidden
            />
            <ShimmerText as="span">Signed in. Finishing…</ShimmerText>
          </div>
        ) : (
          <>
            <p className="mt-1 leading-relaxed text-muted-foreground">
              To resolve, sign in to {label}. We&apos;ll validate the login
              automatically.
            </p>
            {state.kind === "failed" && (
              <p className="mt-1 text-[11px] text-destructive">
                {state.reason}
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => void start()}
                className="gap-1.5"
              >
                <HugeiconsIcon icon={PlayIcon} className="size-3" aria-hidden />
                {state.kind === "failed"
                  ? `Try ${label} sign-in again`
                  : `Sign in to ${label}`}
              </Button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={onOpenSettings}
                className="gap-1"
              >
                <HugeiconsIcon
                  icon={Settings01Icon}
                  className="size-3"
                  aria-hidden
                />
                Settings
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const GEMINI_UPGRADE_COMMAND = "npm i -g @google/gemini-cli@latest";

const isGeminiAcpUpgradeError = (text: string): boolean =>
  /Gemini CLI.*(?:does not support ACP|--experimental-acp)|Unknown arguments?:.*(?:experimental-acp|experimentalAcp)/is.test(
    text,
  );

function GeminiUpgradeCard({ onDismiss }: { onDismiss?: () => void }) {
  const [copied, setCopied] = useState(false);
  const copyCommand = () => {
    void navigator.clipboard.writeText(GEMINI_UPGRADE_COMMAND).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className="px-4 py-2">
      <div className="max-w-[34rem] rounded-xl border border-warning/25 bg-alert-warning-bg px-4 py-3 text-xs text-foreground shadow-sm">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-warning/12 text-warning">
            <HugeiconsIcon
              icon={AlertCircleIcon}
              strokeWidth={2}
              aria-hidden="true"
              className="size-4"
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground">
              Gemini CLI needs an upgrade
            </div>
            <p className="mt-1 leading-relaxed text-muted-foreground">
              Your installed Gemini CLI does not support ACP mode yet, so Zuse
              Alpha cannot start Gemini sessions until the CLI is updated.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <code className="rounded-md border border-border/60 bg-background/60 px-2 py-1 font-mono text-[11px] text-foreground">
                {GEMINI_UPGRADE_COMMAND}
              </code>
              <Button size="xs" variant="outline" onClick={copyCommand}>
                {copied ? (
                  <HugeiconsIcon icon={Tick01Icon} className="size-3.5" />
                ) : (
                  <HugeiconsIcon icon={Copy01Icon} className="size-3.5" />
                )}
                {copied ? "Copied" : "Copy upgrade command"}
              </Button>
              {onDismiss !== undefined && (
                <Button size="xs" variant="ghost" onClick={onDismiss}>
                  Dismiss
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ErrorBubble({
  error,
  sessionId,
  onDismiss,
}: {
  error: ChatError;
  sessionId?: SessionId;
  onDismiss?: () => void;
}) {
  const retry = useMessagesStore((s) => s.retry);
  const send = useMessagesStore((s) => s.send);
  const setView = useUiStore((s) => s.setView);
  const setSettingsSection = useUiStore((s) => s.setSettingsSection);

  const onRetry = () => {
    if (sessionId !== undefined) void retry(sessionId);
  };
  const onKeepGoing = () => {
    if (sessionId !== undefined) void send(sessionId, "keep going");
  };
  const onOpenSettings = () => {
    setView("settings");
    setSettingsSection({ kind: "providers" });
  };

  if (isGeminiAcpUpgradeError(error.message)) {
    return <GeminiUpgradeCard onDismiss={onDismiss} />;
  }

  const rateLimit = parseRateLimit(error.message);
  if (rateLimit !== null) {
    return (
      <div className="px-4 py-1.5">
        <div className="inline-flex max-w-[88%] items-center gap-2 rounded-md border border-border/45 bg-[color-mix(in_oklch,var(--bg-elevated)_34%,var(--background))] px-2.5 py-1.5 text-xs text-foreground dark:shadow-[inset_0_1px_0_color-mix(in_oklch,white_4%,transparent),0_1px_2px_color-mix(in_oklch,black_22%,transparent)]">
          <span className="font-medium">Limit reached</span>
          <span className="text-muted-foreground">
            {formatResetDetail(rateLimit)}
          </span>
          {onDismiss !== undefined && (
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-[0.1875rem] px-1 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label="Dismiss limit status"
            >
              Dismiss
            </button>
          )}
        </div>
      </div>
    );
  }

  const reconnecting = parseReconnectingStatus(error.message);
  if (reconnecting !== null) {
    const isFinalAttempt = reconnecting.attempt >= reconnecting.maxAttempts;
    return (
      <div className="px-4 py-1.5">
        <div className="inline-flex max-w-[88%] items-center gap-2 rounded-md border border-border/45 bg-[color-mix(in_oklch,var(--bg-elevated)_34%,var(--background))] px-2.5 py-1.5 text-xs text-foreground dark:shadow-[inset_0_1px_0_color-mix(in_oklch,white_4%,transparent),0_1px_2px_color-mix(in_oklch,black_22%,transparent)]">
          <span className="font-medium">Reconnecting</span>
          <span className="font-mono text-muted-foreground">
            {reconnecting.attempt}/{reconnecting.maxAttempts}
          </span>
          {isFinalAttempt && (
            <>
              <span className="h-3 w-px bg-border/60" aria-hidden="true" />
              <button
                type="button"
                onClick={onKeepGoing}
                disabled={sessionId === undefined}
                className="rounded-[0.1875rem] bg-secondary px-1.5 py-0.5 font-medium text-secondary-foreground transition-colors hover:bg-secondary/90"
              >
                Retry
              </button>
            </>
          )}
          {onDismiss !== undefined && (
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-[0.1875rem] px-1 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label="Dismiss reconnecting status"
            >
              Dismiss
            </button>
          )}
        </div>
      </div>
    );
  }

  // Auth failure for a provider we can sign into in-app → the dedicated
  // "Authentication required" card with the one-click OAuth button. Other
  // providers (or auth errors without a provider) fall through to the generic
  // bubble below with a "Open Provider Settings" link.
  if (
    error.kind === "auth" &&
    error.providerId !== undefined &&
    PROVIDERS_WITH_LOGIN.has(error.providerId)
  ) {
    return (
      <ProviderAuthCard
        providerId={error.providerId}
        sessionId={sessionId}
        onOpenSettings={onOpenSettings}
        onDismiss={onDismiss}
      />
    );
  }

  const headline =
    error.kind === "auth"
      ? `Sign in to ${
          error.providerId
            ? PROVIDER_LABEL_FOR_ERROR[error.providerId]
            : "your provider"
        }`
      : error.kind === "network"
        ? "Connection lost"
        : null;

  const iconTone =
    error.kind === "auth"
      ? "text-destructive"
      : error.kind === "network"
        ? "text-warning"
        : "text-destructive";
  const bg =
    error.kind === "network" ? "bg-alert-warning-bg" : "bg-alert-error-bg";

  return (
    <div className="py-2">
      <div
        className={cn(
          "w-full rounded-xl px-3 py-2 text-xs text-foreground",
          bg,
        )}
      >
        <div className="flex min-w-0 items-start gap-2">
          <HugeiconsIcon
            icon={AlertCircleIcon}
            strokeWidth={2}
            aria-hidden="true"
            className={cn("mt-px size-3.5 shrink-0", iconTone)}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {headline !== null ? (
              <span className="font-medium text-foreground">{headline}</span>
            ) : (
              <span className="font-medium text-foreground">
                Provider error
              </span>
            )}
            <pre className="min-w-0 max-w-full overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
              {error.message || "(empty)"}
            </pre>
            {sessionId !== undefined && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={onRetry}
                  className="gap-1"
                >
                  <RefreshIcon className="size-3" aria-hidden />
                  Retry
                </Button>
                {error.kind === "auth" && (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={onOpenSettings}
                    className="gap-1"
                  >
                    <HugeiconsIcon
                      icon={Settings01Icon}
                      className="size-3"
                      aria-hidden
                    />
                    Open Provider Settings
                  </Button>
                )}
              </div>
            )}
          </div>
          {onDismiss !== undefined && (
            <button
              type="button"
              onClick={onDismiss}
              className="shrink-0 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Dismiss
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
