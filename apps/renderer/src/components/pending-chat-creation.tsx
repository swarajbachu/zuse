import { useState } from "react";
import { PROVIDER_LABEL } from "../lib/provider-labels.ts";
import { useProviderStartupDelay } from "../lib/provider-startup-delay.ts";
import { type PendingChatCreation, useChatsStore } from "../store/chats.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import { EMPTY_WORKTREES, useWorktreesStore } from "../store/worktrees.ts";
import { SetupCardView } from "./worktree-setup-card.tsx";

/**
 * Safe pre-ack surface for a provisional chat. It deliberately reads only
 * renderer state and worktree state: no transcript, session, filesystem,
 * terminal, or pull-request RPC can fire before the durable chat exists.
 */
export function PendingChatCreationSurface({
	creation,
}: {
	creation: PendingChatCreation;
}) {
	const [retrying, setRetrying] = useState(false);
	const retryCreation = useChatsStore((s) => s.retryCreation);
	const discardCreation = useChatsStore((s) => s.discardCreation);
	const folder = useWorkspaceStore(
		(s) =>
			s.folders.find((candidate) => candidate.id === creation.projectId) ??
			null,
	);
	const worktree = useWorktreesStore((s) =>
		creation.worktreeId === null
			? null
			: ((s.byProject[creation.projectId] ?? EMPTY_WORKTREES).find(
					(candidate) => candidate.id === creation.worktreeId,
				) ?? null),
	);
	const providerActive = creation.phase === "creating-chat";
	const providerDelayed = useProviderStartupDelay(
		providerActive,
		creation.operationId,
	);

	return (
		<div className="flex min-h-0 flex-1 flex-col px-3">
			<div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col">
				<div className="min-h-0 flex-1 overflow-y-auto">
					<SetupCardView
						data={{
							repoName: folder?.name ?? "this repo",
							hasWorktree:
								creation.workspaceRequested || creation.worktreeId !== null,
							worktreePending:
								(creation.phase === "creating-workspace" ||
									(creation.worktreeId !== null && worktree === null)) &&
								creation.phase !== "failed",
							worktreeName: worktree?.name ?? null,
							branch: worktree?.branch ?? null,
							baseBranch: worktree?.baseBranch ?? null,
							setupStatus:
								worktree?.setupStatus ??
								(creation.phase === "failed" && creation.workspaceRequested
									? "failed"
									: null),
							setupOutput: worktree?.setupOutput ?? "",
							providerLabel:
								PROVIDER_LABEL[creation.providerId] ?? creation.providerId,
							providerState:
								creation.phase === "failed"
									? "failed"
									: providerActive
										? "active"
										: "pending",
							providerDelayed,
							onRerun: null,
						}}
					/>
					{creation.phase === "failed" ? (
						<div className="mx-auto mt-3 flex max-w-xl items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
							<p className="min-w-0 flex-1 text-xs text-destructive">
								{creation.error ?? "Chat creation failed."}
							</p>
							<button
								type="button"
								disabled={retrying}
								className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50"
								onClick={() => {
									setRetrying(true);
									void retryCreation(creation.chatId).finally(() =>
										setRetrying(false),
									);
								}}
							>
								{retrying ? "Retrying…" : "Retry"}
							</button>
							<button
								type="button"
								disabled={retrying}
								className="rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
								onClick={() => discardCreation(creation.chatId)}
							>
								Discard
							</button>
						</div>
					) : null}
				</div>
				{creation.prompt !== null ? (
					<div className="px-4 pb-4">
						<div className="ml-auto max-w-[78%] rounded-2xl rounded-br-md border border-border/70 bg-muted/70 px-3 py-2 text-sm text-foreground">
							{creation.prompt}
							<div className="mt-1 text-[10px] text-muted-foreground">
								Queued · sends when the agent is ready
							</div>
						</div>
					</div>
				) : null}
			</div>
		</div>
	);
}
