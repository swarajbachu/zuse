import type { Message, MessageContent, UserQuestion } from "@zuse/wire";
import { router } from "expo-router";
import {
  AlertCircle,
  Bot,
  Brain,
  Camera,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FilePenLine,
  Folder,
  Globe,
  Hourglass,
  Search,
  Terminal,
  Wrench,
} from "lucide-react-native";
import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { cn } from "~/lib/cn";
import {
  summarizeValue,
  type ToolResultRecord,
} from "~/lib/message-presentation";
import { captureMobileError } from "~/lib/crash-reporting";
import {
  buildToolPresentation,
  type MobileToolIcon,
} from "~/lib/tool-presentation";
import { putPlanDocument } from "~/store/plan-viewer";
import { ShimmerText } from "~/components/ui/shimmer-text";
import { Markdown } from "./markdown";
import {
  PendingUserInputCard,
  type QuestionAnswer,
} from "./pending-user-input-card";

/** Extra context the stream provides so question rows can render statefully. */
export type MessageRowContext = {
  answeredQuestionIds: ReadonlySet<string>;
  questionsByItemId: ReadonlyMap<string, readonly UserQuestion[]>;
  toolResultsByItemId: ReadonlyMap<string, ToolResultRecord>;
  planMode?: boolean;
  /** Whether the session is actively running (drives the shimmer on the last row). */
  sessionRunning?: boolean;
  onAnswerQuestion: (
    itemId: string,
    answers: readonly QuestionAnswer[],
  ) => void | Promise<void>;
};

export const MessageRow = ({
  message,
  ctx,
  isLast = false,
}: {
  message: Message;
  ctx: MessageRowContext;
  isLast?: boolean;
}) => (
  <MessageRowBoundary
    context={`message-row:${message.id}:${message.content._tag}`}
  >
    <MessageRowContent message={message} ctx={ctx} isLast={isLast} />
  </MessageRowBoundary>
);

class MessageRowBoundary extends React.Component<
  { readonly children: React.ReactNode; readonly context: string },
  { readonly failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    void captureMobileError(error, {
      context: this.props.context,
      componentStack: info.componentStack ?? undefined,
    });
  }

  render() {
    if (this.state.failed) {
      return <ErrorRow message="This message could not be rendered." />;
    }
    return this.props.children;
  }
}

const MessageRowContent = ({
  message,
  ctx,
  isLast,
}: {
  message: Message;
  ctx: MessageRowContext;
  isLast: boolean;
}) => {
  const content = message.content;
  const shimmerActive = ctx.sessionRunning === true && isLast;
  switch (content._tag) {
    case "user":
      return <UserBubble text={content.text} goal={content.goal} />;
    case "user_rich":
      return (
        <UserBubble
          text={content.text}
          chips={richChips(content)}
          goal={content.goal}
        />
      );
    case "assistant":
      return (
        <AssistantMarkdown
          text={content.text}
          planMode={ctx.planMode === true}
        />
      );
    case "thinking":
      return <ThinkingRow content={content} shimmer={shimmerActive} />;
    case "tool_use":
      return (
        <ToolUseRow
          content={content}
          result={ctx.toolResultsByItemId.get(content.itemId)}
          shimmer={shimmerActive}
        />
      );
    case "tool_result":
      return ctx.toolResultsByItemId.has(content.itemId) ? null : (
        <ToolResultRow content={content} />
      );
    case "error":
      return <ErrorRow message={content.message} />;
    case "usage_limit":
      return <UsageLimitRow content={content} />;
    case "interrupted":
      return <InlineSystemRow label="Interrupted by user" />;
    case "context_compaction":
      return <ContextCompactionRow content={content} />;
    case "subagent_summary":
      return <SubagentSummaryRow content={content} />;
    case "usage":
    case "context_usage":
      return null;
    case "user_question":
      return ctx.answeredQuestionIds.has(content.itemId) ? (
        <AnsweredQuestion questions={content.questions} />
      ) : (
        <PendingUserInputCard
          itemId={content.itemId}
          questions={content.questions}
          onSubmit={ctx.onAnswerQuestion}
        />
      );
    case "user_question_answer":
      return (
        <AnswerBubble
          content={content}
          questions={ctx.questionsByItemId.get(content.itemId)}
        />
      );
    default:
      return <FallbackRow content={content} />;
  }
};

const UserBubble = ({
  text,
  goal,
  chips = [],
}: {
  text: string;
  goal?: boolean;
  chips?: string[];
}) => (
  <View className="items-end px-2 py-2">
    <View
      style={{ borderCurve: "continuous" }}
      className="max-w-[88%] rounded-2xl bg-primary px-3.5 py-2.5"
    >
      {goal === true ? (
        <Text className="mb-1 font-sans-medium text-xs text-primary-foreground/75">
          Goal
        </Text>
      ) : null}
      <Text className="font-sans text-[15px] leading-5 text-primary-foreground">
        {text}
      </Text>
      {chips.length > 0 ? (
        <View className="mt-2 flex-row flex-wrap gap-1">
          {chips.map((chip) => (
            <Text
              key={chip}
              className="rounded-full bg-background/15 px-2 py-0.5 font-sans text-[11px] text-primary-foreground"
            >
              {chip}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  </View>
);

const AssistantMarkdown = ({
  text,
  planMode,
}: {
  text: string;
  planMode: boolean;
}) =>
  planMode || isLikelyPlan(text) ? (
    <PlanPreview text={text} />
  ) : (
    <View className="px-2 py-2">
      <Markdown>{text}</Markdown>
    </View>
  );

const PlanPreview = ({ text }: { text: string }) => {
  const title = planTitle(text);
  const preview = planPreview(text);
  return (
    <View className="px-2 py-2">
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          const id = putPlanDocument(text);
          router.push(`/plan-viewer?id=${encodeURIComponent(id)}`);
        }}
        className="rounded-2xl border border-border bg-card px-4 py-4 active:opacity-80"
        style={{ borderCurve: "continuous" }}
      >
        <View className="mb-3 flex-row items-center gap-2">
          <Text className="font-sans-medium text-[13px] text-muted-foreground">
            Plan
          </Text>
          <Text className="ml-auto font-sans text-[12px] text-muted-foreground">
            Open
          </Text>
        </View>
        <Text
          className="font-sans-bold text-[22px] leading-7 text-foreground"
          numberOfLines={2}
        >
          {title}
        </Text>
        <Text
          className="mt-3 font-sans text-[15px] leading-6 text-muted-foreground"
          numberOfLines={5}
        >
          {preview}
        </Text>
      </Pressable>
    </View>
  );
};

const ThinkingRow = ({
  content,
  shimmer,
}: {
  content: Extract<MessageContent, { _tag: "thinking" }>;
  shimmer: boolean;
}) => (
  <PlainEventRow
    icon="thinking"
    label={content.redacted ? "Redacted thinking" : "Thinking"}
    shimmer={shimmer && !content.redacted}
  >
    <Text className="font-sans text-[13px] leading-5 text-muted-foreground">
      {content.redacted ? "Thought content was redacted." : content.text}
    </Text>
  </PlainEventRow>
);

const ToolUseRow = ({
  content,
  result,
  shimmer,
}: {
  content: Extract<MessageContent, { _tag: "tool_use" }>;
  result?: ToolResultRecord;
  shimmer: boolean;
}) => {
  const view = buildToolPresentation(content, result);
  const running = view.resultLabel === "Running";

  // Errors keep the boxed danger row for readability (risk containment).
  if (view.isError) {
    return (
      <ExpandableEventRow
        icon={view.icon}
        title={view.label}
        detail={view.detail ?? undefined}
        badge={view.resultLabel}
        danger
      >
        <Text className="font-mono text-xs leading-5 text-muted-foreground">
          {view.body}
        </Text>
        {view.resultBody !== null ? (
          <View className="mt-3 border-t border-border pt-3">
            <Text className="mb-1 font-sans-medium text-[11px] uppercase text-danger">
              Error
            </Text>
            <Text
              selectable
              className="font-mono text-xs leading-5 text-muted-foreground"
              numberOfLines={8}
            >
              {view.resultBody}
            </Text>
          </View>
        ) : null}
      </ExpandableEventRow>
    );
  }

  // File-changing tools keep a subtle rounded container headed by the change
  // summary, expandable to the per-file mono diffs.
  if (view.fileChangeSummary !== null) {
    return (
      <ExpandableEventRow
        icon="edit"
        title={view.fileChangeSummary}
        badge={running ? "Running" : undefined}
        shimmer={shimmer && running}
      >
        <View className="gap-2">
          {view.editSummaries.map((summary) => (
            <View
              key={summary.path}
              className="rounded-xl border border-border bg-muted/45 px-3 py-2"
              style={{ borderCurve: "continuous" }}
            >
              <View className="flex-row items-center gap-2">
                <FilePenLine size={14} color="hsl(72 98% 54%)" />
                <Text
                  className="min-w-0 flex-1 font-mono text-xs text-foreground"
                  numberOfLines={1}
                >
                  {summary.path}
                </Text>
                <Text className="font-mono text-[11px] text-presence-online">
                  +{summary.added}
                </Text>
                <Text className="font-mono text-[11px] text-danger">
                  -{summary.removed}
                </Text>
              </View>
              <Text
                className="mt-2 font-mono text-xs leading-5 text-muted-foreground"
                numberOfLines={6}
              >
                {summary.preview}
              </Text>
            </View>
          ))}
        </View>
      </ExpandableEventRow>
    );
  }

  // Everything else: a plain full-width tool line.
  return (
    <PlainEventRow
      icon={view.icon}
      label={view.inlineLabel}
      shimmer={shimmer && running}
    >
      <Text className="font-mono text-xs leading-5 text-muted-foreground">
        {view.body}
      </Text>
      {view.resultBody !== null ? (
        <Text
          selectable
          className="mt-2 font-mono text-xs leading-5 text-muted-foreground"
          numberOfLines={8}
        >
          {view.resultBody}
        </Text>
      ) : null}
    </PlainEventRow>
  );
};

const ToolResultRow = ({
  content,
}: {
  content: Extract<MessageContent, { _tag: "tool_result" }>;
}) =>
  content.isError ? (
    <ExpandableEventRow
      icon="wrench"
      title="Tool error"
      detail={summarizeValue(content.output, 96)}
      danger
    >
      <Text
        selectable
        className="font-mono text-xs leading-5 text-muted-foreground"
      >
        {summarizeValue(content.output)}
      </Text>
    </ExpandableEventRow>
  ) : (
    <PlainEventRow icon="wrench" label="Tool result">
      <Text
        selectable
        className="font-mono text-xs leading-5 text-muted-foreground"
      >
        {summarizeValue(content.output)}
      </Text>
    </PlainEventRow>
  );

const ErrorRow = ({ message }: { message: string }) => (
  <View className="px-2 py-2">
    <View
      style={{ borderCurve: "continuous" }}
      className="rounded-2xl border border-danger bg-danger/10 px-3 py-2"
    >
      <Text className="font-sans-medium text-xs text-danger">Error</Text>
      <Text selectable className="mt-1 font-sans text-sm leading-5 text-danger">
        {message}
      </Text>
    </View>
  </View>
);

const UsageLimitRow = ({
  content,
}: {
  content: Extract<MessageContent, { _tag: "usage_limit" }>;
}) => {
  const reset = formatResetTime(content.resetsAt);
  const detail =
    reset !== null
      ? `${content.label} · resets ${reset}`
      : content.label.length > 0
        ? content.label
        : "This provider has reached its current usage window.";

  return (
    <View className="px-2 py-1.5">
      <View
        style={{ borderCurve: "continuous" }}
        className="rounded-2xl border border-primary/25 bg-primary/10 px-3 py-2.5"
      >
        <View className="flex-row items-center gap-2">
          <AlertCircle size={15} color="hsl(72 98% 54%)" />
          <Text className="font-sans-medium text-sm text-foreground">
            Limit reached
          </Text>
          {typeof content.usedPercent === "number" ? (
            <Text className="ml-auto rounded-full bg-primary/15 px-2 py-0.5 font-sans-medium text-[11px] text-primary">
              {Math.round(content.usedPercent)}%
            </Text>
          ) : null}
        </View>
        <Text
          className="mt-1 font-sans text-[13px] leading-5 text-muted-foreground"
          numberOfLines={2}
        >
          {detail}
        </Text>
      </View>
    </View>
  );
};

const InlineSystemRow = ({ label }: { label: string }) => (
  <View className="items-center px-2 py-1">
    <Text className="rounded-full bg-muted px-2.5 py-1 font-sans text-[11px] text-muted-foreground">
      {label}
    </Text>
  </View>
);

const ContextCompactionRow = ({
  content,
}: {
  content: Extract<MessageContent, { _tag: "context_compaction" }>;
}) => {
  const before = formatTokens(content.beforeTokens);
  const after = formatTokens(content.afterTokens);
  const detail =
    before !== null && after !== null
      ? `${before} to ${after}`
      : content.status === "in_progress"
        ? "Compacting context"
        : "Context compacted";

  return (
    <ExpandableEventRow
      icon="hourglass"
      title={
        content.status === "in_progress" ? "Compacting context" : "Compacted"
      }
      detail={detail}
      badge={formatDuration(content.durationMs)}
    >
      <Text className="font-sans text-sm leading-5 text-muted-foreground">
        {before !== null && after !== null
          ? `Context changed from ${before} to ${after}.`
          : "The conversation context was compacted for the next turn."}
      </Text>
    </ExpandableEventRow>
  );
};

const SubagentSummaryRow = ({
  content,
}: {
  content: Extract<MessageContent, { _tag: "subagent_summary" }>;
}) => (
  <ExpandableEventRow
    icon="agent"
    title={content.isError ? `${content.agentName} failed` : content.agentName}
    detail={`${content.turns} ${content.turns === 1 ? "turn" : "turns"} · ${formatDuration(content.durationMs)}`}
    danger={content.isError}
  >
    <Text
      selectable
      className="font-sans text-sm leading-5 text-muted-foreground"
    >
      {content.summary}
    </Text>
  </ExpandableEventRow>
);

const AnsweredQuestion = ({
  questions,
}: {
  questions: readonly UserQuestion[];
}) => (
  <View className="px-2 py-2">
    <View className="rounded-2xl border border-border bg-card px-3 py-3 opacity-70">
      <Text className="font-sans-medium text-xs text-muted-foreground">
        Question · answered
      </Text>
      {questions.map((question, qi) => (
        <Text
          key={`answered-${qi}`}
          className={cn(
            "font-sans-medium text-sm text-foreground",
            qi > 0 ? "mt-2" : "mt-1",
          )}
        >
          {question.question}
        </Text>
      ))}
    </View>
  </View>
);

const AnswerBubble = ({
  content,
  questions,
}: {
  content: Extract<MessageContent, { _tag: "user_question_answer" }>;
  questions?: readonly UserQuestion[];
}) => {
  const labels = content.answers.flatMap((answer) => {
    const options = questions?.[answer.questionIndex]?.options ?? [];
    const picked = answer.selected
      .map((index) => options[index])
      .filter((label): label is string => label !== undefined);
    const other = answer.other?.trim();
    return other !== undefined && other.length > 0
      ? [...picked, other]
      : picked;
  });
  const summary = labels.length > 0 ? labels.join(", ") : "Answered";
  return (
    <View className="items-end px-3 py-1.5">
      <View
        style={{ borderCurve: "continuous" }}
        className="max-w-[88%] rounded-2xl bg-primary px-3.5 py-2.5"
      >
        <Text className="mb-1 font-sans-medium text-xs text-primary-foreground/75">
          Answer
        </Text>
        <Text className="font-sans text-[15px] leading-5 text-primary-foreground">
          {summary}
        </Text>
      </View>
    </View>
  );
};

const FallbackRow = ({ content }: { content: MessageContent }) => (
  <View className="px-2 py-2">
    <View className="rounded-2xl border border-border bg-muted px-3 py-2">
      <Text className="font-sans-medium text-xs text-muted-foreground">
        {content._tag}
      </Text>
      <Text
        className="mt-1 font-mono text-xs leading-5 text-muted-foreground"
        numberOfLines={4}
      >
        {safeSummary(content)}
      </Text>
    </View>
  </View>
);

const richChips = (content: Extract<MessageContent, { _tag: "user_rich" }>) => [
  ...content.attachments.map((attachment) => attachment.originalName),
  ...content.fileRefs.map((file) => file.relPath),
  ...content.skillRefs.map((skill) => skill.name),
];

/**
 * Boxless, full-width event row for thinking / non-error tool lines: a leading
 * muted icon, a single-line label (optionally shimmering while the row is the
 * last running one), and a trailing chevron. Expanded content renders as plain
 * indented text — no border, no background.
 */
function PlainEventRow({
  icon,
  label,
  shimmer = false,
  children,
}: {
  icon: "thinking" | "hourglass" | MobileToolIcon;
  label: string;
  shimmer?: boolean;
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      onPress={() => setExpanded((value) => !value)}
      className="px-2 py-1.5 active:opacity-60"
    >
      <View className="flex-row items-center gap-2">
        {renderToolRowIcon(icon, "hsl(72 2% 64%)")}
        {shimmer ? (
          <ShimmerText className="min-w-0 flex-1 font-sans text-[13px] text-muted-foreground">
            {label}
          </ShimmerText>
        ) : (
          <Text
            className="min-w-0 flex-1 font-sans text-[13px] text-muted-foreground"
            numberOfLines={1}
          >
            {label}
          </Text>
        )}
        <Chevron size={12} color="hsl(72 2% 64%)" />
      </View>
      {expanded ? <View className="mt-2 pl-6">{children}</View> : null}
    </Pressable>
  );
}

function ExpandableEventRow({
  title,
  detail,
  badge,
  danger,
  icon,
  shimmer = false,
  children,
}: {
  title: string;
  detail?: string;
  badge?: string;
  danger?: boolean;
  icon: "thinking" | "hourglass" | MobileToolIcon;
  shimmer?: boolean;
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <View className="px-2 py-1">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        className={cn(
          "rounded-xl border px-3 py-2 active:opacity-75",
          danger ? "border-danger/40 bg-danger/10" : "border-border bg-card",
        )}
        style={{ borderCurve: "continuous" }}
      >
        <View className="flex-row items-center gap-2">
          <Chevron size={15} color="hsl(72 2% 64%)" />
          {renderToolRowIcon(
            icon,
            danger ? "hsl(2 86% 64%)" : "hsl(72 98% 54%)",
          )}
          {shimmer && !danger ? (
            <ShimmerText className="min-w-0 flex-1 font-sans-medium text-[13px] text-foreground">
              {title}
            </ShimmerText>
          ) : (
            <Text
              className={cn(
                "min-w-0 flex-1 font-sans-medium text-[13px]",
                danger ? "text-danger" : "text-foreground",
              )}
              numberOfLines={1}
            >
              {title}
            </Text>
          )}
          {badge ? (
            <Text
              className={cn(
                "rounded-full px-2 py-0.5 font-sans-medium text-[11px]",
                danger
                  ? "bg-danger/15 text-danger"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {badge}
            </Text>
          ) : null}
        </View>
        {detail ? (
          <Text
            className="mt-1 pl-11 font-sans text-[12px] leading-4 text-muted-foreground"
            numberOfLines={expanded ? 3 : 1}
          >
            {detail}
          </Text>
        ) : null}
        {expanded ? <View className="mt-3 pl-6">{children}</View> : null}
      </Pressable>
    </View>
  );
}

const renderToolRowIcon = (
  icon: "thinking" | "hourglass" | MobileToolIcon,
  color: string,
) => {
  switch (icon) {
    case "thinking":
      return <Brain size={14} color={color} />;
    case "hourglass":
      return <Hourglass size={14} color={color} />;
    case "terminal":
      return <Terminal size={14} color={color} />;
    case "file":
      return <FileCode2 size={14} color={color} />;
    case "edit":
      return <FilePenLine size={14} color={color} />;
    case "search":
      return <Search size={14} color={color} />;
    case "folder":
      return <Folder size={14} color={color} />;
    case "agent":
      return <Bot size={14} color={color} />;
    case "web":
      return <Globe size={14} color={color} />;
    case "camera":
      return <Camera size={14} color={color} />;
    case "todo":
      return <CheckSquare size={14} color={color} />;
    case "wrench":
      return <Wrench size={14} color={color} />;
  }
};

function formatResetTime(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(date);
  } catch {
    return date.toLocaleTimeString();
  }
}

function formatTokens(value: number | null): string | null {
  if (value === null) {
    return null;
  }
  if (value >= 1000) {
    return `${Math.round(value / 100) / 10}k tokens`;
  }
  return `${value} tokens`;
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return "now";
  }
  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`;
  }
  return `${Math.round(durationMs / 1000)}s`;
}

function safeSummary(value: unknown): string {
  try {
    return summarizeValue(value);
  } catch {
    return "Unsupported message payload";
  }
}

const isLikelyPlan = (text: string): boolean => {
  const value = text.toLowerCase();
  return (
    value.includes("## summary") ||
    value.includes("## key changes") ||
    value.includes("## test plan") ||
    value.includes("# implementation plan") ||
    value.includes("implementation plan")
  );
};

const planTitle = (text: string): string => {
  const heading = text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .find((line) => /^#{1,3}\s+\S/.test(line));
  if (heading !== undefined) return heading.replace(/^#{1,3}\s+/, "");
  return "Implementation Plan";
};

const planPreview = (text: string): string =>
  text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(1, 8)
    .join("\n");
