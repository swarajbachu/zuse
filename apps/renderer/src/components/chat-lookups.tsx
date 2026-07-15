import type { AgentItemId, Message, UserQuestionAnswer } from "@zuse/contracts";
import { createContext, useContext } from "react";

export interface ToolResultRecord {
  readonly output: unknown;
  readonly isError: boolean;
}

export interface ChatLookups {
  readonly resultsByItemId: ReadonlyMap<AgentItemId, ToolResultRecord>;
  readonly answersByItemId: ReadonlyMap<
    AgentItemId,
    ReadonlyArray<UserQuestionAnswer>
  >;
}

const EMPTY_RESULTS = new Map<AgentItemId, ToolResultRecord>();
const EMPTY_ANSWERS = new Map<AgentItemId, ReadonlyArray<UserQuestionAnswer>>();

const ChatLookupsContext = createContext<ChatLookups>({
  resultsByItemId: EMPTY_RESULTS,
  answersByItemId: EMPTY_ANSWERS,
});

export function ChatLookupsProvider({
  value,
  children,
}: {
  readonly value: ChatLookups;
  readonly children: React.ReactNode;
}) {
  return (
    <ChatLookupsContext.Provider value={value}>
      {children}
    </ChatLookupsContext.Provider>
  );
}

export const useChatLookups = () => useContext(ChatLookupsContext);

export function deriveChatLookups(
  messages: ReadonlyArray<Message>,
): ChatLookups {
  const seenUseIds = new Set<AgentItemId>();
  const resultsByItemId = new Map<AgentItemId, ToolResultRecord>();
  const seenQuestionIds = new Set<AgentItemId>();
  const answersByItemId = new Map<
    AgentItemId,
    ReadonlyArray<UserQuestionAnswer>
  >();

  for (const message of messages) {
    if (message.content._tag === "tool_use") {
      seenUseIds.add(message.content.itemId);
    } else if (
      message.content._tag === "tool_result" &&
      seenUseIds.has(message.content.itemId)
    ) {
      resultsByItemId.set(message.content.itemId, {
        output: message.content.output,
        isError: message.content.isError,
      });
    } else if (message.content._tag === "user_question") {
      seenQuestionIds.add(message.content.itemId);
    } else if (
      message.content._tag === "user_question_answer" &&
      seenQuestionIds.has(message.content.itemId)
    ) {
      answersByItemId.set(message.content.itemId, message.content.answers);
    }
  }

  return { resultsByItemId, answersByItemId };
}
