# ADR 0022 — Build control-plane tools in MessageStore; inject via `provider.start`

Date: 2026-06-19
Status: Accepted

## Context

The agent needs in-process tools that create worktrees, create chats/sessions,
inject messages, and inspect threads. These tools must call the same services
the renderer's RPCs call (one source of truth), and they're attached per
session at `provider.start` time inside the Claude driver.

The natural home looks like `ProviderServiceLive` — it already builds
`buildIndexTools` / `buildBrowserTools` there and has a captured runtime. But:

- `create_thread` must call `MessageStore.createChat`; `send_to_thread` must
  call `MessageStore.sendMessage`.
- The layer graph is `MessageStore → ProviderService` (one-directional; see
  `apps/server/src/runtime.ts`). Making `ProviderService` depend on
  `MessageStore` is a **construction cycle** and would deadlock the layer.

A captured `Effect.runtime<never>()` inside `ProviderServiceLive` only contains
that layer's declared deps, so it can't reach `MessageStore` either.

Options considered:

1. **Service-locator `Ref`** — a registry holding the orchestration service,
   set after both layers build, read lazily at tool-call time. Breaks the cycle
   but adds an indirection + a "constructed but unreferenced" layer to force.
2. **Pass SDK tools through `StartSessionInput`** — rejected: that's a wire
   schema, and SDK `tool()` closures aren't serializable.
3. **Build the tools in `MessageStore` and pass them down.** `MessageStore`
   already depends on `WorktreeService`, `GitService`, and `ConfigStoreService`
   and *is* the thread API — it has everything. The tools flow DOWN to
   `provider.start` as a plain function argument.

## Decision

Build the orchestration tools in `MessageStore` (`buildExtraToolsForSession`)
and pass them to the driver via a new **in-process** 4th parameter on
`ProviderService.start`:

```ts
readonly start: (
  input: StartSessionInput,
  resumeCursor?: string | null,
  getRuntimeMode?: GetRuntimeMode,
  extraTools?: ReadonlyArray<unknown>,   // NEW — in-process only
) => Effect.Effect<...>
```

`provider-service.ts` spreads it into the same tools array as the built-ins:
`[...indexTools, ...browserTools, ...extraTools]`, so the orchestration tools
land in the existing `memoize` MCP server and get `mcp__memoize__*` FQNs for
free. The param is typed `unknown[]` (SDK tool objects aren't in the wire
schema), defaults to `[]`, and is ignored by non-Claude drivers.

The tool builder itself (`orchestration-tools.ts`) is Effect-free — it takes
promise-bound deps that return `{ ok, ... }` result objects (mirroring
`browser-tools.ts` / `BrowserCommandResult`). `MessageStore` binds those deps
to its Effect methods via `Runtime.runPromise` over a captured
`Effect.runtime<never>()`, mapping every typed failure to `{ ok: false,
error }` so the SDK handlers never throw.

Tools are attached at all four `provider.start` call sites: synchronous +
background `createSession`, `restartProviderSession`, and `resumeSession`.

## Consequences

- **No layer cycle, no service locator.** Tools live where their deps already
  are; the dependency arrow stays `MessageStore → ProviderService`.
- One source of truth: the agent's `create_thread` and the renderer's
  `chat.create` call the same `MessageStore.createChat`, so spawned threads
  appear live in the sidebar via the existing pubsub streams.
- `provider.start`'s signature grows by one optional in-process arg; legacy
  `agent.*` callers pass nothing and are unaffected.
- The driver's permission policy (`policyFor`) classifies the new FQNs with no
  driver-side knowledge of "orchestration" — see ADR 0023.
