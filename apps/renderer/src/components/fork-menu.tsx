import "@zuse/i18n/english/chat";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
	FolderId,
	ForkDestination,
	MessageId,
	SessionId,
	Worktree,
} from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { Loading02Icon } from "@zuse/icons/solid-rounded";
import { GitBranchIcon } from "@zuse/icons/stroke-rounded";
import { useState } from "react";

import { activeSessionById } from "../lib/environment-entities.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useWorktreesStore } from "../store/worktrees.ts";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu.tsx";
import { toastManager } from "./ui/toast.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip.tsx";

function ForkSplitIcon({ className }: { readonly className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			viewBox="0 0 24 24"
			fill="none"
			className={className}
		>
			<path
				d="M4 12h4c2.3 0 3.8-1 5.2-2.7L18 4"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<path
				d="M13.5 4H18v4.5"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<path
				d="M8 12c2.3 0 3.8 1 5.2 2.7L18 20"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<path
				d="M18 15.5V20h-4.5"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

export function ForkButton({
	sourceSessionId,
	fromMessageId,
	label = "response",
	fixedDestination,
	sourceProjectId,
}: {
	readonly sourceSessionId: SessionId;
	readonly fromMessageId: MessageId;
	readonly label?: "message" | "response";
	readonly fixedDestination?: ForkDestination;
	readonly sourceProjectId?: FolderId;
}) {
	const { message: uiMessage } = useUiMessages(["chat"]);

	const [forking, setForking] = useState(false);
	const fork = useSessionsStore((state) => state.fork);

	const run = async (destination: ForkDestination) => {
		if (forking) return;
		setForking(true);

		let createdWorktree: Worktree | null = null;
		let projectId = sourceProjectId ?? null;
		try {
			if (destination === "chat") {
				if (projectId === null) {
					const source = activeSessionById(sourceSessionId);
					projectId = source?.projectId ?? null;
				}
				if (projectId === null) {
					toastManager.add({
						title: uiMessage("chat:fork_menu_fork_failed"),
						description: uiMessage(
							"chat:fork_menu_the_source_session_is_no_longer_available",
						),
						type: "error",
					});
					return;
				}
				createdWorktree = await useWorktreesStore.getState().create(projectId);
				if (createdWorktree === null) {
					toastManager.add({
						title: uiMessage("chat:fork_menu_worktree_creation_failed"),
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
				if (createdWorktree !== null && projectId !== null) {
					await useWorktreesStore
						.getState()
						.remove(projectId, createdWorktree.id);
				}
				toastManager.add({
					title: uiMessage("chat:fork_menu_fork_failed"),
					description: uiMessage(
						"chat:fork_menu_could_not_branch_this_conversation",
					),
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
						: `The conversation through this ${label} was copied into the new branch.`,
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
							aria-label={uiMessage("chat:fork_menu_fork_from_this_2", {
								label: String(label),
							})}
							className="inline-grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground/70 outline-none hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97] data-[popup-open]:bg-muted/50 data-[popup-open]:text-foreground [@media(pointer:coarse)]:size-11"
						>
							{forking ? (
								<HugeiconsIcon
									icon={Loading02Icon}
									className="size-3.5 animate-spin"
									aria-hidden="true"
								/>
							) : (
								<ForkSplitIcon className="size-3.5" />
							)}
						</MenuTrigger>
					}
				/>
				<TooltipPopup>
					{uiMessage("chat:fork_menu_fork_from_this_sentence", {
						label: label,
					})}
				</TooltipPopup>
			</Tooltip>
			<MenuPopup align="start" className="min-w-52 bg-glass border-glass">
				{fixedDestination !== "chat" ? (
					<Tooltip>
						<TooltipTrigger
							render={
								<MenuItem
									onClick={() => void run("tab")}
									className="gap-2.5 px-2 py-1.5"
								>
									<ForkSplitIcon className="size-4" />
									<span>{uiMessage("chat:fork_menu_fork_in_this_chat")}</span>
								</MenuItem>
							}
						/>
						<TooltipPopup side="right" align="start" className="max-w-64">
							{uiMessage(
								"chat:fork_menu_open_a_new_session_tab_that_shares_this_chat_and_its_current_worktree",
							)}
						</TooltipPopup>
					</Tooltip>
				) : null}
				{fixedDestination !== "tab" ? (
					<Tooltip>
						<TooltipTrigger
							render={
								<MenuItem
									onClick={() => void run("chat")}
									className="gap-2.5 px-2 py-1.5"
								>
									<HugeiconsIcon icon={GitBranchIcon} className="size-4" />
									<span>
										{uiMessage("chat:fork_menu_fork_into_a_new_worktree")}
									</span>
								</MenuItem>
							}
						/>
						<TooltipPopup side="right" align="start" className="max-w-64">
							{uiMessage(
								"chat:fork_menu_create_a_separate_chat_in_an_isolated_git_worktree_for_parallel_work",
							)}
						</TooltipPopup>
					</Tooltip>
				) : null}
			</MenuPopup>
		</Menu>
	);
}
