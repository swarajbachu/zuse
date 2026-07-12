# Verification pipeline / "ship lane" — PLANNED (Phase 2, the headline)

This is the anti-slop centerpiece. A loop or thread produces first-pass code;
the verification pipeline takes that first pass all the way to a clean,
evidence-backed PR — or escalates the parts a human must decide. It's the
productized form of the maker/checker discipline (Anthropic's evaluator-
optimizer pattern) and of Kun's `no-mistakes` tool. See
[decisions/0029-verification-pipeline.md](../decisions/0029-verification-pipeline.md).

## Why it's the headline, not an add-on

A loop engine without verification is a slop generator: it opens PRs faster than
a human can read them, so review capacity becomes the new bottleneck. The
pipeline is what lets a human *walk away* — it's the reason autonomy is safe.
memoize's whole position ("loops you can trust") rests on this being first-class.

## The stages

Runs in an **isolated worktree** so validation never touches the working repo:

1. **Infer intent** — analyze the originating agent session to recover what was
   actually asked (not just the diff).
2. **Branch + commit**, then **rebase on latest `origin/main`** and resolve
   conflicts up front.
3. **Adversarial review in a fresh context** — a blind verifier (ADR 0027): no
   exposure to the maker's reasoning, separate instructions, ideally a different
   model. Self-correct obvious issues; **escalate ambiguous / product-judgment
   ones to a human**.
4. **End-to-end test against intent** + **record evidence** — screenshot, video,
   or log captured via the browser bridge and linked from the PR.
5. **Objective gate** (ADR 0027) — tests / type / build / lint must pass by exit
   code; **security checks** (SAST, dependency audit, secret scan) run here too.
6. **Docs pass** — update docs the change affects.
7. **Open PR** with a structured body: intent · what changed · how tested (links
   to evidence) · what the pipeline fixed · **risk assessment**.
8. **Babysit the PR until merged** — re-resolve conflicts, re-run on CI failure.
   This stage *is* a heartbeat loop on the PR — it reuses the Phase 2 loop engine.

## Risk assessment → how much to review

The PR's risk score tells the human how deep to go: low-risk → trust the gate
and the evidence; higher-risk → read the diff. This is the explicit antidote to
**comprehension debt** (see [autonomy-and-safety.md](autonomy-and-safety.md)) —
the goal is to make staying-in-comprehension cheap at fleet scale, not to remove
the human from it. Spot-checking the gate periodically is part of the workflow
(gates rot).

## Surfaces

- **Agent capability**: a spawned thread can route its own output through the
  pipeline (a loop-control/orchestration tool, e.g. `ship` / `verify_and_pr`).
- **One-click UI action** on any change ("ship this") for the human-driven path.
- **Evidence store**: screenshots / video / logs, linked from the PR and
  renderable in the rich plan-artifact viewer (ADR 0030).

## Reuse

| Need | Existing thing |
|---|---|
| Isolated validation | worktrees (Pokemon worktrees) |
| Recorded evidence | browser bridge / browser tools |
| Rebase / PR / merge | GitService (`prState`/`prDetails`/`prMerge`/`prReady`) + new `prComments` |
| PR babysitting | the Phase 2 loop engine (heartbeat on the PR) |
| Blind verifier | spawned reviewer thread/subagent without the maker's transcript |

## Failure modes it must avoid

- **Ralph Wiggum** (exits half-done) → objective exit-code gate, ADR 0027.
- **Self-preferential bias** → blind verifier, no maker reasoning.
- **Gate rot** → surface "what did the gate actually check" + periodic human
  spot-check prompts.

## Verification (of the pipeline itself)

- A change with a deliberately failing test never reaches "PR opened."
- An ambiguous/product-judgment change gets escalated, not auto-merged.
- Evidence is attached and viewable; risk score correlates with diff size/area
  (e.g. `src/payments/**` → high regardless of size).
