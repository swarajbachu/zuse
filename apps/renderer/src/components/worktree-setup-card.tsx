import { HugeiconsIcon } from "@hugeicons/react";
import {
	Alert01Icon,
	GitBranchIcon,
	Tick01Icon,
} from "@hugeicons-pro/core-stroke-rounded";
import { PROVIDER_LABEL } from "../lib/provider-labels.ts";
import { useActiveContext } from "../store/active-workspace.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import { EMPTY_WORKTREES, useWorktreesStore } from "../store/worktrees.ts";
import { Button } from "./ui/button.tsx";
import { ShimmerText } from "./ui/shimmer-text.tsx";
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
	readonly providerLabel: string;
	readonly providerState: StepState;
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
	const session = useSessionsStore((s) => {
		if (s.selectedSessionId === null) return null;
		for (const list of Object.values(s.sessionsByProject)) {
			const match = list.find((sess) => sess.id === s.selectedSessionId);
			if (match !== undefined) return match;
		}
		return null;
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
	const providerBooting = session?.status === "booting";
	const providerErrored = session?.status === "error";

	// Visible while there's worktree/setup work left, OR while the provider CLI
	// is still booting (covers a worktree-less "new tab in this chat" too).
	// Once the provider errors we stop occupying the screen with a fake
	// "Starting…" spinner — the ErrorBubble below carries the failure + the
	// inline "Sign in" CTA — so a worktree-less errored session hides the card.
	const visible =
		!externalResume &&
		((hasWorktree && !setupDone) || providerBooting === true);
	if (!visible) return null;

	const providerLabel: string =
		session !== null
			? (PROVIDER_LABEL[session.providerId] ?? session.providerId)
			: "agent";
	const providerState: StepState =
		session === null
			? "pending"
			: providerBooting
				? "active"
				: providerErrored
					? "failed"
					: "done";

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
				providerLabel,
				providerState,
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
	const {
		repoName,
		hasWorktree,
		worktreePending,
		worktreeName,
		branch,
		baseBranch,
		setupStatus,
		setupOutput,
		providerLabel,
		providerState,
		onRerun,
	} = data;

	const failed = setupStatus === "failed";
	// Worktree dir + branch + copy all land together when the row hydrates, so
	// collapse them into the single `worktreePending` signal.
	const wtReady = hasWorktree && !worktreePending;
	const setupStarted = setupStatus !== null && setupStatus !== "pending";
	const busy =
		worktreePending ||
		providerState === "active" ||
		setupStatus === "running" ||
		setupStatus === "pending";

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
					{busy ? (
						<Spinner className="size-3.5 text-muted-foreground" />
					) : failed ? (
						<HugeiconsIcon
							icon={Alert01Icon}
							className="size-4 text-[var(--accent-red)]"
						/>
					) : null}
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
					<StepRow
						state={providerState}
						label={
							providerState === "failed"
								? `${providerLabel} failed to start`
								: `Starting ${providerLabel}`
						}
					/>
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

function StepRow({ state, label }: { state: StepState; label: string }) {
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
