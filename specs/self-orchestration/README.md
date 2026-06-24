# Self-Orchestrating Agents — control plane, loops & trustworthy autonomy

MVP 0.01–0.04 shipped a chat-first desktop app where a **human drives the
loop**: you ask the agent for a plan, say "go", run it, file the PR, paste
review comments back in, merge, then start the next thread by hand. Every
handoff is a human carrying context from one box to the next.

This spec teaches the agent to **run the loop itself** — spin up its own git
worktrees, open its own threads, verify its own work, watch its own PRs, and
chain the next piece — while the human supervises a *tree* of work instead of
hand-feeding each step. It is a multi-phase **feature track**, not a new MVP cut.

The bet is not "loop faster than everyone else" — that gets commoditized. It's
**loops you can trust**: every loop is a watchable thread, every result is
independently verified against an objective gate, spending is capped and
visible, and a human stands at every irreversible edge. "Loop engineering
without slop" = **verification + observability + taste-gated autonomy**, which
is the half of the problem terminal-native tools (Claude Code, Codex) are worst
at.

Sources folded into this spec: Anthropic's engineering docs, Addy Osmani's
loop-engineering essay, Kun's agent-engineering workflow (`axi` / `lavish` /
`no-mistakes` / `gnhf` / `treehouse` / `firstmate`), and the "Ralph Wiggum"
failure-mode write-up.

## The three layers

Each higher layer is *composed from* the one below. The agent gets primitives,
not pre-baked roles — the loop shape is **emergent** (ADR 0024).

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 3 — DYNAMIC WORKFLOWS (emergent, agent-authored)       │
│   spawn impl thread → verify → loop on review → merge →       │
│   trigger next. The "first mate" orchestrator. No per-        │
│   workflow code — the agent composes layers 1+2.             │
├─────────────────────────────────────────────────────────────┤
│ Layer 2 — LOOP ENGINE + VERIFICATION                         │
│   heartbeat/goal/wake-on-event · objective gate · state      │
│   file · the verification pipeline ("ship lane") · kill      │
│   switch · Loops panel.                                       │
├─────────────────────────────────────────────────────────────┤
│ Layer 1 — CONTROL-PLANE TOOLS (in-process MCP tools)         │
│   create_worktree · create_thread · send_to_thread ·         │
│   read_thread · list_threads · whoami.                       │
└─────────────────────────────────────────────────────────────┘
```

memoize already has the service/RPC surface to create worktrees, chats, and
sessions and to inject messages. The work is (a) exposing it to the agent as
*tools*, (b) the missing primitive — a **loop engine** — and (c) the
**verification + safety** layer that makes unattended runs sane.

## Phases

### Phase 1 — Control plane + autonomy gating ✅ SHIPPED

Agents spin up worktrees/threads and hand them work, under an opt-in,
permission-gated autonomy setting. No scheduler yet — spawning on demand.

- `AutonomyLevel` (`off`/`approval-gated`/`autonomous`, default `off`) +
  `defaultAutonomyLevel` setting.
- Tools: `create_worktree`, `create_thread`, `send_to_thread`, `read_thread`,
  `list_threads`, `whoami`.
- Lineage: `chats.origin_session_id` (migration 0019).
- Gating reuses the permission broker + `READ_ONLY_TOOLS` policy.

Verified: 8 packages typecheck, 113/113 server tests pass (now 127/127 after the
main merge). See [features/control-plane-tools.md](features/control-plane-tools.md).

### Phase 2 — Loop engine + verification (the heart) ⬜ PLANNED

The transcript's PR-watcher and `/goal` both work, output is verified before it
reaches you, and there's a big red button.

- `loops` table + `LoopEngineService` (Effect-fiber scheduler, crash recovery).
- Three kinds: `heartbeat` (cron), `goal` (re-prompt until an **objective gate**
  passes — ADR 0027), `wake_on_event`.
- **Per-loop state file** + standing spec reread each run (ADR 0028).
- **Verification pipeline / "ship lane"** — isolated worktree → infer intent →
  rebase → blind adversarial review → e2e test with **recorded evidence** →
  objective + security gate → docs → PR (intent/changes/evidence/risk) → babysit
  until merged (ADR 0029). *This is the anti-slop headline, not an add-on.*
- Loop-control tools (`schedule_heartbeat`, `start_goal_loop`, `wait_for`,
  `cancel_loop`, `list_loops`) + PR tools (`pr_status`, `pr_comments`,
  `mark_pr_ready`, `merge_pr`).
- **Global kill switch** (`loops.killAll`) + `loops.*` RPCs.
- Renderer: Loops/Activity panel + spawned-chat lineage badge.

See [features/loop-engine.md](features/loop-engine.md) +
[features/verification-pipeline.md](features/verification-pipeline.md).

### Phase 3 — Safety, economics & failure-mode hardening ⬜ PLANNED

"Loops that make loops" overnight, safely bounded.

- Token / iteration / concurrency **budgets** aggregated per lineage subtree.
- **Cost-per-accepted-change** metric + acceptance rate in the Loops panel
  (auto-flag degraded loops).
- The **4-condition loop-readiness gate** at loop creation.
- **Named failure-mode** defenses (Ralph Wiggum, goal drift, self-preferential
  bias, comprehension debt, cognitive surrender) + the **security tax**
  (SAST/dep-audit/secret-scan in the gate, connector/skill source audit, log
  sanitization, permission re-audit).

See [features/autonomy-and-safety.md](features/autonomy-and-safety.md).

### Phase 4 — Ecosystem & ergonomics ⬜ PLANNED (GitHub/Linear pullable earlier)

- **MCP connector passthrough** (GitHub → Linear/Jira → Slack → Sentry) — turns
  *code* loops into *work* loops (ADR 0032).
- **axi tool-ergonomics** — token-efficient control-plane output (ADR 0031).
- **"First mate" orchestrator** mode (Layer 3 made turnkey).
- **Worktree reuse** (treehouse parity) on top of Pokemon worktrees.
- **Voice input + mobile/remote supervision** (honest gaps vs. terminal flows).
- **External HTTP control plane** (drive memoize threads from terminal agents).

See [features/ecosystem-and-ergonomics.md](features/ecosystem-and-ergonomics.md).

### Cross-cutting — Rich plan artifacts ⬜ PLANNED (lands independently)

Annotatable, in-design-system plan artifacts instead of wall-of-text plans
(lavish parity) — improves the front of every task, loop or not. ADR 0030 /
[features/plan-artifacts.md](features/plan-artifacts.md).

## What's deliberately deferred

- **Unattended auto-approve at `autonomous`** until the kill switch ships (ADR
  0026) — auto-spawn/merge before a stop button is unsafe; today `autonomous` ≡
  `approval-gated`.
- **Codex / ACP provider coverage** — Phases 1–2 target the Claude SDK driver;
  the engine itself is provider-agnostic.
- **Cross-machine orchestration** — single process for now.

## Where to read

Features:
- [control-plane-tools.md](features/control-plane-tools.md) — Layer 1 (shipped).
- [loop-engine.md](features/loop-engine.md) — Layer 2 scheduler + loop kinds.
- [verification-pipeline.md](features/verification-pipeline.md) — the ship lane.
- [autonomy-and-safety.md](features/autonomy-and-safety.md) — autonomy, budgets,
  kill switch, the 4-condition gate, the cost metric, failure modes, security.
- [plan-artifacts.md](features/plan-artifacts.md) — rich annotatable plans.
- [ecosystem-and-ergonomics.md](features/ecosystem-and-ergonomics.md) —
  connectors, axi, first mate, worktree reuse, voice/mobile, HTTP.

Decisions (ADRs):
- [0022](decisions/0022-control-plane-in-message-store.md) — tools built in
  MessageStore, injected via `provider.start`.
- [0023](decisions/0023-autonomy-via-permission-broker.md) — autonomy on the
  permission broker.
- [0024](decisions/0024-real-threads-over-sdk-subagents.md) — real threads as
  the unit of autonomy.
- [0025](decisions/0025-loop-engine-fiber-scheduler.md) — one fiber-scheduler,
  three loop kinds.
- [0026](decisions/0026-kill-switch-gates-autonomous.md) — autonomous gated on
  the kill switch.
- [0027](decisions/0027-objective-gate-over-sentinel.md) — objective gate, not a
  self-emitted sentinel (Ralph Wiggum fix).
- [0028](decisions/0028-loop-state-file.md) — per-loop state file + standing spec.
- [0029](decisions/0029-verification-pipeline.md) — verification pipeline.
- [0030](decisions/0030-rich-plan-artifacts.md) — rich plan artifacts.
- [0031](decisions/0031-axi-tool-ergonomics.md) — agent-ergonomic tool output.
- [0032](decisions/0032-mcp-connector-passthrough.md) — MCP connector passthrough.
