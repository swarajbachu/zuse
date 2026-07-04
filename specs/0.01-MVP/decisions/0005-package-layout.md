# ADR 0005: Package layout & naming

**Status**: Accepted

**Date**: 2026-05-02

## Context

The monorepo has two apps (`desktop`, `renderer`) and a growing number of cross-cutting concerns: RPC contracts, branded IDs, shared schemas, future agent adapters, future UI primitives. We need a layout that supports the v1 surface area without forcing every new domain to negotiate a new package.

Other terminal-for-agents apps split their server into a dozen domain packages (auth, workspace, project, terminal, git, provider, orchestration, persistence, environment, observability, telemetry, checkpointing) and split their contracts package similarly. That's appropriate at their scale; it's premature partitioning at ours.

## Decision

### One contracts package: `@zuse/wire`

All RPC contracts, branded IDs, and cross-process schemas live in a single workspace package: `@zuse/wire`. Inside, **one file per domain** (`ping.ts`, `workspace.ts`, `pty.ts`, `git.ts`). One `RpcGroup` (`MemoizeRpcs`) collects every `Rpc.make(...)`.

**Why one package, not many:** the wire format is the boundary. Splitting it across packages forces every new RPC to negotiate package membership. One package, one file per domain, lets us add an RPC by editing one file and re-exporting from `index.ts`.

### Internal package naming: `@zuse/*`

All packages we create live under `@zuse/*` (e.g. `@zuse/wire`). Pre-existing repo-shared config packages keep their `@repo/*` namespace (`@repo/typescript-config`, `@repo/eslint-config`, `@repo/ui`) — they're scaffolding that came with the Turborepo template, not domain code.

**Why not mix scoped and unscoped:** a single namespace makes it obvious at a glance whether a dependency is ours or third-party.

### Service classes: `<Domain>Service`

Every Effect.Service class ends in `Service`: `WorkspaceService`, `PtyService`, `GitService`, `AgentService`. No exceptions, no abbreviations, no domain-specific suffixes (no `WorkspaceFileSystem`, `OrchestrationEngine`, bare `Open`).

**Why uniform:** one suffix means readers don't have to learn a vocabulary of suffixes per domain. Searching for `Service` finds every service in one grep.

### RPC method names: dotted lowercase

All RPC method names are dotted-lowercase string literals passed directly to `Rpc.make`:

```ts
Rpc.make("workspace.add", { ... })
Rpc.make("pty.open", { ... })
Rpc.make("git.log", { ... })
```

**No central method-name enum.** The string literal in `Rpc.make("...", ...)` IS the API. Adding an RPC is one edit.

**Why no enum:** an enum doubles the change footprint per RPC (define the constant, reference it) without adding type safety — Effect RPC already infers the method name from the literal.

### Branded entity IDs

Every entity that crosses the wire has a branded ID via `Schema.brand`:

```ts
const makeEntityId = <Brand extends string>(brand: Brand) =>
  Schema.Trim.pipe(Schema.nonEmptyString(), Schema.brand(brand));
export const FolderId = makeEntityId("FolderId");
```

**Why brand:** prevents `PtyId` from being passed where `FolderId` is expected, even though both are strings at runtime. Cost: zero. Caught: a real class of bugs.

### Per-domain folder layout (apps/server)

> **Updated 2026-05-03 by [ADR 0007](0007-server-as-code-only-app.md):** services moved from `apps/desktop/src/services/` to `apps/server/src/`, and the per-domain shape adopted the reference repo's split. The original "flat" rule below is preserved for context — see the **Updated rule** below it.

**Original rule (Phase 1):**

```
apps/desktop/src/services/<domain>/
  <domain>-service.ts    # Effect.Service class + Default Layer
  <domain>-handlers.ts   # RPC handler implementations
```

Flat. No `Layers/` and `Services/` subdirs. Split only when a domain grew past ~300 LOC.

**Updated rule (Phase 2 onwards):**

```
apps/server/src/<domain>/
  Drivers/                # per-impl static configs + factories (e.g. ClaudeDriver, CodexDriver)
  Layers/                 # live Effect.Service impls (Layer.effect(Tag, factory))
  Services/               # Context.Service tags — interfaces only
  Errors.ts               # tagged errors for the domain
  handlers.ts             # toLayerHandler bindings
  <misc helpers>.ts       # availability.ts, spawn.ts, credentials.ts, etc.
```

Single-impl domains (Phase 1's `pty`, `git`, `workspace`) still use the same split — `Layers/` has one file, `Services/` has one file, `Drivers/` may be empty.

**Why uniform split now (overriding "flat-until-scale"):**

1. The reference architecture uses this split. Code we lift from there transplants 1:1 if our paths match.
2. Phase 2 introduces the agent domain, which already justifies the split (multiple drivers + adapters + a registry + a service).
3. Inconsistency between domains has higher onboarding cost than uniform "small-but-split" structure.
4. Renaming Phase 1's three single-file services into the split is a one-time mechanical refactor (PR-6).

### File naming

- Files: `kebab-case.ts` (`workspace-service.ts`, `electron-server-protocol.ts`)
- Folders: singular kebab-case (`service/`, `ipc/`, not `services/` for the inner domain folder — but the parent `services/` is plural, since it contains many)

### App layout (Phase 2 onwards)

See [`spec/architecture.md`](../architecture.md) for the canonical layout. Summary:

```
apps/server/src/                          # NEW — main-process service implementations
  <domain>/                                # Drivers/Layers/Services/Errors.ts/handlers.ts
  app-paths.ts, runtime.ts, handlers.ts, bin.ts

apps/desktop/src/                          # thin Electron shim
  main.ts                                  # imports makeMainLayer from @zuse/server
  preload.ts
  ipc/electron-server-protocol.ts          # transport stays in apps/desktop

apps/renderer/src/
  app.tsx, main.tsx, styles.css
  lib/
    rpc-client.ts                          # the seam — selects transport
    electron-client-protocol.ts
  store/<domain>.ts
  components/<name>.tsx
```

## Consequences

- Adding a new RPC: edit one file in `packages/wire/src/<domain>.ts`, add a handler file in `apps/desktop/src/services/<domain>/`, register it in `ipc/handlers.ts`. No package boundaries to renegotiate.
- Adding a new domain: one folder with two files. Promote to subfolders only when scale demands it.
- New contributors find services by searching `*Service` and RPCs by searching `Rpc.make("`.

## What we deliberately rejected

- Splitting `wire` into per-domain packages — forces package coordination per RPC.
- Central `WS_METHODS`-style enum of method names — doubles the change footprint.
- ~~Per-domain `Layers/` + `Services/` subdirs — premature partitioning.~~ **Reversed by [ADR 0007](0007-server-as-code-only-app.md):** the per-domain split is now adopted uniformly so we match the reference repo's layout and Phase 2 code transplants line up 1:1.
- Inconsistent service suffixes (`*Engine`, `*FileSystem`, bare verbs) — readers shouldn't have to learn a per-domain vocabulary.
- A `packages/shared/` junk drawer — when we have a real cross-cutting utility, we'll create a focused package for it.
