import type { Message } from "@zuse/contracts";

export const sanitizeMessages = (
  messages: readonly Message[],
): readonly Message[] => messages.filter(isRenderableMessage);

export const messageKey = (message: Message, index: number): string =>
  typeof message.id === "string" && message.id.length > 0
    ? message.id
    : `message-${index}`;

const isRenderableMessage = (value: unknown): value is Message => {
  if (!isRecord(value) || !isNonEmptyString(value.id)) {
    return false;
  }
  const content = value.content;
  if (!isRecord(content) || typeof content._tag !== "string") {
    return false;
  }

  switch (content._tag) {
    case "user":
    case "assistant":
      return typeof content.text === "string";
    case "user_rich":
      return (
        typeof content.text === "string" &&
        Array.isArray(content.attachments) &&
        Array.isArray(content.fileRefs) &&
        Array.isArray(content.skillRefs)
      );
    case "thinking":
      return typeof content.text === "string" && typeof content.redacted === "boolean";
    case "tool_use":
      return isNonEmptyString(content.itemId) && typeof content.tool === "string";
    case "tool_result":
      return isNonEmptyString(content.itemId) && typeof content.isError === "boolean";
    case "error":
      return typeof content.message === "string";
    case "interrupted":
      return true;
    case "subagent_summary":
      return (
        isNonEmptyString(content.itemId) &&
        typeof content.agentName === "string" &&
        typeof content.model === "string" &&
        typeof content.turns === "number" &&
        typeof content.durationMs === "number" &&
        typeof content.summary === "string" &&
        typeof content.isError === "boolean"
      );
    case "usage":
      return (
        typeof content.inputTokens === "number" &&
        typeof content.outputTokens === "number" &&
        typeof content.cacheReadTokens === "number" &&
        typeof content.cacheCreationTokens === "number" &&
        typeof content.model === "string"
      );
    case "context_usage":
      return typeof content.providerId === "string";
    case "context_compaction":
      return (
        isNonEmptyString(content.itemId) &&
        typeof content.providerId === "string" &&
        typeof content.startedAt === "number" &&
        typeof content.durationMs === "number"
      );
    case "usage_limit":
      return typeof content.providerId === "string" && typeof content.label === "string";
    case "user_question":
      return isNonEmptyString(content.itemId) && Array.isArray(content.questions);
    case "user_question_answer":
      return isNonEmptyString(content.itemId) && Array.isArray(content.answers);
    default:
      return false;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
