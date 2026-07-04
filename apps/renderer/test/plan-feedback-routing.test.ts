import { describe, expect, it } from "bun:test";

import {
  PermissionRequest,
  type Message,
  type SessionId,
} from "@zuse/wire";

import {
  chooseComposerSubmitRoute,
  findPendingPlanApprovalRequest,
  hasEmulatedPlanAwaitingAction,
  shouldSendPlanFeedbackNow,
} from "../src/lib/plan-feedback-routing.ts";

type TestMessage = Pick<Message, "content">;

const sessionId = "session-plan" as SessionId;

const user = (text = "make a plan"): TestMessage => ({
  content: { _tag: "user", text },
});

const assistant = (
  text = "<proposed_plan>\nDo it\n</proposed_plan>",
): TestMessage => ({
  content: { _tag: "assistant", text },
});

const toolUse = (tool = "Read"): TestMessage => ({
  content: {
    _tag: "tool_use",
    itemId: "tool_1" as never,
    tool,
    input: {},
  },
});

const exitPlanRequest = PermissionRequest.make({
  id: "perm_plan",
  sessionId,
  kind: {
    _tag: "Other",
    tool: "ExitPlanMode",
    summary: "Approve plan",
  },
  requestedAt: new Date("2026-06-28T00:00:00.000Z"),
  forcePrompt: true,
});

describe("plan feedback routing", () => {
  it("detects a pending ExitPlanMode approval request", () => {
    expect(findPendingPlanApprovalRequest([exitPlanRequest], sessionId)).toBe(
      exitPlanRequest,
    );
  });

  it("routes Claude-style pending plan approval feedback to send now", () => {
    expect(
      shouldSendPlanFeedbackNow({
        permissionMode: "plan",
        messages: [user(), toolUse("ExitPlanMode")],
        pendingPlanApprovalRequest: exitPlanRequest,
      }),
    ).toBe(true);
  });

  it("routes emulated provider plan feedback to send now after an assistant plan", () => {
    expect(
      shouldSendPlanFeedbackNow({
        permissionMode: "plan",
        messages: [user(), assistant()],
        pendingPlanApprovalRequest: null,
      }),
    ).toBe(true);
  });

  it("marks emulated provider plans as awaiting an explicit action", () => {
    expect(
      hasEmulatedPlanAwaitingAction({
        permissionMode: "plan",
        messages: [user(), assistant()],
        pendingPlanApprovalRequest: null,
      }),
    ).toBe(true);
  });

  it("does not use the emulated approval state for native plan permission requests", () => {
    expect(
      hasEmulatedPlanAwaitingAction({
        permissionMode: "plan",
        messages: [user(), toolUse("ExitPlanMode")],
        pendingPlanApprovalRequest: exitPlanRequest,
      }),
    ).toBe(false);
  });

  it("keeps normal running turns on the queue path before an assistant response", () => {
    expect(
      shouldSendPlanFeedbackNow({
        permissionMode: "default",
        messages: [user()],
        pendingPlanApprovalRequest: null,
      }),
    ).toBe(false);
    expect(
      shouldSendPlanFeedbackNow({
        permissionMode: "plan",
        messages: [user()],
        pendingPlanApprovalRequest: null,
      }),
    ).toBe(false);
  });

  it("keeps setup or active tool work on the queue path", () => {
    expect(
      shouldSendPlanFeedbackNow({
        permissionMode: "plan",
        messages: [user(), toolUse("Read")],
        pendingPlanApprovalRequest: null,
      }),
    ).toBe(false);
  });

  it("routes plan feedback before goal mode or queueing", () => {
    expect(
      chooseComposerSubmitRoute({
        sendPlanFeedbackNow: true,
        goalSendMode: true,
        shouldQueue: true,
      }),
    ).toBe("planFeedback");
  });

  it("preserves normal goal, queue, and send routing otherwise", () => {
    expect(
      chooseComposerSubmitRoute({
        sendPlanFeedbackNow: false,
        goalSendMode: true,
        shouldQueue: true,
      }),
    ).toBe("goal");
    expect(
      chooseComposerSubmitRoute({
        sendPlanFeedbackNow: false,
        goalSendMode: false,
        shouldQueue: true,
      }),
    ).toBe("queue");
    expect(
      chooseComposerSubmitRoute({
        sendPlanFeedbackNow: false,
        goalSendMode: false,
        shouldQueue: false,
      }),
    ).toBe("send");
  });
});
