import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readAnthropicJsonl } from "../src/sources/engines/anthropic-jsonl.ts";
import { readCodexJsonl } from "../src/sources/engines/codex-jsonl.ts";

const dirs: string[] = [];
const makeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "tokenmaxer-test-"));
  dirs.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const writeLines = (path: string, lines: object[]): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
};

describe("anthropic-jsonl engine", () => {
  it("dedupes by message id + request id, keeping the larger token total", async () => {
    const root = makeDir();
    const file = join(root, "projects", "proj", "session.jsonl");
    writeLines(file, [
      {
        timestamp: "2026-06-20T10:00:00.000Z",
        requestId: "req-1",
        message: { id: "msg-1", model: "claude-opus-4-8", usage: { input_tokens: 10, output_tokens: 5 } },
      },
      // Duplicate hash, larger total → should win.
      {
        timestamp: "2026-06-20T10:00:00.000Z",
        requestId: "req-1",
        message: { id: "msg-1", model: "claude-opus-4-8", usage: { input_tokens: 100, output_tokens: 50 } },
      },
      // No message id → always kept.
      {
        timestamp: "2026-06-20T10:01:00.000Z",
        message: { model: "claude-opus-4-8", usage: { input_tokens: 7, output_tokens: 3 } },
      },
    ]);

    const { records } = await readAnthropicJsonl({ sourceId: "claude", sourceLabel: "Claude Code", roots: [root] });

    expect(records).toHaveLength(2);
    const deduped = records.find((r) => r.inputTokens === 100 || r.inputTokens === 10);
    expect(deduped?.inputTokens).toBe(100);
    expect(records.reduce((sum, r) => sum + r.inputTokens, 0)).toBe(107);
  });

  it("skips API error rows and reads project + cache tokens", async () => {
    const root = makeDir();
    writeLines(join(root, "projects", "myproj", "s.jsonl"), [
      { timestamp: "2026-06-20T10:00:00.000Z", isApiErrorMessage: true, message: { id: "e", usage: { input_tokens: 1, output_tokens: 1 } } },
      {
        timestamp: "2026-06-20T10:00:00.000Z",
        message: { id: "ok", model: "claude-opus-4-8", usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 9, cache_creation_input_tokens: 4 } },
      },
    ]);
    const { records } = await readAnthropicJsonl({ sourceId: "claude", sourceLabel: "Claude Code", roots: [root] });
    expect(records).toHaveLength(1);
    expect(records[0]?.cacheReadTokens).toBe(9);
    expect(records[0]?.cacheCreationTokens).toBe(4);
    expect(records[0]?.projectPath).toBe("myproj");
  });
});

describe("codex-jsonl engine", () => {
  it("prefers last_token_usage and subtracts cumulative totals", async () => {
    const root = makeDir();
    const sessions = join(root, "sessions");
    writeLines(join(sessions, "a.jsonl"), [
      { timestamp: "2026-06-20T10:00:00.000Z", type: "turn_context", payload: { model: "gpt-5.3-codex" } },
      // First event: only cumulative total → delta = full total.
      {
        timestamp: "2026-06-20T10:00:01.000Z",
        type: "event_msg",
        payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 100, output_tokens: 200, total_tokens: 1200 } } },
      },
      // Second event: cumulative grew → delta should be the difference.
      {
        timestamp: "2026-06-20T10:00:02.000Z",
        type: "event_msg",
        payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1600, cached_input_tokens: 300, output_tokens: 450, total_tokens: 2050 } } },
      },
    ]);

    const { records } = await readCodexJsonl({ sourceId: "codex", sourceLabel: "Codex", sessionsDirs: [sessions] });

    expect(records).toHaveLength(2);
    // Input is stored exclusive of cache: first delta input 1000 - cached 100 = 900.
    expect(records[0]?.inputTokens).toBe(900);
    expect(records[0]?.cacheReadTokens).toBe(100);
    expect(records[0]?.model).toBe("gpt-5.3-codex");
    // Second delta: input 600, cached 200 → exclusive 400, output 250.
    expect(records[1]?.inputTokens).toBe(400);
    expect(records[1]?.cacheReadTokens).toBe(200);
    expect(records[1]?.outputTokens).toBe(250);
  });

  it("deduplicates identical events across files", async () => {
    const root = makeDir();
    const sessions = join(root, "sessions");
    const event = {
      timestamp: "2026-06-20T10:00:01.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 5, total_tokens: 55 } } },
    };
    const ctx = { timestamp: "2026-06-20T10:00:00.000Z", type: "turn_context", payload: { model: "gpt-5.3-codex" } };
    writeLines(join(sessions, "parent.jsonl"), [ctx, event]);
    writeLines(join(sessions, "branch.jsonl"), [ctx, event]);

    const { records } = await readCodexJsonl({ sourceId: "codex", sourceLabel: "Codex", sessionsDirs: [sessions] });
    expect(records).toHaveLength(1);
  });
});
