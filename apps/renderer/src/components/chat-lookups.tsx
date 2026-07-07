import { createContext, useContext } from "react";

import type { AgentItemId, UserQuestionAnswer } from "@zuse/wire";

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
