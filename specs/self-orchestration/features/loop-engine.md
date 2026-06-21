# Loop engine (Layer 2) — PLANNED (Phase 2)

The loop engine is the one genuinely new subsystem. Today everything in
memoize is event-driven (message in → process) or one-off
(`Effect.forkDaemon` boot). There is **no recurring / scheduled / goal
primitive**. This adds a `LoopEngineService` Layer, a `loops` persistence
table, a set of loop-control tools, the PR tools that loops feed on, and the
global kill switch.

## Loop kinds — one engine, three behaviors

1. **`heartbeat`** — fire every `intervalMs` (or cron expr). On each tick,
   inject a fixed `prompt` into a target session ("Check PR #X; if there are
   new review comments, address them; if it's approved + green, merge it and
   reply DONE"). The session does its turn; the loop sleeps until next tick.
   This is the transcript's PR-watcher.
2. **`goal`** — after the target session goes **idle** (already streamed via
   `session.streamStatus`), inject a continuation prompt ("Have you achieved:
   `<goal>`? If not, continue. If yes, reply `GOAL-COMPLETE`."). Loops until
   the agent emits the completion sentinel, the iteration cap, or budget
   exhaustion. This is Claude Code's `/goal`.
3. **`wake_on_event`** — fire when a watched condition flips: PR merged, a
   child thread reaches idle, or a file path changes (via the existing
   `code-index/watcher.ts`). Lets a parent thread "wait for the review thread,
   then act" without busy-polling.

All three share one tick mechanism — an Effect fiber per active loop, driven
by `Effect.Schedule` for time-based loops and by subscribing to existing
pubsub streams (`streamStatus`, the file watcher) for event-based ones. See
[decisions/0025-loop-engine-fiber-scheduler.md](../decisions/0025-loop-engine-fiber-scheduler.md).

## Persistence — `loops` table

New migration `00NN_loops.ts`:

| column | meaning |
|---|---|
| `id`, `project_id` | identity / scope (FK cascade like other tables) |
| `kind` | `heartbeat` \| `goal` \| `wake_on_event` |
| `target_session_id` | session the loop drives (FK `SET NULL`) |
| `created_by_session_id` | lineage — which agent created this loop |
| `prompt` | text injected each tick |
| `schedule_json` | interval ms / cron expr / event spec |
| `status` | `active` \| `paused` \| `done` \| `killed` \| `errored` |
| `iteration_count`, `max_iterations` | progress + hard cap |
| `budget_tokens`, `spent_tokens` | per-loop token budget |
| `next_run_at`, `last_run_at` | scheduling |
| `completion_sentinel` | string that ends a goal loop (default `GOAL-COMPLETE`) |
| `created_at`, `updated_at` | — |

On server boot, `LoopEngineService` loads `status = active` rows and re-arms
their fibers (crash-safe, mirroring the `booting → error` session sweep
already in `message-store.ts`).

## Reuse, don't reinvent

The engine is mostly *wiring existing primitives*:

| Need | Existing thing | Location |
|---|---|---|
| Inject a prompt | `MessageStore.sendMessage` / `messages.queue.add` | `message-store.ts`, `session.ts` |
| Know when a session is idle (goal) | `session.streamStatus` | `provider/handlers.ts` |
| File-change events (wake) | debounced `fs.watch` | `code-index/watcher.ts` |
| Background fibers + recovery | `Effect.forkDaemon` + booting sweep | `message-store.ts` |
| Token accounting | persisted `usage` message-content variant | `wire/session.ts` |
| Live UI stream | `chat.streamChanges` pattern | `provider/handlers.ts` |

## Loop-control tools (Layer 1 ∩ Layer 2)

So the agent can build dynamic workflows itself, exposed as in-process tools
alongside the Phase-1 control plane:

- `schedule_heartbeat({ sessionId, prompt, everyMinutes, maxIterations? })` → `loopId`
- `start_goal_loop({ sessionId, goal, maxIterations? })` → `loopId`
- `wait_for({ event, ... })` → `loopId`
- `cancel_loop({ loopId })`, `list_loops()`

This is what makes "I asked the model to make a loop and it made a loop that
makes sub-loops" possible: the orchestrator agent calls `create_thread` +
`start_goal_loop` + `schedule_heartbeat` itself, composing the workflow shape
that fits the problem.

## PR tools (loops feed on these)

Reuse `git/layers/git-service.ts`, which already wraps `gh`:

- `pr_status({ worktreeId })` → open/draft/merged + review state + failing
  checks + comment count (`prState` / `prDetails` already exist).
- `pr_comments({ worktreeId })` → unresolved review comments
  (`gh pr view --json comments,reviews`) — small read-only addition to
  GitService; this is what the heartbeat loop feeds back to the impl thread.
- `mark_pr_ready({ worktreeId })` → wraps `prReady`.
- `merge_pr({ worktreeId })` → wraps `prMerge`. **Stays approval-gated even at
  `autonomous`** unless merges are separately opted in (see
  [autonomy-and-safety.md](autonomy-and-safety.md)).

## Wire / RPC additions (Phase 2)

In `packages/wire/src/loop.ts` (+ handlers, registered in `MemoizeRpcs`):

- `loops.list(projectId)`, `loops.get(loopId)`, `loops.streamChanges(projectId)`
- `loops.create(input)`, `loops.pause(loopId)`, `loops.resume(loopId)`,
  `loops.cancel(loopId)`
- `loops.killAll(projectId)` — the global kill switch

These give the renderer the same control the agent has via tools — both call
the same `LoopEngineService` methods.

## Files (Phase 2)

**New**
- `apps/server/src/loop/services/loop-engine-service.ts` — abstract shape.
- `apps/server/src/loop/layers/loop-engine-service.ts` — fiber scheduler, tick
  logic, boot recovery.
- `apps/server/src/loop/handlers.ts` — `loops.*` RPC handlers.
- `apps/server/src/persistence/migrations/00NN_loops.ts`.
- `packages/wire/src/loop.ts` — `Loop`, `LoopKind`, RPC defs.
- Renderer: Loops/Activity panel + kill-switch control + spawned-chat badge.

**Modified**
- `apps/server/src/runtime.ts` — add `LoopEngineServiceLive` to `makeMainLayer`.
- `apps/server/src/git/layers/git-service.ts` — add read-only `prComments`.
- `apps/server/src/provider/layers/message-store.ts` — add loop-control + PR
  tools to `buildOrchestrationTools` deps; route `send_to_thread` through the
  message queue when the target is busy.

## Reentrancy guard

A loop must not spawn another loop on the *same* `(session, kind)` each tick —
the engine enforces one active loop per `(target_session_id, kind)`.

## Verification (Phase 2)

- `loops` CRUD round-trips; engine arms/fires/cancels a heartbeat against a
  fake session; goal loop terminates on sentinel and on iteration cap.
- E2E: open a PR on a worktree, `schedule_heartbeat` to watch it, push a
  review comment → loop wakes the thread, it addresses the comment, the Loops
  panel shows the iteration count advancing. Hit the kill switch → all loops
  stop and running sessions interrupt.
