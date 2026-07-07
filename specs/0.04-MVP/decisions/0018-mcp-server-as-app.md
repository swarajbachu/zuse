# ADR 0018 — MCP server as a standalone app (`apps/mcp-server`)

Date: 2026-05-06
Status: Accepted

## Context

The index engine (`@zuse/index`, ADR 0013) has two consumers in
0.04: the desktop server and an MCP server for external agents. The
external-MCP shape lets users connect *any* agent runtime (terminal
Claude Code, Codex, Cursor's agent mode, custom scripts) to the same
index, getting the same tools memoize's bundled agent uses.

Distribution shape questions:

- Is the MCP server a route inside `apps/server`, or its own app?
- Does it ship with the desktop, or as a standalone binary?
- Does it run only when memoize is open, or independently?
- How do users without memoize installed get it?

The honest goal: memoize's index becomes useful **even if the user is
running `claude` in a terminal without the desktop app.** That's the
distribution play — same engine, two transports, available everywhere
agents are.

## Decision

Ship the MCP server as a separate workspace app: **`apps/mcp-server`**.

### Layout

```
apps/mcp-server/
  package.json                      # name: "@zuse/mcp-server"
  src/
    bin.ts                          # CLI entry — `zuse-mcp [opts]`
    server.ts                       # MCP server boot
    tools/
      code-search.ts
      symbol-lookup.ts
      find-references.ts
      read-chunk.ts
      list-module.ts
      index-status.ts
    runtime.ts                      # Effect Layer composing IndexService.Default
```

### Transport

- **stdio** (default) — `zuse-mcp --workspace /path` reads/writes
  JSON-RPC over stdin/stdout. This is what `~/.claude/mcp.json` and
  Codex's MCP config expect.
- **HTTP** (optional) — `zuse-mcp --http :7421 --workspace /path`
  exposes the same MCP endpoints over HTTP for runtimes that prefer
  HTTP (or for IDE plugins).

Both transports use `@modelcontextprotocol/sdk` server primitives.

### Distribution

Three channels:

1. **npm** — `npx @zuse/mcp-server --workspace .` works for users
   with Node ≥ 22. Lowest-friction entry.
2. **Bun-compiled binaries** — `bun build --compile` produces
   `zuse-mcp` per OS. No Node required. Distributed via GitHub
   Releases and Homebrew.
3. **Bundled in the desktop app** — the binary lives inside the
   memoize app bundle so users who installed the desktop also get
   `zuse-mcp` on PATH.

### Authentication and key handling

The MCP server does **not** mount the desktop's keytar. If a user wants
paid embeddings/rerank when running `zuse-mcp` standalone, they
provide keys via env vars (`VOYAGE_API_KEY`, etc.) — same env vars the
desktop reads after fetching them from keytar. This way:

- Standalone MCP server is self-contained, no Electron dependencies
- No accidental cross-process credential leaks
- Local default works zero-config

When the MCP server is *invoked from inside the desktop app* (e.g., for
testing), it inherits the env including keys the desktop already
loaded.

### Workspace argument

`--workspace <path>` is required. Defaults to `process.cwd()` if
omitted. The server opens (or creates) the index DB at the path
described in ADR 0014 (`<userData>/index/<repo-id>/memoize-index.sqlite`),
which means desktop and standalone share the same DB when run on the
same repo. Users on a memoize-managed index get warm-started search.

### Why a separate app, not a route in `apps/server`

`apps/server` pulls in IPC + RPC machinery for Electron. The MCP server
shouldn't pay that cost — it's a different process model (single CLI
invocation, stdio-attached) and a different bundle size target.
Separate app keeps each focused and Bun-compilable.

`@zuse/index` is the shared substrate. Both apps consume it. No
code duplication; no cross-contamination of transport concerns.

### Why npm + binary, not just binary

- npm is the de-facto channel for MCP servers (`npx ...` is what every
  example in MCP docs shows). Skipping it cuts off discovery.
- Binaries handle the no-Node case (rare but real, especially among
  users who are already wary of Node ecosystem bloat).

## Consequences

### Positive

- Memoize's index reaches users who don't run the desktop app.
- The MCP binary is small (no Electron, no React, no Effect RPC).
- Same engine, same data, same answers across desktop and MCP.
- npm distribution doubles as marketing (`@zuse/mcp-server` is
  searchable, installable, recommendable).

### Negative

- Two apps to keep in sync. Mitigated by `@zuse/index` being the
  source of truth; both apps are thin wrappers.
- npm publishing pipeline (CI workflow, version bumps) is one more
  thing to maintain.
- Bun-compiled binaries per OS = a release matrix.

## Alternatives considered

### MCP route inside `apps/server`

- Pro: one app to deploy.
- Con: external agents can't use it without the desktop running. Loses
  the distribution shape entirely.

### Just the binary, no npm

- Pro: simpler release pipeline.
- Con: cuts off the dominant MCP install path. `npx @scope/server` is
  what users expect.

### MCP server as a feature inside Cursor / Continue / etc.

- Pro: zero distribution work for us.
- Con: vendor-coupled. We'd be a feature of those products, not a
  product. Doesn't extend to terminal Claude Code or Codex.

### HTTP-only (no stdio)

- Pro: simpler to debug.
- Con: stdio is what `~/.claude/mcp.json` and Codex configs expect by
  default. Users would need to configure a port + URL. Higher friction.

## What we deliberately rejected

- Bundling MCP transport into `@zuse/index`. Keeps the package
  transport-agnostic.
- Spinning up the MCP server on demand from `apps/desktop`. The
  desktop's bundled agent uses `IndexService` in-process; users who
  want external MCP access run `zuse-mcp` themselves.

## Reference

The Model Context Protocol spec (modelcontextprotocol.io) and SDK
(`@modelcontextprotocol/sdk`) define the wire format. Cursor's,
Sourcegraph's, and Anthropic's published MCP servers follow the same
shape: separate binary, stdio default, HTTP optional. We match.
