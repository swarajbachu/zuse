# ADR 0025 — Loop engine: one persistent fiber-scheduler, three loop kinds

Date: 2026-06-19
Status: Proposed (Phase 2)

## Context

memoize has no recurring/scheduled/goal primitive — work is event-driven or
one-off `forkDaemon`. The self-orchestration feature needs three looping
behaviors that the transcript calls for:

- a **heartbeat** that wakes a session every N minutes to poll a PR,
- a **goal** loop that re-prompts one session until it's done,
- a **wake-on-event** loop that fires when a condition flips (PR merged, child
  idle, file changed).

These could be three separate mechanisms, or external infra (cron, a job
queue like BullMQ). External infra is overkill for a single-process Electron
app and breaks the "in-process, Effect-native" architecture (ADR 0007).

## Decision

One `LoopEngineService` Layer with a single tick mechanism that expresses all
three kinds, persisted in a `loops` table, recovered on boot.

- **One fiber per active loop.** Time-based loops (`heartbeat`, `goal` tick
  cadence) use `Effect.Schedule`; event-based loops (`wake_on_event`, and
  `goal`'s "wait for idle") subscribe to existing pubsub streams
  (`session.streamStatus`, the `code-index/watcher.ts` file watcher). Modeled
  on the `forkDaemon` lifecycle already in `message-store.ts`.
- **Persisted + crash-safe.** Loop state lives in `loops`; on boot the engine
  re-arms `status = active` rows, mirroring the existing `booting → error`
  session sweep.
- **Reuse, don't reinvent.** Injecting a prompt = `MessageStore.sendMessage` /
  `messages.queue.add`; idle detection = `session.streamStatus`; token
  accounting = the persisted `usage` message rows; live UI = the
  `chat.streamChanges` pattern.
- **Termination is explicit.** Every loop has `max_iterations`; goal loops also
  end on a `completion_sentinel` (default `GOAL-COMPLETE`); Phase 3 adds token
  budgets. One active loop per `(target_session_id, kind)` (reentrancy guard).
- **Symmetry with the renderer.** The same engine methods back both the
  agent's loop-control tools (`schedule_heartbeat`, `start_goal_loop`,
  `wait_for`, `cancel_loop`) and the `loops.*` RPCs the UI uses.

## Consequences

- No external scheduler/queue dependency; the engine is pure Effect + SQLite,
  consistent with the rest of `apps/server`.
- The three kinds share recovery, budgeting, and the kill switch for free.
- Dynamic workflows ("loops that make loops") need **no per-workflow code** —
  they're the agent composing `create_thread` + loop-control tools at runtime.
- Risk: a fiber-per-loop could accumulate; the concurrency cap + kill switch
  (ADR 0026) bound it, and `max_iterations` guarantees forward termination.
- Provider-agnostic: the engine drives sessions through `MessageStore` /
  `session.*` methods, not SDK internals, so it works for any provider that
  backs a session.
