import type { Message, SessionId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
  classifyToolActivity,
  countTurnProgressMessages,
  summarizeToolActivity,
} from "../src/lib/tool-activity";

const sessionId = "tool-summary" as SessionId;
const use = (id: string, tool: string): Message =>
  ({
    id,
    sessionId,
    role: "assistant",
    content: { _tag: "tool_use", itemId: id as never, tool, input: {} },
    createdAt: new Date(),
  }) as Message;
const result = (id: string, isError = false): Message =>
  ({
    id: `${id}:result`,
    sessionId,
    role: "tool",
    content: { _tag: "tool_result", itemId: id as never, output: "", isError },
    createdAt: new Date(),
  }) as Message;

describe("tool activity summaries", () => {
  it("recognizes provider command labels with spaces", () => {
    expect(classifyToolActivity("Run Terminal Command")).toBe("command");
  });

  it("counts assistant updates and nested thinking as progress messages", () => {
    const assistant = {
      ...use("assistant", "unused"),
      content: { _tag: "assistant", text: "Checking." },
    } as Message;
    const thinking = {
      ...use("thinking", "unused"),
      content: {
        _tag: "thinking",
        itemId: "thinking" as never,
        text: "Inspecting files",
        redacted: false,
      },
    } as Message;

    expect(
      countTurnProgressMessages([assistant, thinking, use("read", "Read")]),
    ).toBe(2);
  });

  it("uses the latest pending tool action", () => {
    expect(
      summarizeToolActivity([
        use("read", "Read"),
        result("read"),
        use("run", "Bash"),
      ]),
    ).toMatchObject({ label: "Running commands…", pending: true });
  });

  it("summarizes settled activity by category", () => {
    expect(
      summarizeToolActivity([
        use("run-1", "Bash"),
        result("run-1"),
        use("run-2", "Bash"),
        result("run-2"),
        use("list", "Glob"),
        result("list"),
      ]),
    ).toMatchObject({ label: "Ran commands, Listed files", pending: false });
  });

  it("surfaces settled failures", () => {
    expect(
      summarizeToolActivity([use("run", "Bash"), result("run", true)]),
    ).toMatchObject({ label: "Ran a command", hasError: true });
  });

  it("uses thinking only when it is the live tip", () => {
    const thinking = {
      ...use("thinking", "unused"),
      content: {
        _tag: "thinking",
        itemId: "thinking" as never,
        text: "Considering the result",
        redacted: false,
      },
    } as Message;

    expect(summarizeToolActivity([thinking], true)).toMatchObject({
      label: "Thinking…",
      pending: true,
    });
    expect(summarizeToolActivity([thinking], false)).toMatchObject({
      label: "Thinking",
      pending: false,
    });
  });
});
