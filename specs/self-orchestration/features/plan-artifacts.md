# Rich plan artifacts — PLANNED (cross-cutting; can land independently)

Replace the wall-of-text plan with an annotatable artifact rendered in the
project's design system. The productized form of Kun's `lavish`. See
[decisions/0030-rich-plan-artifacts.md](../decisions/0030-rich-plan-artifacts.md).

## The problem

memoize plan mode emits a markdown plan. The human scrolls it, can't point at a
specific part, and can't visually judge a UI option from prose. The leverage in
agent work concentrates at the **start** (clarify intent) and **end** (hold
quality) of a task — a weak planning surface wastes the most valuable minutes
and lets the long autonomous middle drift.

## The artifact

When an agent plans (plan mode, or a spawned thread proposing work), it can emit
an HTML artifact rendered in memoize's existing **webview** that:

- presents options / diffs / mockups **in the project's design system**, so
  what you review looks like the real app;
- supports **inline annotation** — select a region, leave a comment;
- surfaces **explicit decisions** (buttons / choices) to resolve;
- ships the structured feedback (annotations + decisions) back to the agent as
  the plan's resolution — no terminal round-trip, no copy-paste.

It composes with the existing `AskUserQuestion` tool: that's for discrete
choices; the artifact is the richer, spatial version for plans / designs /
mockups. The same viewer renders the verification pipeline's **evidence**
(ADR 0029) and a loop's **state file** (ADR 0028).

## Why it's also a strategic proof point

Even a terminal-maximalist workflow (Kun's) reaches for a **browser** at the
planning step because text-in-terminal is a bad review surface. That's memoize's
GUI bet in microcosm: the terminal wins the edit/flow loop; the GUI wins the
plan and supervise loops.

## Reuse & surfaces

- Reuses the in-app webview / browser bridge (same plumbing as the browser
  tools) — no new rendering stack.
- New channels: agent → renderer (artifact), renderer → agent (annotations +
  decisions).
- Lands independently of the loop engine — normal plan mode benefits immediately.

## Verification

- An agent-emitted plan renders as an artifact in the app's design system.
- Annotating a region + clicking a decision returns structured feedback the
  agent acts on, with no terminal interaction.
