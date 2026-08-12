import { HugeiconsIcon } from "@hugeicons/react";
import {
	Alert01Icon,
	CloudIcon,
	GitBranchIcon,
	Tick01Icon,
} from "@hugeicons-pro/core-solid-rounded";
import type { CloudChatSummary } from "@zuse/contracts";
import { Effect } from "effect";
import { useState } from "react";
import { getControlPlaneRpcClient } from "../lib/rpc-client.ts";
import { shouldShowSetupCard } from "../lib/setup-card-visibility.ts";
import { useActiveContext } from "../store/active-workspace.ts";
import { useChatsStore } from "../store/chats.ts";
import { useCloudChatsStore } from "../store/cloud-chats.ts";
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
export function WorktreeSetupCard() {
	const ctx = useActiveContext();
	const selectedChatId = useChatsStore((state) => state.selectedChatId);
	const cloudSummary = useCloudChatsStore(
		(state) =>
			state.summaries.find((row) => row.chatId === selectedChatId) ?? null,
	);
	const session = useSessionsStore((s) => {
		if (s.selectedSessionId === null) return null;
		for (const list of Object.values(s.sessionsByProject)) {
			const match = list.find((sess) => sess.id === s.selectedSessionId);
			if (match !== undefined) return match;
		}
		return null;
	});
	const initialSession = useSessionsStore((s) => {
		if (session === null) return false;
		const chatSessions = s.sessionsByProject[session.projectId] ?? [];
		const oldest = chatSessions
			.filter((candidate) => candidate.chatId === session.chatId)
			.toSorted(
				(left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
			)[0];
		return oldest?.id === session.id;
	});
	const repoName = useWorkspaceStore((s) => {
		if (ctx.status !== "ready") return null;
		return s.folders.find((f) => f.id === ctx.folderId)?.name ?? null;
	});
	const worktree = useWorktreesStore((s) => {
		if (ctx.status !== "ready" || ctx.worktreeId === null) return null;
		const list = s.byProject[ctx.folderId] ?? EMPTY_WORKTREES;
		return list.find((w) => w.id === ctx.worktreeId) ?? null;
	});
	const rerunSetup = useWorktreesStore((s) => s.rerunSetup);
	const hasWorktree = ctx.status === "ready" && ctx.worktreeId !== null;
	const worktreePending = ctx.status === "ready" && ctx.worktreePending;
	const setupStatus = worktree?.setupStatus ?? null;
	const setupDone = setupStatus === "succeeded" || setupStatus === "skipped";
	const externalResume = session !== null && session.resumeStrategy !== "none";

	// This card belongs to chat/worktree creation. A provider still boots for
	// every additional session, but that must not replay chat setup UI after the
	// shared worktree is ready.
	const visible = shouldShowSetupCard({
		externalResume,
		initialSession,
		hasWorktree,
		setupDone,
	});
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

export function CloudWorkspaceSetupCard({
	summary,
}: {
	readonly summary: CloudChatSummary;
}) {
	const [busy, setBusy] = useState<"retry" | "delete" | null>(null);
	const runAction = async (action: "resume" | "delete") => {
		setBusy(action === "resume" ? "retry" : "delete");
		try {
			const control = await getControlPlaneRpcClient();
			if (action === "resume")
				await Effect.runPromise(
					control["cloud.workspaces.resume"]({
						workspaceId: summary.workspaceId,
					}),
				);
			else
				await Effect.runPromise(
					control["cloud.workspaces.delete"]({
						workspaceId: summary.workspaceId,
					}),
				);
			await useCloudChatsStore.getState().hydrate();
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
							Startup stopped during {summary.statusCode}.
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
	} = data;

	const failed = setupStatus === "failed";
	// Worktree dir + branch + copy all land together when the row hydrates, so
	// collapse them into the single `worktreePending` signal.
	const wtReady = hasWorktree && !worktreePending;
	const setupStarted = setupStatus !== null && setupStatus !== "pending";
	const busy =
		worktreePending || setupStatus === "running" || setupStatus === "pending";
	const activityState =
		worktreePending || setupStatus === "running" || setupStatus === "pending"
			? "shaping"
			: "working";

	const name = worktreeName ?? "your workspace";

	return (
		<div className="mx-auto w-full max-w-3xl px-4 pt-4">
			<div className="overflow-hidden rounded-xl border border-border/60 bg-muted/15">
				<header className="flex items-center gap-2 border-b border-border/40 px-3.5 py-2.5">
					<HugeiconsIcon
						icon={GitBranchIcon}
						className="size-4 shrink-0 text-muted-foreground"
					/>
					<span className="flex-1 text-[13px] font-medium text-foreground/90">
						{busy ? (
							<ShimmerText tone="lime">
								Creating a worktree and running setup
							</ShimmerText>
						) : (
							"Creating a worktree and running setup"
						)}
					</span>
					<span className="inline-grid size-5 shrink-0 place-items-center">
						{busy ? (
							<AgentActivityOrb
								state={activityState}
								label={
									activityState === "shaping"
										? "Preparing workspace"
										: "Preparing workspace"
								}
							/>
						) : failed ? (
							<HugeiconsIcon
								icon={Alert01Icon}
								className="size-4 text-[var(--accent-red)]"
							/>
						) : null}
					</span>
				</header>
				<div className="flex flex-col gap-1.5 px-3.5 py-2.5 text-[12px]">
					{hasWorktree ? (
						<>
							<StepRow
								state={wtReady ? "done" : "active"}
								label={`You're in a new copy of ${repoName} called ${name}`}
							/>
							<StepRow
								state={wtReady ? "done" : "active"}
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
