import type { Message, MessageContent, UserQuestion } from "@zuse/wire";
import { Text, View } from "react-native";

import { cn } from "~/lib/cn";
import { Markdown } from "./markdown";
import { PendingUserInputCard, type QuestionAnswer } from "./pending-user-input-card";

/** Extra context the stream provides so question rows can render statefully. */
export type MessageRowContext = {
  answeredQuestionIds: ReadonlySet<string>;
  questionsByItemId: ReadonlyMap<string, readonly UserQuestion[]>;
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
      return <ToolUseRow content={content} />;
    case "tool_result":
      return <ToolResultRow content={content} />;
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
  <View className="items-end px-3 py-1.5">
    <View className="max-w-[88%] rounded-lg bg-primary px-3 py-2">
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
  <View className="px-3 py-1.5">
    <Markdown>{text}</Markdown>
  </View>
);

const ThinkingRow = ({
  content
}: {
  content: Extract<MessageContent, { _tag: "thinking" }>;
}) => (
  <View className="px-3 py-1.5">
    <View className="rounded-lg border border-border bg-muted px-3 py-2">
      <Text className="font-sans-medium text-xs text-muted-foreground">
        {content.redacted ? "Redacted thinking" : "Thinking"}
      </Text>
      {!content.redacted ? (
        <Text className="mt-1 font-sans text-sm leading-5 text-muted-foreground">
          {content.text}
        </Text>
      ) : null}
    </View>
  </View>
);

const ToolUseRow = ({
  content
}: {
  content: Extract<MessageContent, { _tag: "tool_use" }>;
}) => (
  <View className="px-3 py-1.5">
    <View className="rounded-lg border border-border bg-card px-3 py-2">
      <Text className="font-sans-medium text-xs text-primary">{content.tool}</Text>
      <Text className="mt-1 font-mono text-xs leading-5 text-muted-foreground" numberOfLines={6}>
        {preview(content.input)}
      </Text>
    </View>
  </View>
);

const ToolResultRow = ({
  content
}: {
  content: Extract<MessageContent, { _tag: "tool_result" }>;
}) => (
  <View className="px-3 py-1.5">
    <View
      className={cn(
        "rounded-lg border px-3 py-2",
        content.isError ? "border-danger bg-danger/10" : "border-border bg-card"
      )}
    >
      <Text
        className={cn(
          "font-sans-medium text-xs",
          content.isError ? "text-danger" : "text-muted-foreground"
        )}
      >
        Tool result
      </Text>
      <Text className="mt-1 font-mono text-xs leading-5 text-muted-foreground" numberOfLines={8}>
        {preview(content.output)}
      </Text>
    </View>
  </View>
);

const ErrorRow = ({ message }: { message: string }) => (
  <View className="px-3 py-1.5">
    <View className="rounded-lg border border-danger bg-danger/10 px-3 py-2">
      <Text className="font-sans-medium text-xs text-danger">Error</Text>
      <Text selectable className="mt-1 font-sans text-sm leading-5 text-danger">
        {message}
      </Text>
    </View>
  </View>
);

const AnsweredQuestion = ({ questions }: { questions: readonly UserQuestion[] }) => (
  <View className="px-3 py-1.5">
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
      <View className="max-w-[88%] rounded-lg bg-primary px-3 py-2">
        <Text className="mb-1 font-sans-medium text-xs text-primary-foreground/75">Answer</Text>
        <Text className="font-sans text-[15px] leading-5 text-primary-foreground">{summary}</Text>
      </View>
    </View>
  );
};

const FallbackRow = ({ content }: { content: MessageContent }) => (
  <View className="px-3 py-1.5">
    <View className="rounded-lg border border-border bg-muted px-3 py-2">
      <Text className="font-sans-medium text-xs text-muted-foreground">{content._tag}</Text>
      <Text className="mt-1 font-mono text-xs leading-5 text-muted-foreground" numberOfLines={4}>
        {preview(content)}
      </Text>
    </View>
  </View>
);

const richChips = (content: Extract<MessageContent, { _tag: "user_rich" }>) => [
  ...content.attachments.map((attachment) => attachment.originalName),
  ...content.fileRefs.map((file) => file.relPath),
  ...content.skillRefs.map((skill) => skill.name)
];

const preview = (value: unknown) => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};
