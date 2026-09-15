import "@zuse/i18n/english/chat";
import "@zuse/i18n/english/projects";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ExecutionRef } from "@zuse/client-runtime/resource-ref";
import type { GitPrInfo, SessionId } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { AiMagicIcon, Tick02Icon } from "@zuse/icons/stroke-rounded";
import { formatError } from "../lib/format-error.ts";
import { usePrWatchStore } from "../store/pr-watch.ts";
import { compactMenuItemClass, MenuItem } from "./ui/menu.tsx";
import { toastManager } from "./ui/toast.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip.tsx";

export function PrAutoFix({
	executionRef,
	pr,
	sessionId,
	presentation = "button",
}: {
	executionRef: ExecutionRef;
	pr: GitPrInfo;
	sessionId: SessionId | null;
	presentation?: "button" | "menu";
}) {
	const { message: uiMessage } = useUiMessages(["common", "projects", "chat"]);
	const id = `${executionRef.environmentId}:${executionRef.folderId}:${executionRef.worktreeId}:${pr.number}`;
	const watch = usePrWatchStore((state) =>
		state.watches.find((item) => item.id === id),
	);
	const toggle = () => {
		try {
			const store = usePrWatchStore.getState();
			if (watch?.enabled) {
				store.save({ ...watch, enabled: false, error: null });
				return;
			}
			if (!sessionId || !pr.url || !pr.branch || !executionRef.rootPath) return;
			store.save({
				id,
				generation: crypto.randomUUID(),
				ref: { ...executionRef, rootPath: executionRef.rootPath },
				sessionId: watch?.sessionId ?? sessionId,
				url: pr.url,
				branch: pr.branch,
				enabled: true,
				handled:
					watch?.handled.length === watch?.maxRepairs
						? []
						: (watch?.handled ?? []),
				pending: watch?.pending ?? null,
				error: null,
				maxRepairs: 3,
			});
		} catch (cause) {
			toastManager.add({
				type: "error",
				title: "Could not update CI watcher",
				description: formatError(cause),
			});
		}
	};
	const disabled =
		!watch?.enabled && (!sessionId || pr.state !== "open" || pr.isDraft);
	const label = uiMessage("projects:github_auto_fix");
	const help = watch?.error ?? uiMessage("projects:github_watch_help");
	if (presentation === "menu")
		return (
			<MenuItem
				className={compactMenuItemClass}
				role="menuitemcheckbox"
				aria-checked={watch?.enabled ?? false}
				disabled={disabled}
				closeOnClick={false}
				onClick={toggle}
				title={help}
			>
				<HugeiconsIcon
					icon={AiMagicIcon}
					className={watch?.enabled ? "text-primary" : "text-muted-foreground"}
				/>
				{label}
				{watch?.enabled && (
					<HugeiconsIcon
						icon={Tick02Icon}
						className="!ml-auto !size-3.5 text-primary"
					/>
				)}
			</MenuItem>
		);
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						disabled={disabled}
						aria-pressed={watch?.enabled ?? false}
						onClick={toggle}
						className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring aria-pressed:bg-primary/10 aria-pressed:text-primary disabled:opacity-40"
					/>
				}
			>
				<HugeiconsIcon icon={AiMagicIcon} className="size-3.5" />
				{label}
			</TooltipTrigger>
			<TooltipPopup className="max-w-64 text-xs">{help}</TooltipPopup>
		</Tooltip>
	);
}
