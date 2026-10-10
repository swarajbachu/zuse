# Generated UI in transcripts

Agents can call `emit_ui({ spec })` through the session's orchestration tools to
publish a small OpenUI Lang dashboard. The tool is available to providers through
the shared MCP gateway and Claude's native tool adapter. Successful calls return
the persisted message ID; invalid specs return an error the agent can correct.

```text
emit_ui → shared validation → persistMessage → ui_spec timeline row
                                             ├─ desktop/web: native components
                                             ├─ mobile: selectable source
                                             └─ export/read_thread: full source
```

The source is stored as `{ _tag: "ui_spec", spec, version: 1 }` using the normal
message persistence and event stream. Reconnects and transcript replay do not
execute generation again. Each successful tool call appends a new snapshot.

## Component library

`packages/utils/src/generative-ui.ts` owns component names, positional prop
schemas, prompt signatures, and validation. The renderer maps every catalogue
entry to a typed implementation; adding a component requires both a schema and a
renderer. Existing argument order is part of the saved format and must remain
compatible.

Components: Card, Text, Stat, KeyValue, Table, Progress, Badge, List, Grid,
BarChart, LineChart, and FollowUps. Charts use ordered `{ label, value }` points and an
optional unit. Grids collapse with available chat width. The line chart uses
Zuse's existing chart implementation, exposes values for assistive technology,
and supports pointer inspection. Bar charts support negative and zero values.

```openui
root = Card([Grid([Stat("Tests", "428 passed"), Progress("Build", 100)], 2), trend, next], "Build health")
trend = LineChart("Build duration", [{label: "Mon", value: 12}, {label: "Tue", value: 9}], "s")
next = FollowUps([{label: "Profile slow build", prompt: "Profile the Tuesday build and explain the slowest step."}])
```

## Follow-ups

FollowUps is the only interactive component. Each button raises OpenUI's
built-in `continue_conversation` action. The renderer's `onAction` puts the
prompt at the cursor in the source session's composer through
`insertIntoCurrentComposer`. It never sends the prompt. If the mounted composer
belongs to a different session, the prompt is not inserted and a toast asks the
user to open the chat. Read-only transcripts render disabled buttons. Other
action types are ignored.

Arguments are positional. Use one assignment per line, define `root`, and pass
literal data or named references. Short answers should remain ordinary text.

## Validation and failure behavior

- Input is capped at 32,768 characters before parsing.
- A preflight over OpenUI's AST bounds reference expansion to 4,096 visited
  nodes and a depth of 48 before the parser materializes the tree. Cycles,
  duplicate names, reactive state, expressions, and non-catalogue calls fail.
- Full Zod validation enforces ranges and collection limits that the parser's
  type validation alone does not enforce. Containers accept up to 64 children;
  charts accept 1–100 finite numeric points; tables accept 1–20 columns and up to
  200 rows with matching cell counts. Progress is between 0 and 100.
- Validation runs before persistence and again when reading a saved block.
- Parser failures, component errors, and lazy chunk failures preserve a source
  fallback instead of taking down the transcript. Text is rendered as text,
  never as model-provided HTML.
- The renderer is lazy-loaded. Ordinary messages do not load its chart code.
  OpenUI observability publishing is disabled for message contents.

This implementation publishes complete snapshots. It does not stream partial
tool arguments, refresh live data, accept form submissions, send messages, or
execute `Query`, `Mutation`, or actions beyond the composer handoff above. Those features need a session-scoped interaction
protocol, durable interaction state, and integration with the permission broker.
The native mobile client currently exposes source rather than rich components.

## Verification

- `packages/utils/test/unit/generative-ui.test.ts`: static subset, component
  constraints, malformed data, cycles, and expansion limits.
- `apps/server/test/unit/generative-ui.test.ts`: validation before persistence,
  storage failures, JSON replay, readback, and safe Markdown export fences.
- `packages/agents/test/integration/mcp-gateway.test.ts`: authenticated gateway
  discovery and dispatch without mutation approval for this display-only tool.
- `apps/renderer/test/unit/ui-spec-block.test.tsx`: native markup, charts,
  accessible values, fallback source, HTML escaping, and follow-up enablement.
- `apps/renderer/test/unit/context-handoff-target.test.ts`: follow-ups only
  reach the source session's composer.

OpenUI packages are pinned together at 0.3.0. Check saved version-1 fixtures and
browser rendering when upgrading them. Reference: https://www.openui.com/docs/openui-lang
