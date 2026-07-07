import type { Message, MessageContent, UserQuestion } from "@zuse/wire";
import {
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
  Search,
  Terminal,
  Wrench,
} from "lucide-react-native";
import type React from "react";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { cn } from "~/lib/cn";
import {
  summarizeValue,
  type ToolResultRecord,
} from "~/lib/message-presentation";
import {
  buildToolPresentation,
  type MobileToolIcon,
} from "~/lib/tool-presentation";
import { Markdown } from "./markdown";
import { PendingUserInputCard, type QuestionAnswer } from "./pending-user-input-card";

/** Extra context the stream provides so question rows can render statefully. */
export type MessageRowContext = {
  answeredQuestionIds: ReadonlySet<string>;
  questionsByItemId: ReadonlyMap<string, readonly UserQuestion[]>;
  toolResultsByItemId: ReadonlyMap<string, ToolResultRecord>;
  onAnswerQuestion: (itemId: string, answers: readonly QuestionAnswer[]) => void | Promise<void>;
};

export const MessageRow = ({
  message,
  ctx
}: {
  message: Message;
  ctx: MessageRowContext;
}) => {
  const content = message.content;
  switch (content._tag) {
    case "user":
      return <UserBubble text={content.text} goal={content.goal} />;
    case "user_rich":
      return <UserBubble text={content.text} chips={richChips(content)} goal={content.goal} />;
    case "assistant":
      return <AssistantMarkdown text={content.text} />;
    case "thinking":
      return <ThinkingRow content={content} />;
    case "tool_use":
      return <ToolUseRow content={content} result={ctx.toolResultsByItemId.get(content.itemId)} />;
    case "tool_result":
      return ctx.toolResultsByItemId.has(content.itemId) ? null : <ToolResultRow content={content} />;
    case "error":
      return <ErrorRow message={content.message} />;
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
        <AnswerBubble content={content} questions={ctx.questionsByItemId.get(content.itemId)} />
      );
    default:
      return <FallbackRow content={content} />;
  }
};

const UserBubble = ({
  text,
  goal,
  chips = []
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
        <Text className="mb-1 font-sans-medium text-xs text-primary-foreground/75">Goal</Text>
      ) : null}
      <Text className="font-sans text-[15px] leading-5 text-primary-foreground">{text}</Text>
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

const AssistantMarkdown = ({ text }: { text: string }) => (
  <View className="px-2 py-2">
    <Markdown>{text}</Markdown>
  </View>
);

const ThinkingRow = ({
  content
}: {
  content: Extract<MessageContent, { _tag: "thinking" }>;
}) => (
  <ExpandableEventRow
    icon="thinking"
    title={content.redacted ? "Redacted thinking" : "Thinking"}
    detail={content.redacted ? "Hidden by the model" : firstLine(content.text)}
  >
    <Text className="font-sans text-sm leading-5 text-muted-foreground">
      {content.redacted ? "Thought content was redacted." : content.text}
    </Text>
  </ExpandableEventRow>
);

const ToolUseRow = ({
  content,
  result,
}: {
  content: Extract<MessageContent, { _tag: "tool_use" }>;
  result?: ToolResultRecord;
}) => {
  const view = buildToolPresentation(content, result);

  return (
    <ExpandableEventRow
      icon={view.icon}
      title={view.label}
      detail={view.detail ?? undefined}
      badge={view.resultLabel}
      danger={view.isError}
    >
      {view.editSummaries.length > 0 ? (
        <View className="gap-2">
          {view.editSummaries.map((summary) => (
            <View
              key={summary.path}
              className="rounded-xl border border-border bg-muted/45 px-3 py-2"
              style={{ borderCurve: "continuous" }}
            >
              <View className="flex-row items-center gap-2">
                <FilePenLine size={14} color="hsl(72 98% 54%)" />
                <Text className="min-w-0 flex-1 font-mono text-xs text-foreground" numberOfLines={1}>
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
      ) : (
        <Text className="font-mono text-xs leading-5 text-muted-foreground">
          {view.body}
        </Text>
      )}
      {view.resultBody !== null ? (
        <View className="mt-3 border-t border-border pt-3">
          <Text
            className={cn(
              "mb-1 font-sans-medium text-[11px] uppercase text-muted-foreground",
              view.isError && "text-danger",
            )}
          >
            {view.isError ? "Error" : "Result"}
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
};

const ToolResultRow = ({
  content
}: {
  content: Extract<MessageContent, { _tag: "tool_result" }>;
}) => (
  <ExpandableEventRow
    icon="wrench"
    title={content.isError ? "Tool error" : "Tool result"}
    detail={summarizeValue(content.output, 96)}
    danger={content.isError}
  >
    <Text selectable className="font-mono text-xs leading-5 text-muted-foreground">
      {summarizeValue(content.output)}
    </Text>
  </ExpandableEventRow>
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

const AnsweredQuestion = ({ questions }: { questions: readonly UserQuestion[] }) => (
  <View className="px-2 py-2">
    <View className="rounded-2xl border border-border bg-card px-3 py-3 opacity-70">
      <Text className="font-sans-medium text-xs text-muted-foreground">Question · answered</Text>
      {questions.map((question, qi) => (
        <Text
          key={`answered-${qi}`}
          className={cn(
            "font-sans-medium text-sm text-foreground",
            qi > 0 ? "mt-2" : "mt-1"
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
  questions
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
    return other !== undefined && other.length > 0 ? [...picked, other] : picked;
  });
  const summary = labels.length > 0 ? labels.join(", ") : "Answered";
  return (
    <View className="items-end px-3 py-1.5">
      <View
        style={{ borderCurve: "continuous" }}
        className="max-w-[88%] rounded-2xl bg-primary px-3.5 py-2.5"
      >
        <Text className="mb-1 font-sans-medium text-xs text-primary-foreground/75">Answer</Text>
        <Text className="font-sans text-[15px] leading-5 text-primary-foreground">{summary}</Text>
      </View>
    </View>
  );
};

const FallbackRow = ({ content }: { content: MessageContent }) => (
  <View className="px-2 py-2">
    <View className="rounded-2xl border border-border bg-muted px-3 py-2">
      <Text className="font-sans-medium text-xs text-muted-foreground">{content._tag}</Text>
      <Text className="mt-1 font-mono text-xs leading-5 text-muted-foreground" numberOfLines={4}>
        {summarizeValue(content)}
      </Text>
    </View>
  </View>
);

const richChips = (content: Extract<MessageContent, { _tag: "user_rich" }>) => [
  ...content.attachments.map((attachment) => attachment.originalName),
  ...content.fileRefs.map((file) => file.relPath),
  ...content.skillRefs.map((skill) => skill.name)
];

function ExpandableEventRow({
  title,
  detail,
  badge,
  danger,
  icon,
  children,
}: {
  title: string;
  detail?: string;
  badge?: string;
  danger?: boolean;
  icon: "thinking" | MobileToolIcon;
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
          <Text
            className={cn(
              "min-w-0 flex-1 font-sans-medium text-[13px]",
              danger ? "text-danger" : "text-foreground",
            )}
            numberOfLines={1}
          >
            {title}
          </Text>
          {badge ? (
            <Text
              className={cn(
                "rounded-full px-2 py-0.5 font-sans-medium text-[11px]",
                danger ? "bg-danger/15 text-danger" : "bg-muted text-muted-foreground",
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
  icon: "thinking" | MobileToolIcon,
  color: string,
) => {
  switch (icon) {
    case "thinking":
      return <Brain size={14} color={color} />;
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

const firstLine = (value: string): string => {
  const line = value.trim().split(/\r\n|\r|\n/)[0] ?? "";
  return line.length > 0 ? line : "(empty)";
};
