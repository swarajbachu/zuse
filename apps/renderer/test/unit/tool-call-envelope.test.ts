import { describe, expect, it } from "vitest";

import { normalizeToolCallEnvelope } from "../../src/lib/tool-call-envelope.ts";

describe("normalizeToolCallEnvelope", () => {
  it("unwraps provider UseTool and MCP result envelopes", () => {
    expect(
      normalizeToolCallEnvelope(
        "Use Tool",
        {
          variant: "UseTool",
          tool_name: "zuse-orchestration__list_threads",
          tool_input: {},
        },
        {
          isError: false,
          output: {
            type: "MCP",
            tool_name: "list_threads",
            server_name: "zuse-orchestration",
            output: { OkayOutput: '{"ok":true}' },
          },
        },
      ),
    ).toEqual({
      tool: "zuse-orchestration__list_threads",
      input: {},
      result: { isError: false, output: '{"ok":true}' },
    });
  });

  it("preserves ordinary tool calls", () => {
    const result = { output: "ok", isError: false };
    expect(normalizeToolCallEnvelope("Bash", { command: "pwd" }, result)).toEqual(
      { tool: "Bash", input: { command: "pwd" }, result },
    );
  });
});
