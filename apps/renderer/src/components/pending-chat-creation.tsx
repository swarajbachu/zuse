import { useState } from "react";
import { useWorktreeSetupLifecycle } from "../hooks/use-worktree-setup-lifecycle.ts";
import { type PendingChatCreation, useChatsStore } from "../store/chats.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
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
	const folder = useWorkspaceStore(
		(s) =>
			s.folders.find((candidate) => candidate.id === creation.projectId) ??
			null,
	);
	const worktree = useWorktreeSetupLifecycle(
		creation.projectId,
		creation.worktreeId,
		creation.phase,
	);
	return (
		<div className="flex min-h-0 flex-1 flex-col px-3">
			<div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col">
				<div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3">
					<ChatCreationPromptBubble prompt={creation.prompt} />
					{creation.workspaceRequested ||
					creation.worktreeId !== null ||
					creation.phase === "starting_agent" ? (
						<SetupCardView
							data={{
								repoName: folder?.name ?? "this repo",
								hasWorktree:
									creation.workspaceRequested || creation.worktreeId !== null,
								worktreePending:
									(creation.phase === "persisted" ||
										creation.phase === "creating_workspace" ||
										(creation.worktreeId !== null && worktree === null)) &&
									creation.phase !== "failed",
								workspacePreparing: creation.phase === "persisted",
								worktreeName: worktree?.name ?? null,
								branch: worktree?.branch ?? null,
								baseBranch: worktree?.baseBranch ?? null,
								setupStatus:
									worktree?.setupStatus ??
									(creation.phase === "failed" && creation.workspaceRequested
										? "failed"
										: null),
								setupOutput: worktree?.setupOutput ?? "",
								agentStarting:
									creation.phase === "starting_agent" ? true : undefined,
								onRerun: null,
							}}
						/>
					) : null}
					{creation.phase === "failed" ? (
						<ChatCreationFailureActions creation={creation} />
					) : null}
				</div>
			</div>
		</div>
	);
}

export function ChatCreationPromptBubble({
	prompt,
}: {
	readonly prompt: string | null;
}) {
	if (prompt === null) return null;
	return (
		<div className="ml-auto max-w-[78%] rounded-xl rounded-br-md bg-muted/70 px-3 py-2 text-sm text-foreground">
			{prompt}
		</div>
	);
}

export function ChatCreationFailureActions({
	creation,
}: {
	readonly creation: PendingChatCreation;
}) {
	const [retrying, setRetrying] = useState(false);
	const retryCreation = useChatsStore((s) => s.retryCreation);
	const continueCreation = useChatsStore((s) => s.continueCreation);
	const discardCreation = useChatsStore((s) => s.discardCreation);
	return (
		<div className="mx-auto mt-3 flex max-w-xl items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
			<p className="min-w-0 flex-1 text-xs text-destructive">
				{creation.error ?? "Chat startup needs attention."}
			</p>
			<button
				type="button"
				disabled={retrying}
				className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50"
				onClick={() => {
					setRetrying(true);
					void retryCreation(creation.chatId).finally(() => setRetrying(false));
				}}
			>
				{retrying
					? "Retrying…"
					: creation.failureStage === "workspace"
						? "Retry workspace"
						: creation.failureStage === "provider"
							? "Retry agent"
							: "Retry setup"}
			</button>
			{creation.failureStage === "setup" ? (
				<button
					type="button"
					disabled={retrying}
					className="rounded-md border border-border/70 px-2 py-1.5 text-xs text-foreground hover:bg-muted disabled:opacity-50"
					onClick={() => {
						setRetrying(true);
						void continueCreation(creation.chatId).finally(() =>
							setRetrying(false),
						);
					}}
				>
					Continue anyway
				</button>
			) : null}
			<button
				type="button"
				disabled={retrying}
				className="rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
				onClick={() => discardCreation(creation.chatId)}
			>
				Discard
			</button>
		</div>
	);
}
