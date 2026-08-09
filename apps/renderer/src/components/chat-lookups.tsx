import type { AgentItemId, Message, UserQuestionAnswer } from "@zuse/contracts";
import { createContext, useContext } from "react";
import {
	type SubagentReference,
	subagentDisplayName,
} from "~/lib/subagent-metadata";
import type { SubagentWaitResult } from "~/lib/subagent-wait";

export type ToolResultRecord = SubagentWaitResult;

export interface ChatLookups {
	readonly resultsByItemId: ReadonlyMap<AgentItemId, ToolResultRecord>;
	readonly answersByItemId: ReadonlyMap<
		AgentItemId,
		ReadonlyArray<UserQuestionAnswer>
	>;
	readonly subagentsByTaskId: ReadonlyMap<string, SubagentReference>;
}

const EMPTY_RESULTS = new Map<AgentItemId, ToolResultRecord>();
const EMPTY_ANSWERS = new Map<AgentItemId, ReadonlyArray<UserQuestionAnswer>>();
const EMPTY_SUBAGENTS = new Map<string, SubagentReference>();

const ChatLookupsContext = createContext<ChatLookups>({
	resultsByItemId: EMPTY_RESULTS,
	answersByItemId: EMPTY_ANSWERS,
	subagentsByTaskId: EMPTY_SUBAGENTS,
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
	const subagentsByTaskId = new Map<string, SubagentReference>();

	for (const message of messages) {
		if (message.content._tag === "tool_use") {
			seenUseIds.add(message.content.itemId);
			if (
				(message.content.tool === "Agent" || message.content.tool === "Task") &&
				message.content.input !== null &&
				typeof message.content.input === "object"
			) {
				const input = message.content.input as Record<string, unknown>;
				const taskId =
					message.content.subagent?.childSessionId ??
					(typeof input.task_id === "string" ? input.task_id : undefined);
				if (taskId !== undefined) {
					subagentsByTaskId.set(taskId, {
						agentName: subagentDisplayName(input),
					});
				}
			}
		} else if (
			message.content._tag === "tool_result" &&
			seenUseIds.has(message.content.itemId)
		) {
			resultsByItemId.set(message.content.itemId, {
				output: message.content.output,
				isError: message.content.isError,
				completedAt: message.createdAt,
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

	return { resultsByItemId, answersByItemId, subagentsByTaskId };
}
