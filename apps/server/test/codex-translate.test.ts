import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";

import type { AgentEvent } from "@memoize/wire";

import type { ThreadItem } from "../src/provider/codex-app-protocol/v2/ThreadItem.ts";
import {
  codexWritableRootsForCwd,
  translateCodexItem,
  translateCodexStatusNotification,
} from "../src/provider/drivers/codex.ts";

const tags = (events: ReadonlyArray<AgentEvent>): string[] =>
  events.map((event) => event._tag);

const only = <T extends AgentEvent["_tag"]>(
  events: ReadonlyArray<AgentEvent>,
  tag: T,
): Extract<AgentEvent, { _tag: T }> => {
  expect(tags(events)).toEqual([tag]);
  return events[0] as Extract<AgentEvent, { _tag: T }>;
};

describe("translateCodexItem", () => {
  it("maps a parsed read command to the canonical Read row", () => {
    const item: ThreadItem = {
      type: "commandExecution",
      id: "cmd1",
      command: "sed -n '1,20p' apps/server/src/index.ts",
      cwd: "/repo",
      processId: null,
      source: "agent",
      status: "inProgress",
      commandActions: [
        {
          type: "read",
          command: "sed -n '1,20p' apps/server/src/index.ts",
          name: "sed",
          path: "/repo/apps/server/src/index.ts",
        },
      ],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };

    const ev = only(translateCodexItem(item, "started"), "ToolUse");
    expect(ev.tool).toBe("Read");
    expect(ev.input).toEqual({ file_path: "/repo/apps/server/src/index.ts" });
  });

  it("returns raw command output for a completed canonical Read", () => {
    const item: ThreadItem = {
      type: "commandExecution",
      id: "cmd1",
      command: "/bin/zsh -lc \"sed -n '1,220p' package.json\"",
      cwd: "/repo",
      processId: null,
      source: "agent",
      status: "completed",
      commandActions: [
        {
          type: "read",
          command: "sed -n '1,220p' package.json",
          name: "sed",
          path: "/repo/package.json",
        },
      ],
      aggregatedOutput: '{\n  "name": "desktop"\n}\n',
      exitCode: 0,
      durationMs: 12,
    };

    const ev = only(translateCodexItem(item, "completed"), "ToolResult");
    expect(ev.output).toBe('{\n  "name": "desktop"\n}\n');
  });

  it("falls back to Bash for ordinary command execution", () => {
    const item: ThreadItem = {
      type: "commandExecution",
      id: "cmd2",
      command: "bun test apps/server/test/translate.test.ts",
      cwd: "/repo",
      processId: null,
      source: "agent",
      status: "inProgress",
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };

    const ev = only(translateCodexItem(item, "started"), "ToolUse");
    expect(ev.tool).toBe("Bash");
    expect(ev.input).toMatchObject({
      command: "bun test apps/server/test/translate.test.ts",
      cwd: "/repo",
    });
  });

  it("renders Codex file changes as patch-backed edit rows", () => {
    const item: ThreadItem = {
      type: "fileChange",
      id: "patch1",
      status: "completed",
      changes: [
        {
          path: "apps/server/src/provider/drivers/codex.ts",
          kind: { type: "update", move_path: null },
          diff: "@@ -1 +1 @@\n-old\n+new",
        },
      ],
    };

    const out = translateCodexItem(item, "completed");
    expect(tags(out)).toEqual(["ToolUse", "ToolResult"]);
    const use = out[0] as Extract<AgentEvent, { _tag: "ToolUse" }>;
    expect(use.tool).toBe("Edit");
    expect(use.input).toEqual({
      file_path: "apps/server/src/provider/drivers/codex.ts",
      kind: "update",
      patch: "@@ -1 +1 @@\n-old\n+new",
      move_path: null,
    });
  });

  it("normalizes MCP tool names to Claude-style names", () => {
    const item: ThreadItem = {
      type: "mcpToolCall",
      id: "mcp1",
      server: "memoize",
      tool: "browser_screenshot",
      status: "inProgress",
      arguments: {},
      result: null,
      error: null,
      durationMs: null,
    };

    const ev = only(translateCodexItem(item, "started"), "ToolUse");
    expect(ev.tool).toBe("mcp__memoize__browser_screenshot");
  });

  it("renders context compaction as a compacted message", () => {
    const item: ThreadItem = { type: "contextCompaction", id: "compact1" };

    const ev = only(translateCodexItem(item, "completed"), "AssistantMessage");
    expect(ev.text).toBe("Conversation context compacted.");
  });
});

describe("translateCodexStatusNotification", () => {
  it("maps token usage notifications to exact context usage", () => {
    const ev = only(
      translateCodexStatusNotification(
        {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread1",
            turnId: "turn1",
            tokenUsage: {
              total: {
                totalTokens: 231_700,
                inputTokens: 220_000,
                cachedInputTokens: 0,
                outputTokens: 10_000,
                reasoningOutputTokens: 1_700,
              },
              last: {
                totalTokens: 1_000,
                inputTokens: 800,
                cachedInputTokens: 0,
                outputTokens: 200,
                reasoningOutputTokens: 0,
              },
              modelContextWindow: 258_400,
            },
          },
        },
        "thread1",
      ) ?? [],
      "ContextUsage",
    );

    expect(ev.providerId).toBe("codex");
    expect(ev.usedTokens).toBe(231_700);
    expect(ev.windowTokens).toBe(258_400);
    expect(ev.precision).toBe("exact");
  });

  it("maps account rate-limit notifications to usage limits", () => {
    const ev = only(
      translateCodexStatusNotification(
        {
          method: "account/rateLimits/updated",
          params: {
            rateLimits: {
              limitId: "primary",
              limitName: "Codex weekly",
              primary: {
                usedPercent: 42,
                windowDurationMins: 10_080,
                resetsAt: 1_800_000_000,
              },
              secondary: null,
              credits: null,
              planType: null,
              rateLimitReachedType: null,
            },
          },
        },
        "thread1",
      ) ?? [],
      "UsageLimit",
    );

    expect(ev.providerId).toBe("codex");
    expect(ev.label).toBe("Codex weekly");
    expect(ev.usedPercent).toBe(42);
    expect(ev.windowMinutes).toBe(10_080);
    expect(ev.resetsAt).toBe("2027-01-15T08:00:00.000Z");
  });
});

describe("codexWritableRootsForCwd", () => {
  it("includes the real Git metadata dirs for worktree-safe git operations", () => {
    const cwd = process.cwd();
    const gitDirs = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
      { cwd, encoding: "utf8" },
    )
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    expect(codexWritableRootsForCwd(cwd)).toEqual(
      expect.arrayContaining([cwd, ...gitDirs]),
    );
  });
});
