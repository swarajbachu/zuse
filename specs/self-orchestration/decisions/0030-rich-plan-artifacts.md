# ADR 0030 — Rich, annotatable plan artifacts instead of wall-of-text plans

Date: 2026-06-23
Status: Accepted

## Context

memoize's plan mode today produces a markdown plan — a wall of text the human
scrolls through, can't easily point at a specific part of, and can't visually
evaluate. Kun's `lavish` tool solves exactly this: instead of printing the plan,
the agent renders an **HTML artifact in the project's own design system**,
shows it in a browser, lets the human **annotate specific parts** and **click
decision buttons**, and feeds that structured feedback straight back — without
returning to the terminal.

This matters doubly for loop engineering: the human's leverage concentrates at
the *start* (clarifying intent) and *end* (holding quality) of a task. A better
planning surface front-loads clarity, which is what lets the long autonomous
middle actually succeed.

It's also a direct proof point for memoize's GUI bet: even a terminal
maximalist reaches for a *visual* surface at the planning step.

## Decision

Add **rich plan artifacts** as a planning output mode. When an agent plans
(plan mode, or a spawned thread proposing work), it can emit an artifact
rendered in memoize's existing **webview** that:

- presents options/diffs/mockups **in the project's design system** (consistent
  with how the app actually looks);
- supports **inline annotation** — the human selects a region and comments;
- surfaces **explicit decisions** (buttons / choices) the human resolves;
- ships the structured feedback (annotations + decisions) back to the agent as
  the plan's resolution — no context lost, no copy-paste.

This composes with the existing `AskUserQuestion` tool (discrete decisions) —
the artifact is the richer, spatial version for plans/designs/mockups. It is
also the natural place to render the verification pipeline's **recorded
evidence** (ADR 0029) and a loop's **state file** (ADR 0028) for review.

## Consequences

- Reuses the in-app webview / browser bridge already used by the browser tools —
  no new rendering stack.
- Turns "review the plan" from scrolling text into pointing at a picture, which
  raises plan quality and lowers the chance the autonomous middle goes off-track.
- New surface: an artifact channel (agent → renderer) + an annotation/decision
  channel (renderer → agent). Sketched in
  [plan-artifacts.md](../features/plan-artifacts.md).
- Cross-cutting: useful outside loops too (normal plan mode benefits), so it can
  land independently of the loop engine.
