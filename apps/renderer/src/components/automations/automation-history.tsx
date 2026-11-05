import { HugeiconsIcon } from "@hugeicons/react";
import { type Automation, type AutomationRun, ChatId } from "@zuse/contracts";
import { PlayIcon } from "@zuse/icons/solid-rounded";
import { useCallback, useEffect, useState } from "react";
import {
	type automationClient,
	openAutomationCloudRun,
} from "~/lib/automation-client.ts";
import {
	describeTrigger,
	formatAutomationTime,
	RUN_STATUS,
	type RunTone,
	runDuration,
	runIsActive,
	runSourceLabel,
} from "~/lib/automation-format.ts";
import { cloudProviderLabel } from "~/lib/cloud-provider-presentation.ts";
import { formatError } from "~/lib/format-error.ts";
import { cn } from "~/lib/utils";
import { useChatsStore } from "~/store/chats.ts";
import { useUiStore } from "~/store/ui.ts";
import { Button } from "../ui/button.tsx";
import {
	Sheet,
	SheetBody,
	SheetDescription,
	SheetHeader,
	SheetPopup,
	SheetTitle,
} from "../ui/sheet.tsx";
import { Skeleton } from "../ui/skeleton.tsx";
import { toastManager } from "../ui/toast.tsx";
import { AutomationNotice } from "./automation-controls.tsx";

type Client = ReturnType<typeof automationClient>;

export function AutomationHistory({
	client,
	automation,
	running,
	onRun,
	onClose,
}: {
	client: Client;
	automation: Automation;
	running: boolean;
	onRun: () => void;
	onClose: () => void;
}) {
	const [runs, setRuns] = useState<ReadonlyArray<AutomationRun> | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set());
	const load = useCallback(
		() =>
			client.runs(automation.id).then(
				(result) => {
					setRuns(result);
					setError(null);
				},
				(cause) => setError(formatError(cause)),
			),
		[client, automation.id],
	);
	const active = runs?.some(runIsActive) ?? false;
	useEffect(() => {
		let alive = true;
		let timer = 0;
		const tick = () =>
			void load().finally(() => {
				// Poll quickly only while a run can still change.
				if (alive) timer = window.setTimeout(tick, active ? 3000 : 15000);
			});
		tick();
		return () => {
			alive = false;
			window.clearTimeout(timer);
		};
	}, [load, active]);
	// Pick up a run started from this dialog without waiting for the next poll.
	useEffect(() => {
		if (running) void load();
	}, [running, load]);

	const openSession = (run: AutomationRun) => {
		if (run.cloudWorkspaceId) {
			// Cloud runs live in the cloud agent's own chat.
			void openAutomationCloudRun(run.cloudWorkspaceId).then(onClose, (cause) =>
				toastManager.add({
					type: "error",
					title: "Could not open the cloud agent",
					description: formatError(cause),
				}),
			);
			return;
		}
		if (!run.chatId) return;
		useChatsStore.getState().select(ChatId.make(run.chatId));
		useUiStore.getState().setActiveMainTab("chat");
		onClose();
	};
	const cancel = (run: AutomationRun) => {
		setCancelling((current) => new Set(current).add(run.id));
		void client
			.cancel(run.id)
			.then(load, (cause) =>
				toastManager.add({
					type: "error",
					title: "Could not cancel the run",
					description: formatError(cause),
				}),
			)
			.finally(() =>
				setCancelling((current) => {
					const next = new Set(current);
					next.delete(run.id);
					return next;
				}),
			);
	};
	return (
		<Sheet
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<SheetPopup className="w-[min(480px,100vw)]">
				<SheetHeader className="pe-12">
					<div className="min-w-0 flex-1">
						<SheetTitle className="truncate">
							{automation.config.name}
						</SheetTitle>
						<SheetDescription className="truncate">
							{automation.config.triggers.map(describeTrigger).join(" or ")}
						</SheetDescription>
					</div>
					<Button
						className="h-7"
						variant="outline"
						loading={running}
						onClick={onRun}
					>
						<HugeiconsIcon icon={PlayIcon} aria-hidden />
						Run now
					</Button>
				</SheetHeader>
				<SheetBody className="text-xs">
					{error && (
						<AutomationNotice tone="error" className="mb-2">
							Couldn’t load runs. {error}
						</AutomationNotice>
					)}
					{runs === null && !error ? (
						<div
							role="status"
							aria-busy="true"
							aria-label="Loading runs"
							className="space-y-1"
						>
							{[0, 1, 2].map((key) => (
								<Skeleton key={key} className="h-10 rounded-md" />
							))}
						</div>
					) : runs?.length === 0 ? (
						<p className="py-10 text-center text-muted-foreground">
							No runs yet.
						</p>
					) : (
						<ul className="divide-y divide-border/50" aria-live="polite">
							{(runs ?? []).map((run) => {
								const status = RUN_STATUS[run.status];
								const duration = runDuration(run);
								return (
									<li key={run.id} className="py-2.5">
										<div className="flex items-center gap-2.5">
											<span
												className={cn(
													"size-1.5 shrink-0 rounded-full",
													TONE_DOT[status.tone],
													run.status === "running" && "animate-pulse",
												)}
												aria-hidden
											/>
											<div className="min-w-0 flex-1">
												<p className="truncate">
													{run.cloudProviderId && run.status === "completed"
														? `Started on ${cloudProviderLabel(run.cloudProviderId)}`
														: status.label}
													<span className="text-muted-foreground">
														{" "}
														· {runSourceLabel(run.source)}
													</span>
												</p>
												<p className="text-[11px] text-muted-foreground tabular-nums">
													{formatAutomationTime(run.createdAt)}
													{duration ? ` · ${duration}` : ""}
												</p>
											</div>
											{(run.status === "queued" ||
												run.status === "running") && (
												<Button
													className="h-7 text-muted-foreground"
													variant="ghost"
													loading={cancelling.has(run.id)}
													onClick={() => cancel(run)}
												>
													Cancel
												</Button>
											)}
											{run.chatId && (
												<Button
													className="h-7"
													variant="ghost"
													onClick={() => openSession(run)}
												>
													Open
												</Button>
											)}
										</div>
										{run.error && (
											<p className="mt-1 ps-4 line-clamp-3 break-words text-[11px] text-destructive">
												{run.error}
											</p>
										)}
									</li>
								);
							})}
						</ul>
					)}
				</SheetBody>
			</SheetPopup>
		</Sheet>
	);
}

const TONE_DOT: Readonly<Record<RunTone, string>> = {
	success: "bg-success",
	error: "bg-destructive",
	info: "bg-info",
	warning: "bg-warning",
	outline: "bg-muted-foreground/50",
};
