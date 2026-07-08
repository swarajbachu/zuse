# ADR 0026 — `autonomous` mode is gated on the kill switch + budgets

Date: 2026-06-19
Status: Accepted

## Context

The whole point of `autonomous` is unattended runs — the agent spawns threads,
loops on PRs, and merges while the human is asleep. That is also where the
transcript's two explicit warnings live: cost blow-ups ("an 8-hour, 3M-token
run to address three comments") and "don't do this on prod with millions of
users." Shipping unattended auto-approve **before** there is a way to stop it,
bound it, or even see it would be irresponsible.

Phase 1 ships the control plane (spawning) and the autonomy *enum*, but the
loop engine, kill switch, budgets, and Loops panel are Phase 2/3.

## Decision

Sequence safety before autonomy:

1. `autonomy = "off"` and `"approval-gated"` are fully usable from Phase 1.
2. `autonomy = "autonomous"` is **accepted but behaves like `approval-gated`**
   until the Phase 2 safety primitives exist:
   - the **global kill switch** (`loops.killAll`) — pause every loop, interrupt
     running spawned sessions, flip autonomy to `off`;
   - the **Loops/Activity panel** — see what's running and its spend;
   - and at least iteration caps (token/concurrency budgets in Phase 3).
3. Even once `autonomous` auto-approves spawns, **`merge_pr` stays
   approval-gated** unless the user opts merges into autonomous separately.
   Auto-merge is the highest-blast-radius action.

## Consequences

- No "spawn 50 worktrees overnight with no off switch" failure mode ships
  early. The dangerous capability and its safety belt land together.
- The autonomy enum is forward-declared now, so enabling true autonomous
  behavior in Phase 2 is a behavior change, not a schema/wire change — no
  migration churn.
- Slightly surprising that `autonomous` ≡ `approval-gated` in Phase 1; the
  `AutonomyLevel` doc comment and the spec README call this out explicitly.
- Auto-merge being separately gated means the common safe-autonomous loop
  ("address comments, push, re-request review") runs unattended while the
  irreversible step still asks — matching how a cautious human would delegate.
