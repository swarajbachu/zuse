import "@zuse/i18n/english/projects";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ChatCreationPhase } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { Alert01Icon, Tick01Icon } from "@zuse/icons/solid-rounded";
import { ChevronRight } from "lucide-react";
import { useWorktreeSetupLifecycle } from "../hooks/use-worktree-setup-lifecycle.ts";
import { useCloudChatCatalogStore } from "../lib/cloud-workspace-catalog.ts";
import { useActiveEnvironmentEntities } from "../lib/environment-entity-hooks.ts";
import { shouldShowSetupCard } from "../lib/setup-card-visibility.ts";
import { useActiveContext } from "../store/active-workspace.ts";
import { useChatsStore } from "../store/chats.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import { useWorktreesStore } from "../store/worktrees.ts";
import { Button } from "./ui/button.tsx";
import { Spinner } from "./ui/spinner";

type StepState = "pending" | "active" | "done" | "failed";

/**
 * Everything the unified setup card needs to render, decoupled from the
 * stores so the same markup can drive both the live in-`ChatView` card and
 * the optimistic landing bridge (no session/worktree row yet). Keeping it a
 * plain prop object guarantees the two render pixel-identically so the swap
 * from bridge → live card is invisible.
 */
export type SetupCardData = {
	/** Repo / project name — "a new copy of <repo>". */
	readonly repoName: string;
	readonly creationPhase?: ChatCreationPhase | null;
	/** Whether this flow creates a worktree at all (false = main checkout). */
	readonly hasWorktree: boolean;
	/** Worktree row not hydrated yet — branch/copy still in flight. */
	readonly worktreePending: boolean;
	readonly worktreeName: string | null;
	readonly branch: string | null;
	readonly baseBranch: string | null;
	/** `null` until the worktree row exists. */
	readonly setupStatus:
		| "pending"
		| "running"
		| "succeeded"
		| "failed"
		| "skipped"
		| null;
	readonly setupOutput: string;
	/** Rerun handler, present only when setup has failed and a row exists. */
	readonly onRerun: (() => void) | null;
};

/**
 * Inline timeline card shown while a new chat is coming up: it narrates the
 * worktree branch/copy, streams the live environment-setup log, and tracks
 * the provider/model CLI boot — all in one place, with the composer pinned
 * at the bottom. Replaces the old full-screen `ChatCreatingPanel` stepper.
 * Renders nothing once there's no setup work left and the provider is ready.
 */
export function WorktreeSetupCard({
	providerOutputStarted = false,
}: {
	readonly providerOutputStarted?: boolean;
} = {}) {
	const ctx = useActiveContext();
	const selectedChatId = useChatsStore((state) => state.selectedChatId);
	const pendingCreation = useChatsStore((state) =>
		selectedChatId === null
			? null
			: (state.pendingCreationByChat[selectedChatId] ?? null),
	);
	const cloudSummary = useCloudChatCatalogStore(
		(state) =>
			state.summaries.find((row) => row.chatId === selectedChatId) ?? null,
	);
	const selectedSessionId = useSessionsStore((s) => s.selectedSessionId);
	const { sessionsByProject, creationOperationsByProject } =
		useActiveEnvironmentEntities();
	const creation = Object.values(creationOperationsByProject)
		.flat()
		.find((row) => row.chatId === selectedChatId);
	const creationPhase = creation?.phase ?? pendingCreation?.phase ?? null;
	const session =
		selectedSessionId === null
			? null
			: (Object.values(sessionsByProject)
					.flat()
					.find((candidate) => candidate.id === selectedSessionId) ?? null);
	const initialSession = (() => {
		if (session === null) return false;
		const chatSessions = sessionsByProject[session.projectId] ?? [];
		const oldest = chatSessions
			.filter((candidate) => candidate.chatId === session.chatId)
			.toSorted(
				(left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
			)[0];
		return oldest?.id === session.id;
	})();
	const repoName = useWorkspaceStore((s) => {
		if (ctx.status !== "ready" && ctx.status !== "worktree-pending")
			return null;
		return s.folders.find((f) => f.id === ctx.folderId)?.name ?? null;
	});
	const setupProjectId =
		pendingCreation?.projectId ??
		(ctx.status === "ready" || ctx.status === "worktree-pending"
			? ctx.folderId
			: null);
	const setupWorktreeId =
		ctx.status === "ready" || ctx.status === "worktree-pending"
			? ctx.worktreeId
			: (creation?.worktreeId ?? pendingCreation?.worktreeId ?? null);
	const worktree = useWorktreeSetupLifecycle(
		setupProjectId,
		setupWorktreeId,
		creationPhase,
	);
	const rerunSetup = useWorktreesStore((s) => s.rerunSetup);
	const hasWorktree =
		ctx.status === "worktree-pending" ||
		(ctx.status === "ready" && ctx.worktreeId !== null);
	const worktreePending =
		ctx.status === "worktree-pending" ||
		(ctx.status === "ready" && ctx.worktreePending);
	const setupStatus = worktree?.setupStatus ?? null;
	const setupDone =
		setupStatus === "succeeded" ||
		setupStatus === "skipped" ||
		((setupStatus === null || setupStatus === "pending") &&
			(creationPhase === "starting_agent" || creationPhase === "running"));
	const externalResume = session !== null && session.resumeStrategy !== "none";

	// This card owns workspace setup only. As soon as that work is done, the
	// normal transcript activity row owns provider startup.
	const visible = shouldShowSetupCard({
		externalResume,
		initialSession,
		hasWorktree,
		setupDone,
		workspacePending: ctx.status === "worktree-pending",
	});
	if (providerOutputStarted) return null;
	// Cloud lifecycle is shown once, in the composer connection tray.
	if (cloudSummary !== null) return null;
	if (!visible) return null;

	return (
		<SetupCardView
			data={{
				repoName: repoName ?? "this repo",
				creationPhase,
				hasWorktree,
				worktreePending,
				worktreeName: worktree?.name ?? null,
				branch: worktree?.branch ?? null,
				baseBranch: worktree?.baseBranch ?? null,
				setupStatus,
				setupOutput: worktree?.setupOutput ?? "",
				onRerun:
					worktree !== null && setupStatus === "failed"
						? () => void rerunSetup(worktree.projectId, worktree.id)
						: null,
			}}
		/>
	);
}

/**
 * Presentational card. Pure function of {@link SetupCardData} so the live
 * card and the landing bridge share one source of truth for the markup.
 */
export function SetupCardView({ data }: { data: SetupCardData }) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	const {
		repoName,
		hasWorktree,
		worktreePending,
		branch,
		creationPhase,
		setupStatus: observedSetupStatus,
		setupOutput,
		onRerun,
	} = data;

	const setupStatus =
		observedSetupStatus !== null && observedSetupStatus !== "pending"
			? observedSetupStatus
			: creationPhase === "starting_agent" || creationPhase === "running"
				? "succeeded"
				: creationPhase === "running_setup"
					? "running"
					: creationPhase === "failed"
						? "failed"
						: observedSetupStatus;
	const showsWorktreeSteps = hasWorktree || worktreePending;
	const wtReady =
		showsWorktreeSteps &&
		(!worktreePending ||
			setupStatus === "running" ||
			setupStatus === "succeeded" ||
			setupStatus === "skipped");
	const setupDone = setupStatus === "succeeded" || setupStatus === "skipped";
	const summaryState: StepState =
		setupStatus === "failed" ? "failed" : !setupDone ? "active" : "done";
	const summaryLabel =
		setupStatus === "failed"
			? wtReady
				? uiMessage("projects:worktree_setup_card_environment_setup_failed")
				: uiMessage("projects:worktree_setup_card_worktree_creation_failed")
			: setupStatus === "running"
				? uiMessage("projects:worktree_setup_card_running_environment_setup")
				: setupDone
					? uiMessage("projects:worktree_setup_card_workspace_ready")
					: !wtReady
						? uiMessage("projects:worktree_setup_card_creating_worktree", {
								repoName,
							})
						: uiMessage("projects:worktree_setup_card_detecting_setup_script");

	return (
		<details className="group/setup mx-auto w-full max-w-3xl px-4 pt-3 text-xs">
			<summary className="flex h-7 cursor-pointer list-none items-center gap-2 rounded-md text-muted-foreground outline-none select-none marker:content-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
				<span
					className="flex size-4 shrink-0 items-center justify-center"
					aria-hidden="true"
				>
					{summaryState === "active" ? (
						<Spinner className="size-3" />
					) : (
						<HugeiconsIcon
							icon={summaryState === "failed" ? Alert01Icon : Tick01Icon}
							className={
								summaryState === "failed"
									? "size-3.5 text-destructive"
									: "size-3.5"
							}
						/>
					)}
				</span>
				<span
					className={
						summaryState === "failed"
							? "min-w-0 truncate text-destructive"
							: "min-w-0 truncate text-foreground/80"
					}
				>
					{summaryLabel}
				</span>
				<ChevronRight
					aria-hidden="true"
					className="size-3 shrink-0 transition-transform duration-150 group-open/setup:rotate-90 motion-reduce:transition-none"
				/>
				{branch !== null ? (
					<span
						title={branch}
						className="ml-auto min-w-0 truncate font-mono text-[11px] text-muted-foreground"
					>
						{branch}
					</span>
				) : null}
			</summary>
			<div className="pb-1 pl-6 pt-1">
				{setupOutput.trim().length > 0 ? (
					<pre className="max-h-48 overflow-auto rounded-md bg-muted/30 px-3 py-2 font-mono text-[11px] leading-4 whitespace-pre-wrap break-words text-muted-foreground">
						{setupOutput}
					</pre>
				) : (
					<p className="py-1 text-[11px] leading-4 text-muted-foreground">
						{!wtReady
							? uiMessage("projects:worktree_setup_card_preparing_directory")
							: setupStatus === "skipped"
								? uiMessage("projects:worktree_setup_card_no_setup_script")
								: setupDone
									? uiMessage(
											"projects:worktree_setup_card_workspace_ready_description",
										)
									: uiMessage(
											"projects:worktree_setup_card_preparing_environment",
										)}
					</p>
				)}
				{onRerun !== null ? (
					<div className="mt-2">
						<Button variant="ghost" className="h-7" onClick={onRerun}>
							{uiMessage("projects:worktree_setup_card_rerun_setup")}
						</Button>
					</div>
				) : null}
			</div>
		</details>
	);
}
