import { describe, expect, it } from "bun:test";

import type { AgentEvent } from "@zuse/wire";

import {
  createAcpTranslator,
  translateAcpSessionUpdate,
} from "../src/provider/drivers/acp/translate.ts";

// Narrowing helpers — the translator returns the AgentEvent union; tests below
// assert on concrete variants, so pull the tag out and cast for convenience.
const tags = (events: ReadonlyArray<AgentEvent>): string[] =>
  events.map((e) => e._tag);

const only = <T extends AgentEvent["_tag"]>(
  events: ReadonlyArray<AgentEvent>,
  tag: T,
): Extract<AgentEvent, { _tag: T }> => {
  expect(tags(events)).toEqual([tag]);
  return events[0] as Extract<AgentEvent, { _tag: T }>;
};

describe("translateAcpSessionUpdate — tool-call normalization", () => {
  it("maps Grok read_file → canonical Read with file_path", () => {
    const ev = only(
      translateAcpSessionUpdate(
        {
          sessionUpdate: "tool_call",
          kind: "read_file",
          toolCallId: "tc1",
          locations: [{ path: "/repo/a.ts" }],
        },
        "grok",
      ),
      "ToolUse",
    );
    expect(ev).toEqual({
      _tag: "ToolUse",
      itemId: "tc1",
      tool: "Read",
      input: { file_path: "/repo/a.ts" },
    });
  });

  it("recovers a Grok SearchReplace envelope into a canonical Edit", () => {
    const ev = only(
      translateAcpSessionUpdate(
        {
          sessionUpdate: "tool_call",
          kind: "search_replace",
          toolCallId: "tc2",
          content: [
            {
              type: "SearchReplace",
              EditsApplied: {
                absolute_path: "/repo/a.ts",
                old_string: "foo",
                new_string: "bar",
              },
            },
          ],
        },
        "grok",
      ),
      "ToolUse",
    );
    expect(ev.tool).toBe("Edit");
    expect(ev.input).toEqual({
      file_path: "/repo/a.ts",
      old_string: "foo",
      new_string: "bar",
    });
  });

  it("maps a Gemini diff block → canonical Edit", () => {
    const ev = only(
      translateAcpSessionUpdate(
        {
          sessionUpdate: "tool_call",
          kind: "edit",
          toolCallId: "tc3",
          content: [
            { type: "diff", path: "/repo/b.ts", oldText: "a", newText: "b" },
          ],
        },
        "gemini",
      ),
      "ToolUse",
    );
    expect(ev.tool).toBe("Edit");
    expect(ev.input).toEqual({
      file_path: "/repo/b.ts",
      old_string: "a",
      new_string: "b",
    });
  });

  it("maps a Bash command and folds title into description", () => {
    const ev = only(
      translateAcpSessionUpdate(
        {
          sessionUpdate: "tool_call",
          kind: "bash",
          toolCallId: "tc4",
          command: "ls -la",
          title: "List files",
        },
        "grok",
      ),
      "ToolUse",
    );
    expect(ev.tool).toBe("Bash");
    expect(ev.input).toEqual({ command: "ls -la", description: "List files" });
  });

  it("omits Bash description when title echoes the command", () => {
    const ev = only(
      translateAcpSessionUpdate(
        {
          sessionUpdate: "tool_call",
          kind: "bash",
          toolCallId: "tc4b",
          command: "ls -la",
          title: "ls -la",
        },
        "grok",
      ),
      "ToolUse",
    );
    expect(ev.tool).toBe("Bash");
    expect(ev.input).toEqual({ command: "ls -la" });
  });

  it("omits Bash description when title is the first line of a multiline command", () => {
    const ev = only(
      translateAcpSessionUpdate(
        {
          sessionUpdate: "tool_call",
          kind: "bash",
          toolCallId: "tc4c",
          command: "echo one\necho two",
          title: "echo one",
        },
        "grok",
      ),
      "ToolUse",
    );
    expect(ev.tool).toBe("Bash");
    expect(ev.input).toEqual({ command: "echo one\necho two" });
  });

  it("normalizes unknown tool kinds into a Title Case label", () => {
    const ev = only(
      translateAcpSessionUpdate(
        { sessionUpdate: "tool_call", kind: "list_dir", toolCallId: "tc5" },
        "grok",
      ),
      "ToolUse",
    );
    expect(ev.tool).toBe("ListDir");
  });

  it("uses the call id from any of the accepted id fields", () => {
    const ev = only(
      translateAcpSessionUpdate(
        { sessionUpdate: "tool_call", kind: "read", call_id: "snake_id" },
        "grok",
      ),
      "ToolUse",
    );
    expect(ev.itemId).toBe("snake_id");
  });

  it("normalizes zuse-orchestration MCP tool names to the canonical FQN", () => {
    const kindEvent = only(
      translateAcpSessionUpdate(
        {
          sessionUpdate: "tool_call",
          kind: "zuse-orchestration__create_thread",
          toolCallId: "orch1",
        },
        "grok",
      ),
      "ToolUse",
    );
    expect(kindEvent.tool).toBe("mcp__zuse-orchestration__create_thread");

    const titleEvent = only(
      translateAcpSessionUpdate(
        {
          sessionUpdate: "tool_call",
          title: "zuse-orchestration__send_to_thread",
          toolCallId: "orch2",
        },
        "grok",
      ),
      "ToolUse",
    );
    expect(titleEvent.tool).toBe("mcp__zuse-orchestration__send_to_thread");
  });
});

describe("translateAcpSessionUpdate — result normalization", () => {
  it("decodes Grok byte-array stdout into UTF-8 text", () => {
    const ev = only(
      translateAcpSessionUpdate(
        {
          sessionUpdate: "tool_result",
          toolCallId: "g1",
          output: { stdout: [72, 105], stderr: [] }, // "Hi"
        },
        "grok",
      ),
      "ToolResult",
    );
    expect(ev.output).toBe("Hi");
    expect(ev.isError).toBe(false);
  });

  it("strips Grok N→ line markers from FileContent results", () => {
    const ev = only(
      translateAcpSessionUpdate(
        {
          sessionUpdate: "tool_result",
          toolCallId: "r1",
          output: {
            type: "ReadFile",
            FileContent: { content: "1→hello\n2→world" },
          },
        },
        "grok",
      ),
      "ToolResult",
    );
    expect(ev.output).toBe("hello\nworld");
  });

  it("flattens nested MCP content blocks to a plain string", () => {
    const ev = only(
      translateAcpSessionUpdate(
        {
          sessionUpdate: "tool_result",
          toolCallId: "m1",
          content: [
            { type: "content", content: { type: "text", text: "body" } },
          ],
        },
        "grok",
      ),
      "ToolResult",
    );
    expect(ev.output).toBe("body");
  });

  it("maps is_error / failed status onto isError", () => {
    const ev = only(
      translateAcpSessionUpdate(
        {
          sessionUpdate: "tool_result",
          toolCallId: "e1",
          is_error: true,
          output: "boom",
        },
        "grok",
      ),
      "ToolResult",
    );
    expect(ev.isError).toBe(true);
    expect(ev.output).toBe("boom");
  });
});

describe("createAcpTranslator — assistant + thinking coalescing", () => {
  it("buffers agent_message_chunk deltas and flushes one AssistantMessage", () => {
    const t = createAcpTranslator("grok");
    expect(
      t.translate({ sessionUpdate: "agent_message_chunk", content: "Hello " }),
    ).toEqual([]);
    expect(
      t.translate({ sessionUpdate: "agent_message_chunk", content: "world" }),
    ).toEqual([]);
    const flushed = only(t.flush(), "AssistantMessage");
    expect(flushed.text).toBe("Hello world");
  });

  it("repairs missing spaces between streamed sentence words", () => {
    const t = createAcpTranslator("grok");
    t.translate({ sessionUpdate: "agent_message_chunk", content: "I'll" });
    t.translate({
      sessionUpdate: "agent_message_chunk",
      content: "Starting now",
    });
    const flushed = only(t.flush(), "AssistantMessage");
    expect(flushed.text).toBe("I'll Starting now");
  });

  it("flushes buffered text before the next non-text event, preserving order", () => {
    const t = createAcpTranslator("grok");
    t.translate({ sessionUpdate: "agent_message_chunk", content: "intro" });
    const out = t.translate({
      sessionUpdate: "tool_call",
      kind: "read",
      toolCallId: "x1",
      locations: [{ path: "/a.ts" }],
    });
    expect(tags(out)).toEqual(["AssistantMessage", "ToolUse"]);
    expect(
      (out[0] as Extract<AgentEvent, { _tag: "AssistantMessage" }>).text,
    ).toBe("intro");
  });

  it("does not split Grok streamed text around tool result updates", () => {
    const t = createAcpTranslator("grok");
    t.translate({ sessionUpdate: "agent_message_chunk", content: "I'll" });

    const result = only(
      t.translate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-stream",
        status: "completed",
        rawOutput: { type: "Bash", output: "ok" },
      }),
      "ToolResult",
    );
    expect(result.itemId).toBe("tc-stream");

    t.translate({
      sessionUpdate: "agent_message_chunk",
      content: " keep this joined.",
    });

    const message = only(t.flush(), "AssistantMessage");
    expect(message.text).toBe("I'll keep this joined.");
  });

  it("coalesces thinking chunks into one Thinking event", () => {
    const t = createAcpTranslator("gemini");
    expect(
      t.translate({ sessionUpdate: "agent_thought_chunk", content: "think " }),
    ).toEqual([]);
    expect(
      t.translate({ sessionUpdate: "agent_thought_chunk", content: "more" }),
    ).toEqual([]);
    const ev = only(t.flush(), "Thinking");
    expect(ev.text).toBe("think more");
    expect(ev.redacted).toBe(false);
  });

  it("strips Grok's echoed-prompt prefix from the first thinking chunk", () => {
    const t = createAcpTranslator("grok");
    t.translate({
      sessionUpdate: "agent_thought_chunk",
      content:
        'The user says: "do X" Now I need to plan the real approach here',
    });
    const ev = only(t.flush(), "Thinking");
    expect(ev.text).not.toContain("The user says");
    expect(ev.text).toContain("Now I need to plan");
  });
});

describe("createAcpTranslator — tool_call_update dedup & re-emit", () => {
  it("skips a tool_call_update whose input is unchanged", () => {
    const t = createAcpTranslator("cursor");
    const first = t.translate({
      sessionUpdate: "tool_call",
      kind: "read",
      toolCallId: "d1",
      locations: [{ path: "/a.ts" }],
    });
    expect(tags(first)).toEqual(["ToolUse"]);
    // Same locations, no content, no terminal status → nothing new to emit.
    const second = t.translate({
      sessionUpdate: "tool_call_update",
      toolCallId: "d1",
      locations: [{ path: "/a.ts" }],
    });
    expect(second).toEqual([]);
  });

  it("dedupes equivalent file path aliases for the same tool call", () => {
    const t = createAcpTranslator("grok");
    const first = t.translate({
      sessionUpdate: "tool_call",
      kind: "read",
      toolCallId: "read-1",
      rawInput: { target_file: "/repo/a.ts" },
    });
    expect(tags(first)).toEqual(["ToolUse"]);
    expect(only(first, "ToolUse").input).toEqual({
      file_path: "/repo/a.ts",
    });

    const second = t.translate({
      sessionUpdate: "tool_call_update",
      kind: "read",
      toolCallId: "read-1",
      rawInput: { file_path: "/repo/a.ts" },
    });
    expect(second).toEqual([]);
  });

  it("re-emits ToolUse when a diff first appears on an Edit update", () => {
    const t = createAcpTranslator("cursor");
    t.translate({
      sessionUpdate: "tool_call",
      kind: "edit",
      toolCallId: "e1",
      locations: [{ path: "/c.ts" }],
    });
    const update = t.translate({
      sessionUpdate: "tool_call_update",
      toolCallId: "e1",
      content: [{ type: "diff", path: "/c.ts", oldText: "x", newText: "y" }],
    });
    const ev = only(update, "ToolUse");
    expect(ev.tool).toBe("Edit");
    expect(ev.input).toEqual({
      file_path: "/c.ts",
      old_string: "x",
      new_string: "y",
    });
  });

  it("remembers the tool name across update frames that omit kind (Cursor)", () => {
    const t = createAcpTranslator("cursor");
    t.translate({
      sessionUpdate: "tool_call",
      kind: "read",
      toolCallId: "c1",
      rawInput: { path: "/repo/x.ts" },
    });
    const result = t.translate({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "file body" } },
      ],
    });
    const ev = only(result, "ToolResult");
    expect(ev.output).toBe("file body");
    expect(ev.isError).toBe(false);
  });

  it("emits ToolResult once when status flips to completed even without content", () => {
    const t = createAcpTranslator("grok");
    t.translate({
      sessionUpdate: "tool_call",
      kind: "bash",
      toolCallId: "b1",
      command: "true",
    });
    const done = t.translate({
      sessionUpdate: "tool_call_update",
      toolCallId: "b1",
      status: "completed",
    });
    expect(tags(done)).toEqual(["ToolResult"]);
    // A late duplicate terminal update must not stack a second result row.
    const late = t.translate({
      sessionUpdate: "tool_call_update",
      toolCallId: "b1",
      status: "completed",
    });
    expect(late).toEqual([]);
  });
});

describe("createAcpTranslator — per-provider quirks & errors", () => {
  it("renders Grok collab spawnAgent as a grouped Agent run", () => {
    const t = createAcpTranslator("grok");
    const out = t.translate({
      item: {
        type: "collabAgentToolCall",
        id: "spawn-1",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "main",
        receiverThreadIds: ["agent-thread-1"],
        prompt: "Explore codebase architecture",
        model: null,
        reasoningEffort: null,
        agentsStates: {
          "agent-thread-1": { status: "running", message: null },
        },
      },
      threadId: "main",
      turnId: "turn-1",
    });

    const ev = only(out, "ToolUse");
    expect(ev.itemId).toBe("spawn-1");
    expect(ev.tool).toBe("Agent");
    expect(ev.input).toEqual({
      subagent_type: "agent",
      prompt: "Explore codebase architecture",
      receiverThreadIds: ["agent-thread-1"],
    });
  });

  it("groups Grok/Cursor Task child tool batches under the subagent row", () => {
    const t = createAcpTranslator("grok");
    const taskId =
      "call-e9325475-3790-4ba8-b6de-d31ccbe5f0bd-composer_call_RRQI1";
    t.translate({
      sessionUpdate: "tool_call",
      toolCallId: taskId,
      title: "Task",
      rawInput: {
        description: "Task",
        subagent_type: "generalPurpose",
        prompt: "Analyze the current state of the branch.",
      },
    });
    const ev = only(
      t.translate({
        sessionUpdate: "tool_call_update",
        toolCallId: taskId,
        kind: "other",
        title: "Audit recent branch work",
        rawInput: {
          variant: "CursorTask",
          description: "Audit recent branch work",
          prompt: "Analyze the current state of the branch.",
          subagent_type: "generalPurpose",
        },
      }),
      "ToolUse",
    );

    expect(ev.tool).toBe("Task");
    expect(ev.input).toEqual({
      variant: "CursorTask",
      description: "Audit recent branch work",
      prompt: "Analyze the current state of the branch.",
      subagent_type: "generalPurpose",
    });

    const childUse = only(
      t.translate({
        sessionUpdate: "tool_call",
        toolCallId:
          "call-6bc3338e-60b3-42c6-b0f8-91cadd4694a7-composer_call_kLDxP",
        title: "Shell",
        rawInput: {
          description: "Commits on branch vs main",
          command: "git log origin/main..HEAD --oneline",
        },
      }),
      "ToolUse",
    );
    expect(childUse.parentItemId).toBe(taskId);

    const summary = only(t.flush(), "SubagentSummary");
    expect(summary.itemId).toBe(taskId);
    expect(summary.summary).toBe("Audit recent branch work");
    expect(summary.isError).toBe(false);
  });

  it("nests Grok collab agent messages under the spawned Agent row", () => {
    const t = createAcpTranslator("grok");
    t.translate({
      item: {
        type: "collabAgentToolCall",
        id: "spawn-1",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "main",
        receiverThreadIds: ["agent-thread-1"],
        prompt: "Explore codebase architecture",
        model: "grok-code-fast-1",
        reasoningEffort: null,
        agentsStates: {},
      },
      threadId: "main",
      turnId: "turn-1",
    });

    const out = t.translate({
      item: {
        type: "agentMessage",
        id: "msg-1",
        text: "Found the server and renderer boundaries.",
        phase: null,
        memoryCitation: null,
      },
      threadId: "agent-thread-1",
      turnId: "turn-2",
    });

    const ev = only(out, "AssistantMessage");
    expect(ev.parentItemId).toBe("spawn-1");
    expect(ev.text).toBe("Found the server and renderer boundaries.");
  });

  it("finishes Grok collab Agent rows from terminal agent state updates", () => {
    const t = createAcpTranslator("grok");
    t.translate({
      item: {
        type: "collabAgentToolCall",
        id: "spawn-1",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "main",
        receiverThreadIds: ["agent-thread-1"],
        prompt: "Explore codebase architecture",
        model: "grok-code-fast-1",
        reasoningEffort: null,
        agentsStates: {},
      },
      threadId: "main",
      turnId: "turn-1",
    });
    t.translate({
      item: {
        type: "agentMessage",
        id: "msg-1",
        text: "Architecture summary.",
        phase: null,
        memoryCitation: null,
      },
      threadId: "agent-thread-1",
      turnId: "turn-2",
    });

    const out = t.translate({
      item: {
        type: "collabAgentToolCall",
        id: "wait-1",
        tool: "wait",
        status: "completed",
        senderThreadId: "main",
        receiverThreadIds: ["agent-thread-1"],
        prompt: null,
        model: null,
        reasoningEffort: null,
        agentsStates: {
          "agent-thread-1": {
            status: "completed",
            message: "Done exploring.",
          },
        },
      },
      threadId: "main",
      turnId: "turn-1",
    });

    expect(tags(out)).toEqual(["ToolUse", "ToolResult", "SubagentSummary"]);
    const summary = out[2] as Extract<AgentEvent, { _tag: "SubagentSummary" }>;
    expect(summary.itemId).toBe("spawn-1");
    expect(summary.summary).toBe("Done exploring.");
    expect(summary.turns).toBe(1);
  });

  it("finishes Grok collab Agent rows from receiver thread idle status", () => {
    const t = createAcpTranslator("grok");
    t.translate({
      method: "item/started",
      item: {
        type: "collabAgentToolCall",
        id: "spawn-1",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "main",
        receiverThreadIds: ["agent-thread-1"],
        prompt: "Explore renderer UI",
        model: null,
        reasoningEffort: null,
        agentsStates: {},
      },
      threadId: "main",
      turnId: "turn-1",
    });
    t.translate({
      method: "item/completed",
      item: {
        type: "agentMessage",
        id: "msg-1",
        text: "Renderer UI is React.",
        phase: null,
        memoryCitation: null,
      },
      threadId: "agent-thread-1",
      turnId: "turn-2",
    });

    const out = t.translate({
      method: "thread/status/changed",
      threadId: "agent-thread-1",
      status: { type: "idle" },
    });

    const summary = only(out, "SubagentSummary");
    expect(summary.itemId).toBe("spawn-1");
    expect(summary.summary).toBe("Renderer UI is React.");
    expect(summary.isError).toBe(false);
  });

  it("finishes Grok collab Agent rows from receiver thread close", () => {
    const t = createAcpTranslator("grok");
    t.translate({
      method: "item/started",
      item: {
        type: "collabAgentToolCall",
        id: "spawn-1",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "main",
        receiverThreadIds: ["agent-thread-1"],
        prompt: "Task",
        model: null,
        reasoningEffort: null,
        agentsStates: {},
      },
      threadId: "main",
      turnId: "turn-1",
    });

    const out = t.translate({
      method: "thread/closed",
      threadId: "agent-thread-1",
    });

    const summary = only(out, "SubagentSummary");
    expect(summary.itemId).toBe("spawn-1");
    expect(summary.summary).toBe("");
    expect(summary.isError).toBe(false);
  });

  it("skips Gemini's internal `think` tool call (surfaced via thinking chunks)", () => {
    expect(
      translateAcpSessionUpdate(
        { sessionUpdate: "tool_call", kind: "think", toolCallId: "t1" },
        "gemini",
      ),
    ).toEqual([]);
  });

  it("ignores transient Grok auth-noise error frames", () => {
    expect(
      translateAcpSessionUpdate(
        { sessionUpdate: "error", message: "Auth(AuthorizationRequired)" },
        "grok",
      ),
    ).toEqual([]);
  });

  it("surfaces a real error frame as an Error event", () => {
    const ev = only(
      translateAcpSessionUpdate(
        { sessionUpdate: "error", message: "disk full" },
        "gemini",
      ),
      "Error",
    );
    expect(ev.message).toBe("disk full");
  });

  it("returns no events for unknown / ignored update kinds", () => {
    expect(
      translateAcpSessionUpdate(
        { sessionUpdate: "current_mode_update" },
        "cursor",
      ),
    ).toEqual([]);
    expect(translateAcpSessionUpdate(null, "grok")).toEqual([]);
    expect(translateAcpSessionUpdate({ noKindHere: true }, "grok")).toEqual([]);
  });
});
