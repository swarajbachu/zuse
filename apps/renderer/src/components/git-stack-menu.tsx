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
import { ArrowDown01Icon, Layers01Icon } from "@zuse/icons/solid-rounded";
import { useEffect, useMemo, useState } from "react";
import { formatError } from "../lib/format-error.ts";
import { dispatchGitWorkspaceCommand } from "../lib/git-workspace-client-bus.ts";
import { openExternal } from "../lib/platform-capabilities.ts";
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
	const [name, setName] = useState("");
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
		setBusy(true);
		setError(null);
		try {
			const execute = (next: GitStackAction) =>
				dispatchGitWorkspaceCommand<
					{
						folderId: typeof executionRef.folderId;
						worktreeId: typeof executionRef.worktreeId;
						action: GitStackAction;
						name?: string;
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
						...(next === "add" ? { name } : {}),
					},
				});
			if (action !== "view") await execute(action);
			await readGitStack(stableRef, branch ?? "", true);
			if (action === "add") setName("");
		} catch (cause) {
			setError(formatError(cause));
		} finally {
			setBusy(false);
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
			{busy ? (
				<div role="status" className="px-2 py-1 text-xs text-muted-foreground">
					{uiMessage("projects:github_updating_stack")}
				</div>
			) : null}
			{error ? (
				<div
					role="alert"
					className="max-h-32 overflow-y-auto px-2 py-2 text-xs text-destructive"
				>
					{error}
				</div>
			) : null}
			<div className="px-2 py-1 text-xs text-muted-foreground">
				{uiMessage("projects:github_base")} {stack.trunk}
			</div>
			{stack.branches.map((branch) => (
				<MenuItem
					className={compactMenuItemClass}
					key={branch.name}
					disabled={busy || branch.isCurrent}
					onClick={() => {
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
					<span className="min-w-0 flex-1 truncate">{branch.name}</span>
					<span className="text-xs text-muted-foreground">
						{branch.isCurrent
							? uiMessage("chat:computer_switcher_current")
							: branch.isMerged
								? uiMessage("projects:pr_pane_merged")
								: branch.needsRebase
									? uiMessage("projects:github_needs_rebase")
									: ""}
					</span>
				</MenuItem>
			))}
			<MenuSeparator />
			<form
				className="flex gap-1 p-1"
				onSubmit={(event) => {
					event.preventDefault();
					void command("add");
				}}
			>
				<input
					aria-label={uiMessage("projects:github_new_stack_branch")}
					placeholder={uiMessage("projects:github_new_stack_branch")}
					className="h-7 min-w-0 flex-1 rounded bg-muted px-2 text-xs outline-none"
					value={name}
					disabled={busy}
					onChange={(event) => setName(event.target.value)}
					onKeyDown={(event) => {
						if (event.key !== "Escape") event.stopPropagation();
					}}
				/>
				<button
					type="submit"
					disabled={busy || !name.trim()}
					className="h-7 rounded bg-muted px-2 text-xs disabled:opacity-50"
				>
					{uiMessage("common:add")}
				</button>
			</form>
			<MenuItem
				className={compactMenuItemClass}
				disabled={busy}
				closeOnClick={false}
				onClick={() => void command("submit")}
			>
				{uiMessage("projects:github_submit_stack")}
			</MenuItem>
			<MenuSeparator />
			<MenuItem
				className={compactMenuItemClass}
				onClick={() => void openExternal("https://gh.io/stacks")}
			>
				{uiMessage("projects:github_stack_help")}
			</MenuItem>
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
					<MenuSubPopup className="w-60" sideOffset={4}>
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
			<MenuPopup side="left" align="start" sideOffset={8} className="w-60">
				{content}
			</MenuPopup>
		</Menu>
	);
}
