# Feature: Sub-agents

The main agent (Opus 4.7 by default for Claude sessions) can delegate
scoped sub-tasks to cheaper sub-agents (Haiku 4.5 / Sonnet 4.6). Each
sub-agent runs in its own context window with its own system prompt and
tool subset; only the final summary returns to the parent's context.

This document covers the wire schema, the driver, persistence, the UI
wrapper-row design, the permission flow, and the per-agent token
accounting. The seed sub-agents themselves are in
[preset-library.md](preset-library.md). Cross-provider bridging (Claude
main → Codex sub) is in [cross-provider.md](cross-provider.md).

## Why this works without re-architecting

The Claude Agent SDK already exposes the primitive. From
`@anthropic-ai/claude-agent-sdk`:

```ts
type Options = {
  // …
  allowedTools?: string[];                       // must include "Agent"
  agents?: Record<string, AgentDefinition>;       // ← the new lever
};

type AgentDefinition = {
  description: string;        // when Claude should delegate to this agent
  prompt: string;             // the agent's system prompt
  tools?: string[];           // allowlist; omit to inherit
  disallowedTools?: string[]; // denylist
  model?: "sonnet" | "opus" | "haiku" | "inherit" | string; // alias or full id
  maxTurns?: number;
  permissionMode?: PermissionMode;
};
```

When `Agent` is in `allowedTools` and the user (or main agent) hits a task
that matches an agent's `description`, the SDK emits a `tool_use` block
with `name: "Agent"` and an input shape `{ subagent_type, prompt, model? }`.
Subsequent SDK messages carry `parent_tool_use_id` pointing to that
`tool_use.id`, marking them as "from inside the sub-agent's context."
When the sub-agent finishes, a `tool_result` for that id lands carrying
the sub-agent's final message as text.

Memoize's job is therefore narrow:

1. Forward an `agents` map from the wire into the SDK options.
2. Propagate `parent_tool_use_id` onto every emitted wire event.
3. Render nested events under a wrapper row in the renderer.
4. Persist the `parent_item_id` chain so resume works.
5. Surface per-agent token cost.

That's the whole feature. No new agent runtime, no manual orchestration.

## Wire schema deltas

All edits live in `packages/contracts/src/agent.ts`.

### New schema: `AgentDefinition`

Mirror of the SDK shape (subset that we expose today):

```ts
export const AgentDefinition = Schema.Struct({
  description: Schema.String,
  prompt: Schema.String,
  tools: Schema.optional(Schema.Array(Schema.String)),
  disallowedTools: Schema.optional(Schema.Array(Schema.String)),
  model: Schema.optional(Schema.String),
  maxTurns: Schema.optional(Schema.Number),
  // permissionMode reuses our existing RuntimeMode literal set.
  permissionMode: Schema.optional(RuntimeMode),
});
export type AgentDefinition = typeof AgentDefinition.Type;
```

We do **not** expose `skills`, `mcpServers`, `memory`, `effort`,
`background`, or `isolation` in this PR. They're additive — each can come
back as a follow-up if a use case appears.

### `StartSessionInput` extension

```ts
export const StartSessionInput = Schema.Struct({
  folderId: FolderId,
  providerId: ProviderId,
  mode: SessionMode,
  initialPrompt: Schema.optional(Schema.String),
  sessionId: Schema.optional(AgentSessionId),
  model: Schema.optional(Schema.String),
  // NEW
  agents: Schema.optional(Schema.Record({
    key: Schema.String,
    value: AgentDefinition,
  })),
  enableSubagents: Schema.optional(Schema.Boolean), // defaults true when agents non-empty
});
```

### `parentItemId` on streamed events

Every event that can originate from inside a sub-agent gains an optional
`parentItemId: AgentItemId`. Concretely:

- `AssistantMessageEvent`
- `ThinkingEvent`
- `ToolUseEvent`
- `ToolResultEvent`
- `PermissionRequestEvent` (so the toast can label the requester)

Existing top-level events (`Started`, `Status`, `Auth`, `Capabilities`,
`SessionCursor`, `Completed`, `Error`) are not affected — they belong to
the parent session.

### New event: `SubagentSummary`

Emitted when the parent's `tool_result` for an `Agent` tool_use lands. The
wrapper-row footer reads from this when collapsed.

```ts
const SubagentSummaryEvent = Schema.TaggedStruct("SubagentSummary", {
  itemId: AgentItemId,            // matches the parent ToolUse.itemId
  agentName: Schema.String,        // e.g. "research"
  model: Schema.String,            // e.g. "claude-haiku-4-5"
  turns: Schema.Number,            // sub-agent turn count
  durationMs: Schema.Number,
  summary: Schema.String,          // sub-agent's final assistant text
  isError: Schema.Boolean,
});
```

### New event: `UsageDelta`

Per-turn usage for the agent that just emitted a `result` message. Tagged
with the same `parentItemId` rule as other nested events; absent
`parentItemId` means the usage belongs to the main agent.

```ts
const UsageDeltaEvent = Schema.TaggedStruct("UsageDelta", {
  parentItemId: Schema.optional(AgentItemId),
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  cacheCreationTokens: Schema.Number,
  model: Schema.String,
});
```

Pricing is computed renderer-side from a static table next to
`MODELS_BY_PROVIDER`. The wire stays just numbers.

### New static export: `MODEL_PRICING`

```ts
// USD per million tokens (input, output, cache_read, cache_create).
export const MODEL_PRICING: Record<string, {
  input: number; output: number; cacheRead: number; cacheCreate: number;
}> = {
  "claude-opus-4-7":   { input: 15, output: 75, cacheRead: 1.50, cacheCreate: 18.75 },
  "claude-sonnet-4-6": { input:  3, output: 15, cacheRead: 0.30, cacheCreate:  3.75 },
  "claude-haiku-4-5":  { input:  1, output:  5, cacheRead: 0.10, cacheCreate:  1.25 },
};
```

(Numbers are illustrative; actual table populated from current pricing at
implementation time and updated alongside `MODELS_BY_PROVIDER`.)

## Driver changes

All edits live in `packages/agents/src/drivers/claude.ts`.

### `start()` — pass `agents` into SDK options

```ts
const options: Options = {
  // …existing config…
  agents: input.agents ?? {},
  allowedTools: hasAgents
    ? Array.from(new Set([...(existing ?? []), "Agent"]))
    : existing,
};
```

If `enableSubagents === false` (or no `agents` map provided), we leave
`allowedTools` alone and the `Agent` tool stays unavailable. This is the
"opt-out" path — sessions without sub-agent presets behave identically to
today.

### `translate()` — propagate `parent_tool_use_id`

The current `translate()` produces wire events from SDK messages. Every
SDK `assistant`, `user`, and `result` message carries an optional
`parent_tool_use_id` field. Update the function signature:

```ts
const translate = (
  msg: SDKMessage,
  state: TranslateState,
): ReadonlyArray<AgentEvent> => {
  const parentItemId =
    typeof (msg as { parent_tool_use_id?: unknown }).parent_tool_use_id === "string"
      ? ((msg as { parent_tool_use_id: string }).parent_tool_use_id as AgentItemId)
      : undefined;

  // …existing branches, but each output event spreads `parentItemId` if defined
};
```

Every `AssistantMessage`, `Thinking`, `ToolUse`, `ToolResult` produced
inside the function gets `parentItemId` attached when it's set on the SDK
message.

### Match both `"Agent"` and `"Task"`

Per Anthropic's [SDK subagents doc](https://code.claude.com/docs/en/agent-sdk/subagents),
the tool was renamed from `"Task"` to `"Agent"` in v2.1.63 but both names
still appear (current versions emit `"Agent"` in `tool_use` blocks but
still use `"Task"` in `system:init` tools list and
`result.permission_denials[].tool_name`). When detecting a sub-agent
invocation, accept either:

```ts
const isAgentToolUse = (block: { type: string; name?: string }) =>
  block.type === "tool_use" && (block.name === "Agent" || block.name === "Task");
```

### Emit `SubagentSummary` on tool_result

When a `tool_result` lands whose `tool_use_id` matches a previously seen
`Agent`/`Task` tool_use:

```ts
const summary: SubagentSummary = {
  _tag: "SubagentSummary",
  itemId: block.tool_use_id as AgentItemId,
  agentName: pendingAgent.subagent_type,
  model: pendingAgent.model ?? "inherit",
  turns: pendingAgent.turnCount,
  durationMs: Date.now() - pendingAgent.startedAt,
  summary: extractText(block.content),
  isError: block.is_error === true,
};
```

`pendingAgent` is a small in-handle map keyed by `tool_use.id`,
populated when the parent emits the `Agent` tool_use and updated as
nested SDK messages land.

### Emit `UsageDelta`

Each SDK `result` message carries `usage`. Emit a `UsageDelta` with the
correct `parentItemId` (if the result has `parent_tool_use_id`, this
result belongs to the sub-agent; otherwise it's main-agent usage).

### Sensitive paths still apply

`policyFor()` (`claude.ts:484`) is unchanged. `parent_tool_use_id` is a
*hint* for the permission UI, not a policy lever. A sub-agent reading
`~/.ssh/id_rsa` still triggers the sensitive-path prompt.

## Provider service

`apps/server/src/provider/services/provider-service.ts` plumbs
`agents` and `enableSubagents` through to the driver and persists the
config onto the session row. On resume, it reads `agents_json` back and
passes it into `start()` so the resumed session has the same sub-agent
roster as when it was created.

## Persistence

`apps/server/src/provider/layers/message-store.ts` adds two columns:

- `sessions.agents_json TEXT NULL` — JSON-serialized `agents` map.
- `messages.parent_item_id TEXT NULL` — references the parent
  `Agent`/`Task` tool_use's `itemId`. Nullable; null means "top-level."

Migration is additive (Phase 1 SQLite migrations are append-only). Insert
path: when the driver emits a wire event with `parentItemId`, persist
that value on the row. The renderer reads `messages.*` and builds the
nesting client-side.

Sub-agent message rows are stored just like main-agent rows — same
table, same columns. Keeps the export / scrollback / search story
unchanged. Renderer logic is one line: "if `parent_item_id` is set, group
under that parent."

## UI — "Agent is just one more wrapper row"

The `Agent` tool call IS a tool call. The wrapper row visually mirrors
the existing `tool-row.tsx` style (hugeicons + muted-foreground + chevron
swap on hover, per the project's [accordion pattern](../../../.claude/projects/-Users-whizzy-Developer-startups-memoize/memory/feedback_accordion_pattern.md)
and [icon convention](../../../.claude/projects/-Users-whizzy-Developer-startups-memoize/memory/feedback_icons_hugeicons.md)).

Inside, every nested call uses `tool-row.tsx` *unchanged*, with a single
`indented` prop that draws a left rail.

```
🤖 Agent  Find syndicate card on investor dashboard      ▾
   📋 Prompt
   📁 Glob  apps/web/**/*syndicate*
   📁 Glob  apps/web/**/*investor*
   🔍 grep for 'View syndicate' in apps/web   5 matches
   📄 Read 235 lines    [syndicate-card.tsx]
   📁 Glob  apps/web/src/app/**/*investor*page*
   📄 Read 672 lines    [page.tsx]
   ▶ Bash  grep -n "CardFrame…"
   📄 Read 287 lines    [card.tsx]
   Perfect! Now I have all the information needed. Let me create a comprehensive report:
```

### Components

| Component | Path | Change |
|---|---|---|
| `subagent-row.tsx` | `apps/renderer/src/components/subagent-row.tsx` | NEW. Layout shell. |
| `tool-row.tsx` | `apps/renderer/src/components/tool-row.tsx` | Add `indented` prop. |
| `message-row.tsx` | `apps/renderer/src/components/message-row.tsx` | Route by `parentItemId`. |
| `chat-view.tsx` | `apps/renderer/src/components/chat-view.tsx` | Render top-level events through grouping. |
| `permission-toast.tsx` | `apps/renderer/src/components/permission-toast.tsx` | Prepend "via *agent name* · *model* ·" when `parentItemId` is set. |
| `messages.ts` | `apps/renderer/src/store/messages.ts` | Derive `byParent: Map<AgentItemId, AgentEvent[]>`. |
| `chat-composer.tsx` | `apps/renderer/src/components/chat-composer.tsx` | "↳ Sub-agents: 3 enabled" chip → opens settings. |

### `subagent-row.tsx` shape

```tsx
type Props = {
  agentItemId: AgentItemId;
  agentName: string;       // "research"
  prompt: string;          // first arg of Agent tool_use input
  model?: string;          // "claude-haiku-4-5"
  status: "running" | "completed" | "error";
  // children pulled from store.byParent.get(agentItemId)
};
```

The row layout reuses the same grid template `tool-row.tsx` uses today —
icon cell, label cell, inline-chip cell, trailing meta cell. The only
new sub-element is the `Prompt` row at the top of the children list,
rendered as a clipboard-icon row with the same styling.

### Default expansion behavior

- **Live-streaming** (status === "running"): expanded so the user can
  watch the sub-agent work.
- **Completed**: auto-collapse to a single-row meta line:
  `Haiku 4.5 · 7 tools · 18.4k tok · ~$0.02`. Click expands.
- **Error**: stay expanded so the user sees the failure context.

### Indent depth

Sub-agents cannot themselves spawn sub-agents (SDK constraint), so the
renderer only ever needs `depth ∈ {0, 1}`. `tool-row.tsx`'s `indented`
prop is a boolean — sufficient until the constraint changes upstream.

## Settings

This ships a **full settings page section**, not a per-session picker.

`apps/renderer/src/components/settings-page.tsx` already exists. We add a
new section: **Sub-agents**. Layout:

```
┌─ Sub-agents ─────────────────────────────────────────────┐
│  Let your main agent delegate scoped tasks to cheaper    │
│  models. Saves tokens on long sessions.                  │
│  [☑] Enable sub-agents for new sessions                  │
│                                                          │
│  ┌───────────────────────────────────────────────────┐   │
│  │ ☑  research                          Haiku 4.5 ▾  │   │
│  │    Read-only codebase exploration.   [Edit ▸]     │   │
│  ├───────────────────────────────────────────────────┤   │
│  │ ☑  file-edits                       Sonnet 4.6 ▾  │   │
│  │    Apply well-defined file changes.  [Edit ▸]     │   │
│  ├───────────────────────────────────────────────────┤   │
│  │ ☑  test-runner                       Haiku 4.5 ▾  │   │
│  │    Run a test suite, report.         [Edit ▸]     │   │
│  └───────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

- Master toggle gates `enableSubagents` for *new* sessions. Existing
  sessions keep whatever was set when they were created (resume parity).
- Per-preset toggle controls inclusion in the `agents` map sent to the
  driver.
- Model dropdown — values come from
  `MODELS_BY_PROVIDER["claude"]`. Changing it updates the preset for
  future sessions.
- **Edit** opens a sheet with `description`, `prompt`, `tools` (multi-select
  from the known tool names), `maxTurns`. No "create new" button in this
  PR — only the three seeds, editable.
- All settings persist via the existing settings RPC into the same JSON
  store used by other preferences. New file: `subagents.json`.

A new Zustand slice `store/subagents.ts` reads/writes this.

The `chat-composer.tsx` chip ("↳ Sub-agents: 3 enabled") clicks through
to this section.

## Permissions

Sub-agent tool calls flow through the **same** `canUseTool` callback. No
new RPC, no new policy.

- **Toast text**: when the call has `parent_tool_use_id`, prepend
  `via research · Haiku 4.5 ·` to the existing message. One-line change
  in `permission-toast.tsx`. Source the human name from the
  `subagent-presets` lookup.
- **Permissions inspector**: row gets a small "agent" badge showing the
  sub-agent's name when nested. Filter chip "Show only sub-agent calls"
  added to the inspector header.
- **Sensitive paths**: unchanged. `.env`, `.ssh/`, `*.pem` etc. always
  prompt regardless of nesting.
- **Always-allow scope**: the existing always-allow rules apply across
  the whole session, not per-agent. (Per-agent allow lists are a
  legitimate request but out of scope here.)

## Cost surfacing

The transcript footer (small text below the latest assistant message)
gains a per-agent breakdown:

```
Opus: 4.2k in / 1.1k out · Haiku (research): 18.4k in / 412 out · saved ~$0.34
```

"Saved" is computed as: cost the entire transcript would have been if
all sub-agent turns ran on the main model, minus actual cost. Pure
visualization — no functional impact.

Renderer reads `MODEL_PRICING` from `@zuse/contracts`. When a sub-agent
finishes, the cumulative numbers update in place.

## Open questions left for implementation

- **Default `enableSubagents` value for *new* sessions.** Likely `true`
  when at least one preset is enabled and the session model is Opus
  (highest savings); otherwise `false`. To be confirmed with a couple of
  smoke runs.
- **Auto-collapse threshold.** Sub-agents that finished in <2s might be
  noise — consider auto-hiding entirely (with a "+1 sub-agent run" chip
  to expand). Defer until we see real usage.
