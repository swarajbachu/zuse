import type { Message, PermissionRequest, SessionId } from "@zuse/wire";

export type ChatAttentionState =
  | "idle"
  | "running"
  | "planReady"
  | "question"
  | "permission";

const priority: Record<ChatAttentionState, number> = {
  idle: 0,
  running: 1,
  planReady: 2,
  question: 3,
  // A blocking permission prompt is the most urgent attention state — the
  // agent is stalled until the user decides.
  permission: 4,
};

const itemIdOf = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

export const mergeChatAttentionStates = (
  states: ReadonlyArray<ChatAttentionState>,
): ChatAttentionState =>
  states.reduce<ChatAttentionState>(
    (best, next) => (priority[next] > priority[best] ? next : best),
    "idle",
  );

export const deriveChatAttentionState = (
  messages: ReadonlyArray<Pick<Message, "content">>,
  running: boolean,
): ChatAttentionState => {
  const answeredQuestions = new Set<string>();
  const completedTools = new Set<string>();

  for (const message of messages) {
    const content = message.content;
    if (content._tag === "user_question_answer") {
      const itemId = itemIdOf(content.itemId);
      if (itemId !== null) answeredQuestions.add(itemId);
    }
    if (content._tag === "tool_result") {
      const itemId = itemIdOf(content.itemId);
      if (itemId !== null) completedTools.add(itemId);
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]!.content;
    if (content._tag !== "user_question") continue;
    const itemId = itemIdOf(content.itemId);
    if (itemId !== null && !answeredQuestions.has(itemId)) return "question";
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]!.content;
    if (content._tag !== "tool_use") continue;
    if (content.tool !== "ExitPlanMode") continue;
    const itemId = itemIdOf(content.itemId);
    if (itemId !== null && !completedTools.has(itemId)) return "planReady";
  }

  return running ? "running" : "idle";
};

/**
 * Attention contributed by *pending permission prompts*. Unlike plan mode —
 * whose `ExitPlanMode` approval rides in as a `tool_use` message and surfaces
 * via `deriveChatAttentionState` ("planReady") — ordinary supervised-mode
 * permission requests never become messages; they live only in the permissions
 * store. Without this the sidebar/tab indicators stay dark while the agent is
 * blocked waiting for a Bash/FileWrite/Network decision.
 *
 * `ExitPlanMode` is deliberately skipped here so plan mode keeps its dedicated
 * "planReady" icon instead of being double-counted as a generic permission.
 */
export const derivePermissionAttention = (
  requests: ReadonlyArray<PermissionRequest>,
  sessionIds: ReadonlySet<SessionId>,
): ChatAttentionState => {
  for (const req of requests) {
    if (!sessionIds.has(req.sessionId)) continue;
    if (req.kind._tag === "Other" && req.kind.tool === "ExitPlanMode") continue;
    return "permission";
  }
  return "idle";
};
