# ADR 0024 — The unit of autonomy is a real memoize thread, not an SDK sub-agent

Date: 2026-06-19
Status: Accepted

## Context

memoize already has SDK-native sub-agents (the `agents` map + the `Agent`/`Task`
tools — see `specs/sub-agents/`). When the agent needs to spawn parallel work,
there are two candidate primitives:

1. **SDK sub-agents (`Agent`/`Task`)** — ephemeral, in-process, share the
   parent's conversation, depth ≤ 1 (the SDK forbids sub-agents spawning their
   own), no separate worktree / PR / transcript. Great for "go find every API
   endpoint and summarize."
2. **Real memoize threads** — a new `chat` + `session`, optionally on its own
   `worktree`, with its own persisted transcript that appears in the sidebar.
   This is the Codex "a thread spawns another thread" model.

The transcript's workflow — spawn an impl thread, spawn a *separate* review
thread, loop on PR comments, merge, trigger the next stacked PR — is
fundamentally about **separate units of work with their own branches, PRs, and
review cycles**, which the user watches and supervises. SDK sub-agents can't
express that: they're one collapsed row inside one conversation.

## Decision

The control plane's unit of autonomy is a **real memoize thread**.
`create_thread` calls `MessageStore.createChat` to produce an actual
chat/session (sidebar-visible, own worktree, own transcript, own resume
cursor), tagged with `originSessionId` for lineage. SDK sub-agents remain
available and unchanged for in-conversation fan-out.

Tool descriptions explicitly steer the model: use `create_thread` "when the
work deserves its own worktree/PR/review cycle"; use `Agent`/`Task` for
in-conversation delegation that shares this chat.

## Consequences

- The user supervises a **tree of real threads** (Phase 3 lineage/Loops panel),
  not opaque nested rows — matching the transcript's "I woke up to four stacked
  PRs."
- Spawned threads can themselves have the control plane (recursion → "loops
  that make loops"), unlike SDK sub-agents which are depth-capped. This is
  powerful and dangerous — hence budgets + concurrency caps + kill switch
  (ADR 0026).
- More heavyweight than a sub-agent (a full provider boot per thread), so the
  tool descriptions push sub-agents for cheap in-chat work.
- Reuses the entire chat/session/worktree stack — no new "agent runtime."
