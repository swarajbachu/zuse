import {
	type Chat,
	EnvironmentId,
	type Session,
	type SessionId,
} from "@zuse/contracts";
import { useMemo } from "react";
import {
	type ChatAttentionState,
	deriveChatAttentionState,
	derivePermissionAttention,
	mergeChatAttentionStates,
} from "./chat-attention-state.ts";
import { useActiveEnvironmentEntities } from "./environment-entity-hooks.ts";
import { useEnvironmentPermissions } from "./environment-permissions-client-bus.ts";
import { useEnvironmentQuestionAttachments } from "./environment-question-attachments-client-bus.ts";
import { filterActionableQuestionInteractions } from "./question-actionability.ts";
import { isSessionRuntimeBusy } from "./session-runtime-state.ts";
import { useRendererSessionTimelines } from "./session-timeline-hooks.ts";

export type ChatAttention = {
	readonly chatSessions: ReadonlyArray<Session>;
	readonly sessionIds: ReadonlyArray<SessionId>;
	readonly attentionState: ChatAttentionState;
	readonly permissionAttention: ChatAttentionState;
};

/**
 * Live attention for one chat in the active environment, merged across every
 * non-archived session (tab): running agents, open questions, unfinished
 * plans, and pending permission prompts. A pending chat creation counts as
 * running so the row lights up before the first session exists.
 */
export function useChatAttention(
	chat: Chat,
	environmentId: string,
	creationPending: boolean,
): ChatAttention {
	const { sessionsByProject } = useActiveEnvironmentEntities();
	const chatSessions = useMemo(
		() =>
			(sessionsByProject[chat.projectId] ?? []).filter(
				(row) => row.chatId === chat.id && row.archivedAt === null,
			),
		[sessionsByProject, chat.projectId, chat.id],
	);
	const sessionIds = useMemo(
		() => chatSessions.map((session) => session.id),
		[chatSessions],
	);
	const timelineRefs = useMemo(
		() =>
			sessionIds.map((sessionId) => ({
				environmentId: EnvironmentId.make(environmentId),
				sessionId,
			})),
		[environmentId, sessionIds],
	);
	const timelines = useRendererSessionTimelines(timelineRefs, "cache-only");
	const questionAttachmentsByKey =
		useEnvironmentQuestionAttachments(EnvironmentId.make(environmentId)).data
			?.attachmentsByKey ?? {};
	const runningAttention = useMemo(
		() =>
			mergeChatAttentionStates(
				timelines.map((timeline) =>
					isSessionRuntimeBusy(timeline.runtime) ? "running" : "idle",
				),
			),
		[timelines],
	);
	const messageAttention = useMemo(
		() =>
			mergeChatAttentionStates(
				timelines.map((timeline) =>
					deriveChatAttentionState(
						timeline.messages,
						false,
						filterActionableQuestionInteractions(
							timeline.ref.sessionId,
							timeline.presentation.interactions.map(
								(item) => item.interaction,
							),
							questionAttachmentsByKey,
						),
					),
				),
			),
		[timelines, questionAttachmentsByKey],
	);
	const sessionIdSet = useMemo(() => new Set(sessionIds), [sessionIds]);
	// Supervised-mode permission prompts live only in the permissions store —
	// they never arrive as messages, so they'd otherwise leave the row dark.
	const permissionRequests =
		useEnvironmentPermissions().data?.requestsById ?? {};
	const permissionAttention = derivePermissionAttention(
		Object.values(permissionRequests),
		sessionIdSet,
	);
	const attentionState = mergeChatAttentionStates([
		creationPending ? "running" : "idle",
		runningAttention,
		messageAttention,
		permissionAttention,
	]);
	return { chatSessions, sessionIds, attentionState, permissionAttention };
}
