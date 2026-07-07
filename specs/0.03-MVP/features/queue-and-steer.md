# Feature: Mid-turn queue and Steer

In MVP 0.02, while a turn is in flight the composer's Send button swaps
to Interrupt (`apps/renderer/src/components/chat-composer.tsx:111-126`).
The user can keep typing, but submission is blocked: anything they type
either has to be remembered until the turn ends, or thrown away.

MVP 0.03 turns those mid-turn typed thoughts into first-class queued
messages with a steerable affordance. Pressing `Enter` while a turn is
running puts the current `ComposerInput` into a per-session queue; the
queued message appears as a chip strip above the editor (inside the
composer card). Each queue chip carries an arrow icon: **hovering shows
a tooltip "Steer"**; **clicking interrupts the running turn and sends
the queued message immediately as the next user turn**.

The choice of "interrupt + send" over true mid-stream injection is
recorded in [../decisions/0012-steer-via-interrupt.md](../decisions/0012-steer-via-interrupt.md).

## Behavior

### Queueing

- The composer reads `runningBySession[sessionId]` from
  `useMessagesStore` (sourced from the existing `streamStatus`
  subscription, `apps/renderer/src/store/messages.ts:97-125`).
- When the user submits while `running === true`, the composer calls
  `queue(sessionId, input)` instead of `send(sessionId, input)` and
  clears the editor.
- Queued items are append-only; ordering is preserved.
- The queue is **per session** — switching sessions hides the current
  queue and shows the destination session's queue (if any).
- Queue state is renderer-only; it lives in `useMessagesStore` and
  does not survive an app reload. (Reasoning: queued messages are
  ephemeral by user intent. If the app restarts mid-turn, the user
  is making a recovery decision anyway.)

### `QueueTray`

The tray is mounted **inside the composer card**, above the editor,
so it visually attaches to the input rather than floating in the
timeline:

```
┌─ Frame ─────────────────────────────────────────────┐
│ ┌─ Card ──────────────────────────────────────────┐ │
│ │ ┌─ QueueTray ─────────────────────────────────┐ │ │
│ │ │  [📝 also check the codex driver  ↑  ×]    │ │ │
│ │ │  [📝 and update the README        ↑  ×]    │ │ │
│ │ └────────────────────────────────────────────┘ │ │
│ │ ┌─ CodeMirror ───────────────────────────────┐ │ │
│ │ │  …                                         │ │ │
│ │ └────────────────────────────────────────────┘ │ │
│ └────────────────────────────────────────────────┘ │
│ FrameFooter (model picker, mode, timer, etc.)      │
└────────────────────────────────────────────────────┘
```

Each chip:

- Subtle pill: `border-border/60 bg-muted/40`, vertical-center
  flex-row.
- 1-line text preview, truncated with `text-overflow: ellipsis`.
  Overflow tooltip shows the full message on hover after a 500 ms
  delay.
- **Steer arrow** on the right (lucide `ArrowUp`). On hover, the
  existing `Tooltip` from `~/components/ui/tooltip.tsx` shows
  `"Steer"`. Click semantics below.
- A small `×` (lucide `X`) drops the chip silently with no RPC call.
- If a chip carries attachments, the chip count appears as a tiny
  pill next to the text (e.g. `+2 image`); chips do not unfurl.

### Steer click

Clicking the arrow on a queue chip calls
`steerFromQueue(sessionId, queueId)`:

1. The store removes the chip from the queue (optimistic — the user
   is committing to send).
2. The store calls `messages.steer({ sessionId, input })` over RPC.
3. The provider driver:
   - Issues an interrupt against the running provider session.
   - Drains any post-interrupt messages that the SDK still emits
     (e.g. a Claude `ResultMessage` with `subtype:
     "error_during_execution"`).
   - Sends the queued `ComposerInput` as the next user turn (same
     pipeline as `messages.send`).
4. The renderer's existing message stream picks up the new user
   message; the Send/Interrupt button stays "running" continuously
   because the steer issues the new turn before the status drops.

### Auto-flush at end of turn

When the running turn ends naturally (assistant lands without a steer),
the messages store hooks the existing status-stream subscription
(`apps/renderer/src/store/messages.ts:97-125`):

- On the `running → idle | closed` transition, if
  `queueBySession[sessionId]` is non-empty, the store iterates the
  queue in order and calls `messages.send` for each `ComposerInput`,
  awaiting each one before sending the next so the provider sees a
  single chain rather than racing turns.
- After the queue drains, a toast appears: `"Queue cleared (N
  message(s) sent)"`.
- If a `messages.send` call errors, the loop stops, the remaining
  chips stay in the queue, and an error toast surfaces. The user can
  retry the head chip via its arrow (which now means "send next" since
  no turn is running) or drop it.

### Editor focus

When the queue is non-empty, the editor itself remains active and
accepts text — the user can keep composing while their previous
inputs sit in the queue. When the queue is empty, the tray collapses
(no zero-height ghost row).

## RPC contract

Added next to `MessagesSendRpc` in `packages/wire/src/session.ts`:

```ts
export class SteerUnsupportedError extends Schema.TaggedError<SteerUnsupportedError>()(
  "SteerUnsupportedError",
  { providerId: ProviderId },
) {}

export const MessagesSteerRpc = Rpc.make("messages.steer", {
  payload: Schema.Struct({
    sessionId: SessionId,
    input: ComposerInput,
  }),
  success: Schema.Void,
  error: Schema.Union(SessionNotFoundError, SteerUnsupportedError),
});
```

`SteerUnsupportedError` is wired through the schema for forward
compatibility with future providers that don't support interrupt;
both 0.03 drivers (Claude, Codex) report `canSteer: true` and never
return this error.

## Driver behavior

Both drivers implement the same shape; only the underlying mechanism
differs.

### Claude driver

```
1. await sdkClient.interrupt();
2. for await (msg of sdkClient.receiveResponse()) {
     if (msg.type === "result") break;     // drain the interrupted turn
   }
3. await dispatchSendInput(sessionId, input);   // same path messages.send takes
```

The drain in step 2 matches the Claude Agent SDK guidance for
post-interrupt cleanup: an interrupt produces a final result message
that must be consumed before the next query is issued.

### Codex driver

```
1. await codexClient.request("turn/interrupt");
2. // No drain needed; Codex's response stream closes on interrupt.
3. await dispatchSendInput(sessionId, input);
```

## Renderer state

Added to `apps/renderer/src/store/messages.ts`:

```ts
type QueuedMessage = {
  id: string;                         // local uuid
  input: ComposerInput;
  createdAt: Date;
};

readonly queueBySession: Record<SessionId, ReadonlyArray<QueuedMessage>>;
readonly queue:          (sessionId: SessionId, input: ComposerInput) => void;
readonly steerFromQueue: (sessionId: SessionId, queueId: string) => Promise<void>;
readonly dropFromQueue:  (sessionId: SessionId, queueId: string) => void;
```

Auto-flush is wired into the existing `streamStatus` `Effect.runFork`
block (`apps/renderer/src/store/messages.ts:97-125`): when the
`wasRunning && !isRunning` branch fires, after the existing
`refresh(projectId)` call, the store also iterates and drains the
queue for `sessionId`.

Heartbeats: any attachments referenced by queued messages are kept
alive by the same `attachments.touch` heartbeat the composer uses for
draft attachments (see [composer.md](composer.md)).

## Components added / changed

| File                                                       | Status | Purpose                                                       |
| ---------------------------------------------------------- | ------ | ------------------------------------------------------------- |
| `apps/renderer/src/components/composer/queue-tray.tsx`     | new    | Chip strip above the editor; renders queue chips.             |
| `apps/renderer/src/components/composer/queue-chip.tsx`     | new    | Single chip — preview, Steer arrow + tooltip, drop button.    |
| `apps/renderer/src/components/chat-composer.tsx`           | edit   | Mount `QueueTray` inside the card, above the editor.          |
| `apps/renderer/src/store/messages.ts`                      | edit   | `queueBySession`, `queue`, `steerFromQueue`, `dropFromQueue`; auto-flush hook. |
| `apps/server/src/provider/services/provider-service.ts`    | edit   | `steer(sessionId, input)` orchestrator.                       |
| `apps/server/src/provider/drivers/claude.ts`               | edit   | `steer` impl: interrupt → drain → send.                       |
| `apps/server/src/provider/drivers/codex.ts`                | edit   | `steer` impl: interrupt → send.                               |
| `packages/wire/src/session.ts`                             | edit   | `SteerUnsupportedError` + `MessagesSteerRpc`.                 |
| `packages/wire/src/rpc.ts`                                 | edit   | Register the new RPC.                                         |

## Acceptance criteria

Q1. While a turn is running, pressing `Enter` on a non-empty editor
    creates a queue chip in `QueueTray` and clears the editor; no
    message is sent.

Q2. Hovering the arrow icon on any queue chip shows a tooltip
    `"Steer"` after the standard tooltip delay.

Q3. Clicking the arrow ends the running assistant turn (the timeline
    shows the assistant's partial output as final), then a new user
    turn begins immediately with the queued text — no idle gap in the
    Send/Interrupt indicator.

Q4. If the assistant's turn lands while the queue still has items, the
    items auto-flush in order. A toast `"Queue cleared (N message(s)
    sent)"` appears once the last item is sent.

Q5. Clicking the `×` on a chip removes it silently — no RPC call, no
    toast.

Q6. The queue is per-session: switching to another session hides the
    chips; switching back shows them again. App reload clears all
    queues.

Q7. A queue chip carrying attachments keeps its attachments alive
    across the running turn — when it auto-flushes (or is steered),
    the resulting message still references the same
    `zuse://attachments/<id>` URLs.

Q8. `bun run check-types` passes for `apps/renderer`, `apps/server`,
    and `packages/wire`.

## Future hooks (intentional shape, not built yet)

- **Boundary-aware Steer**. Interrupt at the next tool-call boundary
  rather than mid-token so the assistant's last completed thought is
  preserved. Implementable as a driver-side guard that queues the
  interrupt until the active tool result lands. Decision recorded in
  [../decisions/0012-steer-via-interrupt.md](../decisions/0012-steer-via-interrupt.md).
- **Reorder / merge queue chips**. Drag-to-reorder, plus a merge
  affordance ("send these as one message"). Out of scope for v1.
- **Persist queue across reload**. Currently the queue is in-memory.
  If users start typing long backlogs, persisting per-session queues
  to the existing SQLite layer is a small, additive change.
