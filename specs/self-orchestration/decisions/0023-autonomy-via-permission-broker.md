# ADR 0023 — Autonomy levels ride the existing permission broker

Date: 2026-06-19
Status: Accepted

## Context

We need three autonomy postures — `off`, `approval-gated`, `autonomous` — that
decide whether the agent can spawn worktrees/threads and how much it must ask
first. The temptation is to build a new gating subsystem. But memoize already
has a mature one: `PermissionService` brokers between the SDK `canUseTool`
callback and the renderer toast, with per-session and per-folder "allow"
decisions persisted in SQLite, plus a `policyFor` classifier in `claude.ts`
that auto-allows read-only tools and sensitive-path-guards everything.

## Decision

Map autonomy onto **tool registration + the existing permission system**
rather than a new mechanism.

- **`off`** — `buildExtraToolsForSession` returns `[]`. No orchestration tools
  are registered; memoize behaves byte-for-byte as before. This is the default
  and the regression guarantee.
- **`approval-gated` / `autonomous`** — orchestration tools are registered.
  Then the *driver's existing policy* decides per call:
  - Read-only tools (`read_thread`, `list_threads`, `whoami`) are added to
    `READ_ONLY_TOOLS` in `claude.ts` → auto-allow, like the index reads.
  - Mutating tools (`create_worktree`, `create_thread`, `send_to_thread`, and
    later `merge_pr`) are NOT read-only → `policyFor` falls through to a
    permission prompt. **That prompt is the approval gate.** "Always allow for
    session/folder" already persists, so a user who trusts the flow isn't
    re-prompted.

`autonomy` lives in `SettingsFile.defaultAutonomyLevel`, read by
`MessageStore` at session-create time. No separate `autonomy.*` RPC for now —
the existing `settings.update` (with `SettingsPatch.defaultAutonomyLevel`)
covers it.

The fully-unattended auto-approve that distinguishes `autonomous` from
`approval-gated` is **deferred until the kill switch exists** — see
[0026-kill-switch-gates-autonomous.md](0026-kill-switch-gates-autonomous.md).
Until then both gated levels behave identically (everything prompts unless the
session's `runtimeMode` already auto-allows).

## Consequences

- `approval-gated` is almost entirely *configuration* — minimal new gating
  code, and the UX (the permission toast) is one the user already knows.
- The driver stays ignorant of "autonomy" — it only sees tool FQNs and the
  existing `runtimeMode`. Autonomy is decided upstream (whether to register the
  tools at all).
- Known edge: a session whose `runtimeMode` is already `full-access` will
  auto-allow mutating orchestration tools even at `approval-gated`. Acceptable
  for v1 (the user chose full-access); a per-tool force-prompt refinement can
  land with the kill switch if needed.
- Sensitive-path guards (`.env`, `.ssh/`, `*.pem`) and the always-prompt
  `ExitPlanMode` rule continue to apply unchanged.
