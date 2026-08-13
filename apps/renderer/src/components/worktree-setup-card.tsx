import { HugeiconsIcon } from "@hugeicons/react";
import type { CloudChatSummary } from "@zuse/contracts";
import { Alert01Icon, CloudIcon, Tick01Icon } from "@zuse/icons/solid-rounded";
import { useState } from "react";
import {
	refreshCloudChatCatalog,
	useCloudChatCatalogStore,
} from "../lib/cloud-workspace-catalog.ts";
import { runControlPlane } from "../lib/control-plane-client.ts";
import { useActiveEnvironmentEntities } from "../lib/environment-entity-hooks.ts";
import { shouldShowSetupCard } from "../lib/setup-card-visibility.ts";
import { useActiveContext } from "../store/active-workspace.ts";
import { useChatsStore } from "../store/chats.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import { EMPTY_WORKTREES, useWorktreesStore } from "../store/worktrees.ts";
import { AgentActivityOrb } from "./ui/agent-activity-orb.tsx";
import { Button } from "./ui/button.tsx";
import { ShimmerText } from "./ui/shimmer-text.tsx";
import { Spinner } from "./ui/spinner";
import { toastManager } from "./ui/toast.tsx";

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
	/** Workspace is ready, but the initial provider turn has not started yet. */
	readonly agentStarting?: boolean;
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
	agentStarting,
}: {
	readonly agentStarting?: boolean;
} = {}) {
	const ctx = useActiveContext();
	const selectedChatId = useChatsStore((state) => state.selectedChatId);
	const cloudSummary = useCloudChatCatalogStore(
		(state) =>
			state.summaries.find((row) => row.chatId === selectedChatId) ?? null,
	);
	const selectedSessionId = useSessionsStore((s) => s.selectedSessionId);
	const { sessionsByProject } = useActiveEnvironmentEntities();
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
	const worktree = useWorktreesStore((s) => {
		if (
			(ctx.status !== "ready" && ctx.status !== "worktree-pending") ||
			ctx.worktreeId === null
		)
			return null;
		const list = s.byProject[ctx.folderId] ?? EMPTY_WORKTREES;
		return list.find((w) => w.id === ctx.worktreeId) ?? null;
	});
	const rerunSetup = useWorktreesStore((s) => s.rerunSetup);
	const hasWorktree =
		ctx.status === "worktree-pending" ||
		(ctx.status === "ready" && ctx.worktreeId !== null);
	const worktreePending =
		ctx.status === "worktree-pending" ||
		(ctx.status === "ready" && ctx.worktreePending);
	const setupStatus = worktree?.setupStatus ?? null;
	const setupDone = setupStatus === "succeeded" || setupStatus === "skipped";
	const externalResume = session !== null && session.resumeStrategy !== "none";

	// This card belongs to chat/worktree creation. A provider still boots for
	// every additional session, but that must not replay chat setup UI after the
	// shared worktree is ready.
	const visible =
		initialSession &&
		(ctx.status === "worktree-pending" ||
			agentStarting !== undefined ||
			shouldShowSetupCard({
				externalResume,
				initialSession,
				hasWorktree,
				setupDone,
			}));
	if (
		cloudSummary !== null &&
		cloudSummary.startupPhase !== "running" &&
		cloudSummary.state !== "paused" &&
		cloudSummary.state !== "resuming" &&
		!cloudSummary.statusCode.includes("resume")
	)
		return <CloudWorkspaceSetupCard summary={cloudSummary} />;
	if (!visible) return null;

	return (
		<SetupCardView
			data={{
				repoName: repoName ?? "this repo",
				hasWorktree,
				worktreePending,
				worktreeName: worktree?.name ?? null,
				branch: worktree?.branch ?? null,
				baseBranch: worktree?.baseBranch ?? null,
				setupStatus,
				setupOutput: worktree?.setupOutput ?? "",
				agentStarting,
				onRerun:
					worktree !== null && setupStatus === "failed"
						? () => void rerunSetup(worktree.projectId, worktree.id)
						: null,
			}}
		/>
	);
}

const cloudPhaseRank: Record<CloudChatSummary["startupPhase"], number> = {
	allocating: 0,
	booting: 1,
	"authenticating-runtime": 1,
	"syncing-repository": 2,
	"starting-agent": 3,
	running: 4,
	failed: -1,
};

const cloudFailureRank = (statusCode: string): number => {
	if (/agent/u.test(statusCode)) return 3;
	if (/git|repository|branch/u.test(statusCode)) return 2;
	if (/runtime|enroll|credential|auth/u.test(statusCode)) return 1;
	return 0;
};

export const cloudFailureMessage = (statusCode: string): string => {
	switch (statusCode) {
		case "updating-runtime-failed":
			return "The secure runtime is incompatible with the cloud control plane. Retry after the cloud service finishes updating.";
		case "starting-runtime-failed":
			return "The secure runtime could not start. Retry will create a clean sandbox.";
		case "syncing-repository-failed":
			return "The sandbox started, but the repository could not be prepared. Retry will create a clean sandbox.";
		case "runtime-connection-timeout":
			return "The sandbox started, but its secure runtime did not connect in time.";
		case "provider-sandbox-missing":
			return "The saved sandbox no longer exists. Retry will restore this workspace in a new sandbox.";
		case "provider-unavailable":
			return "The cloud provider is temporarily unavailable.";
		case "workspace-credential-install-failed":
		case "credential-install-failed":
			return "The workspace could not install your connected account credentials.";
		default:
			return `Startup stopped during ${statusCode}.`;
	}
};

export function CloudWorkspaceSetupCard({
	summary,
}: {
	readonly summary: CloudChatSummary;
}) {
	const [busy, setBusy] = useState<"retry" | "delete" | null>(null);
	const runAction = async (action: "resume" | "delete") => {
		setBusy(action === "resume" ? "retry" : "delete");
		try {
			if (action === "resume")
				await runControlPlane((control) =>
					control["cloud.workspaces.resume"]({
						workspaceId: summary.workspaceId,
					}),
				);
			else
				await runControlPlane((control) =>
					control["cloud.workspaces.delete"]({
						workspaceId: summary.workspaceId,
					}),
				);
			await refreshCloudChatCatalog();
		} catch {
			toastManager.add({
				type: "error",
				title: "Cloud action failed",
				description: "The workspace was kept. Try again.",
			});
		} finally {
			setBusy(null);
		}
	};
	const failed = summary.startupPhase === "failed";
	const rank = failed
		? cloudFailureRank(summary.statusCode)
		: cloudPhaseRank[summary.startupPhase];
	const step = (index: number): StepState =>
		failed && index === rank
			? "failed"
			: rank > index
				? "done"
				: rank === index
					? "active"
					: "pending";
	return (
		<div className="mx-auto w-full max-w-3xl px-4 pt-4" role="status">
			<div className="overflow-hidden rounded-xl border border-border/60 bg-muted/15">
				<header className="flex items-center gap-2 border-b border-border/40 px-3.5 py-2.5">
					<HugeiconsIcon
						icon={CloudIcon}
						className="size-4 shrink-0 text-muted-foreground"
					/>
					<span className="flex-1 text-[13px] font-medium text-foreground/90">
						{failed ? (
							"Cloud workspace needs attention"
						) : (
							<ShimmerText tone="lime">Cloud starting</ShimmerText>
						)}
					</span>
					{failed ? (
						<HugeiconsIcon
							icon={Alert01Icon}
							className="size-4 text-[var(--accent-red)]"
						/>
					) : (
						<AgentActivityOrb state="shaping" label="Cloud starting" />
					)}
				</header>
				<div className="flex flex-col gap-1.5 px-3.5 py-2.5 text-[12px]">
					<StepRow state={step(0)} label="Starting cloud workspace" />
					<StepRow state={step(1)} label="Starting secure cloud runtime" />
					<StepRow state={step(2)} label="Fetching the latest Git changes" />
					<StepRow
						state={step(3)}
						label="Checking out branch and starting agent"
					/>
				</div>
				{failed ? (
					<div className="flex items-center gap-2 border-t border-border/40 px-3.5 py-2">
						<p className="min-w-0 flex-1 text-[11px] text-[var(--accent-red)]">
							{cloudFailureMessage(summary.statusCode)}
						</p>
						<Button
							size="xs"
							loading={busy === "retry"}
							onClick={() => void runAction("resume")}
						>
							Retry
						</Button>
						<Button
							size="xs"
							variant="ghost"
							loading={busy === "delete"}
							onClick={() => void runAction("delete")}
						>
							Delete workspace
						</Button>
					</div>
				) : null}
			</div>
		</div>
	);
}

/**
 * Presentational card. Pure function of {@link SetupCardData} so the live
 * card and the landing bridge share one source of truth for the markup.
 */
export function SetupCardView({ data }: { data: SetupCardData }) {
	const {
		repoName,
		hasWorktree,
		worktreePending,
		worktreeName,
		branch,
		baseBranch,
		setupStatus,
		setupOutput,
		onRerun,
		agentStarting,
	} = data;

	// The worktree request is already canonical before its id/list row arrives.
	// Treat that pending phase as a real worktree so the card body is populated
	// from its first frame instead of briefly rendering an empty shell.
	const showsWorktreeSteps = hasWorktree || worktreePending;
	// Worktree dir + branch + copy all land together when the row hydrates, so
	// collapse them into the single `worktreePending` signal.
	const wtReady = showsWorktreeSteps && !worktreePending;
	const setupStarted = setupStatus !== null && setupStatus !== "pending";
	const name = worktreeName ?? "your workspace";

	return (
		<div className="mx-auto w-full max-w-3xl px-4 pt-4">
			<div className="overflow-hidden rounded-xl border border-border/60 bg-muted/15">
				<div className="flex flex-col gap-1.5 px-3.5 py-2.5 text-[12px]">
					{showsWorktreeSteps ? (
						<>
							<StepRow
								state={wtReady ? "done" : "active"}
								label={
									worktreeName === null
										? `Creating a new copy of ${repoName}…`
										: `Created a new copy of ${repoName} called ${name}`
								}
							/>
							<StepRow
								state={branch !== null ? "done" : "pending"}
								label={
									branch !== null
										? `Branched ${branch} from ${baseBranch ?? "origin/main"}`
										: "Branching a fresh worktree…"
								}
							/>
							<StepRow
								state={setupStarted ? "done" : wtReady ? "active" : "pending"}
								label={`Created ${name} and copying files…`}
							/>
							<StepRow
								state={
									setupStatus === "succeeded" || setupStatus === "skipped"
										? "done"
										: setupStatus === "failed"
											? "failed"
											: setupStarted
												? "active"
												: "pending"
								}
								label={
									setupStatus === "failed"
										? "Environment setup failed"
										: setupStatus === "succeeded" || setupStatus === "skipped"
											? "Environment setup complete"
											: setupStatus === "running"
												? "Running environment setup"
												: "Detecting setup script…"
								}
							/>
						</>
					) : null}
					{agentStarting === undefined ? null : (
						<StepRow
							state={agentStarting ? "active" : "done"}
							label={agentStarting ? "Starting agent…" : "Agent ready"}
						/>
					)}
				</div>
				{setupOutput.trim().length > 0 ? (
					<pre className="max-h-48 overflow-auto border-t border-border/40 bg-background/40 px-3.5 py-2.5 font-mono text-[11px] leading-5 whitespace-pre-wrap text-foreground/80">
						{setupOutput}
					</pre>
				) : null}
				{onRerun !== null ? (
					<div className="flex justify-end border-t border-border/40 px-3.5 py-2">
						<Button variant="settings" size="sm" onClick={onRerun}>
							Rerun setup
						</Button>
					</div>
				) : null}
			</div>
		</div>
	);
}

function StepRow({
	state,
	label,
	tone = "default",
}: {
	state: StepState;
	label: string;
	tone?: "default" | "warning";
}) {
	return (
		<div className="flex items-center gap-2">
			{state === "active" ? (
				<Spinner className="size-3 shrink-0 text-muted-foreground" />
			) : state === "failed" ? (
				<HugeiconsIcon
					icon={Alert01Icon}
					className="size-3.5 shrink-0 text-[var(--accent-red)]"
				/>
			) : state === "done" ? (
				<HugeiconsIcon
					icon={Tick01Icon}
					className="size-3.5 shrink-0 text-foreground/60"
				/>
			) : (
				<span className="size-3.5 shrink-0" aria-hidden="true">
					<span className="m-[0.3125rem] block size-1 rounded-full bg-muted-foreground/40" />
				</span>
			)}
			<span
				className={
					state === "failed"
						? "text-[var(--accent-red)]"
						: tone === "warning"
							? "text-warning"
							: state === "pending"
								? "text-muted-foreground/50"
								: "text-foreground/80"
				}
			>
				{state === "active" ? (
					<ShimmerText tone="lime">{label}</ShimmerText>
				) : (
					label
				)}
			</span>
		</div>
	);
}
