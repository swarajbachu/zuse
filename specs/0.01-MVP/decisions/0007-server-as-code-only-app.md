# ADR 0007: `apps/server` as a code-only app, designed for future extraction

**Status**: Accepted

**Date**: 2026-05-03

## Context

Phase 1 put all main-process services (`workspace`, `pty`, `git`) inside `apps/desktop/src/services/`. That worked for a single Electron-only target. Phase 2 introduces the agent domain, which is structurally heavier (Driver / Adapter / Service / Registry split) and will eventually carry features the reference architecture exposes through a separate process — remote sessions, headless/CLI clients, multi-client renderers, future mobile clients connecting to a desktop over the network.

We now know we want to be able to:

1. SSH into a desktop and connect to it from another machine (browser pointing at the running server).
2. Ship a CLI client that talks to the same backend.
3. Ship a mobile client (someday) that connects to a user's desktop over LAN/tunnel.
4. Have multiple renderer processes/windows talk to the same backend.

The reference architecture solves (1)–(4) by running the backend as a standalone Bun WS server. Their renderer code (`apps/web/`) is transport-agnostic — Electron loads it from disk and talks to a localhost server, browsers load it from a URL and talk to a remote server.

Doing the full extraction *now* (real subprocess, port discovery, WS transport) is a 2–3 week diversion before Phase 2 features can ship. Doing nothing leaves us with a layout that has to be re-architected when remote becomes a priority.

## Decision

Adopt **Path 2**: create `apps/server/` as a structurally separate "app" that today is consumed by `apps/desktop/main.ts` via direct in-process import, but is designed so that extraction to a real WS server is a localized, low-risk PR later.

### What lives where

```
packages/
  wire/                         # RPC contracts — transport-agnostic by definition
apps/
  server/                       # main-process service implementations
    src/
      <domain>/                 # workspace, pty, git, provider — Drivers/Layers/Services split
      app-paths.ts              # Context.Tag for OS-paths (no electron import)
      runtime.ts                # makeMainLayer(deps) — pure factory, no transport
      handlers.ts               # mergeAll of all per-domain handlers
      bin.ts                    # standalone entrypoint stub. Today: just re-exports runtime.
                                # Tomorrow: WS server boot.
  desktop/                      # thin Electron shim
    src/
      main.ts                   # Electron lifecycle. Imports runtime from @zuse/server.
      preload.ts                # contextBridge
      ipc/                      # electron-server-protocol — Electron-bound transport
  renderer/                     # React UI
    src/
      lib/
        rpc-client.ts           # the seam — picks transport based on environment
        electron-client-protocol.ts  # in-process transport
        # ws-client-protocol.ts (added when remote ships)
```

### Hard rules that keep extraction cheap

These rules turn "future WS extraction" from a refactor into a wiring change:

1. **`apps/server/` may NOT import from `electron` or any electron-only package.** Not even via `import type`. If a service needs an electron-provided value (userData path, app version, etc.), it consumes it from `AppPaths` (or a new typed Context tag) — `apps/desktop/main.ts` is the single place electron leaks in.
2. **`apps/server/` may NOT import from `apps/desktop/` or `apps/renderer/`.** Strict one-direction dependency.
3. **`apps/server/src/runtime.ts` exports `makeMainLayer(deps: { userData: string, ... }): Layer<...>`.** Pure factory, no side effects, no transport. Both `apps/desktop/main.ts` (today) and `apps/server/src/bin.ts` (future WS server) call it.
4. **All transport-related code lives outside `apps/server/`.** `electron-server-protocol.ts` and `electron-client-protocol.ts` stay in `apps/desktop/src/ipc/` and `apps/renderer/src/lib/` respectively. When WS lands, its server side goes in `apps/server/src/transports/ws.ts` (the only place WS is allowed inside the package); its client side goes in `apps/renderer/src/lib/`.
5. **Renderer transport selection is centralized in `apps/renderer/src/lib/rpc-client.ts`.** Today: returns Electron protocol. Tomorrow: returns Electron protocol when running inside Electron, WS protocol otherwise. Other renderer code calls `getRpcClient()` and never names a transport directly.
6. **`apps/server/package.json` has no electron, no node-pty in `dependencies` directly... actually wait — node-pty is required for the PTY service.** Pragmatic exception: native modules (node-pty) live as deps of `apps/server` because that's where the service is, and electron-rebuild from `apps/desktop` finds them via Bun's hoisted layout. This is the only "leak" — node-pty assumes a Node ABI; remote/headless servers can't provide a real PTY, so a real WS deployment would need to gate the PTY domain or supply a different impl. Document and accept.

### Why "app" not "package"

Naming-wise, `apps/server` matches the reference repo's layout, so transplanting code from there is mechanical (paths line up). The `apps/` vs `packages/` distinction in monorepo conventions is soft — `apps/` typically means "runnable thing." Today our `apps/server` is not separately runnable (`bin.ts` is a stub); it ships with `apps/desktop`. When `bin.ts` becomes a real WS server boot, the naming retroactively fits the convention without a rename.

### What this lets us defer

The following are *enabled* by this layout but *not built* yet:

- Real subprocess spawn of `apps/server` from `apps/desktop/main.ts`
- Port discovery + readiness signaling (`backendPort`, `backendReadiness` patterns from the reference)
- WebSocket transport (`ws-server-protocol.ts`, `ws-client-protocol.ts`)
- CLI client (`apps/cli/`) that connects over WS
- Mobile client (someday) that connects over LAN/tunnel
- Multi-window support (multiple renderers connected to one backend)

When any of these become priority, we add the relevant bits without restructuring services or contracts. Estimated cost of the future WS extraction PR: ~1 week, isolated to transport modules + `bin.ts` + `apps/desktop/main.ts` startup orchestration.

## Consequences

- Phase 2 can ship on schedule (no transport refactor blocking it).
- Every Phase 2 service is built once and works in both modes (in-process today, WS tomorrow) without modification.
- The layout matches the reference repo, so lifting code (especially `provider/`) is mechanical.
- One actual cost: `apps/desktop/main.ts` always pays a small wiring tax — it has to bridge electron paths into `apps/server`'s typed context tags. Worth it.

## What we deliberately rejected

- **Path 1: full WS extraction now.** ~3 weeks. Useful only if remote is the headline feature for v1. It isn't — agents are.
- **Path 3: ship Electron IPC + WS in parallel from day one.** ~2 weeks. Pays full distributed-systems cost (process lifecycle, port collision, reconnection) before we have a single user asking for remote. Defer.
- **Keeping services in `apps/desktop/src/services/`.** Locks us to Electron-bundled forever. Every future remote/CLI/mobile feature would require moving everything anyway, plus all the API churn from the move.

## How we'll know we got it right

- Phase 2 ships without revisiting transport.
- The day someone asks for "let me SSH into my desktop and use memoize from my laptop browser," the PR touches `apps/server/src/bin.ts`, `apps/server/src/transports/ws.ts`, `apps/desktop/src/main.ts`, and `apps/renderer/src/lib/rpc-client.ts` — and nothing in any service.
- New service domains (Phase 3 permissions, Phase 4 diff viewer) follow the same `apps/server/src/<domain>/{Drivers,Layers,Services,Errors.ts}` pattern without anyone asking where they should live.
