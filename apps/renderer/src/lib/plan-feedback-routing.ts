import type {
  AgentItemId,
  Message,
  PermissionMode,
  PermissionRequest,
  ProviderId,
  SessionId,
} from "@zuse/contracts";

const EMPTY_PLAN_APPROVAL_MESSAGES: ReadonlyArray<Message> = [];

/**
 * Select the transcript used to locate a native plan interaction.
 *
 * Selectors consumed through `useSyncExternalStore` must return the
 * same snapshot while the store is unchanged. In particular, do not allocate
 * an empty array here while a newly-created session is still loading.
 */
export const selectPlanApprovalMessages = (
  messagesBySession: Readonly<Record<string, ReadonlyArray<Message>>>,
  sessionId: SessionId,
): ReadonlyArray<Message> =>
  messagesBySession[sessionId] ?? EMPTY_PLAN_APPROVAL_MESSAGES;

/**
 * Whether a provider still drives plan mode through the transcript-shape
 * heuristic. Native plan interactions are authoritative for Claude and Grok.
 */
export const providerUsesEmulatedPlanMode = (providerId: ProviderId): boolean =>
  providerId !== "claude" && providerId !== "grok";

export const isPlanApprovalRequest = (
  req: PermissionRequest,
  sessionId: SessionId,
): boolean =>
  req.sessionId === sessionId &&
  req.kind._tag === "Other" &&
  req.kind.tool === "ExitPlanMode";

export const findPendingPlanApprovalRequest = (
  requests: ReadonlyArray<PermissionRequest>,
  sessionId: SessionId,
): PermissionRequest | null => {
  for (const req of requests) {
    if (isPlanApprovalRequest(req, sessionId)) return req;
  }
  return null;
};

export interface PendingNativePlanApproval {
  readonly toolCallId: AgentItemId;
  readonly plan: string | null;
}

/**
 * Locate the newest unresolved plan interaction in the transcript. Callers
 * must prefer a matching permission request when one exists; providers that
 * expose the typed interaction do not create that permission request.
 */
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
    const content = messages[index]?.content;
    if (
      content?._tag !== "tool_use" ||
      content.tool !== "ExitPlanMode" ||
      settledToolCalls.has(content.itemId)
    ) {
      continue;
    }
    const input = content.input;
    const plan =
      input !== null &&
      typeof input === "object" &&
      "plan" in input &&
      typeof input.plan === "string"
        ? input.plan
        : null;
    return { toolCallId: content.itemId, plan };
  }

  return null;
};

export const deliverNativePlanFeedback = async ({
  respond,
  fallbackSend,
}: {
  readonly respond: () => Promise<
    "accepted" | "session-not-found" | "failed"
  >;
  readonly fallbackSend: () => Promise<unknown>;
}): Promise<"responded" | "sent" | "failed"> => {
  const result = await respond();
  if (result === "accepted") return "responded";
  if (result === "failed") return "failed";
  await fallbackSend();
  return "sent";
};

/**
 * True when typed composer text should be treated as feedback on a proposed
 * plan instead of a mid-turn queue item.
 *
 * Claude exposes this as an ExitPlanMode permission request. Providers with
 * emulated plan mode do not have that tool, so use the transcript shape:
 * while the session is still in plan mode, an assistant answer after the last
 * user message means the agent has produced the plan and is waiting for
 * feedback. If the latest turn is still only the user's prompt or a tool call,
 * the agent is still working and normal queueing should apply.
 *
 * The transcript heuristic is gated two ways so the "Review plan" tray can't
 * flicker: it never runs for a native-plan provider (Claude — driven solely by
 * `pendingPlanApprovalRequest`), and it never runs mid-turn (`isRunning`),
 * since the tail message flips assistant↔tool on every streamed chunk.
 */
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
  if (!usesEmulatedPlanMode) return false;
  if (permissionMode !== "plan") return false;
  if (isRunning) return false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined) continue;
    const content = message.content;
    switch (content._tag) {
      case "assistant":
        return content.text.trim().length > 0;
      case "user":
      case "user_rich":
      case "tool_use":
      case "error":
      case "interrupted":
      case "user_question":
        return false;
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
