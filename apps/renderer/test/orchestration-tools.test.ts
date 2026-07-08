import { describe, expect, it } from "bun:test";

import {
  orchestrationToolName,
  parseOrchestrationResult,
} from "../src/lib/orchestration-tools.ts";

describe("orchestration tool helpers", () => {
  it("matches canonical, historical, and legacy orchestration tool names", () => {
    expect(
      orchestrationToolName("mcp__zuse-orchestration__create_thread"),
    ).toBe("create_thread");
    expect(
      orchestrationToolName("mcp__zuse_orchestration__create_thread"),
    ).toBe("create_thread");
    expect(orchestrationToolName("zuse-orchestration__create_thread")).toBe(
      "create_thread",
    );
    expect(orchestrationToolName("Zuse Orchestration Create Thread")).toBe(
      "create_thread",
    );
    expect(orchestrationToolName("mcp__zuse-orchestration__create_chat")).toBe(
      "create_chat",
    );
    expect(orchestrationToolName("mcp__zuse_orchestration__create_chat")).toBe(
      "create_chat",
    );
    expect(
      orchestrationToolName("mcp__zuse-orchestration__create_session"),
    ).toBe("create_session");
    expect(
      orchestrationToolName("mcp__zuse_orchestration__create_session"),
    ).toBe("create_session");
    expect(orchestrationToolName("Zuse Orchestration Create Session")).toBe(
      "create_session",
    );
    expect(orchestrationToolName("Bash")).toBeNull();
    expect(orchestrationToolName("mcp__zuse__browser_navigate")).toBeNull();
  });

  it("parses orchestration results from persisted provider output shapes", () => {
    expect(
      parseOrchestrationResult(
        JSON.stringify({ ok: true, chatId: "chat_1", title: "Review" }),
      ),
    ).toEqual({ ok: true, chatId: "chat_1", title: "Review" });
    expect(
      parseOrchestrationResult([
        { type: "text", text: '{"ok":true,"chatId":"chat_2"}' },
      ]),
    ).toEqual({ ok: true, chatId: "chat_2" });
    expect(
      parseOrchestrationResult({
        content: [{ type: "text", text: '{"ok":true,"chatId":"chat_3"}' }],
      }),
    ).toEqual({ ok: true, chatId: "chat_3" });
    expect(parseOrchestrationResult("not json")).toBeNull();
  });
});
