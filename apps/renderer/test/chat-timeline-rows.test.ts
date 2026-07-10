import { describe, expect, it } from "vitest";

import type { Message, SessionId } from "@zuse/contracts";

import {
  deriveChatTimelineRows,
  normalizeTimelineMessages,
  resolveLatestUserMessageId,
  rowAnchorMessageId,
} from "../src/lib/chat-timeline-rows.ts";

const sessionId = "session-timeline" as SessionId;

function message(
  id: string,
  content: Message["content"],
  createdAt = new Date("2026-07-06T00:00:00.000Z"),
): Message {
  return {
    id,
    sessionId,
    role:
      content._tag === "user" || content._tag === "user_rich"
        ? "user"
        : "assistant",
    content,
    createdAt,
  } as Message;
}

describe("chat timeline rows", () => {
  it("returns no anchor for an empty timeline", () => {
    expect(resolveLatestUserMessageId([])).toBe(null);
  });

  it("resolves the latest user message anchor", () => {
    const rows = deriveChatTimelineRows({
      messages: [
        message("u1", { _tag: "user", text: "first", goal: null }),
        message("a1", { _tag: "assistant", text: "reply" }),
        message("u2", { _tag: "user", text: "second", goal: null }),
      ],
      inFlight: true,
      awaitingPlanApproval: false,
    });

    expect(resolveLatestUserMessageId(rows)).toBe("u2");
    expect(rows.map((row) => rowAnchorMessageId(row))).toContain("u2");
  });

  it("resolves the first optimistic user message as the new-chat anchor", () => {
    const rows = deriveChatTimelineRows({
      messages: [
        message("u1", { _tag: "user", text: "first prompt", goal: null }),
      ],
      inFlight: true,
      awaitingPlanApproval: false,
    });

    expect(resolveLatestUserMessageId(rows)).toBe("u1");
    expect(rowAnchorMessageId(rows[0]!)).toBe("u1");
  });

  it("moves the anchor when a later user message appears before assistant output", () => {
    const first = deriveChatTimelineRows({
      messages: [
        message("u1", { _tag: "user", text: "first prompt", goal: null }),
        message("a1", { _tag: "assistant", text: "first reply" }),
      ],
      inFlight: false,
      awaitingPlanApproval: false,
    });
    const second = deriveChatTimelineRows({
      messages: [
        message("u1", { _tag: "user", text: "first prompt", goal: null }),
        message("a1", { _tag: "assistant", text: "first reply" }),
        message("u2", { _tag: "user", text: "second prompt", goal: null }),
      ],
      inFlight: true,
      awaitingPlanApproval: false,
    });

    expect(resolveLatestUserMessageId(first)).toBe("u1");
    expect(resolveLatestUserMessageId(second)).toBe("u2");
    expect(second.map((row) => rowAnchorMessageId(row))).toContain("u2");
  });

  it("preserves stable row ids for unchanged messages", () => {
    const messages = [
      message("u1", { _tag: "user", text: "first", goal: null }),
      message("a1", { _tag: "assistant", text: "reply" }),
    ];
    const first = deriveChatTimelineRows({
      messages,
      inFlight: false,
      awaitingPlanApproval: false,
    });
    const second = deriveChatTimelineRows({
      messages,
      inFlight: false,
      awaitingPlanApproval: false,
    });

    expect(second.map((row) => row.id)).toEqual(first.map((row) => row.id));
  });

  it("collapses duplicate tool_use rows with the same provider item id", () => {
    const messages = [
      message("u1", { _tag: "user", text: "inspect", goal: null }),
      message("t1", {
        _tag: "tool_use",
        itemId: "call-1" as never,
        tool: "Read",
        input: { target_file: "/repo/a.ts" },
      }),
      message("t2", {
        _tag: "tool_use",
        itemId: "call-1" as never,
        tool: "Read",
        input: { file_path: "/repo/a.ts", limit: 80 },
      }),
      message("r1", {
        _tag: "tool_result",
        itemId: "call-1" as never,
        output: "body",
        isError: false,
      }),
      message("a1", { _tag: "assistant", text: "done" }),
    ];

    const normalized = normalizeTimelineMessages(messages);
    expect(
      normalized.filter((m) => m.content._tag === "tool_use"),
    ).toHaveLength(1);
    expect(
      normalized.find((m) => m.content._tag === "tool_use")?.content,
    ).toMatchObject({
      _tag: "tool_use",
      input: { file_path: "/repo/a.ts", limit: 80 },
    });

    const rows = deriveChatTimelineRows({
      messages,
      inFlight: false,
      awaitingPlanApproval: false,
    });
    const summary = rows.find((row) => row.kind === "turn-summary");
    expect(summary?.kind).toBe("turn-summary");
    expect(
      summary?.kind === "turn-summary"
        ? summary.body.filter((m) => m.content._tag === "tool_use")
        : [],
    ).toHaveLength(1);
  });
});
