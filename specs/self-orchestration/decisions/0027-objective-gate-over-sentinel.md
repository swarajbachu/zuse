# ADR 0027 — Goal loops stop on an objective gate, not a self-emitted sentinel

Date: 2026-06-23
Status: Accepted (supersedes the stop-condition design in ADR 0025)

## Context

ADR 0025 / `loop-engine.md` originally defined the `goal` loop's termination as a
**completion sentinel** the agent emits (default `GOAL-COMPLETE`). After
reviewing Addy Osmani's loop-engineering analysis and Geoffrey Huntley's
documented failure mode, this is a known anti-pattern — the **"Ralph Wiggum
loop"**:

> An agent meant to emit a completion token only when finished emits it early,
> and the loop exits on a half-done job. Without a hard gate, loops fail quietly
> and keep spending.

A self-emitted sentinel is the agent grading its own homework. Two related
biases make it worse:

- **Self-preferential bias** — the model that wrote the code is "way too nice"
  judging it.
- **Agentic laziness** — the loop declares "done enough" at partial completion.

## Decision

A `goal` loop terminates on an **objective gate**, not the agent's say-so.

1. **The stop condition is an executable check** — a test command, type check,
   build, or linter whose **exit code** decides pass/fail. "Not a verifier that
   has an opinion." The `loops` row stores this as `gate_command` (+ optional
   `gate_cwd`); the engine runs it after each iteration and only stops on exit 0.
2. **A self-emitted sentinel is advisory only.** The agent may still say it
   believes it's done; that triggers the gate to run, but never ends the loop by
   itself. `completion_sentinel` is retained purely as a "check now" hint.
3. **The verifier is blind to the maker.** When a loop uses an LLM reviewer
   subagent (in addition to the objective gate), that reviewer runs in a **fresh
   context with no exposure to the maker's reasoning** — separate instructions,
   ideally a different model. (Anthropic's evaluator-optimizer pattern.)
4. **No gate → no goal loop.** If a project has no automated check the loop can
   run, the engine refuses to create a `goal` loop and says why (see the
   4-condition gate in [autonomy-and-safety.md](../features/autonomy-and-safety.md)).

## Consequences

- Eliminates the most common silent-failure / money-pit mode for our loops.
- `loops` schema gains `gate_command`, `gate_cwd`; `completion_sentinel`
  downgraded to advisory. `loop-engine.md` updated accordingly.
- Forces a healthy constraint: goal loops only run where there's a real check,
  which is exactly where they're safe to run unattended.
- The blind-verifier rule means our reviewer subagent must be spawned without
  the maker's transcript — a concrete wiring requirement for Phase 2.
- Cross-references ADR 0026 (autonomous mode) — the objective gate is part of
  what makes unattended runs trustworthy.
