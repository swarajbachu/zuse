import { HugeiconsIcon } from "@hugeicons/react";
import {
	type EndedBackgroundProcess,
	endedBackgroundProcesses,
	type RunningBackgroundTask,
	runningBackgroundProcesses,
} from "@zuse/client-runtime/background-agent-presentation";
import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import type { ResourceView } from "@zuse/client-runtime/resource-state";
import type { ProviderId, SessionTimelineProjection } from "@zuse/contracts";
import "@zuse/i18n/english/chat";
import "@zuse/i18n/english/common";
import { useMessages } from "@zuse/i18n/react";
import { ComputerTerminal01Icon, StopIcon } from "@zuse/icons/solid-rounded";
import { type ReactNode, useMemo, useState } from "react";
import type { DelegationStatus } from "../lib/delegation-display.ts";
import { formatError } from "../lib/format-error.ts";
import { stopBackgroundTask } from "../lib/session-actions.ts";
import { cn } from "../lib/utils.ts";
import { summaryMetaClass, summaryRowClass } from "./cloud-workspace-info.tsx";
import {
	DelegationElapsed,
	StatusGlyph,
	useDelegationStatusLabel,
} from "./delegation-row.tsx";
import { SummarySection } from "./summary-section.tsx";
import { Spinner } from "./ui/spinner.tsx";

interface BackgroundTasksProps {
	readonly view: ResourceView<SessionTimelineProjection>;
	readonly sessionRef: SessionRef;
	readonly providerId: ProviderId;
}

const OUTCOME_STATUS = {
	completed: "done",
	failed: "failed",
	stopped: "stopped",
} as const satisfies Record<
	EndedBackgroundProcess["outcome"],
	DelegationStatus
>;

/**
 * Background processes for the session, folded by default. Detached agents
 * are listed with the other agents instead.
 */
export function BackgroundTasks(props: BackgroundTasksProps) {
	const { message } = useMessages(["chat"]);
	const running = useMemo(
		() => runningBackgroundProcesses(props.view).length,
		[props.view],
	);
	const ended = useMemo(
		() => endedBackgroundProcesses(props.view).length,
		[props.view],
	);
	if (running + ended === 0) return null;
	return (
		<SummarySection
			icon={ComputerTerminal01Icon}
			label={message("chat:background_tasks_title")}
			meta={
				running > 0
					? message("chat:agents_summary_running", { count: String(running) })
					: null
			}
			defaultOpen={false}
		>
			<BackgroundTaskRows {...props} />
		</SummarySection>
	);
}

/**
 * Running processes first, each with its own stop control, then the stopped
 * ones with how they ended. Rows align with the section label.
 */
export function BackgroundTaskRows({
	view,
	sessionRef,
	providerId,
}: BackgroundTasksProps) {
	const { message } = useMessages(["chat", "common"]);
	const statusLabel = useDelegationStatusLabel();
	const running = useMemo(() => runningBackgroundProcesses(view), [view]);
	const ended = useMemo(() => endedBackgroundProcesses(view), [view]);
	const [errors, setErrors] = useState<Readonly<Record<string, string | null>>>(
		{},
	);
	const processLabel = message("chat:background_process");
	const errorKey = (task: RunningBackgroundTask) =>
		`${sessionRef.environmentId}:${sessionRef.sessionId}:${task.attemptId}:${task.id}`;
	const isStopping = (task: RunningBackgroundTask) =>
		view.pendingCommands.some(
			(command) =>
				command.kind === "messages.background.stop" &&
				command.targetId === task.taskId,
		);
	const canStop = (task: RunningBackgroundTask) =>
		providerId === "claude" &&
		task.turnId !== null &&
		task.attemptId !== null &&
		view.data?.activeTurn?.id === task.turnId &&
		view.data.activeTurn.attempt?.id === task.attemptId;
	const stop = (task: RunningBackgroundTask) => {
		const key = errorKey(task);
		setErrors((current) => ({ ...current, [key]: null }));
		void stopBackgroundTask(sessionRef, task).catch((cause) => {
			setErrors((current) => ({ ...current, [key]: formatError(cause) }));
		});
	};
	const stoppable = running.filter(
		(task) => canStop(task) && !isStopping(task),
	);

	const runningRow = (task: RunningBackgroundTask) => {
		const pending = isStopping(task);
		const failed = view.failedCommands.find(
			(command) =>
				command.kind === "messages.background.stop" &&
				command.targetId === task.taskId,
		);
		const key = errorKey(task);
		const error = pending ? null : key in errors ? errors[key] : failed?.error;
		const label = task.description || processLabel;
		return (
			<div key={task.id}>
				<div
					title={label}
					aria-description={processLabel}
					className={cn(summaryRowClass, "ps-[34px] hover:bg-muted/60")}
				>
					<span className="min-w-0 flex-1 truncate">{label}</span>
					<span className={summaryMetaClass}>
						<span role="timer" aria-live="off">
							<DelegationElapsed
								timing={{
									status: "working",
									startedAt: task.startedAtMs,
									completedAt: null,
								}}
							/>
						</span>
						<span className="grid size-3 place-items-center">
							{canStop(task) ? (
								<button
									type="button"
									disabled={pending}
									aria-label={
										pending
											? message("chat:chat_composer_stopping")
											: message("chat:background_stop_task", { task: label })
									}
									title={message("common:stop")}
									onClick={() => stop(task)}
									className="-m-0.5 grid size-4 place-items-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none"
								>
									{pending ? (
										<Spinner className="size-3" />
									) : (
										<HugeiconsIcon icon={StopIcon} className="size-3" />
									)}
								</button>
							) : (
								<StatusGlyph status="working" />
							)}
						</span>
					</span>
				</div>
				{error ? (
					<p
						role="status"
						className="px-2.5 pb-1 ps-[34px] text-[11px] text-destructive"
					>
						{error}
					</p>
				) : null}
			</div>
		);
	};

	const endedRow = (task: EndedBackgroundProcess) => {
		const status = OUTCOME_STATUS[task.outcome];
		const label = task.description || processLabel;
		return (
			<div
				key={task.id}
				title={label}
				aria-description={statusLabel(status)}
				className={cn(
					summaryRowClass,
					"ps-[34px] text-muted-foreground hover:bg-muted/60",
				)}
			>
				<span className="min-w-0 flex-1 truncate">{label}</span>
				<span className={summaryMetaClass}>
					<DelegationElapsed
						timing={{
							status,
							startedAt: task.startedAtMs,
							completedAt: task.endedAtMs,
						}}
					/>
					<span className="grid size-3 place-items-center">
						<StatusGlyph status={status} />
					</span>
				</span>
			</div>
		);
	};

	return (
		<>
			{running.length > 0 ? (
				<BackgroundGroup
					label={message("chat:background_group_running")}
					action={
						stoppable.length > 1 ? (
							<button
								type="button"
								onClick={() => {
									for (const task of stoppable) stop(task);
								}}
								className="rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
							>
								{message("chat:background_stop_all")}
							</button>
						) : null
					}
				>
					{running.map(runningRow)}
				</BackgroundGroup>
			) : null}
			{ended.length > 0 ? (
				<BackgroundGroup label={message("chat:background_group_stopped")}>
					{ended.map(endedRow)}
				</BackgroundGroup>
			) : null}
		</>
	);
}

function BackgroundGroup({
	label,
	action,
	children,
}: {
	readonly label: string;
	readonly action?: ReactNode;
	readonly children: ReactNode;
}) {
	return (
		<section aria-label={label}>
			<div className="flex h-6 items-center justify-between gap-2 ps-[34px] pe-2.5 text-[11px] text-muted-foreground/80">
				<span className="truncate">{label}</span>
				{action}
			</div>
			{children}
		</section>
	);
}
