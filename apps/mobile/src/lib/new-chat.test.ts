import { describe, expect, test } from "bun:test";

import { buildNewChatCreatePayload, MAIN_SOURCE } from "./new-chat";

describe("new chat helper", () => {
  test("does not create without prompt or project", () => {
    const base = {
      connectionKey: "env-1",
      projectId: "project-1" as never,
      providerId: "codex" as const,
      model: "gpt-5-codex",
      runtimeMode: "approval-required" as const,
      permissionMode: "default" as const,
      source: MAIN_SOURCE,
    };

    expect(buildNewChatCreatePayload({ ...base, text: "   " })).toBeNull();
    expect(
      buildNewChatCreatePayload({ ...base, projectId: null, text: "hello" }),
    ).toBeNull();
  });

  test("builds payload from selected options", () => {
    const payload = buildNewChatCreatePayload({
      connectionKey: "env-1",
      projectId: "project-1" as never,
      providerId: "claude",
      model: "claude-sonnet-5",
      runtimeMode: "full-access",
      permissionMode: "plan",
      source: {
        kind: "branch",
        label: "feature",
        worktreeId: null,
        createSource: { _tag: "branch", branch: "feature", remote: "origin" },
      },
      text: "  build it  ",
    });

    expect(payload).toMatchObject({
      projectId: "project-1",
      providerId: "claude",
      model: "claude-sonnet-5",
      runtimeMode: "full-access",
      permissionMode: "plan",
      initialPrompt: "build it",
      createSource: { _tag: "branch", branch: "feature", remote: "origin" },
    });
  });
});
