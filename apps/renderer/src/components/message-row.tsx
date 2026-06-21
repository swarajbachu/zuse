import {
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Copy01Icon,
  DashboardSpeedIcon,
  RotateRight01Icon,
  Settings01Icon,
  Tick01Icon,
} from "@hugeicons-pro/core-bulk-rounded";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import type {
  AgentItemId,
  AttachmentRef,
  CodeAnnotation,
  FileRef,
  Message,
  ProviderId,
  SessionId,
  SkillRef,
  UserQuestionAnswer,
} from "@memoize/wire";

import { getFileIconUrl } from "~/lib/icons/material-icons";
import { cn } from "~/lib/utils";
import { useMessagesStore, type ChatError } from "~/store/messages";
import { useUiStore } from "~/store/ui";

import { CopyButton } from "./copy-button.tsx";
import { useRevealAnnotation } from "./annotation/annotation-navigation.ts";
import { AnnotationFileChip, FileChip } from "./file-chip.tsx";
import { MarkdownBody } from "./markdown-body.tsx";
import {
  ExitPlanModeRow,
  ThinkingRow,
  ToolRow,
  UserInputRow,
} from "./tool-row.tsx";
import { Button } from "./ui/button.tsx";

export interface ToolResultRecord {
  readonly output: unknown;
  readonly isError: boolean;
}

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

/**
 * Render a single chat row. Variants are dispatched on `content._tag` rather
 * than `role` because role collapses tool_use and assistant text into one
 * bucket, but their visual treatment differs.
 *
 * `resultsByItemId` lets `tool_use` rows render their paired `tool_result`
 * inline. Standalone `tool_result` rows are suppressed when they pair with
 * a tool_use; only orphan errors fall through to the standalone error row.
 */
export function MessageRow({
  message,
  resultsByItemId,
  answersByItemId,
  sessionId,
}: {
  message: Message;
  resultsByItemId: ReadonlyMap<AgentItemId, ToolResultRecord>;
  answersByItemId?: ReadonlyMap<AgentItemId, ReadonlyArray<UserQuestionAnswer>>;
  sessionId?: SessionId;
}) {
  switch (message.content._tag) {
    case "user":
      return (
        <UserBubble text={message.content.text} goal={message.content.goal} />
      );
    case "user_rich":
      return (
        <UserBubble
          text={message.content.text}
          attachments={message.content.attachments}
          fileRefs={message.content.fileRefs}
          skillRefs={message.content.skillRefs}
          annotations={message.content.annotations}
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
        <ThinkingRow
          text={message.content.text}
          redacted={message.content.redacted}
        />
      );
    case "tool_use":
      if (message.content.tool === "ExitPlanMode") {
        return (
          <ExitPlanModeRow
            input={message.content.input}
            result={resultsByItemId.get(message.content.itemId)}
            sessionId={sessionId}
          />
        );
      }
      return (
        <ToolRow
          tool={message.content.tool}
          input={message.content.input}
          result={resultsByItemId.get(message.content.itemId)}
        />
      );
    case "tool_result": {
      // Suppress paired results — the matching ToolRow renders them inline.
      // Only orphan errors (no tool_use found, e.g. driver dropped the use
      // event) surface as a standalone error row.
      const paired = resultsByItemId.has(message.content.itemId);
      if (paired) return null;
      return message.content.isError ? (
        <ToolErrorRow output={message.content.output} />
      ) : null;
    }
    case "user_question": {
      // Pending questions live in the composer slot — ChatComposer swaps the
      // editor for a QuestionCard. Once answered, the question + the user's
      // selections render here as a `UserInputRow` accordion so the Q&A
      // stays visible in scrollback like every other tool call.
      const answers = answersByItemId?.get(message.content.itemId);
      if (answers === undefined) return null;
      return (
        <UserInputRow questions={message.content.questions} answers={answers} />
      );
    }
    case "user_question_answer":
      // The paired `user_question` row above renders the answer inline, so
      // the standalone answer row is suppressed.
      return null;
    case "usage":
    case "context_usage":
    case "usage_limit":
      return null;
    case "error":
      return (
        <ErrorBubble
          error={{ kind: "generic", message: message.content.message }}
          sessionId={sessionId}
        />
      );
  }
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
  goal = false,
}: {
  text: string;
  attachments?: ReadonlyArray<AttachmentRef>;
  fileRefs?: ReadonlyArray<FileRef>;
  skillRefs?: ReadonlyArray<SkillRef>;
  annotations?: ReadonlyArray<CodeAnnotation>;
  goal?: boolean;
}) {
  const hasAnnotations = annotations !== undefined && annotations.length > 0;
  const revealAnnotation = useRevealAnnotation();
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
      <div className="relative max-w-[80%] rounded-2xl rounded-tr-sm bg-user-bubble px-3 py-2 pr-9 text-sm text-user-bubble-foreground">
        <CopyButton
          text={display || text}
          label="Copy message"
          className="absolute right-2 top-1.5 size-5 text-user-bubble-foreground/50 opacity-60 hover:bg-background/10 hover:text-user-bubble-foreground hover:opacity-100 focus-visible:opacity-100"
        />
        {hasAnnotations ? (
          <ol className="mb-2 space-y-1">
            {(annotations ?? []).map((a, i) => (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => revealAnnotation(a)}
                  className="flex w-full min-w-0 items-start gap-2 rounded-lg border border-user-bubble-foreground/12 bg-background/10 px-2 py-1.5 text-left text-xs hover:bg-background/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-user-bubble-foreground/30"
                  title="Open annotation"
                >
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-background/20 text-[10px] font-semibold tabular-nums">
                    {i + 1}
                  </span>
                  <span className="grid min-w-0 flex-1 gap-1">
                    <AnnotationFileChip annotation={a} />
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
              const src = `memoize://attachments/${a.id}`;
              const className =
                "inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted/60";
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
                className="inline-flex items-center rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-xs text-muted-foreground"
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
      <div className="max-w-[88%]">
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
              Your installed Gemini CLI does not support ACP mode yet, so
              memoize cannot start Gemini sessions until the CLI is updated.
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
        <div className="inline-flex max-w-[88%] items-center gap-2 rounded-md border border-border/45 bg-[color-mix(in_oklch,var(--bg-elevated)_34%,var(--background))] px-2.5 py-1.5 text-xs text-foreground shadow-[inset_0_1px_0_color-mix(in_oklch,white_4%,transparent),0_1px_2px_color-mix(in_oklch,black_22%,transparent)]">
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
        <div className="inline-flex max-w-[88%] items-center gap-2 rounded-md border border-border/45 bg-[color-mix(in_oklch,var(--bg-elevated)_34%,var(--background))] px-2.5 py-1.5 text-xs text-foreground shadow-[inset_0_1px_0_color-mix(in_oklch,white_4%,transparent),0_1px_2px_color-mix(in_oklch,black_22%,transparent)]">
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
    <div className="px-4 py-2">
      <div
        className={cn(
          "max-w-[88%] rounded-xl px-3 py-2 text-xs text-foreground",
          bg,
        )}
      >
        <div className="flex items-start gap-2">
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
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
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
                  <HugeiconsIcon
                    icon={RotateRight01Icon}
                    className="size-3"
                    aria-hidden
                  />
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
              className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Dismiss
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
