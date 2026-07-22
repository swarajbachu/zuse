import { HugeiconsIcon } from "@hugeicons/react";
import {
	GitBranchIcon,
	GitForkIcon,
	Loading02Icon,
} from "@hugeicons-pro/core-solid-rounded";
import type { MessageId, SessionId, Worktree } from "@zuse/contracts";
import { useState } from "react";

import { getSessionById, useSessionsStore } from "../store/sessions.ts";
import { useWorktreesStore } from "../store/worktrees.ts";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu.tsx";
import { toastManager } from "./ui/toast.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip.tsx";

export function ForkButton({
	sourceSessionId,
	fromMessageId,
}: {
	readonly sourceSessionId: SessionId;
	readonly fromMessageId: MessageId;
}) {
	const [forking, setForking] = useState(false);
	const fork = useSessionsStore((state) => state.fork);

	const run = async (destination: "tab" | "chat") => {
		if (forking) return;
		setForking(true);

		let createdWorktree: Worktree | null = null;
		try {
			if (destination === "chat") {
				const source = getSessionById(sourceSessionId);
				if (source === null) {
					toastManager.add({
						title: "Fork failed",
						description: "The source session is no longer available.",
						type: "error",
					});
					return;
				}
				createdWorktree = await useWorktreesStore
					.getState()
					.create(source.projectId);
				if (createdWorktree === null) {
					toastManager.add({
						title: "Worktree creation failed",
						description:
							useWorktreesStore.getState().error ??
							"Could not create an isolated worktree for this fork.",
						type: "error",
					});
					return;
				}
			}

			const result = await fork({
				sourceSessionId,
				fromMessageId,
				destination,
				worktreeId: createdWorktree?.id,
			});
			if (result === null) {
				if (createdWorktree !== null) {
					const source = getSessionById(sourceSessionId);
					if (source !== null) {
						await useWorktreesStore
							.getState()
							.remove(source.projectId, createdWorktree.id);
					}
				}
				toastManager.add({
					title: "Fork failed",
					description: "Could not branch this conversation.",
					type: "error",
				});
				return;
			}
			toastManager.add({
				title:
					destination === "tab"
						? "Forked in this chat"
						: "Forked into a new worktree",
				description:
					result.forkMode === "resume"
						? "The new branch continues with full agent memory."
						: "The conversation through this response was copied into the new branch.",
				type: "success",
			});
		} finally {
			setForking(false);
		}
	};

	return (
		<Menu>
			<Tooltip>
				<TooltipTrigger
					render={
						<MenuTrigger
							disabled={forking}
							aria-label="Fork from this response"
							className="inline-grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground/70 outline-none hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97] data-[popup-open]:bg-muted/50 data-[popup-open]:text-foreground [@media(pointer:coarse)]:size-11"
						>
							<HugeiconsIcon
								icon={forking ? Loading02Icon : GitForkIcon}
								className={forking ? "size-3.5 animate-spin" : "size-3.5"}
								aria-hidden="true"
							/>
						</MenuTrigger>
					}
				/>
				<TooltipPopup>Fork from this response</TooltipPopup>
			</Tooltip>
			<MenuPopup align="start" className="min-w-52 bg-glass border-glass">
				<Tooltip>
					<TooltipTrigger
						render={
							<MenuItem
								onClick={() => void run("tab")}
								className="gap-2.5 px-2 py-1.5"
							>
								<HugeiconsIcon icon={GitForkIcon} className="size-4" />
								<span>Fork in this chat</span>
							</MenuItem>
						}
					/>
					<TooltipPopup side="right" align="start" className="max-w-64">
						Open a new session tab that shares this chat and its current
						worktree.
					</TooltipPopup>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger
						render={
							<MenuItem
								onClick={() => void run("chat")}
								className="gap-2.5 px-2 py-1.5"
							>
								<HugeiconsIcon icon={GitBranchIcon} className="size-4" />
								<span>Fork into a new worktree</span>
							</MenuItem>
						}
					/>
					<TooltipPopup side="right" align="start" className="max-w-64">
						Create a separate chat in an isolated Git worktree for parallel
						work.
					</TooltipPopup>
				</Tooltip>
			</MenuPopup>
		</Menu>
	);
}
