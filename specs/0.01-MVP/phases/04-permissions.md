# Phase 4 — Permissions & quality

**Goal**: agents become trustworthy enough to leave running unattended. Add the missing UX around the chat MVP (real permission prompts, inline diffs, resume).

**Status**: 📐 Spec

**Estimate**: ~2 weeks

**Depends on**: Phase 3 (chat MVP)

> **Note:** Renumbered from "Phase 3" when the chat-first pivot inserted the new Phase 3. Session persistence already shipped in Phase 3 (SQLite at `<userData>/zuse.sqlite`, sessions list in the projects sidebar). What's left here is permissions UI, inline diff rendering, resume of interrupted turns, and an NDJSON audit/export sink.

## Deliverables

1. Permission prompt UI: file write, command exec, network access
2. Per-session "allow for session" memory (no in-app pattern matching — the SDK suppresses re-prompts when we hand back a session-scoped decision)
3. NDJSON transcript audit log — best-effort tail-write per session, rotates at ~100 MB. SQLite remains the canonical store; NDJSON is for export / external tooling.
4. Resume: relaunch app, click a stopped session, continue from where it ended (where the SDK supports it — Claude does via its `session_id`; Codex falls back to "Session ended").
5. Inline diff rendering for `Edit` / `Write` / `MultiEdit` tool calls (replaces the JSON view).

## User scenarios

### S1 — Permission prompt
> Agent wants to run `npm install`. A toast appears at the top of the agent panel: "Run `npm install`?" with buttons: Allow once / Allow for this session / Deny. I pick "Allow for this session" — same command later in the same session doesn't re-prompt.

### S2 — Restart resume
> I'm mid-task, app crashes (or I quit). I reopen. The folder shows a "Resumable session" badge. I click it. The transcript loads. I send a new message; the SDK resumes from the last cursor.

### S3 — Audit trail
> I want to know what an agent did last week. I open the folder, click the sessions list, pick a date. Full transcript is there. I click any tool-use to see exact arguments and results.

## Storage layout

Session metadata, message history, and permission decisions all live in `<userData>/zuse.sqlite` (SQLite is canonical — schema added by migrations 0002 and 0003). NDJSON is a side-write audit/export sink:

```
<userData>/
  zuse.sqlite                                 # canonical: sessions, messages, permission_decisions
  sessions/
    <project-id>/
      <session-id>.events.ndjson                  # tail-written; rotates to *.events.<ts>.ndjson at 100MB
```

## Permission model

```ts
type PermissionKind =
  | { _tag: "FileWrite"; path: string }
  | { _tag: "Bash"; command: string }
  | { _tag: "Network"; url: string }

type PermissionDecision =
  | { _tag: "AllowOnce" }
  | { _tag: "AllowForSession" }
  | { _tag: "Deny" }
  | { _tag: "AlwaysAllow"; scope: "folder" | "global" }   // future
```

For Phase 4 only `AllowOnce`, `AllowForSession`, `Deny` are exposed in the UI. `AlwaysAllow` is schema-only plumbing.

## Acceptance criteria

- [ ] Permission prompts block agent execution until decided (no race conditions)
- [ ] "Allow for session" is honored for exact-match commands; near-matches re-prompt
- [ ] Crash recovery: kill -9 the app mid-session, relaunch, transcript is intact
- [ ] Resume works for Claude SDK (verify cursor handling)
- [ ] Resume falls back gracefully for Codex if SDK lacks resume — shows "Session ended, start new"
- [ ] NDJSON transcript size capped (rotate at 100MB per session)

## Risks

- **Permission prompt UX is hard to get right.** Mitigation: copy patterns from existing CLI permission flows; iterate after dogfooding.
- **Cursor/resume semantics differ across SDKs.** Mitigation: explicit `ResumeStrategy` per adapter, with "no resume" as a valid value.
