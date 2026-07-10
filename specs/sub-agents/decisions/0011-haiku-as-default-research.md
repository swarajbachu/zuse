# 0011 — Haiku 4.5 as the default model for the `research` preset

Status: Accepted (2026-05-04)

## Context

The `research` sub-agent ([../features/preset-library.md](../features/preset-library.md))
is the highest-traffic preset by design — almost every Opus session
spends a meaningful share of tokens on `Glob` / `Grep` / `Read` chains
just to find the right file before doing the actual reasoning. Routing
those to a cheaper model is the single biggest win the sub-agents
feature offers.

We ship one default model for `research`. Picking it sets user
expectations and (importantly) determines the cost ceiling for any
Opus session that lights this preset up. The default has to be
defensible without forcing users to re-tune.

## Options

For Claude, the candidates today (`packages/contracts/src/agent.ts:189`):

- Opus 4.7
- Sonnet 4.6
- Haiku 4.5

### Opus 4.7

Same model as the parent (most likely). Routing research to Opus saves
*context*, not *cost* — the wins are real (smaller parent context
window) but the per-token rate is unchanged. Defeats the framing of
sub-agents as a cost lever.

### Sonnet 4.6

The "safe middle." Sonnet won't fumble a multi-step grep chain. But it's
~3× the input rate of Haiku and we don't need its extra reasoning for
read-only search.

### Haiku 4.5

Cheapest tier, fastest. The risk is whether it's *good enough* for
search and summarization. Two checks:

1. **Tool-use accuracy.** Haiku 4.5 was Anthropic's first Haiku release
   trained for solid tool use; benchmarks against the same agentic
   evals as Sonnet show no regression for simple Read/Glob/Grep
   patterns. The failure modes Haiku has historically had — code
   generation accuracy, multi-step reasoning — don't apply when the
   tool-set is read-only.
2. **Summarization quality at the boundary.** The summary the sub-agent
   returns is what the parent sees. If Haiku writes a vague or wrong
   summary, the parent makes a worse decision. This is the genuine
   risk.

Mitigation for (2): the preset's prompt explicitly demands "cite file
paths and line numbers, don't speculate beyond code you've actually
read." That constraint is enforceable by the parent — if Haiku returns
a summary without citations, the parent can re-prompt or re-do the
work itself. The pattern is "trust but verify with cheap citations."

## Decision

**Haiku 4.5 is the default for `research`.**

The cost delta vs. Sonnet 4.6 (~3× cheaper input, ~3× cheaper output)
is meaningful for the highest-traffic preset, the read-only tool set
caps the blast radius, and the citation-required prompt makes
summary errors detectable.

User can change the model in settings — that's why the dropdown
exists. We ship the most-savings default and let users dial up if they
hit accuracy issues.

## Consequences

- The seed `research` preset in `apps/renderer/src/lib/subagent-presets.ts`
  uses `model: "claude-haiku-4-5"`.
- The `test-runner` preset, which is also search-heavy + parsing, uses
  Haiku as well (same reasoning).
- The `file-edits` preset uses Sonnet 4.6 — file edits *do* benefit
  from Sonnet's better coding accuracy and they're not high-volume
  enough for the cost delta to matter as much. Different preset,
  different default; this ADR specifically only covers `research`.
- If usage data shows Haiku materially under-performing on research
  tasks (false summaries, missed files), the default flips to Sonnet
  in a follow-up. This is reversible — just edit the preset.
- The settings UI's per-preset model dropdown (see
  [sub-agents.md → Settings](../features/sub-agents.md#settings))
  exists precisely so users who don't trust Haiku can switch without
  forking the preset.
