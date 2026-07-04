import type {
  Message,
  PermissionMode,
  PermissionRequest,
  SessionId,
} from "@zuse/wire";

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
 */
export const shouldSendPlanFeedbackNow = ({
  permissionMode,
  messages,
  pendingPlanApprovalRequest,
}: {
  readonly permissionMode: PermissionMode;
  readonly messages: ReadonlyArray<Pick<Message, "content">>;
  readonly pendingPlanApprovalRequest: PermissionRequest | null;
}): boolean => {
  if (pendingPlanApprovalRequest !== null) return true;
  if (permissionMode !== "plan") return false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]!.content;
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
}: {
  readonly permissionMode: PermissionMode;
  readonly messages: ReadonlyArray<Pick<Message, "content">>;
  readonly pendingPlanApprovalRequest: PermissionRequest | null;
}): boolean =>
  pendingPlanApprovalRequest === null &&
  shouldSendPlanFeedbackNow({
    permissionMode,
    messages,
    pendingPlanApprovalRequest,
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
  if (goalSendMode) return "goal";
  if (shouldQueue) return "queue";
  return "send";
};
