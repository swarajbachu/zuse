import type { ExecutionRef } from "@zuse/client-runtime/resource-ref";
import type { GitPrInfo, SessionId } from "@zuse/contracts";
import { Eye } from "lucide-react";
import { formatError } from "../lib/format-error.ts";
import { usePrWatchStore } from "../store/pr-watch.ts";
import {
	MenuItem,
	MenuSeparator,
	MenuSub,
	MenuSubPopup,
	MenuSubTrigger,
} from "./ui/menu.tsx";
import { toastManager } from "./ui/toast.tsx";

export function PrWatchMenu({
	executionRef,
	pr,
	sessionId,
}: {
	executionRef: ExecutionRef;
	pr: GitPrInfo;
	sessionId: SessionId | null;
}) {
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
	return (
		<MenuSub>
			<MenuSubTrigger>
				<Eye className="size-4" />
				Watch CI{" "}
				<span className="ml-auto text-xs text-muted-foreground">
					{watch?.enabled ? "Auto-fix on" : "Off"}
				</span>
			</MenuSubTrigger>
			<MenuSubPopup className="w-64">
				<div className="px-2 py-2 text-xs text-muted-foreground">
					Watch while Zuse is open. Fix, verify, and push new CI failures when
					the agent is idle. Pauses after 3 repairs.
				</div>
				{watch?.error ? (
					<div role="status" className="px-2 pb-2 text-xs text-destructive">
						{watch.error}
					</div>
				) : null}
				<MenuSeparator />
				<MenuItem
					disabled={
						!watch?.enabled && (!sessionId || pr.state !== "open" || pr.isDraft)
					}
					onClick={toggle}
				>
					{watch?.enabled
						? "Stop watching"
						: watch
							? "Resume auto-fix"
							: "Watch and auto-fix"}
				</MenuItem>
			</MenuSubPopup>
		</MenuSub>
	);
}
