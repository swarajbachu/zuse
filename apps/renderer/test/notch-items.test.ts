import { describe, expect, it } from "bun:test";

import type {
  Chat,
  Folder,
  Message,
  PermissionRequest,
  Session,
} from "@zuse/wire";

import {
  buildNotchItems,
  noteCompletedSessions,
  NOTCH_COMPLETION_TTL_MS,
} from "../src/lib/notch-items.ts";

const now = 1_000_000;

const folder = {
  id: "project-1",
  name: "Osaka",
  path: "/repo",
} as Folder;

const chat = {
  id: "chat-1",
  projectId: "project-1",
  title: "Implement notch tray",
  archivedAt: null,
  activeSessionId: "session-1",
  lastMessageAt: null,
  lastReadAt: null,
  worktreeId: null,
} as Chat;

const session = (status: Session["status"] = "idle") =>
  ({
    id: "session-1",
    chatId: "chat-1",
    projectId: "project-1",
    title: "Implement notch tray",
    providerId: "codex",
    model: "gpt-5.3-codex",
    status,
    archivedAt: null,
    cursor: null,
    resumeStrategy: "none",
    runtimeMode: "approval-required",
    worktreeId: null,
  }) as Session;

const userQuestion = {
  content: {
    _tag: "user_question",
    itemId: "q1",
    questions: [{ question: "Which behavior?", options: ["A"] }],
  },
} as Message;

const exitPlan = {
  content: {
    _tag: "tool_use",
    itemId: "p1",
    tool: "ExitPlanMode",
    input: { plan: "Do the work" },
  },
} as Message;

const permission = {
  id: "perm-1",
  sessionId: "session-1",
  kind: { _tag: "Bash", command: "bun test" },
  requestedAt: new Date(now),
  forcePrompt: false,
} as PermissionRequest;

const baseInput = {
  folders: [folder],
  chatsByProject: { "project-1": [chat] },
  sessionsByProject: { "project-1": [session()] },
  messagesBySession: {},
  runningBySession: {},
  permissionRequests: [],
  recentCompletions: {},
  now,
};

describe("buildNotchItems", () => {
  it("shows running sessions", () => {
    const items = buildNotchItems({
      ...baseInput,
      sessionsByProject: { "project-1": [session("running")] },
    });

    expect(items).toHaveLength(1);
    expect(items[0]?.state).toBe("running");
  });

  it("prioritizes permission over question and plan states", () => {
    const items = buildNotchItems({
      ...baseInput,
      messagesBySession: { "session-1": [exitPlan, userQuestion] },
      runningBySession: { "session-1": true },
      permissionRequests: [permission],
    });

    expect(items[0]?.state).toBe("permission");
  });

  it("keeps recent completions for the TTL", () => {
    const recentCompletions = noteCompletedSessions(
      { "session-1": true },
      { "session-1": false },
      {},
      now,
    );
    const fresh = buildNotchItems({
      ...baseInput,
      recentCompletions,
      now: now + NOTCH_COMPLETION_TTL_MS - 1,
    });
    const expired = buildNotchItems({
      ...baseInput,
      recentCompletions,
      now: now + NOTCH_COMPLETION_TTL_MS + 1,
    });

    expect(fresh[0]?.state).toBe("completed");
    expect(expired).toHaveLength(0);
  });

  it("shows failed sessions above completed sessions", () => {
    const failed = { ...session("error"), id: "failed-session" } as Session;
    const completed = {
      ...session("idle"),
      id: "completed-session",
    } as Session;
    const items = buildNotchItems({
      ...baseInput,
      sessionsByProject: { "project-1": [completed, failed] },
      recentCompletions: {
        "completed-session": { completedAt: now },
      },
    });

    expect(items.map((item) => item.state)).toEqual(["failed", "completed"]);
  });
});
