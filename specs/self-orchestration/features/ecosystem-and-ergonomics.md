# Ecosystem & ergonomics — PLANNED (Phase 4, with GitHub/Linear pullable earlier)

Three things that make memoize's loops reach the user's real tools, cost less
per iteration, and run from anywhere. Sources: Kun's `axi` + `firstmate`, the
Osmani connectors section.

## 1. MCP connector passthrough (work loops, not just code loops)

See [decisions/0032-mcp-connector-passthrough.md](../decisions/0032-mcp-connector-passthrough.md).

Today in-app agents only see our in-process `memoize` MCP server. Passthrough
merges the **user's configured MCP servers** (GitHub, Linear/Jira, Slack,
Sentry, Gmail, Figma…) into the driver's `mcpServers` map, so a loop can open
the PR, link the ticket, and ping the channel when CI is green — not just say it
would.

- Highest-ROI order: **GitHub → Linear/Jira → Slack → Sentry**.
- Every connector tool flows through the **same permission broker** (gated by
  autonomy level) — the supervised difference vs. a terminal agent firing
  connectors blind.
- Reuse: keychain for secrets, `toolSearch` deferred loading so many connector
  tools don't bloat the prompt.

## 2. Agent-ergonomic tool output (axi)

See [decisions/0031-axi-tool-ergonomics.md](../decisions/0031-axi-tool-ergonomics.md).

Refine the control-plane + standalone-MCP output for tokens/iteration (it
compounds in loops → cost-per-accepted-change):

- compact, token-efficient output instead of pretty JSON (~40% claimed saving);
- minimal default fields (`list_threads` → id/title/status/spawnedByMe);
- truncate long bodies with size hints + a full-content escape hatch;
- pre-computed aggregates on `read_thread` (`unread`, `isBlockedOnReview`);
- definitive empty states ("no threads") over `[]`;
- keep the existing never-throwing `{ ok, error }` convention.

Cheap, high-frequency win; refines the Phase 1 surface without changing the
`OrchestrationToolDeps` contract.

## 3. "First mate" — the orchestrator you talk to

Kun's `firstmate` is the captain's-mate layer: you talk to one agent, it
decomposes work into parallel tasks, spawns worktrees + threads, runs the
verification pipeline, and juggles the context-switching so you don't. In
memoize terms this is **Layer 3 dynamic workflows** composed from the Phase 1
control plane + Phase 2 loop engine + verification pipeline — no new primitive,
it's an orchestration agent using the tools we ship. Worth shipping a curated
"orchestrator" mode once Phases 2–3 land.

## 4. Worktree reuse (treehouse parity)

We already auto-name/allocate worktrees (Pokemon worktrees). Kun's `treehouse`
adds **idle reuse** — when a thread closes, free its worktree; next request
reuses an idle one instead of creating a new directory. Small addition to the
worktree service that keeps the worktree pool from growing unbounded under heavy
parallel spawning.

## 5. Voice + mobile / remote supervision (roadmap)

Honest gaps Kun's terminal flow does *better* than us today:

- **Voice input** — talking is ~3× faster than typing (Stanford study he cites);
  he drives almost everything by voice via local Whisper. memoize has none.
- **Cross-device / mobile supervision** — he monitors and steers from his phone
  over tmux+ssh. memoize is desktop-only. "Supervise your fleet from your phone"
  is a strong story for the *supervision* layer (where our GUI bet is strongest)
  and worth a roadmap slot.

## 6. External control plane (HTTP)

Expose the control-plane tools over the standalone `apps/mcp-server` (HTTP) so a
terminal Codex/Claude can drive memoize threads too. The in-process design maps
cleanly onto it; lowest priority until Phases 1–3 settle.
