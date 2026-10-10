# Generated UI in transcripts

Agents can call `emit_ui({ spec })` through the session's orchestration tools to
render OpenUI Lang UI inline in their reply: dashboards, plans, comparisons, and
forms. The tool is available to providers through the shared MCP gateway and
Claude's native tool adapter. Successful calls return the persisted message ID;
invalid specs return an error the agent can correct.

```text
emit_ui → shared validation → persistMessage → ui_spec timeline row
                                             ├─ desktop/web: inline components
                                             ├─ mobile: selectable source
                                             └─ export/read_thread: full source
```

The source is stored as `{ _tag: "ui_spec", spec, version: 1 }` using the normal
message persistence and event stream. Reconnects and transcript replay do not
execute generation again. Each successful tool call appends a new snapshot.

## Presentation

The block renders as part of the assistant reply, aligned with assistant text,
with no card surface or background. A successful `emit_ui` call has no tool row
of its own: `normalizeTimelineMessages` drops its tool use and result, so the
block is the visible output. Failed calls keep their tool rows so the error is
visible. `isEmitUiTool` in `@zuse/client-runtime/generative-ui` is the single
check for the tool name.

## Component library

`packages/utils/src/generative-ui.ts` owns component names, positional prop
schemas, prompt signatures, and validation. The renderer maps every catalogue
entry to a typed implementation; adding a component requires both a schema and a
renderer. Existing argument order is part of the saved format and must remain
compatible.

- Display: Card (titled section), Text, Stat, KeyValue, Table, Progress, Badge,
  List, Grid, Callout, Steps, Tabs.
- Charts: BarChart, LineChart. Points are ordered `{ label, value }` pairs with
  an optional unit.
- Interaction: FollowUps, Form, and the fields Input, TextArea, Select,
  RadioGroup, Checkbox, Slider.

```openui
root = Form([env, region, migrate, rollout, notes], "Deploy", "Deploy settings")
env = RadioGroup("env", "Environment", ["staging", "production"], "staging")
region = Select("region", "Region", ["us-east-1", "eu-west-1"])
migrate = Checkbox("migrate", "Run database migrations", true)
rollout = Slider("rollout", "Initial rollout %", 0, 100, 25, 5)
notes = TextArea("notes", "Anything else?")
```

## Interaction

FollowUps buttons and Form submissions raise OpenUI's built-in
`continue_conversation` action. The renderer's `onAction` sends the response as
the user's next message through `sendThroughCurrentComposer`, which uses the
mounted composer's send-or-queue routing without touching the user's draft. A
form sends its title and one `- Label: value` line per field, so the agent
receives an ordinary user turn.

- Only blocks in the latest turn accept input (`interactive` on timeline rows).
  Older blocks and read-only transcripts render disabled controls.
- A block sends at most once, then locks and marks the chosen action as sent.
- If the mounted composer belongs to another session, nothing is sent and a
  toast asks the user to open the chat.
- Form values are local UI state. After reload, the sent answers remain in the
  user's message and the old form stays locked because it is no longer in the
  latest turn.

Fields must be inside a Form, have unique names, and forms cannot nest. Select
and RadioGroup values must be options; Slider values must be within range.

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
  `apps/renderer/src/lib/openui-devtools.ts` suppresses the Inspect widget
  that `@openuidev/react-lang` otherwise auto-mounts in development builds.

This implementation publishes complete snapshots. It does not stream partial
tool arguments, refresh live data, or execute `Query`, `Mutation`, or actions
beyond sending the user's response. Those features need a session-scoped interaction
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
  forms, tabs, steps, fallback source, HTML escaping, and enablement.
- `apps/renderer/test/unit/context-handoff-target.test.ts`: responses only
  reach the source session's composer.
- `apps/renderer/test/unit/chat-timeline-rows.test.ts` and
  `packages/client-runtime/test/unit/timeline.test.ts`: inline placement, hidden
  successful calls, and latest-turn interactivity.

OpenUI packages are pinned together at 0.3.0. Check saved version-1 fixtures and
browser rendering when upgrading them. Reference: https://www.openui.com/docs/openui-lang
