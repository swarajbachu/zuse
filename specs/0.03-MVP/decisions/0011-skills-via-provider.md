# 0011 — Skills are discovered by the active provider, not by memoize

Status: Accepted (2026-05-04)

## Context

MVP 0.03 surfaces user-authored skills (markdown commands with
frontmatter) inside the composer's slash popover. The user's stated
direction was explicit: **memoize should not own a skill directory of
its own.** Users already author skills inside their preferred coding
agent — under `~/.claude/skills/` and project-level `.claude/skills/`
when working with Claude, under `~/.codex/skills/` and project-level
`.codex/skills/` when working with Codex. Asking them to maintain a
third copy under `.zuse/skills/` would be a tax on every user with
no offsetting benefit.

The question is **how** to plumb those existing directories into
memoize's UI without re-implementing each provider's discovery rules,
frontmatter conventions, override semantics, or hot-reload signals.

## Options

### Option A — Memoize owns `.zuse/skills/`

- A new directory the user has to populate.
- Simplest implementation: memoize reads markdown, parses frontmatter,
  emits a list.
- Cost: every user maintains a separate skill copy per coding tool;
  every minor format divergence between Claude/Codex skill formats
  needs a memoize-specific re-encoding; every cross-tool skill
  ergonomic gain in a future Claude or Codex release is invisible to
  memoize unless we re-implement it.

### Option B — Memoize reads provider directories directly

- Memoize reads `.claude/skills/`, `.codex/skills/`, etc. from disk
  itself, parsing the frontmatter formats each tool uses.
- Avoids the "maintain three copies" tax.
- Cost: memoize now owns parsing rules for each provider and has to
  match each provider's discovery semantics (which directories are
  scanned, project vs. global precedence, override rules,
  inheritance). Every time a provider changes those rules, memoize
  drifts. Frontmatter parsing bugs are memoize's bugs, not the
  provider's.

### Option C — Delegate to the provider driver

- Each provider driver exposes `listSkills` and `subscribeSkills`. The
  underlying tool does the discovery and parsing; memoize consumes
  the projected `Skill` shape.
- For Claude, the Agent SDK already does this work (`settingSources:
  ["user", "project", "local"]` exposes commands via `init.commands`);
  the driver projects each entry onto our `Skill` schema.
- For Codex, the CLI exposes `skills/list` over its RPC interface and
  emits `SkillsChangedNotification` on changes.
- Cost: memoize gains a small cross-provider normalization layer; in
  return, every change in provider semantics is invisible (and free).

## Decision

**Option C: drivers expose `listSkills` and `subscribeSkills`; the
renderer never touches the filesystem for skills.**

The choice follows the same logic that gave memoize its provider
abstraction in the first place: the Claude SDK and the Codex CLI are
better at being themselves than memoize will ever be. Any time an
inner tool updates its skill semantics — adding new frontmatter
fields, changing precedence, supporting new directories — memoize
inherits those improvements without code changes.

## Consequences

- A small `Skill` schema lives in `packages/wire/src/skill.ts` with
  the union of fields both providers report (name, scope, description,
  arguments, optional filePath, providerId). Each driver projects its
  native shape onto this; renderer code never sees provider-native
  shapes.

- Skills are **scoped per active session**, by design. The popover
  shows only the active provider's skills. Switching providers swaps
  the list. There is no merged "all skills across all providers"
  view, because skills don't compose across providers — a Claude
  skill body invokes Claude tools, a Codex skill body invokes Codex
  tools, and a hypothetical merged view would make it ambiguous what
  the user is invoking.

- Project-scoped skills shadow global skills with the same name. Both
  drivers already implement this; memoize just respects the
  precedence each driver returns and does not re-sort.

- Hot reload is free. The Claude SDK re-emits `init` (with the new
  command list) on settings changes; Codex emits
  `SkillsChangedNotification`. The driver translates these into
  `subscribeSkills.onChange` calls; the renderer's `skill.stream`
  subscription pushes the new list to the popover.

- Skill body expansion happens on the provider side. When the user
  picks a `skill` chip and submits, memoize passes a `SkillRef
  { name, scope, args }` to the driver, which calls into the SDK or
  CLI to invoke the skill. Memoize never inlines skill body text
  into the prompt. This keeps memoize's behavior identical to using
  the underlying tool directly — users get the same skill semantics
  they'd get from their CLI.

- Authoring is also out of scope for memoize. Users edit skill
  files in their text editor, in the destination directory their
  provider expects. Future polish (a "New skill" template-drop
  affordance, an "Edit skill" jump-to-source link) is additive;
  memoize owning the format itself would not be.

- We accept that switching providers mid-conversation means switching
  skill lists mid-conversation. This is not a bug — a user who
  switches from Claude to Codex on the same session is signaling that
  the conversation is now Codex-flavored, and the Codex skills are
  what should appear.

## Amendment (2026-05-05): how drivers discover

The original wording assumed the underlying tool exposes discovery via
its SDK or RPC interface (`init.commands` for Claude, `skills/list` for
Codex). In practice the Claude Agent SDK only exposes
`Query.supportedCommands()` once a `query()` call is in flight, which
memoize doesn't have at popover-open time — sessions are started
lazily on first send. Spawning an ephemeral `query()` purely to list
skills costs a real model handshake.

We're relaxing the boundary: **drivers own discovery, by whatever
means.** Reading provider skill directories from disk is acceptable
when no live SDK channel exists. The renderer still never touches disk
for skills, and the wire `Skill` shape is unchanged. The driver
remains the authority and is the single place to update if a provider
moves its discovery format.

Concretely for 0.03:

- **Claude driver** scans `~/.claude/skills/`,
  `~/.claude/plugins/*/skills/`, and `<projectCwd>/.claude/skills/`
  directly, parsing `SKILL.md` frontmatter (`name`, `description`,
  `argument-hint`, `allowed-tools`).
- **Codex driver** scans `~/.codex/prompts/` and
  `<projectCwd>/.codex/prompts/`, accepting either YAML frontmatter or
  filename-derived names.
- A future iteration may swap to SDK / RPC discovery (e.g. when the
  Claude SDK exposes a session-less listing) — the renderer surface
  doesn't change.
