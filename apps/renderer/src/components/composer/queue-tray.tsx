import type { SessionId } from "@zuse/contracts";
import { useState } from "react";

import { useAutoAnimate } from "../../lib/use-auto-animate.ts";
import { useMessagesStore } from "../../store/messages.ts";
import { QueueChip } from "./queue-chip.tsx";
import { TrayPill } from "./tray-pill.tsx";

const EMPTY_QUEUE: ReadonlyArray<never> = [];

export function QueueTray({ sessionId }: { sessionId: SessionId }) {
  const items = useMessagesStore(
    (s) => s.queueBySession[sessionId] ?? EMPTY_QUEUE,
  );
  const paused = useMessagesStore(
    (s) => s.queuePausedBySession[sessionId] === true,
  );
  const running = useMessagesStore(
    (s) => s.runningBySession[sessionId] === true,
  );
  const reorder = useMessagesStore((s) => s.reorderQueue);
  const resume = useMessagesStore((s) => s.resumeQueue);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  // Animate add / remove / reorder of queued rows. Clean default ease, no
  // spring — keeps the tray feeling crisp rather than bouncy.
  const listRef = useAutoAnimate<HTMLDivElement>();
  if (items.length === 0) return null;

  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= items.length) return;
    const next = [...items];
    const [item] = next.splice(from, 1);
    if (item === undefined) return;
    next.splice(to, 0, item);
    reorder(
      sessionId,
      next.map((q) => q.id),
    );
  };

  const showPausedPill = paused && !running;

  return (
    <div ref={listRef}>
      {showPausedPill ? (
        <TrayPill
          flush
          title="Queue paused because you interrupted"
          actions={
            <button
              type="button"
              onClick={() => void resume(sessionId)}
              className="rounded px-1.5 py-0.5 text-[12px] text-muted-foreground hover:text-foreground"
              aria-label="Resume queued messages"
            >
              Resume
            </button>
          }
        />
      ) : null}
      {items.map((item, index) => (
        <QueueChip
          key={item.id}
          sessionId={sessionId}
          item={item}
          index={index}
          count={items.length}
          dragging={dragIndex === index}
          onMove={move}
          onDragStart={() => setDragIndex(index)}
          onDragOver={() => {
            if (dragIndex !== null && dragIndex !== index) {
              move(dragIndex, index);
              setDragIndex(index);
            }
          }}
          onDrop={() => setDragIndex(null)}
        />
      ))}
    </div>
  );
}
