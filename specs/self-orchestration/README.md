# Self-Orchestrating Agents — control plane, loops & autonomy

MVP 0.01–0.04 shipped a chat-first desktop app where a **human drives the
loop**: you ask the agent for a plan, say "go", run it, file the PR, paste
review comments back in, merge, then start the next thread by hand. Every
handoff between steps is a human carrying context from one box to the next.

This spec teaches the agent to **run the loop itself** — spin up its own git
worktrees, open its own chats/sessions ("threads"), watch its own PRs, review
its own work, and chain the next piece — while the human supervises a *tree*
of autonomous work instead of hand-feeding each step. It is a multi-phase
**feature track**, not a new MVP cut.

Inspiration: the "you should be designing loops that prompt your agents"
pattern — an agent that spawns threads, loops on PR comments until approved,
merges, and triggers the next PR, with the human writing prompts and reading
results rather than shuttling context between steps. The cool part is that the
loop shape is **emergent**: the agent composes the workflow that fits the
problem rather than us hardcoding a "reviewer persona."

## The three layers

Each higher layer is *composed from* the one below. The agent is given
primitives, not pre-baked roles.

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 3 — DYNAMIC WORKFLOWS (emergent, agent-authored)       │
│   "spawn impl thread → spawn review thread → loop on          │
│    comments → merge → trigger next." Just the agent USING     │
│    layers 1+2. No new code per workflow.                      │
├─────────────────────────────────────────────────────────────┤
│ Layer 2 — LOOP ENGINE (new service + tools)                  │
│   heartbeat/cron · goal loop · wake-on-event. Persistent,    │
│   survives restart, budget-aware, kill-switchable.           │
├─────────────────────────────────────────────────────────────┤
│ Layer 1 — CONTROL-PLANE TOOLS (in-process MCP tools)         │
│   create_worktree · create_thread · send_to_thread ·         │
│   read_thread · list_threads · whoami · (pr_status…)         │
│   Thin wrappers over services that already exist.            │
└─────────────────────────────────────────────────────────────┘
```

The architectural through-line: memoize **already** has the entire
service/RPC surface to create worktrees, chats, and sessions and to inject
messages. The work here is (a) exposing that surface to the agent as *tools*,
and (b) adding the one genuinely missing primitive — a **scheduler/loop
engine** — plus the safety layer (autonomy levels, budgets, kill switch) that
makes unattended runs sane.

## Phases

### Phase 1 — Control plane + autonomy gating ✅ SHIPPED

The agent can spin up worktrees and threads and hand them work, under an
opt-in, permission-gated autonomy setting. No scheduler yet — the agent
spawns on demand when *you* ask it to.

- `AutonomyLevel` wire type (`off` | `approval-gated` | `autonomous`,
  default `off`) + `defaultAutonomyLevel` on `SettingsFile`/`SettingsPatch`.
- In-process control-plane tools: `create_worktree`, `create_thread`,
  `send_to_thread`, `read_thread`, `list_threads`, `whoami`.
- Lineage: `chats.origin_session_id` (migration 0019) so spawned chats record
  their parent.
- Gating reuses the existing permission broker + `READ_ONLY_TOOLS` policy —
  mutating spawns prompt; read-only inspection auto-allows.

Verified: 8 packages typecheck, 113/113 server tests pass. See
[features/control-plane-tools.md](features/control-plane-tools.md).

### Phase 2 — Loop engine + kill switch ⬜ PLANNED

The transcript's PR-watcher and Claude Code's `/goal` loop both work, and
there's a big red button to stop everything.

- `loops` table + `LoopEngineService` (Effect-fiber scheduler, crash
  recovery).
- Three loop kinds on one engine: `heartbeat` (cron), `goal` (re-prompt until
  done), `wake_on_event` (PR merged / child idle / file changed).
- Loop-control tools: `schedule_heartbeat`, `start_goal_loop`, `wait_for`,
  `cancel_loop`, `list_loops`.
- PR tools: `pr_status`, `pr_comments`, `mark_pr_ready`, `merge_pr`.
- **Global kill switch** (`loops.killAll`) + `loops.*` RPCs.
- Renderer: Loops/Activity panel + spawned-chat lineage badge.

See [features/loop-engine.md](features/loop-engine.md).

### Phase 3 — Budgets + hardening ⬜ PLANNED

"Loops that make loops" overnight, safely bounded.

- Token / iteration / concurrency budgets aggregated per lineage subtree.
- `wake_on_event` event sources hardened.
- A worked "stacked PR pipeline" the agent can run end to end.

See [features/autonomy-and-safety.md](features/autonomy-and-safety.md).

### Phase 4 — External control plane ⬜ DEFERRED

Expose the same control-plane tools over the standalone `apps/mcp-server`
(HTTP) so a terminal Codex/Claude can drive memoize threads too. The
in-process design maps cleanly onto it; out of scope until Phases 1–3 settle.

## What's deliberately deferred

- **Unattended auto-approve at `autonomous`** until the kill switch ships.
  Today `autonomous` behaves like `approval-gated` (see
  [decisions/0026-kill-switch-gates-autonomous.md](decisions/0026-kill-switch-gates-autonomous.md)).
  Shipping auto-spawn/auto-merge before there's a stop button is unsafe.
- **Codex / ACP provider coverage.** Phases 1–2 target the Claude SDK driver
  (richest in-process MCP support). The engine itself is provider-agnostic —
  it drives sessions via RPC-level methods, not SDK internals.
- **Cross-machine orchestration.** Single Electron/server process for now.
- **Renderer Loops panel** lands in Phase 2 (the lineage data is persisted in
  Phase 1; the UI follows).

## Where to read

- [features/control-plane-tools.md](features/control-plane-tools.md) — Layer 1
  deep dive (tools, injection path, gating, persistence) — Phase 1, shipped.
- [features/loop-engine.md](features/loop-engine.md) — Layer 2 deep dive (loop
  kinds, `loops` schema, scheduler, control tools, PR tools).
- [features/autonomy-and-safety.md](features/autonomy-and-safety.md) — Layer 3
  (autonomy levels, budgets, kill switch, lineage/visibility).
- ADRs:
  - [decisions/0022-control-plane-in-message-store.md](decisions/0022-control-plane-in-message-store.md)
    — where the tools are built + how they reach the driver.
  - [decisions/0023-autonomy-via-permission-broker.md](decisions/0023-autonomy-via-permission-broker.md)
    — autonomy levels ride the existing permission system.
  - [decisions/0024-real-threads-over-sdk-subagents.md](decisions/0024-real-threads-over-sdk-subagents.md)
    — the unit of autonomy is a real memoize thread, not an SDK sub-agent.
  - [decisions/0025-loop-engine-fiber-scheduler.md](decisions/0025-loop-engine-fiber-scheduler.md)
    — one engine, three loop kinds, persistent fibers.
  - [decisions/0026-kill-switch-gates-autonomous.md](decisions/0026-kill-switch-gates-autonomous.md)
    — autonomous mode is gated on the kill switch + budgets.
