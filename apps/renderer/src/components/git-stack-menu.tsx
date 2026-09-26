import {
	gitStackKey,
	readGitStack,
	useGitStackStore,
} from "../store/git-stack.ts";
import "@zuse/i18n/english/chat";
import "@zuse/i18n/english/projects";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ExecutionRef } from "@zuse/client-runtime/resource-ref";
import {
	CommandId,
	type GitStackAction,
	type GitStackResult,
} from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	ArrowDown01Icon,
	GitBranchIcon,
	GitMergeIcon,
	GitPullRequestDraftIcon,
	GitPullRequestIcon,
	Layers01Icon,
} from "@zuse/icons/solid-rounded";
import { useEffect, useMemo, useState } from "react";
import { formatError } from "../lib/format-error.ts";
import { dispatchGitWorkspaceCommand } from "../lib/git-workspace-client-bus.ts";
import {
	compactMenuItemClass,
	Menu,
	MenuItem,
	MenuPopup,
	MenuSeparator,
	MenuSub,
	MenuSubPopup,
	MenuSubTrigger,
	MenuTrigger,
} from "./ui/menu.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip.tsx";

export function GitStackMenu({
	executionRef,
	className,
	branch,
	variant = "summary",
}: {
	executionRef: ExecutionRef;
	className?: string;
	branch: string | null;
	variant?: "summary" | "submenu";
}) {
	const { message: uiMessage } = useUiMessages(["common", "projects", "chat"]);
	const stackKey = gitStackKey(executionRef, branch ?? "");
	const stack = useGitStackStore(
		(state) => state.entries[stackKey]?.result ?? null,
	);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const { environmentId, folderId, worktreeId, rootPath } = executionRef;
	const stableRef = useMemo(
		() => ({ environmentId, folderId, worktreeId, rootPath }),
		[environmentId, folderId, worktreeId, rootPath],
	);
	useEffect(() => {
		if (!branch) return;
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const discover = () => {
			void readGitStack(stableRef, branch).catch(() => {
				if (!cancelled) timer = setTimeout(discover, 30_000);
			});
		};
		discover();
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [stableRef, branch]);

	const command = async (action: GitStackAction) => {
		if (busy) return;
		if (action === "view") setRefreshing(true);
		else setBusy(true);
		setError(null);
		try {
			const execute = (next: GitStackAction) =>
				dispatchGitWorkspaceCommand<
					{
						folderId: typeof executionRef.folderId;
						worktreeId: typeof executionRef.worktreeId;
						action: GitStackAction;
					},
					GitStackResult
				>({
					ref: executionRef,
					kind: "git.stack",
					commandId: CommandId.make(`git-stack:${crypto.randomUUID()}`),
					payload: {
						folderId: executionRef.folderId,
						worktreeId: executionRef.worktreeId,
						action: next,
					},
				});
			if (action !== "view") await execute(action);
			await readGitStack(stableRef, branch ?? "", true);
		} catch (cause) {
			setError(formatError(cause));
		} finally {
			if (action === "view") setRefreshing(false);
			else setBusy(false);
		}
	};
	if (!stack?.branches.some((item) => item.isCurrent && item.name === branch))
		return null;
	const label = (
		<>
			<HugeiconsIcon
				icon={Layers01Icon}
				className="size-[15px] shrink-0 text-muted-foreground"
			/>
			<span className="min-w-0 flex-1 truncate text-left">
				{uiMessage("projects:github_stack")}
			</span>
		</>
	);
	const content = (
		<>
			<div className="flex h-7 items-center gap-2 px-2 text-xs">
				<span className="font-medium">
					{uiMessage("projects:github_stack")}
				</span>
				{busy || refreshing ? (
					<span
						role="status"
						className="ml-auto text-[11px] text-muted-foreground"
					>
						{uiMessage(
							busy ? "projects:github_updating_stack" : "common:loading",
						)}
					</span>
				) : null}
			</div>
			{error ? (
				<div
					role="alert"
					className="max-h-32 overflow-y-auto px-2 py-2 text-xs text-destructive"
				>
					{error}
				</div>
			) : null}
			<div className="my-1">
				{[...stack.branches].reverse().map((branch) => {
					const pr = branch.pr;
					const merged = branch.isMerged || pr?.state === "merged";
					const icon = merged
						? GitMergeIcon
						: pr?.isDraft
							? GitPullRequestDraftIcon
							: pr
								? GitPullRequestIcon
								: GitBranchIcon;
					const tone = merged
						? "text-violet-400"
						: pr?.state === "closed"
							? "text-destructive"
							: pr?.state === "open" && pr.isDraft === false
								? "text-[var(--accent-green)]"
								: "text-muted-foreground";
					const status = merged
						? uiMessage("projects:pr_pane_merged")
						: pr?.state === "closed"
							? uiMessage("projects:pr_pane_closed")
							: pr?.isDraft
								? uiMessage("projects:pr_pane_draft")
								: pr?.state === "open" && pr.isDraft === false
									? uiMessage("common:open")
									: uiMessage("projects:pr_pane_branch");
					return (
						<MenuItem
							className={`${compactMenuItemClass} relative ${branch.isCurrent ? "bg-accent/50 font-medium" : ""}`}
							key={branch.name}
							title={[
								branch.name,
								status,
								branch.isCurrent
									? uiMessage("chat:computer_switcher_current")
									: "",
								branch.needsRebase
									? uiMessage("projects:github_needs_rebase")
									: "",
							]
								.filter(Boolean)
								.join(" · ")}
							aria-current={branch.isCurrent ? "step" : undefined}
							closeOnClick={!branch.isCurrent}
							disabled={busy}
							onClick={() => {
								if (branch.isCurrent) return;
								setBusy(true);
								void dispatchGitWorkspaceCommand({
									ref: executionRef,
									kind: "git.switchBranch",
									commandId: CommandId.make(
										`stack-checkout:${crypto.randomUUID()}`,
									),
									payload: {
										folderId: executionRef.folderId,
										worktreeId: executionRef.worktreeId,
										branch: branch.name,
									},
								})
									.catch((cause) => setError(formatError(cause)))
									.finally(() => setBusy(false));
							}}
						>
							<span className="relative flex size-[15px] shrink-0 items-center justify-center after:absolute after:top-full after:mt-0.5 after:h-[9px] after:w-px after:bg-muted-foreground/25">
								<HugeiconsIcon
									icon={icon}
									className={`size-[15px] ${tone}`}
									aria-label={status}
								/>
							</span>
							<span className="min-w-0 flex-1 truncate">
								{pr?.title || branch.name}
							</span>
							{pr && (
								<span className="shrink-0 text-[11px] font-normal tabular-nums text-muted-foreground">
									#{pr.number}
								</span>
							)}
						</MenuItem>
					);
				})}
				<div className="relative flex h-7 items-center gap-2 px-2 text-[11px] text-muted-foreground">
					<span
						aria-hidden="true"
						className="flex size-[15px] shrink-0 items-center justify-center"
					>
						<span className="size-1.5 rounded-full border border-muted-foreground/60" />
					</span>
					<span className="truncate font-mono" title={stack.trunk ?? undefined}>
						{stack.trunk}
					</span>
				</div>
			</div>
			<MenuSeparator />
			<Tooltip>
				<TooltipTrigger
					render={
						<MenuItem
							className={compactMenuItemClass}
							disabled={busy}
							closeOnClick={false}
							onClick={() => void command("submit")}
						/>
					}
				>
					{uiMessage("projects:github_submit_stack")}
				</TooltipTrigger>
				<TooltipPopup className="max-w-64 text-xs">
					{uiMessage("projects:github_submit_stack_help")}
				</TooltipPopup>
			</Tooltip>
		</>
	);
	if (variant === "submenu")
		return (
			<>
				<MenuSeparator />
				<MenuSub
					onOpenChange={(open) => {
						if (open) void command("view");
					}}
				>
					<MenuSubTrigger compact>{label}</MenuSubTrigger>
					<MenuSubPopup
						className="w-80 max-w-[calc(100vw-2rem)]"
						sideOffset={4}
					>
						{content}
					</MenuSubPopup>
				</MenuSub>
			</>
		);
	return (
		<Menu
			modal={false}
			onOpenChange={(open) => {
				if (open) void command("view");
			}}
		>
			<MenuTrigger className={className}>
				{label}
				<HugeiconsIcon
					icon={ArrowDown01Icon}
					className="size-3 shrink-0 text-muted-foreground"
				/>
			</MenuTrigger>
			<MenuPopup
				side="left"
				align="start"
				sideOffset={8}
				className="w-80 max-w-[calc(100vw-2rem)]"
			>
				{content}
			</MenuPopup>
		</Menu>
	);
}
