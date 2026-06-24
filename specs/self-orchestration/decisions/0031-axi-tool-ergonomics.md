# ADR 0031 — Agent-ergonomic tool output (axi principles) for the control plane

Date: 2026-06-23
Status: Accepted

## Context

Our control-plane tools (`orchestration-tools.ts`) and the standalone
`apps/mcp-server` currently return pretty-printed **JSON**. Kun's `axi` work
(axi.md) measured that tool *ergonomics* materially change cost and reliability:
agent-ergonomic tooling hit ~79K tokens/task vs ~185K for MCP-style JSON, "100%
reliability at $0.074/task vs $0.100 for MCP," and token-efficient output saves
~40% over JSON. In a loop — which re-reads tool output every iteration — this
compounds directly into the cost-per-accepted-change metric.

The relevant axi principles for us:

1. Token-efficient output format (omit braces/quotes/commas; compact rows).
2. Minimal default schemas — 3–4 fields per list item, not exhaustive.
3. Content truncation with size hints + an escape hatch for full content.
4. Pre-computed aggregates — derived counts/statuses to kill round-trips.
5. Definitive empty states — explicit "zero results", not bare `[]`.
6. Structured errors, idempotent mutations, no interactive prompts.
7–10. Progressive disclosure / contextual next-step hints / consistent help.

## Decision

Apply axi ergonomics to the control-plane tool surface (and the standalone MCP
server):

- **Compact, token-efficient output** instead of `JSON.stringify(…, null, 2)`.
- **`list_threads`**: 3–4 fields/thread by default (id, title, status,
  spawnedByMe), full detail on request.
- **`read_thread`**: truncate long message bodies with a size hint + a way to
  fetch full content; include **pre-computed aggregates** (e.g. `unread`,
  `lastActivity`, `isBlockedOnReview`) so the agent doesn't round-trip.
- **Definitive empty states** ("no threads in this project") over `[]`.
- Keep our existing **structured, never-throwing** `{ ok, error }` result
  convention — already aligned with principle 6.

This is a refinement of the Phase 1 surface (cheap, high-frequency win), not a
redesign — the `OrchestrationToolDeps` contract stays; only the rendered output
shape changes.

## Consequences

- Lower tokens/iteration → directly improves cost-per-accepted-change, part of
  the anti-slop story.
- One judgment call: we adopt the *principles* (compactness, minimal fields,
  aggregates), not necessarily a specific third-party format, to avoid a
  dependency and keep output trivially parseable by the model.
- Applies equally to the loop-control and PR tools added in Phase 2, and to the
  standalone MCP server so external agents get the same efficiency.
- Detailed in [ecosystem-and-ergonomics.md](../features/ecosystem-and-ergonomics.md).
