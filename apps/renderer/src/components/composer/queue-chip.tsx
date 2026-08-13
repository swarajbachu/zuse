import { HugeiconsIcon } from "@hugeicons/react";
import type { EnvironmentId, QueuedMessage, SessionId } from "@zuse/contracts";
import {
	ArrowTurnDownIcon,
	Chat01Icon,
	Delete02Icon,
	DragDropVerticalIcon,
	MoreHorizontalIcon,
} from "@zuse/icons/solid-rounded";
import { ChevronDown, ChevronUp, Pencil } from "lucide-react";
import { useState } from "react";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import {
	dropQueuedMessage,
	runQueuedMessageNext,
} from "../../lib/session-actions.ts";
import { useComposerBridge } from "../../store/composer-bridge.ts";
import { TrayPill, trayPillActionClass } from "./tray-pill.tsx";

const previewText = (q: QueuedMessage): string => {
	const t = q.input.text.trim();
	if (t.length === 0) {
		if (q.input.attachments.length > 0)
			return `(${q.input.attachments.length} file)`;
		return "(empty)";
	}
	return t.replace(/\s+/g, " ");
};

const refSubtitle = (q: QueuedMessage): string | undefined => {
	const a = q.input.attachments.length;
	const r = q.input.fileRefs.length + q.input.skillRefs.length;
	if (a === 0 && r === 0) return undefined;
	const parts: string[] = [];
	if (a > 0) parts.push(`${a} file${a === 1 ? "" : "s"}`);
	if (r > 0) parts.push(`${r} ref${r === 1 ? "" : "s"}`);
	return parts.join(" · ");
};

export function QueueChip({
	sessionId,
	environmentId,
	item,
	index,
	count,
	running,
	dragging,
	onMove,
	onDragStart,
	onDragOver,
	onDrop,
}: {
	sessionId: SessionId;
	environmentId: EnvironmentId;
	item: QueuedMessage;
	index: number;
	count: number;
	running: boolean;
	dragging: boolean;
	onMove: (from: number, to: number) => void;
	onDragStart: () => void;
	onDragOver: () => void;
	onDrop: () => void;
}) {
	const ref = { environmentId, sessionId };
	const [runningNow, setRunningNow] = useState(false);
	const text = previewText(item);
	const subtitle = item.ready ? refSubtitle(item) : "Preparing attachments…";

	const runNext = async () => {
		if (runningNow || !item.ready) return;
		setRunningNow(true);
		await runQueuedMessageNext(ref, item.id);
		setRunningNow(false);
	};

	const edit = () => {
		useComposerBridge.getState().editQueuedMessage?.(item);
	};

	const icon = (
		<HugeiconsIcon icon={Chat01Icon} className="size-3.5" aria-hidden="true" />
	);

	return (
		<TrayPill
			flush
			icon={icon}
			title={text}
			subtitle={subtitle}
			className={cn("group", dragging && "bg-muted/55")}
			draggable
			onDragStart={(event) => {
				event.dataTransfer.effectAllowed = "move";
				onDragStart();
			}}
			onDragOver={(event) => {
				event.preventDefault();
				onDragOver();
			}}
			onDrop={(event) => {
				event.preventDefault();
				onDrop();
			}}
			leading={
				<button
					type="button"
					className="-ml-1 flex size-4 shrink-0 cursor-grab items-center justify-center text-muted-foreground/60 opacity-0 hover:text-foreground group-hover:opacity-100 active:cursor-grabbing"
					aria-label="Drag queued message"
				>
					<HugeiconsIcon icon={DragDropVerticalIcon} className="size-3.5" />
				</button>
			}
			actions={
				<>
					<Tooltip>
						<TooltipTrigger
							render={
								<button
									type="button"
									onClick={() => void runNext()}
									disabled={!item.ready || runningNow}
									className={cn(
										trayPillActionClass,
										"h-7 w-auto gap-1.5 px-2 text-foreground hover:text-foreground",
									)}
									aria-label={
										running
											? "Steer to queued message"
											: "Send queued message now"
									}
								>
									<HugeiconsIcon
										icon={ArrowTurnDownIcon}
										className="size-3.5"
									/>
									<span className="text-[11px]">
										{runningNow ? "Starting…" : running ? "Steer" : "Send now"}
									</span>
								</button>
							}
						/>
						<TooltipPopup>
							{running
								? "Steer the agent to this message next"
								: "Send this message now"}
						</TooltipPopup>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger
							render={
								<button
									type="button"
									onClick={edit}
									className={trayPillActionClass}
									aria-label="Edit queued message"
								>
									<Pencil className="size-3.5" strokeWidth={1.8} />
								</button>
							}
						/>
						<TooltipPopup>Edit</TooltipPopup>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger
							render={
								<button
									type="button"
									onClick={() => dropQueuedMessage(ref, item.id)}
									className={cn(trayPillActionClass, "hover:text-destructive")}
									aria-label="Remove queued message"
								>
									<HugeiconsIcon icon={Delete02Icon} className="size-3.5" />
								</button>
							}
						/>
						<TooltipPopup>Remove</TooltipPopup>
					</Tooltip>
					<Menu>
						<MenuTrigger
							render={
								<button
									type="button"
									className={trayPillActionClass}
									aria-label="More queue actions"
								>
									<HugeiconsIcon
										icon={MoreHorizontalIcon}
										className="size-3.5"
									/>
								</button>
							}
						/>
						<MenuPopup align="end" sideOffset={4}>
							<MenuItem
								onClick={() => onMove(index, index - 1)}
								disabled={index === 0}
							>
								<ChevronUp />
								Move up
							</MenuItem>
							<MenuItem
								onClick={() => onMove(index, index + 1)}
								disabled={index >= count - 1}
							>
								<ChevronDown />
								Move down
							</MenuItem>
						</MenuPopup>
					</Menu>
				</>
			}
		/>
	);
}
