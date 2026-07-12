# ADR 0028 — Loops carry persistent state outside the conversation

Date: 2026-06-23
Status: Accepted

## Context

Osmani's loop-engineering rule: **"the agent forgets, the repo does not."** An
agent's context is lost between runs; a loop without persistent state restarts
from zero every cycle instead of resuming. Two named long-run failure modes
follow from having no external memory:

- **Goal drift** — each summarization step is lossy; "don't do X" constraints
  disappear by turn 47.
- **Restart amnesia** — a loop that wakes tomorrow re-derives everything,
  re-doing work and re-making mistakes it already learned from.

Our current `loops` table holds *scheduling* state (next_run_at, iteration
count) but no *work* state — what's done, what's escalated, what was learned.

## Decision

Every loop owns two markdown artifacts the engine reads/writes around each
iteration:

1. **A loop state file** (`STATE.md`, per loop) — "what's done / in-progress /
   escalated / lessons learned." The engine **injects it at the start of each
   iteration** and instructs the agent to **update it at the end**. Sections
   mirror Osmani's template: Last run · In progress · Completed · Escalated to
   humans · Lessons learned · Stop conditions met.
2. **A standing spec** (`VISION.md` / reuse the project's `AGENTS.md`/`CLAUDE.md`)
   the agent **rereads every run** — "state tells the agent where it is; the
   spec tells it where to go." This is the goal-drift mitigation.

Storage: default to a markdown file under the loop's worktree (version-control-
friendly, diff-readable, and it shows up in the thread the user already
watches). The `loops` row stores a `state_path`. A later option can back state
with an external system (GitHub Issues / Linear) for cross-repo, multi-human
visibility — deferred.

Crucially, the state file **is also the observability surface**: the Loops
panel renders it, so "what is this loop doing / has learned" is one glance, not
a transcript dig.

## Consequences

- Loops resume instead of restart; lessons compound across runs.
- `loops` schema gains `state_path`; the engine's tick wraps each iteration with
  read-state → run → write-state.
- Doubles as anti-slop observability (ties into the cost-per-accepted-change
  metric and the Loops panel in [autonomy-and-safety.md](../features/autonomy-and-safety.md)).
- Pairs with ADR 0027: the state file records *which commit met the objective
  gate*, so "done" is auditable after the fact.
