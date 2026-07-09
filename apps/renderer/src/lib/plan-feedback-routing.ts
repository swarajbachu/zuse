import type {
  Message,
  PermissionMode,
  PermissionRequest,
  ProviderId,
  SessionId,
} from "@zuse/wire";

/**
 * Whether a provider drives plan mode through the transcript-shape heuristic
 * rather than a native `ExitPlanMode` permission request. Claude is the only
 * provider whose driver emits a real `ExitPlanMode` permission; every other
 * provider (Codex / Grok / Gemini / Cursor / opencode) surfaces plan completion
 * as assistant text (Codex via native collaborationMode + `<proposed_plan>`,
 * Grok/Gemini via a developer-instructions prefix), so we infer "plan is
 * ready" from the transcript instead.
 */
export const providerUsesEmulatedPlanMode = (providerId: ProviderId): boolean =>
  providerId !== "claude";

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
  if (goalSendMode) return "goal";
  if (shouldQueue) return "queue";
  return "send";
};
