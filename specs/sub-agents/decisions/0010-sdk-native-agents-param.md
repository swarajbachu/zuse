# 0010 — Use the SDK's `agents` parameter for sub-agent delegation

Status: Accepted (2026-05-04)

## Context

The sub-agents feature ([../features/sub-agents.md](../features/sub-agents.md))
needs a way for the main agent to delegate scoped sub-tasks to a cheaper
model. There are three viable shapes:

1. Use Anthropic's Agent SDK `agents` parameter — the official primitive,
   built on the SDK's `Agent` (formerly `Task`) tool.
2. Hand-roll a router on top of the existing single-session SDK calls —
   parse the parent's intent, decide a model, spawn a fresh `query()`
   ourselves, plumb the result back as a synthetic assistant message.
3. Wrap each sub-agent as a custom MCP tool — the parent calls e.g.
   `memoize.research(prompt)` and we run it however we like under the
   hood.

## Options

### Option 1 — SDK-native `agents` parameter

The shape is documented in
[https://code.claude.com/docs/en/agent-sdk/subagents](https://code.claude.com/docs/en/agent-sdk/subagents):

```ts
query({
  prompt: input,
  options: {
    allowedTools: [..., "Agent"],
    agents: {
      research: {
        description: "...",
        prompt: "...",
        tools: ["Read", "Glob", "Grep"],
        model: "haiku",
      },
    },
  },
})
```

The SDK handles invocation (`Agent` tool_use), context isolation
(separate fresh context window per sub-agent), result return (final
message returns as `tool_result`), and `parent_tool_use_id` correlation.
Memoize just consumes the existing event stream.

**Pros**

- Zero orchestration code on our side. The SDK is the orchestrator.
- Anthropic-tested against the same scenarios we want to support
  (research, file edits, parallel fan-out).
- Per-sub-agent context isolation is *real* — the sub-agent's tool
  results don't pollute the parent's context window. Hand-rolling this
  correctly is non-trivial.
- New SDK features (resumed sub-agents, background sub-agents,
  per-invocation model overrides) ship for free as we adopt them.
- `parent_tool_use_id` already arrives on every SDK message — we just
  forward it onto the wire as `parentItemId`.

**Cons**

- Locks us deeper into Anthropic's SDK shape. (We're already locked in
  for the Claude provider; this is incremental, not new.)
- Only spawns Claude sub-agents. Cross-provider needs a different path
  (the MCP bridge — see ADR
  [0012-codex-bridge-via-mcp.md](0012-codex-bridge-via-mcp.md)).

### Option 2 — Hand-roll a router

Detect when the main agent should delegate (regex / heuristic on the
prompt? embed-and-classify?), call `query()` again with a different
model, splice the result back into the parent stream as a synthetic
assistant message.

**Pros**

- Provider-agnostic. The same router handles Claude → Codex, Codex →
  Claude, Codex → Codex.
- Full control over routing logic.

**Cons**

- We re-implement what the SDK already does well: context isolation,
  delegation decisions, tool-set scoping, result correlation. Each
  sub-feature is a sharp edge (concurrent sub-agents, partial failures,
  cancellation, resume).
- Routing decisions get worse than letting the model decide. Asking
  Opus "should I delegate this to Haiku?" via the `Agent` tool's
  description-matching is *exactly* the routing layer, run by the
  smartest part of the system. A regex router will be wrong in subtle
  ways.
- Kicking off a fresh `query()` inside an existing one is a tangle of
  Effect scopes, message ordering, and mailbox coordination we haven't
  needed yet.

### Option 3 — Each sub-agent as a custom MCP tool

Define `memoize.research`, `memoize.file-edits`, `memoize.test-runner`
as MCP tools. The parent agent calls them like any other tool.

**Pros**

- Same code path as cross-provider bridging will use anyway (see ADR
  0012).
- Fully provider-agnostic.

**Cons**

- For the same-provider case we'd be running our own MCP server *just*
  to invoke a sub-process of the same SDK we're already using —
  pointless overhead.
- The Agent tool's description-driven dispatch + per-invocation model
  overrides + context isolation are all things we'd be re-doing.
- No `parent_tool_use_id` for free — we'd synthesize one and hope.

## Decision

**Use the SDK's `agents` parameter (Option 1) for same-provider
sub-agents.** Cross-provider sub-agents go through the MCP bridge
(Option 3-style, recorded in ADR 0012). Option 2 is rejected entirely.

The same-provider case is the immediate win (Opus → Haiku for research
in long sessions); doing it through the SDK's own primitive is the
shortest path with the strongest correctness guarantees.

## Consequences

- `packages/agents/src/drivers/claude.ts` gains an `agents` field
  in its `Options` construction and `"Agent"` in `allowedTools`. About a
  dozen lines.
- `translate()` propagates `parent_tool_use_id` to wire events. About
  five lines.
- The wire schema gains optional `parentItemId` on streamed events plus
  two new events (`SubagentSummary`, `UsageDelta`). Additive only.
- We accept that cross-provider sub-agents need a different mechanism
  (the MCP bridge). They can't share the SDK's `agents` primitive —
  that's an Anthropic-only construct. ADR 0012 covers the bridge.
- We do **not** add a routing heuristic, intent classifier, or any
  memoize-side decision about when to delegate. The main model
  decides, based on each sub-agent's `description`. Tuning the
  descriptions is the operator surface.
