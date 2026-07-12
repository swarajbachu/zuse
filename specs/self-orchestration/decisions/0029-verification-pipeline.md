# ADR 0029 — A built-in verification pipeline ("ship lane") with recorded evidence

Date: 2026-06-23
Status: Accepted

## Context

The thing every serious loop practitioner reaches for on *every* change is a
verification pipeline, not a bare scheduler. Kun's `no-mistakes` and the
maker/checker discipline in Osmani's essay are the same idea: first-pass code is
not trusted; an independent pass takes it to a clean PR or escalates. This is
the single biggest anti-slop lever and the core of memoize's "loops you can
trust" positioning (see the README).

Without it, loops are a slop *generator*: they open PRs faster than a human can
read them, and "review capacity" becomes the bottleneck the loop was supposed to
remove.

## Decision

Ship a first-class **verification pipeline** ("ship lane") that any change — a
spawned thread's output or a manual session's — can be handed to. It runs in an
**isolated worktree** (so validation can't touch the working repo) and executes:

1. **Infer real intent** from the originating agent session (what was actually
   asked).
2. **Branch + commit**, then **rebase on latest origin/main and resolve
   conflicts** up front.
3. **Adversarial review in a fresh context** (ADR 0027's blind verifier):
   self-correct obvious issues; **escalate ambiguous / product-judgment ones to
   a human**.
4. **End-to-end test against the intent**, and **record evidence** — screenshot,
   video, or log — attached to the PR. (memoize already has the browser bridge
   to capture this.)
5. **Objective gate** — tests/type/build/lint must pass (exit-code gated, ADR
   0027). Security checks belong here too (SAST / dependency audit / secret scan
   — see [autonomy-and-safety.md](../features/autonomy-and-safety.md)).
6. **Docs pass** + **PR open** with: intent summary, what changed, how tested
   (links to evidence), what the pipeline fixed, and a **risk assessment**.
7. **Babysit the PR until merged** — re-resolve conflicts, re-run on CI failure
   (this is a heartbeat loop on the PR — reuses the Phase 2 loop engine).

The risk assessment tells the human **how much to review**: low-risk → trust the
gate; higher-risk → read the diff. This is the explicit antidote to
**comprehension debt** — make staying-in-comprehension cheap, don't remove the
human from it.

The pipeline is exposed both as an agent capability (a spawned thread can route
its own work through it) and a one-click action on any change in the UI.

## Consequences

- This is the headline of Phase 2, not an add-on. "Loop engine" without this is
  just a scheduler.
- Reuses: worktrees (isolation), browser bridge (evidence), GitService + PR
  tools (rebase/PR/merge), the loop engine (PR babysitting), and ADR 0027's
  blind verifier.
- New surface: an evidence store (screenshots/video/logs linked from the PR)
  and a structured PR body (intent / changes / evidence / fixes / risk).
- Detailed in [verification-pipeline.md](../features/verification-pipeline.md).
