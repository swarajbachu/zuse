# Phase 2 — Agents (backend)

**Goal**: running an agent in a folder is a first-class action. Two modes: spawn the CLI in the terminal (works for everything) or use the SDK with a structured side panel.

**Status**: ✅ Backend shipped. UI shell (Cmd+K launcher + single right-side timeline panel) is **superseded by [Phase 3 — Chat-first MVP](03-chat-mvp.md)**. The backend (provider availability, credentials, Claude/Codex SDK adapters, `agent.events` stream) is reused unchanged in Phase 3.

> **Heads up:** This file describes the original terminal-first plan. It is kept for history. The current product direction is chat-first — see `vision.md` and `phases/03-chat-mvp.md`.

**Estimate**: ~4 weeks

**Depends on**: Phase 1

## Deliverables

1. Detect installed `claude` and `codex` CLIs (PATH lookup + version check)
2. Sidebar action: "Run agent here" → menu of detected agents → spawn in terminal
3. Claude Code SDK adapter (Effect Service)
4. OpenAI Codex SDK adapter (Effect Service)
5. Agent side panel: streaming events, tool calls, file writes, status
6. Provider switcher per session
7. Credential management via OS keychain (`keytar`)

## User scenarios

### S1 — Spawn-CLI quick start
> I have a folder open. I press `Cmd+K`, type "claude", hit enter. A new terminal opens (or current terminal if empty) and runs `claude` with cwd set to the folder. From here it's whatever the CLI does.

### S2 — SDK-integrated session
> I click "New agent session" → "Claude Code (SDK)". A side panel opens to the right of the terminal showing: status (idle/running/waiting), a live stream of tool calls (Read, Edit, Bash), each expandable. The terminal is still there for me to type in alongside.

### S3 — Provider switch
> Mid-session I want to try Codex on the same prompt. I click the provider chip → "Codex". Current session stays in history; a new session starts with the same opening prompt.

### S4 — Missing credentials
> I select Claude SDK but I haven't set up an API key. The panel shows a "Set API key" button that opens a settings sheet. Key is stored via `keytar`.

## Architecture

**Adapter pattern** for agents. Each provider implements the same interface:

```ts
interface AgentAdapter {
  readonly id: "claude" | "codex"
  readonly displayName: string
  detectAvailability: Effect<AgentAvailability, AgentError>
  startSession(input: StartSessionInput): Effect<AgentSession, AgentError>
  // AgentSession exposes: events: Stream<AgentEvent>, sendMessage, interrupt, close
}
```

**Spawn-CLI** is not an adapter — it's just a special PTY launch with a known argv. Lives in `services/agent/spawn.ts`.

**SDK adapters** wrap the official SDK in an Effect Service. They translate SDK callbacks/streams into a uniform `AgentEvent` discriminated union:

```ts
type AgentEvent =
  | { _tag: "Started"; sessionId: string }
  | { _tag: "AssistantMessage"; text: string }
  | { _tag: "ToolUse"; tool: string; input: unknown; id: string }
  | { _tag: "ToolResult"; id: string; output: unknown; isError: boolean }
  | { _tag: "PermissionRequest"; kind: PermissionKind; details: unknown }  // Phase 3
  | { _tag: "Completed"; reason: "ended" | "interrupted" | "error" }
  | { _tag: "Error"; cause: AgentError }
```

## IPC contracts

```ts
// agent.ts (in packages/contracts)
export const AgentAvailability = Schema.Struct({
  id: Schema.Literal("claude", "codex"),
  cliInstalled: Schema.Boolean,
  cliVersion: Schema.optional(Schema.String),
  sdkConfigured: Schema.Boolean,    // credentials present
})

export const StartSessionInput = Schema.Struct({
  folderId: Schema.String,
  provider: Schema.Literal("claude", "codex"),
  mode: Schema.Literal("spawn-cli", "sdk"),
  initialPrompt: Schema.optional(Schema.String),
})
```

## IPC channels (additions)

| Channel | Direction | Notes |
|---|---|---|
| `agent:availability` | renderer → main | Returns `AgentAvailability[]` |
| `agent:start` | renderer → main | Returns `{ sessionId }` |
| `agent:send` | renderer → main | `{ sessionId, text }` |
| `agent:interrupt` | renderer → main | `{ sessionId }` |
| `agent:close` | renderer → main | `{ sessionId }` |
| `agent:events` | main → renderer (stream) | per-session event stream |
| `agent:setCredential` | renderer → main | `{ provider, key }` — writes to keychain |

## New files

- `apps/desktop/src/services/agent/`
  - `availability.ts` — PATH lookup, version probe
  - `spawn.ts` — spawn-CLI launcher
  - `claude.ts` — Claude SDK adapter (Effect Service)
  - `codex.ts` — Codex SDK adapter (Effect Service)
  - `events.ts` — `AgentEvent` schema + serialization
  - `credentials.ts` — `keytar` wrapper as Effect Service
- `apps/renderer/src/components/agent-panel.tsx` — side panel
- `apps/renderer/src/components/agent-event-row.tsx` — one event row
- `apps/renderer/src/components/agent-launcher.tsx` — Cmd+K launcher

## Acceptance criteria

- [ ] On a machine with `claude` in PATH, "Run agent here" → "Claude (CLI)" launches it in the active folder's terminal
- [ ] On a machine without `claude` installed, the menu item is grayed out with "Install Claude Code" link
- [ ] Starting an SDK session streams `AssistantMessage` events to the panel within 2s of API response
- [ ] Tool-use events render with the tool name and a collapsed JSON input; click to expand
- [ ] Interrupting a session stops streaming within 500ms
- [ ] Credentials never appear in process listings, logs, or NDJSON transcripts
- [ ] Switching provider mid-conversation starts a new session, preserves the old one in the sessions list

## Verification

1. Spawn-CLI: with `claude` installed, full flow works
2. SDK: with `ANTHROPIC_API_KEY` set in keychain, ask "list files in this folder" → see Read tool calls stream in
3. Repeat with Codex SDK
4. Quit during an active SDK session — no orphan processes; restart shows session in history (Phase 3 makes it resumable)

## Risks

- **SDK API changes.** Both SDKs are pre-1.0. Pin versions; wrap in adapter so updates are localized.
- **Long-running streams across IPC.** Mitigation: chunked JSON over IPC with backpressure (Effect Stream → IPC frames).
- **Permission prompts come from the SDK before Phase 3 ships.** For Phase 2 we auto-deny anything dangerous and surface a "Phase 3 will let you allow this" toast.
