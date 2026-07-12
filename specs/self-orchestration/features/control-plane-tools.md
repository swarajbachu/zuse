# Control-plane tools (Layer 1) — SHIPPED in Phase 1

The control plane is the set of in-process MCP tools that let an agent
orchestrate its OWN work the way a human operator would: spin up a worktree,
open a new thread, hand it a task, and read back its progress. This is the
foundation the loop engine ([loop-engine.md](loop-engine.md)) builds on.

## The tools

Registered in the existing `memoize` MCP server, so the model sees them as
`mcp__memoize__<tool>` alongside the index + browser tools.

| Tool | Mutating? | Wraps | Returns |
|---|---|---|---|
| `create_worktree({ baseBranch? })` | yes | `WorktreeService.create` | `{ worktreeId, path, branch }` |
| `create_thread({ title, prompt, worktreeId?, providerId?, model? })` | yes | `MessageStore.createChat` | `{ chatId, sessionId, title }` |
| `send_to_thread({ sessionId, text })` | yes | `MessageStore.sendMessage` | `{ ok, queued }` |
| `read_thread({ sessionId, limit? })` | no | `getSession` + `listMessages` | `{ status, messages: [{role,text}] }` |
| `list_threads({ includeArchived? })` | no | `listChats` + `listSessions` | `{ threads: [...] }` |
| `whoami()` | no | (context) | `{ sessionId, chatId, projectId, autonomyLevel }` |

`create_thread` tags the new chat with `originSessionId = <spawning session>`
for lineage. `send_to_thread` reports `queued: false` today (Phase 1 sends
directly); Phase 2 routes to the message queue when the target is mid-turn.

Defined in `packages/agents/src/drivers/orchestration-tools.ts`,
mirroring `code-index/claude-tools.ts` and `browser-tools.ts`: plain-async
handlers the SDK invokes directly, kept free of Effect wiring. Each handler
calls a promise-bound dep that returns a `{ ok, ... } | { ok: false, error }`
result, so the tool surface never throws (same convention as
`BrowserCommandResult`).

## Injection path (no layer cycle)

`MessageStore` wraps `ProviderService`, so `ProviderService` **cannot** depend
on `MessageStore` to build the tools. The tools are therefore built **in
`MessageStore`** — which already has `WorktreeService`, `GitService`, and
`ConfigStoreService` as deps and *is* the thread API — and flow **down** to
the driver via a new in-process param. See
[decisions/0022-control-plane-in-message-store.md](../decisions/0022-control-plane-in-message-store.md).

```
MessageStore.createSession
  └─ buildExtraToolsForSession(ctx)            // gated on autonomy level
       ├─ reads ConfigStore.getSettings().defaultAutonomyLevel
       ├─ if "off"  → returns []
       └─ else      → buildOrchestrationTools(deps)
                        deps bridge Effect → Promise via Runtime.runPromise,
                        mapping every typed failure to { ok:false, error }
  └─ provider.start(input, cursor, getRuntimeMode, extraTools)   // 4th arg (NEW)
       └─ startClaudeSession(..., [...indexTools, ...browserTools, ...extraTools])
            └─ createSdkMcpServer({ name: "memoize", tools })
```

`ProviderService.start` gained an optional 4th parameter
`extraTools?: ReadonlyArray<unknown>` (in-process only — **not** part of the
wire `StartSessionInput`, since SDK tool closures aren't serializable). It's
ignored by non-Claude drivers. `MessageStore` captures
`Effect.runtime<never>()` once at layer construction to bridge the async tool
handlers back into its Effect methods — the same shape as the browser-bridge
binding in `ProviderService`.

The tools are attached at **all four** `provider.start` call sites so behavior
is consistent across the session lifecycle: synchronous `createSession`,
background `createSession`, `restartProviderSession`, and `resumeSession`. A
resumed autonomous session keeps its control plane.

## Gating

`buildExtraToolsForSession` returns `[]` when the project's
`defaultAutonomyLevel` is `off`, so **no orchestration tools are registered
and memoize behaves exactly as before**. When autonomy is enabled:

- **Mutating tools** (`create_worktree`, `create_thread`, `send_to_thread`)
  are *not* in the driver's `READ_ONLY_TOOLS` set, so `policyFor` falls
  through to a permission prompt — that prompt **is** the approval gate for
  `approval-gated`.
- **Read-only tools** (`read_thread`, `list_threads`, `whoami`) are added to
  `READ_ONLY_TOOLS` in `claude.ts` and auto-allow, like the index reads.

See [decisions/0023-autonomy-via-permission-broker.md](../decisions/0023-autonomy-via-permission-broker.md).

## Persistence

- Migration `0019_chat_lineage.ts` adds
  `chats.origin_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL`.
  Nullable (user chats have no origin); `SET NULL` because a spawned chat
  outlives the session that created it.
- `Chat.originSessionId: Schema.NullOr(SessionId)` (wire); `ChatRow`,
  `chatFromRow`, every chat `SELECT`, and the `createChat` `INSERT` carry the
  column. `CreateChatInput.originSessionId` and the `chat.create` RPC payload
  gained the optional field.

## Files (Phase 1)

**New**
- `packages/contracts/src/autonomy.ts` — `AutonomyLevel`, `DEFAULT_AUTONOMY_LEVEL`,
  `autonomyEnablesOrchestration()`.
- `packages/agents/src/drivers/orchestration-tools.ts` — `buildOrchestrationTools`.
- `apps/server/src/persistence/migrations/0019_chat_lineage.ts`.

**Modified**
- `packages/contracts/src/settings.ts` — `defaultAutonomyLevel` on `SettingsFile` +
  `SettingsPatch`.
- `packages/contracts/src/session.ts` — `Chat.originSessionId`; `chat.create`
  payload.
- `packages/contracts/src/index.ts` — export autonomy.
- `apps/server/src/config-store/layers/config-store-service.ts` — default +
  `isAutonomyLevel` coercion + patch/migrate paths.
- `apps/server/src/provider/services/provider-service.ts` +
  `layers/provider-service.ts` — `extraTools` 4th param, spread into tools.
- `apps/server/src/provider/services/message-store.ts` —
  `CreateChatInput.originSessionId`.
- `apps/server/src/provider/layers/message-store.ts` — `buildExtraToolsForSession`,
  `Runtime` import, `messageContentToText`/`orchestrationErrorText` helpers,
  `ChatRow`/`chatFromRow`/SELECTs/INSERT lineage column, threaded `extraTools`
  through all 4 `provider.start` calls.
- `packages/agents/src/drivers/claude.ts` — read-only orchestration FQNs.
- `apps/server/src/provider/handlers.ts` — `originSessionId` through `chat.create`.
- `apps/server/src/persistence/migrations.ts` + `test/message-store.test.ts` —
  register migration 0019; test ConfigStore stub returns real settings.

## Verification (Phase 1)

- `bun run check-types` — all 8 packages green.
- `apps/server` `bun test` — 113/113.
- Manual: set `defaultAutonomyLevel = "approval-gated"` via `settings.update`,
  prompt an agent "create a worktree and a new thread that runs the tests" →
  worktree + chat appear in the sidebar, gated by the permission prompt; the
  spawned chat's `origin_session_id` points at the spawning session.
