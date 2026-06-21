import { describe, expect, it } from "bun:test";
import { Schema } from "effect";

import {
  AgentEvent,
  Chat,
  ComposerInput,
  GitBranchInfo,
  Message,
  PokemonPokedexEntry,
  SettingsFile,
  Session,
  Worktree,
} from "../src/index.ts";

/**
 * These guard the renderer↔server wire contract: every payload that crosses
 * the RPC boundary is encoded to plain JSON on one side and decoded on the
 * other. A round-trip (decode∘encode) that isn't the identity, or a schema
 * that silently accepts malformed input, is a contract break.
 */

const roundTrip = <A, I>(schema: Schema.Schema<A, I>, encoded: I): void => {
  const decoded = Schema.decodeUnknownSync(schema)(encoded);
  const reEncoded = Schema.encodeSync(schema)(decoded);
  expect(reEncoded).toEqual(encoded);
};

describe("AgentEvent round-trips", () => {
  const cases: ReadonlyArray<{ name: string; encoded: unknown }> = [
    {
      name: "Started",
      encoded: {
        _tag: "Started",
        sessionId: "s1",
        providerId: "claude",
        mode: "sdk",
      },
    },
    {
      name: "Status",
      encoded: { _tag: "Status", status: "running" },
    },
    {
      name: "AssistantMessage",
      encoded: { _tag: "AssistantMessage", itemId: "i1", text: "hello" },
    },
    {
      name: "Thinking",
      encoded: { _tag: "Thinking", itemId: "i2", text: "hmm", redacted: false },
    },
    {
      name: "ToolUse (unknown input survives)",
      encoded: {
        _tag: "ToolUse",
        itemId: "i3",
        tool: "Edit",
        input: { file_path: "/a.ts", old_string: "x", new_string: "y" },
      },
    },
    {
      name: "ToolResult",
      encoded: {
        _tag: "ToolResult",
        itemId: "i4",
        output: "done",
        isError: false,
      },
    },
    {
      name: "Error",
      encoded: { _tag: "Error", message: "boom" },
    },
    {
      name: "UsageDelta",
      encoded: {
        _tag: "UsageDelta",
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        model: "claude-opus-4-8",
      },
    },
    {
      name: "Completed",
      encoded: { _tag: "Completed", reason: "ended" },
    },
  ];

  for (const c of cases) {
    it(`round-trips ${c.name}`, () => {
      roundTrip(AgentEvent, c.encoded as never);
    });
  }

  it("rejects an event with no _tag", () => {
    expect(() =>
      Schema.decodeUnknownSync(AgentEvent)({ text: "no tag" }),
    ).toThrow();
  });

  it("rejects an unknown _tag", () => {
    expect(() =>
      Schema.decodeUnknownSync(AgentEvent)({ _tag: "Nonsense" }),
    ).toThrow();
  });

  it("rejects a known event missing a required field", () => {
    expect(() =>
      Schema.decodeUnknownSync(AgentEvent)({
        _tag: "ToolResult",
        itemId: "i",
        output: "o",
      }),
    ).toThrow(); // isError missing
  });

  it("rejects an invalid enum literal", () => {
    expect(() =>
      Schema.decodeUnknownSync(AgentEvent)({
        _tag: "Status",
        status: "spinning",
      }),
    ).toThrow();
  });
});

describe("Session round-trip", () => {
  const encoded = {
    id: "sess1",
    projectId: "proj1",
    title: "My session",
    providerId: "claude",
    model: "claude-opus-4-8",
    status: "idle" as const,
    archivedAt: null,
    cursor: null,
    resumeStrategy: "none" as const,
    runtimeMode: "approval-required" as const,
    worktreeId: null,
    chatId: "chat1",
    forkedFromSessionId: null,
    forkedFromMessageId: null,
    permissionMode: "default" as const,
    toolSearch: false,
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
  };

  it("decodes dates and re-encodes them as ISO strings", () => {
    const session = Schema.decodeUnknownSync(Session)(encoded);
    expect(session.createdAt).toBeInstanceOf(Date);
    expect(Schema.encodeSync(Session)(session)).toEqual(encoded);
  });

  it("round-trips an archived session", () => {
    roundTrip(Session, {
      ...encoded,
      archivedAt: "2026-06-17T12:00:00.000Z",
      cursor: "claude-session-abc",
      resumeStrategy: "claude-session-id" as const,
    });
  });

  it("rejects an unknown status literal", () => {
    expect(() =>
      Schema.decodeUnknownSync(Session)({ ...encoded, status: "zombie" }),
    ).toThrow();
  });
});

describe("Message round-trip", () => {
  const base = {
    id: "msg1",
    sessionId: "sess1",
    createdAt: "2026-06-17T00:00:00.000Z",
  };

  it("round-trips a user message", () => {
    roundTrip(Message, {
      ...base,
      role: "user" as const,
      content: { _tag: "user", text: "hi" },
    });
  });

  it("round-trips a rich user message with code annotations", () => {
    roundTrip(Message, {
      ...base,
      role: "user" as const,
      content: {
        _tag: "user_rich",
        text: "please adjust this",
        attachments: [],
        fileRefs: [],
        skillRefs: [],
        annotations: [
          {
            id: "ann1",
            relPath: "src/app.ts",
            absPath: "/repo/src/app.ts",
            startLine: 10,
            endLine: 12,
            comment: "make this clearer",
          },
        ],
      },
    });
  });

  it("decodes legacy rich user messages without annotations", () => {
    const decoded = Schema.decodeUnknownSync(Message)({
      ...base,
      role: "user" as const,
      content: {
        _tag: "user_rich",
        text: "legacy",
        attachments: [],
        fileRefs: [],
        skillRefs: [],
      },
    });
    expect(decoded.content._tag).toBe("user_rich");
    if (decoded.content._tag === "user_rich") {
      expect(decoded.content.annotations).toEqual([]);
    }
  });

  it("round-trips a tool_use message with unknown input", () => {
    roundTrip(Message, {
      ...base,
      role: "assistant" as const,
      content: {
        _tag: "tool_use",
        itemId: "i1",
        tool: "Bash",
        input: { command: "ls" },
      },
    });
  });

  it("rejects an unknown content _tag", () => {
    expect(() =>
      Schema.decodeUnknownSync(Message)({
        ...base,
        role: "user",
        content: { _tag: "telepathy", text: "hi" },
      }),
    ).toThrow();
  });
});

describe("Pokemon and Worktree round-trips", () => {
  it("round-trips an unlocked Pokedex entry", () => {
    roundTrip(PokemonPokedexEntry, {
      number: 25,
      slug: "pikachu",
      name: "Pikachu",
      generation: 1,
      rarity: "rare" as const,
      points: 75,
      unlocked: true,
      unlockedAt: "2026-06-18T00:00:00.000Z",
      worktreeId: "wt1",
      spriteUrl: "memoize://pokemon/25",
      silhouetteUrl:
        "https://img.pokemondb.net/sprites/scarlet-violet/icon/pikachu.png",
      variants: [
        {
          id: "home",
          label: "Home",
          spriteUrl: "memoize://pokemon/25-home",
        },
      ],
      evolutionLine: [
        {
          number: 25,
          slug: "pikachu",
          name: "Pikachu",
          rarity: "rare" as const,
          unlocked: true,
          spriteUrl: "memoize://pokemon/25",
          silhouetteUrl:
            "https://img.pokemondb.net/sprites/scarlet-violet/icon/pikachu.png",
        },
      ],
    });
  });

  it("round-trips a worktree with Pokémon metadata", () => {
    roundTrip(Worktree, {
      id: "wt1",
      projectId: "proj1",
      path: "/tmp/pikachu",
      name: "pikachu",
      branch: "pikachu",
      baseBranch: "main",
      createdAt: "2026-06-18T00:00:00.000Z",
      setupStatus: "skipped" as const,
      setupOutput: "",
      setupStartedAt: null,
      setupFinishedAt: null,
      pokemon: {
        number: 25,
        slug: "pikachu",
        name: "Pikachu",
        generation: 1,
        rarity: "rare" as const,
        points: 75,
        spriteUrl: "memoize://pokemon/25",
      },
    });
  });
});

describe("Chat round-trip", () => {
  it("round-trips a chat row", () => {
    roundTrip(Chat, {
      id: "chat1",
      projectId: "proj1",
      worktreeId: null,
      title: "Chat",
      activeSessionId: "sess1",
      archivedAt: null,
      lastMessageAt: null,
      lastReadAt: "2026-06-17T00:00:00.000Z",
      createdAt: "2026-06-17T00:00:00.000Z",
      updatedAt: "2026-06-17T00:00:00.000Z",
    });
  });
});

describe("ComposerInput round-trip", () => {
  it("round-trips code annotations", () => {
    roundTrip(ComposerInput, {
      text: "review these",
      attachments: [],
      fileRefs: [],
      skillRefs: [],
      annotations: [
        {
          id: "ann1",
          relPath: "src/app.ts",
          absPath: "/repo/src/app.ts",
          startLine: 4,
          endLine: 8,
          comment: "extract this branch",
        },
      ],
    });
  });
});

describe("SettingsFile round-trip", () => {
  it("round-trips completion sound settings", () => {
    roundTrip(SettingsFile, {
      schemaVersion: 1,
      defaultProviderId: "claude",
      defaultModelByProvider: {
        claude: "claude-opus-4-8",
        codex: "gpt-5-codex",
        grok: "grok-code-fast-1",
        cursor: "cursor-agent",
        gemini: "gemini-3-pro",
        opencode: "sonnet",
      },
      defaultRuntimeMode: "approval-required",
      defaultAutoCreateWorktree: false,
      onboardingCompleted: true,
      completionSoundEnabled: true,
      completionSoundPreset: "bloom",
      providerEnabled: {
        claude: true,
        codex: true,
        grok: true,
        cursor: true,
        gemini: true,
        opencode: true,
      },
      subagents: { enableForNewSessions: true, presets: {} },
      branchNamingStyle: "username-slug",
      branchNamingPrefix: "",
    });
  });

  it("rejects an unknown completion sound preset", () => {
    expect(() =>
      Schema.decodeUnknownSync(SettingsFile)({
        schemaVersion: 1,
        defaultProviderId: "claude",
        defaultModelByProvider: {
          claude: "claude-opus-4-8",
          codex: "gpt-5-codex",
          grok: "grok-code-fast-1",
          cursor: "cursor-agent",
          gemini: "gemini-3-pro",
          opencode: "sonnet",
        },
        defaultRuntimeMode: "approval-required",
        defaultAutoCreateWorktree: false,
        onboardingCompleted: true,
        completionSoundEnabled: true,
        completionSoundPreset: "airhorn",
        providerEnabled: {
          claude: true,
          codex: true,
          grok: true,
          cursor: true,
          gemini: true,
          opencode: true,
        },
        subagents: { enableForNewSessions: true, presets: {} },
        branchNamingStyle: "username-slug",
        branchNamingPrefix: "",
      }),
    ).toThrow();
  });
});

describe("Git branch round-trip", () => {
  it("round-trips a local branch", () => {
    roundTrip(GitBranchInfo, {
      name: "feature/top-bar",
      current: true,
      remote: null,
      upstream: "origin/feature/top-bar",
      kind: "local" as const,
    });
  });

  it("round-trips a remote-only branch", () => {
    roundTrip(GitBranchInfo, {
      name: "main",
      current: false,
      remote: "origin/main",
      upstream: null,
      kind: "remote" as const,
    });
  });
});
