import type { EnvironmentId, SessionId } from "@zuse/contracts";
import { useState } from "react";
import {
	reorderSessionQueue,
	resumeSessionQueue,
} from "../../lib/session-actions.ts";
import { isSessionTurnActive } from "../../lib/session-runtime-state.ts";
import { useRendererSessionTimeline } from "../../lib/session-timeline-hooks.ts";
import { useAutoAnimate } from "../../lib/use-auto-animate.ts";
import { QueueChip } from "./queue-chip.tsx";
import { TrayPill } from "./tray-pill.tsx";

export function QueueTray({
	sessionId,
	environmentId,
}: {
	sessionId: SessionId;
	environmentId: EnvironmentId;
}) {
	const timeline = useRendererSessionTimeline(
		sessionId,
		"connect",
		environmentId,
	);
	const items = timeline.projection?.queue.items ?? [];
	const paused = timeline.projection?.queue.paused === true;
	const running = isSessionTurnActive(timeline.runtime);
	const ref = { environmentId, sessionId };
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
		reorderSessionQueue(
			ref,
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
							onClick={() => void resumeSessionQueue(ref)}
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
					environmentId={environmentId}
					item={item}
					index={index}
					count={items.length}
					running={running}
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
