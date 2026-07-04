import type { Message, MessageContent } from "@zuse/wire";
import { Text, View } from "react-native";

import { cn } from "~/lib/cn";

export const MessageRow = ({ message }: { message: Message }) => {
  const content = message.content;
  switch (content._tag) {
    case "user":
      return <UserBubble text={content.text} goal={content.goal} />;
    case "user_rich":
      return <UserBubble text={content.text} chips={richChips(content)} goal={content.goal} />;
    case "assistant":
      return <AssistantBubble text={content.text} />;
    case "thinking":
      return <ThinkingRow content={content} />;
    case "tool_use":
      return <ToolUseRow content={content} />;
    case "tool_result":
      return <ToolResultRow content={content} />;
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

const AssistantBubble = ({ text }: { text: string }) => (
  <View className="items-start px-3 py-1.5">
    <View className="max-w-[92%] rounded-lg border border-border bg-card px-3 py-2">
      <Text className="font-sans text-[15px] leading-5 text-foreground">{text}</Text>
    </View>
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
