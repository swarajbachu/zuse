# Autonomy, safety, economics & failure modes (Layer 3)

Self-spawning + auto-merge is where loops get dangerous (cost blow-ups, slop,
security). The literature is blunt: **most loops fail not because the model is
weak but because the loop has no gate, no state, no stop, or no human at the
irreversible edge.** This doc is the controls layer — autonomy levels, the
loop-readiness gate, budgets, the kill switch, the quality metric, the named
failure modes, and the security tax.

## Autonomy levels

`AutonomyLevel` (`packages/wire/src/autonomy.ts`), persisted as
`SettingsFile.defaultAutonomyLevel` (default `"off"`), set via `settings.update`.

- **`off`** (default) — control-plane tools not registered. memoize behaves as
  before. **Shipped (Phase 1).**
- **`approval-gated`** — tools registered; every spawn/merge/loop-create routes
  through `PermissionService.request`. **Shipped (Phase 1)** for spawns.
- **`autonomous`** — spawns may auto-approve, bounded by budgets + kill switch.
  **Behaves like `approval-gated` until the kill switch ships** (ADR 0026).

## The 4-condition loop-readiness gate (anti-slop by construction)

Before memoize lets a user (or agent) create a loop, it checks the four
conditions from the loop-engineering literature — miss one and the loop costs
more than it returns:

1. **The task repeats** (≥ weekly). One-offs → a good prompt is cheaper.
2. **Verification is automated** — a test/type/build/lint that can fail the work
   without a human in the room. **No gate → no loop** (this is enforced for
   `goal` loops, ADR 0027).
3. **The budget can absorb the waste** — loops re-read/retry/explore; a hard cap
   must exist (below).
4. **A human gate guards the irreversible** — merge / deploy / dependency / spend
   changes require approval before action.

memoize surfaces this as a checklist at loop creation and **refuses or warns**
when a condition is unmet (e.g. no detectable test command → can't make a goal
loop). "The loop tool that tells you when *not* to loop" is a trust signal the
hype crowd can't make. Good first loops: CI-failure triage, dependency bumps,
lint-and-fix, flaky-test repro, issue-to-PR on well-tested code. Bad first
loops: architecture rewrites, auth/payments, prod deploys, vague product work.

## Budgets (the real autonomous guardrail) — Phase 3

Per-loop on the `loops` row, aggregated per lineage subtree:

- **Token budget** — sum persisted `usage` tokens; exceed → loop `status = done`,
  stop arming. Aggregate across a parent's whole spawned subtree (one runaway
  orchestrator can't fork unbounded children). "Ambitious loops burn 5–10× the
  tokens you expected" — the cap is mandatory, not optional.
- **Iteration cap** — hard ceiling (`max_iterations`), always set.
- **Concurrency cap** — max simultaneous agent-spawned sessions per project;
  `create_thread` refuses past it and says so in-thread.

No silent caps: when a budget bites, the engine `log()`s it and the Loops panel
shows the terminal status.

## The north-star metric: cost per accepted change

Not tokens, not tasks, not loops scheduled — **cost per accepted change**, with
**acceptance rate** alongside. "Below 50% accepted → you're doing the review work
the loop was supposed to remove, and the loop is losing." The Loops panel
computes and shows this per loop and auto-flags loops that have degraded into
slop. Nobody else surfaces this; it's the quantified anti-slop pitch.

## Global kill switch (Phase 2)

`LoopEngineService.killAll(projectId)` pauses every loop, interrupts running
spawned sessions, flips autonomy to `off`. `loops.killAll` RPC + a prominent UI
control (status-bar badge: "N loops running"). The safety prerequisite for real
`autonomous` behavior (ADR 0026).

## Visibility — the lineage tree + state files

- `chats.origin_session_id` (migration 0019, **shipped**) → sidebar nests
  agent-spawned chats under their parent with a "🤖 spawned" badge (Phase 2).
- **Loops/Activity panel** (Phase 2): per-loop kind, target, iteration N/max,
  tokens spent/budget, next tick, acceptance rate, and the loop's **state file**
  (ADR 0028) — pause/cancel per row, driven by `loops.streamChanges`.

## Named failure modes (design against each)

- **Ralph Wiggum loop** — emits "done" early, exits half-finished. → objective
  exit-code gate, never a self-emitted sentinel (ADR 0027).
- **Goal drift** — constraints lost by turn 47 (lossy summarization). → standing
  `VISION.md`/`AGENTS.md` reread each run (ADR 0028).
- **Self-preferential bias** — maker too nice grading itself. → blind verifier
  subagent, no exposure to maker reasoning (ADR 0027, 0029).
- **Agentic laziness** — "done enough" at partial completion. → objective stop
  checked by a fresh model.
- **Comprehension debt** — the faster the loop ships code you didn't write, the
  bigger the gap between repo and understanding; "the day you debug a system no
  one has read costs more than the tokens ever did." → the verification
  pipeline's PR summary + recorded evidence + risk score (ADR 0029) make
  staying-in-comprehension cheap at fleet scale; keep loops off architecture;
  read the diffs on higher-risk PRs; spot-check that gates still catch real
  failures (gates rot).
- **Cognitive surrender** — accepting whatever the loop returns. → same actions
  as above, plus the cost-per-accepted-change metric as an external signal.

## The security tax (an unattended loop is an unattended attack surface)

- **Unreviewed generated code** → the objective gate includes **SAST,
  dependency audit, secret scanning** (part of the verification pipeline, ADR
  0029), not just unit tests.
- **Skills/connectors as injection vectors** → don't auto-install community
  skills (measured: a non-trivial fraction leak credentials); audit MCP
  connector sources before enabling (ADR 0032).
- **Credentials in logs** → disable verbose logging in long-running loops;
  sanitize what's logged. (We already keep secrets in the keychain + have
  sensitive-path guards in the driver.)
- **Permission scope creep** → loops tested read-only that gain "just one" write
  permission must be re-audited; surface a periodic permission review.

## Economics & positioning

Loops favor whoever can spend; solo builders on consumer plans get the bill
before the gain. memoize's edge is **making loops safe on metered plans** —
hard budget caps + the cost-per-accepted-change metric + the readiness gate mean
"loop engineering that doesn't bankrupt you." That, plus supervised connectors
and verified output, is the honest, durable position: not "loop on everything,"
but "loop on the right things, with a gate, a cap, and a human at the edges."
