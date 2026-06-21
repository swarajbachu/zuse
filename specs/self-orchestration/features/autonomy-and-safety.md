# Autonomy, safety & visibility (Layer 3)

Self-spawning + auto-merge is exactly where this gets dangerous (the transcript
flags both cost — "3M tokens to address 3 comments" — and "don't run this on
prod with millions of users"). Three controls: autonomy levels, budgets, and a
global kill switch — plus a visible lineage tree so the human supervises rather
than babysits.

## Autonomy levels

`AutonomyLevel` (`packages/wire/src/autonomy.ts`), persisted as
`SettingsFile.defaultAutonomyLevel` (default `"off"`), controllable via the
existing `settings.update` RPC.

- **`off`** (default) — control-plane tools are NOT registered. memoize behaves
  exactly as before this feature. **Shipped (Phase 1).**
- **`approval-gated`** — tools registered; every spawn/merge/loop-create routes
  through `PermissionService.request`. The user approves each, and "always
  allow for session/folder" persists via the existing broker. **Shipped
  (Phase 1)** for spawns; loop/PR tools join in Phase 2.
- **`autonomous`** — tools registered; spawns may auto-approve, bounded only by
  budgets + the global kill switch. **Behaves like `approval-gated` until the
  kill switch ships (Phase 2)** — see
  [decisions/0026-kill-switch-gates-autonomous.md](../decisions/0026-kill-switch-gates-autonomous.md).

Because gating already flows through `PermissionService` + the per-session
`runtimeMode` ([decisions/0023](../decisions/0023-autonomy-via-permission-broker.md)),
`approval-gated` is mostly *configuration*, not new code.

## Budgets — the real autonomous guardrail (Phase 3)

Stored per-loop on the `loops` row and aggregated per lineage tree:

- **Token budget** — sum the persisted `usage` tokens across the loop's turns;
  when exceeded, set loop `status = done` and stop arming. Aggregate across a
  parent's whole spawned subtree so one runaway orchestrator can't fork
  unbounded children.
- **Iteration cap** — hard ceiling on loop ticks (`max_iterations`), always
  set.
- **Concurrency cap** — max simultaneous agent-spawned sessions per project;
  `create_thread` refuses past the cap and tells the agent to wait (in-thread,
  not an error).

No silent caps: when a budget bites, the engine `log()`s it and flips the loop
to a terminal status the Loops panel surfaces.

## Global kill switch (Phase 2)

One `LoopEngineService.killAll(projectId)` that pauses every loop, interrupts
running spawned sessions, and flips autonomy to `off`. Exposed as the
`loops.killAll` RPC + a prominent UI control (toolbar button / status-bar badge
showing "N loops running"). Mirrors the existing `messages.interrupt` plumbing.

This is the safety prerequisite for genuine `autonomous` behavior — there is no
unattended auto-approve before it exists.

## Visibility — the lineage tree

So the user supervises a tree instead of babysitting each thread:

- `chats.origin_session_id` (migration 0019, **shipped**) records which session
  spawned a chat. The sidebar nests agent-spawned chats under their parent with
  a "🤖 spawned" badge (renderer, Phase 2).
- A **Loops/Activity panel** (Phase 2): live list of active loops — kind,
  target thread, iteration N/max, tokens spent/budget, next tick — with
  pause/cancel per row, driven by `loops.streamChanges(projectId)` (same
  pattern as `chat.streamChanges`).

## Cost & danger notes

- **Cost blow-ups** are the headline risk. Mitigations: budgets + visible
  spend (the per-turn `usage` rows already exist) + kill switch. Consider a
  hard project-level monthly token cap.
- **Auto-merge** is the most dangerous tool. Recommendation: keep `merge_pr`
  approval-gated even at `autonomous` unless the user explicitly opts merges
  into autonomous, separately from spawns.
- **Provider coverage**: Phases 1–2 target the Claude SDK driver. The engine
  is provider-agnostic (drives sessions via RPC-level methods).
