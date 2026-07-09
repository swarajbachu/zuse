import type { AgentItemId, Message } from "@zuse/wire";

import { groupMessages } from "./group-messages.ts";

export type ChatTimelineRow =
  | {
      readonly kind: "message";
      readonly id: string;
      readonly message: Message;
      readonly enterUser: boolean;
    }
  | {
      readonly kind: "subagent";
      readonly id: string;
      readonly parent: Message;
      readonly parentItemId: AgentItemId;
      readonly agentName: string;
      readonly prompt: string;
      readonly modelRequested: string | undefined;
      readonly children: ReadonlyArray<Message>;
      readonly summary: {
        readonly text: string;
        readonly turns: number;
        readonly durationMs: number;
        readonly model: string;
        readonly isError: boolean;
      } | null;
    }
  | {
      readonly kind: "turn-summary";
      readonly id: string;
      readonly body: ReadonlyArray<Message>;
    }
  | {
      readonly kind: "working";
      readonly id: string;
      readonly messages: ReadonlyArray<Message>;
    };

export function isUserMessage(message: Message): boolean {
  return (
    message.content._tag === "user" || message.content._tag === "user_rich"
  );
}

export function resolveLatestUserMessageId(
  rows: ReadonlyArray<ChatTimelineRow>,
): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind === "message" && isUserMessage(row.message)) {
      return row.message.id;
    }
  }
  return null;
}

export function rowAnchorMessageId(row: ChatTimelineRow): string | null {
  return row.kind === "message" && isUserMessage(row.message)
    ? row.message.id
    : null;
}

const toolUseKey = (message: Message): string | null =>
  message.content._tag === "tool_use"
    ? `${message.sessionId}:${message.content.itemId}`
    : null;

const inputScore = (input: unknown): number => {
  if (input === null || input === undefined) return 0;
  let score = 1;
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (typeof obj["file_path"] === "string") score += 4;
    if (typeof obj["command"] === "string") score += 4;
    if (typeof obj["old_string"] === "string") score += 3;
    if (typeof obj["new_string"] === "string") score += 3;
  }
  try {
    score += JSON.stringify(input)?.length ?? 0;
  } catch {
    score += String(input).length;
  }
  return score;
};

const preferToolUse = (current: Message, next: Message): Message => {
  if (
    current.content._tag !== "tool_use" ||
    next.content._tag !== "tool_use"
  ) {
    return current;
  }
  return inputScore(next.content.input) > inputScore(current.content.input)
    ? next
    : current;
};

export function normalizeTimelineMessages(
  messages: ReadonlyArray<Message>,
): Message[] {
  const normalized: Message[] = [];
  const toolUseIndexByKey = new Map<string, number>();

  for (const message of messages) {
    const key = toolUseKey(message);
    if (key === null) {
      normalized.push(message);
      continue;
    }

    const existingIndex = toolUseIndexByKey.get(key);
    if (existingIndex === undefined) {
      toolUseIndexByKey.set(key, normalized.length);
      normalized.push(message);
      continue;
    }

    normalized[existingIndex] = preferToolUse(
      normalized[existingIndex]!,
      message,
    );
  }

  return normalized;
}

export function deriveChatTimelineRows({
  messages,
  inFlight,
  awaitingPlanApproval,
}: {
  readonly messages: ReadonlyArray<Message>;
  readonly inFlight: boolean;
  readonly awaitingPlanApproval: boolean;
}): ChatTimelineRow[] {
  const normalizedMessages = normalizeTimelineMessages(messages);
  const turns: Array<{
    user: Message | null;
    body: Message[];
  }> = [];
  let current: { user: Message | null; body: Message[] } | null = null;

  for (const message of normalizedMessages) {
    if (isUserMessage(message)) {
      if (current !== null) turns.push(current);
      current = { user: message, body: [] };
    } else {
      if (current === null) current = { user: null, body: [] };
      current.body.push(message);
    }
  }
  if (current !== null) turns.push(current);

  const rows: ChatTimelineRow[] = [];

  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index]!;
    const isLastTurn = index === turns.length - 1;
    const isLive = inFlight && isLastTurn;

    if (turn.user !== null) {
      rows.push({
        kind: "message",
        id: `message:${turn.user.id}`,
        message: turn.user,
        enterUser: true,
      });
    }

    const hasToolCalls = turn.body.some(
      (message) => message.content._tag === "tool_use",
    );
    const hasFinalText = turn.body.some(
      (message) =>
        message.content._tag === "assistant" &&
        message.content.text.trim().length > 0,
    );
    const showSummary = !isLive && hasToolCalls && hasFinalText;
    const bodyGroups = groupMessages(turn.body);
    const planMessages = turn.body.filter(
      (message) =>
        message.content._tag === "tool_use" &&
        message.content.tool === "ExitPlanMode",
    );
    const planItemIds = new Set(
      planMessages.flatMap((message) =>
        message.content._tag === "tool_use" ? [message.content.itemId] : [],
      ),
    );
    const summaryBody =
      planMessages.length === 0
        ? turn.body
        : turn.body.filter((message) => {
            if (
              message.content._tag === "tool_use" &&
              message.content.tool === "ExitPlanMode"
            ) {
              return false;
            }
            if (
              message.content._tag === "tool_result" &&
              planItemIds.has(message.content.itemId)
            ) {
              return false;
            }
            return true;
          });

    if (showSummary) {
      for (const message of planMessages) {
        rows.push({
          kind: "message",
          id: `message:${message.id}`,
          message,
          enterUser: false,
        });
      }
      rows.push({
        kind: "turn-summary",
        id: `summary:${turn.user?.id ?? `turn-${index}`}`,
        body: summaryBody,
      });
      continue;
    }

    for (const group of bodyGroups) {
      if (group.kind === "single") {
        rows.push({
          kind: "message",
          id: `message:${group.message.id}`,
          message: group.message,
          enterUser: false,
        });
      } else {
        rows.push({
          kind: "subagent",
          id: `subagent:${group.parent.id}`,
          parent: group.parent,
          parentItemId: group.parentItemId,
          agentName: group.agentName,
          prompt: group.prompt,
          modelRequested: group.modelRequested,
          children: group.children,
          summary: group.summary,
        });
      }
    }
  }

  if (inFlight && !awaitingPlanApproval) {
    rows.push({
      kind: "working",
      id: "working",
      messages,
    });
  }

  return rows;
}
