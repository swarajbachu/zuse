# Feature: Cross-provider sub-agents (Phase 2)

The Phase 1 spec ([sub-agents.md](sub-agents.md)) ships sub-agents
*within* the Claude provider — Opus 4.7 delegates to Haiku 4.5 / Sonnet
4.6, all through Anthropic's SDK. That's the immediate win.

Phase 2 closes the loop the other way: a Claude main agent can delegate
to a **Codex** sub-agent (and a Codex main agent can delegate to a
Claude sub-agent) when the cheap-or-better model lives on the *other*
provider. Use cases:

- "Use a small Codex model for high-volume code search" — GPT-5 mini
  variants are cheap and good at keyword search.
- "Use Claude Haiku for summarization mid-Codex-session" — when the
  user starts in Codex but needs Claude's better summarization for one
  step.
- "Run two providers in parallel for higher-recall research" — fan
  out, agree on the answer.

This document is a **full sketch** — wire shape, runtime, error
handling, UI — but no implementation lands in the Phase 1 PR. The Phase
1 wire format is designed so Phase 2 is purely additive.

## The constraint we're working around

Anthropic's Agent SDK and OpenAI's Codex SDK don't know about each
other. Each `query()` call lives entirely within its provider's
process — the SDK's `agents` parameter only spawns same-provider
sub-agents. There's no `model: "gpt-5"` shortcut you can drop into a
Claude `AgentDefinition`.

What both SDKs **do** support is **MCP tools** — model-side function
calls into a server we control. Both providers will happily call an
arbitrary tool, await its result, and incorporate the result into the
conversation. So the bridge is shaped as an **in-process MCP server**
that exposes tools like `memoize.delegate-codex` and
`memoize.delegate-claude`, registered with whichever provider is
currently the *main* agent.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  apps/server (single Effect runtime, both providers loaded)      │
│                                                                  │
│   ┌─ Claude main session ─┐         ┌─ Codex sub-session ──┐     │
│   │  Opus 4.7             │  call   │  gpt-5-mini          │     │
│   │  query({              │ ──────▶ │  (spun up by bridge) │     │
│   │    mcpServers: {      │         │                      │     │
│   │      memoize: …      │         │                      │     │
│   │    }                  │ ◀────── │                      │     │
│   │  })                   │ result  │                      │     │
│   └───────────────────────┘         └──────────────────────┘     │
│              │                                  │                │
│              └──────────── ProviderService ─────┘                │
│                          (parent/child link)                     │
└──────────────────────────────────────────────────────────────────┘
                  │                            │
                  ▼                            ▼
              Wire RPC                    Wire RPC
                  │                            │
                  ▼                            ▼
       ┌─────── Renderer ────────────────────────────┐
       │  one chat view, single transcript,          │
       │  Codex sub-session events nested under      │
       │  the parent's `Agent` wrapper row           │
       └─────────────────────────────────────────────┘
```

## New piece: `apps/server/src/provider/mcp/memoize-bridge.ts`

An in-process MCP server (no socket, no subprocess — `@modelcontextprotocol/sdk`
supports in-memory transports). Exposes two tools:

```ts
// Registered with whichever provider is the main agent.
{
  name: "memoize.delegate-codex",
  description:
    "Delegate a scoped sub-task to a Codex (GPT-5) sub-agent. Use " +
    "when the parent is on Claude and a cheaper Codex model is the " +
    "better fit (e.g. high-volume keyword search). The sub-agent runs " +
    "in its own context, returns only the final summary.",
  inputSchema: {
    type: "object",
    required: ["agent_name", "prompt"],
    properties: {
      agent_name: { type: "string", enum: ["research", "file-edits", /* … */] },
      prompt:     { type: "string" },
      model:      { type: "string" }, // optional override, defaults to preset
    },
  },
}

{
  name: "memoize.delegate-claude",
  description: "Reverse direction. Used when main is Codex.",
  inputSchema: { /* same shape */ },
}
```

When invoked, the bridge:

1. Looks up the named cross-provider sub-agent preset (see
   "Cross-provider preset library" below).
2. Spins up a sub-session via the *other* provider's driver.
   `claude.start({ providerId: "codex", … })` becomes
   `codex.start({ providerId: "codex", … })` on the bridge code path.
3. Pipes that sub-session's `AgentEvent` stream into the parent's
   stream, **rewriting** each event to include the parent's `Agent`
   tool_use id as `parentItemId`. The renderer therefore sees one
   continuous stream and groups normally.
4. Captures the sub-session's final assistant text and returns it as
   the MCP tool's `text` content. The Claude SDK then synthesizes a
   `tool_result` for that tool_use and the conversation continues.
5. Emits a `SubagentSummary` event matching the Phase 1 schema, plus
   `UsageDelta` events tagged with the cross-provider model.

The parent driver doesn't need to know about Codex at all — it just
sees an MCP tool call and an MCP tool result. Same code path as any
other MCP tool.

## Wire deltas — additive on top of Phase 1

The Phase 1 schema already supports cross-provider almost as-is:

- `parentItemId` works regardless of which provider emitted the
  event — the bridge tags Codex sub-session events with the parent's
  Claude `tool_use.id`, and the renderer groups by id.
- `SubagentSummary.model` is `Schema.String`, accepts `"gpt-5-mini"`
  alongside `"claude-haiku-4-5"`.
- `UsageDelta.model` ditto.

The only **new** event Phase 2 needs:

```ts
const CrossProviderInvocationEvent = Schema.TaggedStruct("CrossProviderInvocation", {
  itemId: AgentItemId,             // matches the bridge tool_use
  fromProvider: ProviderId,         // "claude"
  toProvider: ProviderId,           // "codex"
  agentName: Schema.String,         // "research"
  model: Schema.String,             // "gpt-5-mini"
});
```

This is emitted *before* the sub-session starts producing events, so
the renderer can show the wrapper row's badge as
`Agent → Codex (gpt-5-mini)` instead of just `Agent`.

## Cross-provider preset library

Lives next to the Phase 1 presets in
`apps/renderer/src/lib/subagent-presets.ts`, but tagged
`crossProvider: true`. Initial seeds:

- **`codex-research`** — GPT-5 mini, Read/Glob/Grep. Same role as
  `research` but uses Codex. Useful when the user is running on Claude
  Opus and wants the *cheapest* possible search.
- **`claude-summarize`** — Haiku 4.5, Read/Grep. Used by Codex main
  sessions when the user wants Claude's summarization quality for one
  step.

The settings UI ([sub-agents.md → Settings](sub-agents.md#settings))
gains a new section header **"Cross-provider"** below the same-provider
list. Each row shows the source provider → target provider plus the
target model.

## Permissions across providers

Cross-provider sub-agent tool calls flow through the **target** provider's
`canUseTool` — i.e. a Codex sub-agent's tool calls are decided by the
Codex driver's policy. Reasoning: each provider's tool semantics differ
slightly (Codex `shell` vs Claude `Bash`), so the policy code that
already understands those differences should keep deciding.

What the bridge *does* unify:

- Sensitive-path checks fire on both sides (already true for Claude;
  Phase 2 mirrors the same `SENSITIVE_PATTERNS` regex into the Codex
  driver).
- Permission toasts label the agent name + provider:
  `via codex-research · GPT-5 mini · …`.

## Error and lifecycle handling

| Event | Behavior |
|---|---|
| Sub-session fails to start | Bridge returns an `is_error: true` MCP tool_result with the failure reason. Parent agent sees it as a normal failed tool call and decides what to do (usually: try without sub-agent). |
| Sub-session hits `maxTurns` | Bridge returns whatever final text the sub-agent produced + a marker noting truncation. |
| Parent session interrupted while sub-session is running | Bridge cancels the sub-session via the target driver's `interrupt()`. Sub-session emits `Completed { reason: "interrupted" }`, bridge returns an aborted tool_result to the parent. |
| User hits "stop" on the sub-agent's wrapper row directly | New "interrupt sub-agent" affordance: cancels just the sub-session, parent continues with the partial result. Renderer-only change once the cancel-by-itemId RPC exists. |
| Cross-provider auth missing | Bridge surfaces the missing-credentials error as an MCP tool_result; renderer's existing `Auth` event handling lights up the credentials sheet. |

## Cost accounting across providers

Phase 1's `UsageDelta` already carries `model`. Phase 2 extends the
renderer's pricing table with Codex pricing:

```ts
export const MODEL_PRICING = {
  // Claude (from Phase 1)
  "claude-opus-4-7":   { input: 15, output: 75, /* … */ },
  // Codex
  "gpt-5":             { input:  3, output: 12, cacheRead: 0.30, cacheCreate:  3.0 },
  "gpt-5-mini":        { input: 0.5, output:  2, cacheRead: 0.05, cacheCreate:  0.5 },
  // …
};
```

The transcript footer becomes:

```
Opus: 4.2k · Codex mini (codex-research): 22.1k · saved ~$0.41
```

## UI

No new UI components beyond Phase 1. The wrapper row's badge changes:

```
🤖 Agent → Codex (gpt-5-mini)  Find every place we register an RPC handler  ▾
   📋 Prompt
   📁 Glob …
   …
```

The arrow + provider name on the badge is the *only* visual cue that
this is cross-provider. Inside the wrapper, nested tool rows look
identical to Claude-side rows because the wire schema is the same.

## What's still deferred after Phase 2

- **Provider-agnostic agent definitions.** Today an `AgentDefinition`
  lists Claude tool names. A Codex sub-agent gets the closest mapping
  the bridge can manage. A future cleanup is a `tool-name` translation
  layer in `packages/contracts/src/tools.ts`.
- **Model auto-selection.** Today the user picks the sub-agent's
  model. Future: memoize suggests "based on this prompt, gpt-5-mini
  would be ~3× cheaper than Haiku for the same quality, switch?"
- **Parallel cross-provider fan-out.** Phase 2's bridge is one
  sub-session at a time. Real fan-out (run `research` on Claude *and*
  Codex, take whichever finishes first) is a separate concern.

## Implementation order (when Phase 2 lands)

1. `apps/server/src/provider/mcp/memoize-bridge.ts` + register with
   the parent driver's MCP layer.
2. `CrossProviderInvocationEvent` in `packages/contracts/src/agent.ts`.
3. Cross-provider preset entries in
   `apps/renderer/src/lib/subagent-presets.ts`.
4. Renderer badge update + provider arrow icon.
5. Settings UI cross-provider section.
6. Mirror sensitive-path checks into the Codex driver.

ADR [0012-codex-bridge-via-mcp.md](../decisions/0012-codex-bridge-via-mcp.md)
records the "MCP bridge, not SDK fork" decision.
