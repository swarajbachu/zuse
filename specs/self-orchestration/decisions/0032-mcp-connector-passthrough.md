# ADR 0032 — Pass the user's MCP connectors through to in-app agents

Date: 2026-06-23
Status: Accepted

## Context

Today the Claude driver registers **only** our in-process `memoize` MCP server
(`claude.ts`: `mcpServers: { [MEMOIZE_MCP_NAME]: memoizeMcpServer }`). In-app
agents therefore can't reach the user's external connectors — GitHub (beyond
`gh`), Linear/Jira, Slack, Sentry, Gmail, Figma. Codex and Claude Code both let
agents use these, and the loop-engineering literature is explicit that
connectors are what turn "an agent that says here's the fix" into "a loop that
opens the PR, links the Linear ticket, and pings the channel when CI is green."

This is the one capability on the Codex/loop feature lists that is **absent from
our plan entirely**, and it's the difference between *code* loops and *work*
loops (the docs-loop, the weekly-changelog-email loop, ticket-to-PR loops).

Highest-ROI order from the literature: **GitHub → Linear/Jira → Slack →
Sentry**.

## Decision

Add **MCP connector passthrough**: a user-configured set of MCP servers that
memoize merges into the driver's `mcpServers` map alongside the in-process
`memoize` server, per session.

- **Config surface**: a connectors registry (stdio/HTTP MCP servers + auth),
  persisted; reuse the keychain for secrets (as we already do for provider keys).
- **Wiring**: spread user servers into `Options.mcpServers` in the Claude
  driver; their tools appear to the agent as `mcp__<server>__*` and flow through
  the **same permission broker** — so a Gmail-send or a Linear-write hits a gate
  exactly like any mutating tool (this is the trust difference vs. a terminal
  agent firing connectors blind).
- **Tool-search interplay**: with many connector tools, lean on the existing
  deferred-tool loading (`toolSearch`) so the system prompt doesn't bloat.
- **Safety**: connector tools are gated by autonomy level + permission scope;
  re-audit per the security-tax rules in
  [autonomy-and-safety.md](../features/autonomy-and-safety.md).

## Consequences

- Unlocks "work loops," not just "code loops" — the biggest expansion of what a
  memoize loop can *do*.
- Every connector action is supervised (permission broker + lineage), which is
  our differentiation over CLI agents that fire connectors unsupervised.
- New work: connectors config UI + wire schema + driver merge + secret storage.
  Scoped as Phase 4 (ecosystem), but GitHub/Linear specifically may be worth
  pulling earlier since PR/issue loops are the day-one win.
- Detailed in [ecosystem-and-ergonomics.md](../features/ecosystem-and-ergonomics.md).
