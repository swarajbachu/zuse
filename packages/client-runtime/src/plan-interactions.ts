import type {
	AgentItemId,
	Message,
	PermissionMode,
	PermissionRequest,
	ProviderId,
	SessionId,
} from "@zuse/contracts";
import { proposedPlanMarkdownFromContent } from "@zuse/utils/proposed-plan";

const EMPTY_PLAN_MESSAGES: ReadonlyArray<Message> = [];

export const selectPlanApprovalMessages = (
	messagesBySession: Readonly<Record<string, ReadonlyArray<Message>>>,
	sessionId: SessionId,
): ReadonlyArray<Message> =>
	messagesBySession[sessionId] ?? EMPTY_PLAN_MESSAGES;

/** Providers that expose a native blocking plan interaction. */
export const providerUsesEmulatedPlanMode = (providerId: ProviderId): boolean =>
	providerId !== "claude" && providerId !== "grok";

export const isPlanApprovalRequest = (
	request: PermissionRequest,
	sessionId: SessionId,
): boolean =>
	request.sessionId === sessionId &&
	request.kind._tag === "Other" &&
	request.kind.tool === "ExitPlanMode";

export const findPendingPlanApprovalRequest = (
	requests: ReadonlyArray<PermissionRequest>,
	sessionId: SessionId,
): PermissionRequest | null => {
	let newest: PermissionRequest | null = null;
	for (const request of requests) {
		if (!isPlanApprovalRequest(request, sessionId)) continue;
		if (newest === null || request.requestedAt > newest.requestedAt)
			newest = request;
	}
	return newest;
};

export interface PendingNativePlanApproval {
	readonly toolCallId: AgentItemId;
	readonly messageId: string;
	readonly plan: string | null;
}

/** Find the newest unresolved native ExitPlanMode interaction. */
export const findPendingNativePlanApproval = (
	messages: ReadonlyArray<Message>,
): PendingNativePlanApproval | null => {
	const settledToolCalls = new Set<string>();
	for (const message of messages) {
		if (message.content._tag === "tool_result") {
			settledToolCalls.add(message.content.itemId);
		}
	}

	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		const content = message?.content;
		if (content?._tag === "user" || content?._tag === "user_rich") return null;
		if (
			message === undefined ||
			content?._tag !== "tool_use" ||
			content.tool !== "ExitPlanMode" ||
			settledToolCalls.has(content.itemId)
		) {
			continue;
		}
		return {
			toolCallId: content.itemId,
			messageId: message.id,
			plan: proposedPlanMarkdownFromContent(content),
		};
	}

	return null;
};

export interface PendingEmulatedPlanApproval {
	readonly messageId: string;
	readonly plan: string;
}

/**
 * Find the plan at the current transcript edge for providers without a native
 * plan interaction. Only explicit plan metadata or a complete proposed-plan
 * block is accepted, and it must be the final item after the latest user
 * message while the session is idle and still in plan mode.
 */
export const findPendingEmulatedPlanApproval = ({
	messages,
	permissionMode,
	providerId,
	isRunning,
}: {
	readonly messages: ReadonlyArray<Message>;
	readonly permissionMode: PermissionMode;
	readonly providerId: ProviderId;
	readonly isRunning: boolean;
}): PendingEmulatedPlanApproval | null => {
	if (
		permissionMode !== "plan" ||
		isRunning ||
		!providerUsesEmulatedPlanMode(providerId)
	) {
		return null;
	}

	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message === undefined) continue;
		const content = message.content;
		switch (content._tag) {
			case "assistant": {
				const plan = proposedPlanMarkdownFromContent(content);
				return plan === null ? null : { messageId: message.id, plan };
			}
			case "user":
			case "user_rich":
			case "tool_use":
			case "error":
			case "interrupted":
			case "user_question":
				return null;
			case "tool_result":
			case "thinking":
			case "subagent_summary":
			case "usage":
			case "context_usage":
			case "context_compaction":
			case "usage_limit":
			case "user_question_answer":
				continue;
		}
	}

	return null;
};

export type PendingPlanInteraction =
	| {
			readonly kind: "permission";
			readonly request: PermissionRequest;
			readonly native: PendingNativePlanApproval | null;
			readonly plan: string | null;
			readonly sourceMessageId: string | null;
	  }
	| {
			readonly kind: "native";
			readonly native: PendingNativePlanApproval;
			readonly plan: string | null;
			readonly sourceMessageId: string;
	  }
	| {
			readonly kind: "emulated";
			readonly emulated: PendingEmulatedPlanApproval;
			readonly plan: string;
			readonly sourceMessageId: string;
	  };

/** Resolve one authoritative pending plan interaction for a session. */
export const findPendingPlanInteraction = ({
	messages,
	requests,
	sessionId,
	providerId,
	permissionMode,
	isRunning,
}: {
	readonly messages: ReadonlyArray<Message>;
	readonly requests: ReadonlyArray<PermissionRequest>;
	readonly sessionId: SessionId;
	readonly providerId: ProviderId;
	readonly permissionMode: PermissionMode;
	readonly isRunning: boolean;
}): PendingPlanInteraction | null => {
	const request = findPendingPlanApprovalRequest(requests, sessionId);
	const native = findPendingNativePlanApproval(messages);
	if (request !== null) {
		return {
			kind: "permission",
			request,
			native,
			plan: native?.plan ?? null,
			sourceMessageId: native?.messageId ?? null,
		};
	}
	if (native !== null) {
		return {
			kind: "native",
			native,
			plan: native.plan,
			sourceMessageId: native.messageId,
		};
	}
	const emulated = findPendingEmulatedPlanApproval({
		messages,
		permissionMode,
		providerId,
		isRunning,
	});
	return emulated === null
		? null
		: {
				kind: "emulated",
				emulated,
				plan: emulated.plan,
				sourceMessageId: emulated.messageId,
			};
};

export const deliverNativePlanFeedback = async ({
	respond,
	fallbackSend,
}: {
	readonly respond: () => Promise<"accepted" | "session-not-found" | "failed">;
	readonly fallbackSend: () => Promise<unknown>;
}): Promise<"responded" | "sent" | "failed"> => {
	const result = await respond();
	if (result === "accepted") return "responded";
	if (result === "failed") return "failed";
	await fallbackSend();
	return "sent";
};

export const shouldSendPlanFeedbackNow = ({
	permissionMode,
	messages,
	pendingPlanApprovalRequest,
	usesEmulatedPlanMode,
	isRunning,
}: {
	readonly permissionMode: PermissionMode;
	readonly messages: ReadonlyArray<Pick<Message, "content">>;
	readonly pendingPlanApprovalRequest: PermissionRequest | null;
	readonly usesEmulatedPlanMode: boolean;
	readonly isRunning: boolean;
}): boolean => {
	if (pendingPlanApprovalRequest !== null) return true;
	if (!usesEmulatedPlanMode || permissionMode !== "plan" || isRunning) {
		return false;
	}

	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const content = messages[index]?.content;
		if (content === undefined) continue;
		switch (content._tag) {
			case "assistant":
				return proposedPlanMarkdownFromContent(content) !== null;
			case "user":
			case "user_rich":
			case "tool_use":
			case "error":
			case "interrupted":
			case "user_question":
				return false;
			default:
				continue;
		}
	}
	return false;
};

export const hasEmulatedPlanAwaitingAction = ({
	permissionMode,
	messages,
	pendingPlanApprovalRequest,
	usesEmulatedPlanMode,
	isRunning,
}: {
	readonly permissionMode: PermissionMode;
	readonly messages: ReadonlyArray<Pick<Message, "content">>;
	readonly pendingPlanApprovalRequest: PermissionRequest | null;
	readonly usesEmulatedPlanMode: boolean;
	readonly isRunning: boolean;
}): boolean =>
	pendingPlanApprovalRequest === null &&
	shouldSendPlanFeedbackNow({
		permissionMode,
		messages,
		pendingPlanApprovalRequest,
		usesEmulatedPlanMode,
		isRunning,
	});

export type ComposerSubmitRoute = "planFeedback" | "goal" | "queue" | "send";

export const chooseComposerSubmitRoute = ({
	sendPlanFeedbackNow,
	goalSendMode,
	shouldQueue,
}: {
	readonly sendPlanFeedbackNow: boolean;
	readonly goalSendMode: boolean;
	readonly shouldQueue: boolean;
}): ComposerSubmitRoute => {
	if (sendPlanFeedbackNow) return "planFeedback";
	if (shouldQueue) return "queue";
	if (goalSendMode) return "goal";
	return "send";
};
