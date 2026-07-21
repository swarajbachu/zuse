import { HugeiconsIcon } from "@hugeicons/react";
import { GitBranchIcon, GitForkIcon } from "@hugeicons-pro/core-stroke-rounded";
import type { MessageId, SessionId } from "@zuse/contracts";
import { useCallback, useState } from "react";

import { useSessionsStore } from "../store/sessions.ts";
import { Menu, MenuItem, MenuPopup } from "./ui/menu.tsx";
import { toastManager } from "./ui/toast.tsx";

type ForkTarget = {
	anchor: { getBoundingClientRect: () => DOMRect };
	sourceSessionId: SessionId;
	fromMessageId: MessageId;
};

/**
 * Right-click "Fork from here" menu. Manages its own anchored popover; the
 * caller wires `openAt` to an `onContextMenu` handler on the message row and
 * renders `menu` once. Both destinations (new tab / new sidebar chat) are
 * offered directly so the user picks in one click.
 */
export function useForkMenu(): {
	openAt: (
		e: React.MouseEvent,
		sourceSessionId: SessionId,
		fromMessageId: MessageId,
	) => void;
	menu: React.ReactNode;
} {
	const [target, setTarget] = useState<ForkTarget | null>(null);
	const fork = useSessionsStore((s) => s.fork);

	const openAt = useCallback<
		(e: React.MouseEvent, s: SessionId, m: MessageId) => void
	>((e, sourceSessionId, fromMessageId) => {
		e.preventDefault();
		e.stopPropagation();
		const rect = new DOMRect(e.clientX, e.clientY, 0, 0);
		setTarget({
			anchor: { getBoundingClientRect: () => rect },
			sourceSessionId,
			fromMessageId,
		});
	}, []);

	const run = useCallback(
		async (destination: "tab" | "chat") => {
			if (target === null) return;
			const { sourceSessionId, fromMessageId } = target;
			setTarget(null);
			const result = await fork({
				sourceSessionId,
				fromMessageId,
				destination,
			});
			if (result === null) {
				toastManager.add({
					title: "Fork failed",
					description: "Could not branch this conversation.",
					type: "error",
				});
				return;
			}
			toastManager.add({
				title:
					destination === "tab" ? "Forked to new tab" : "Forked to new chat",
				description:
					result.forkMode === "resume"
						? "The branch continues with full agent memory."
						: "The branch was seeded with the conversation so far.",
				type: "success",
			});
		},
		[fork, target],
	);

	const menu =
		target === null ? null : (
			<Menu open onOpenChange={(open) => !open && setTarget(null)}>
				<MenuPopup
					anchor={target.anchor}
					align="start"
					side="bottom"
					className="min-w-[184px]"
				>
					<MenuItem
						onClick={() => void run("tab")}
						className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent"
					>
						<HugeiconsIcon icon={GitBranchIcon} className="size-3.5" />
						Fork to new tab
					</MenuItem>
					<MenuItem
						onClick={() => void run("chat")}
						className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent"
					>
						<HugeiconsIcon icon={GitForkIcon} className="size-3.5" />
						Fork to new chat
					</MenuItem>
				</MenuPopup>
			</Menu>
		);

	return { openAt, menu };
}
