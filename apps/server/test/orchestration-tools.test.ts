import { describe, expect, test } from "bun:test";

import {
  MUTATING_ORCHESTRATION_TOOLS,
  ORCHESTRATION_MCP_SERVER_NAME,
  ORCHESTRATION_MCP_TOOLS,
  READ_ONLY_ORCHESTRATION_TOOLS,
  callOrchestrationTool,
  orchestrationMcpPromptHint,
} from "../src/provider/drivers/orchestration-tools.ts";

describe("orchestration MCP tools", () => {
  test("exposes the stable provider-neutral tool set", () => {
    expect(ORCHESTRATION_MCP_SERVER_NAME).toBe("zuse-orchestration");
    expect(ORCHESTRATION_MCP_TOOLS.map((tool) => tool.name)).toEqual([
      "create_worktree",
      "create_thread",
      "send_to_thread",
      "read_thread",
      "list_threads",
      "list_models",
      "whoami",
    ]);
  });

  test("marks read-only and mutating tools explicitly", () => {
    expect([...READ_ONLY_ORCHESTRATION_TOOLS].sort()).toEqual([
      "list_models",
      "list_threads",
      "read_thread",
      "whoami",
    ]);
    expect([...MUTATING_ORCHESTRATION_TOOLS].sort()).toEqual([
      "create_thread",
      "create_worktree",
      "send_to_thread",
    ]);
  });

  test("schemas encode required arguments for write-like tools", () => {
    const createThread = ORCHESTRATION_MCP_TOOLS.find(
      (tool) => tool.name === "create_thread",
    );
    const sendToThread = ORCHESTRATION_MCP_TOOLS.find(
      (tool) => tool.name === "send_to_thread",
    );
    expect(createThread?.inputSchema.required).toEqual(["title", "prompt"]);
    expect(sendToThread?.inputSchema.required).toEqual(["sessionId", "text"]);
  });

  test("prompt hint tells models not to substitute provider subagents", () => {
    const hint = orchestrationMcpPromptHint();
    expect(hint).toContain("zuse-orchestration");
    expect(hint).toContain("whoami -> list_threads");
    expect(hint).toContain("list_models");
    expect(hint).toContain("Do not substitute");
    expect(hint).toContain("worker/explorer/default");
  });

  test("descriptions teach workspace-vs-thread semantics", () => {
    const createWorktree = ORCHESTRATION_MCP_TOOLS.find(
      (tool) => tool.name === "create_worktree",
    );
    const createThread = ORCHESTRATION_MCP_TOOLS.find(
      (tool) => tool.name === "create_thread",
    );
    const sendToThread = ORCHESTRATION_MCP_TOOLS.find(
      (tool) => tool.name === "send_to_thread",
    );
    const listModels = ORCHESTRATION_MCP_TOOLS.find(
      (tool) => tool.name === "list_models",
    );

    expect(createWorktree?.description).toContain("WORKSPACE");
    expect(createWorktree?.description).toContain("can host MANY chat threads");
    expect(createThread?.description).toContain("does NOT create a workspace");
    expect(sendToThread?.description).toContain("queued is always false");
    expect(listModels?.description).toContain("providerId/model");
    expect(sendToThread?.description).not.toContain(
      "delivered when it goes idle",
    );
  });

  test("generic dispatcher calls the bound deps", async () => {
    const result = await callOrchestrationTool(
      {
        createWorktree: async () => ({
          ok: true,
          worktreeId: "wt_1",
          path: "/tmp/worktree",
          branch: "test",
        }),
        createThread: async () => ({
          ok: true,
          chatId: "chat_1",
          sessionId: "s_1",
          title: "Thread",
        }),
        sendToThread: async () => ({
          ok: true,
          queued: false,
          chatId: "chat_target",
        }),
        readThread: async () => ({
          ok: true,
          status: "idle",
          messages: [],
        }),
        listThreads: async () => ({ ok: true, threads: [] }),
        listModels: async () => ({
          ok: true,
          providers: [
            {
              providerId: "codex",
              defaultModel: "gpt-5.2-codex-max",
              models: [
                {
                  id: "gpt-5.2-codex-max",
                  label: "GPT-5.2 Codex Max",
                  defaultModel: true,
                },
              ],
            },
          ],
        }),
        whoami: async () => ({
          sessionId: "s_self",
          chatId: "chat_self",
          projectId: "project",
          worktreeId: null,
          providerId: "claude",
          model: "claude-sonnet-5",
          autonomyLevel: "approval-gated",
        }),
      },
      "whoami",
      {},
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("approval-gated");
  });
});
