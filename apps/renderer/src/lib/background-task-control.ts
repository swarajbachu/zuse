import {
	type RunningBackgroundTask,
	runningBackgroundTasks,
} from "@zuse/client-runtime/background-agent-presentation";
import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import type { ResourceView } from "@zuse/client-runtime/resource-state";
import type { ProviderId, SessionTimelineProjection } from "@zuse/contracts";

import { stopBackgroundTask } from "./session-actions.ts";

type TimelineView = ResourceView<SessionTimelineProjection>;

/** Only tasks from the live attempt of a provider that supports stopping. */
export const canStopBackgroundTask = (
	view: TimelineView,
	providerId: ProviderId,
	task: RunningBackgroundTask,
): boolean =>
	providerId === "claude" &&
	task.turnId !== null &&
	task.attemptId !== null &&
	view.data?.activeTurn?.id === task.turnId &&
	view.data.activeTurn.attempt?.id === task.attemptId;

export const isStoppingBackgroundTask = (
	view: TimelineView,
	task: RunningBackgroundTask,
): boolean =>
	view.pendingCommands.some(
		(command) =>
			command.kind === "messages.background.stop" &&
			command.targetId === task.taskId,
	);

/** Running processes and agents that a stop request would reach right now. */
export const stoppableBackgroundTasks = (
	view: TimelineView,
	providerId: ProviderId,
): readonly RunningBackgroundTask[] =>
	runningBackgroundTasks(view).filter(
		(task) =>
			canStopBackgroundTask(view, providerId, task) &&
			!isStoppingBackgroundTask(view, task),
	);

/** Fire stop for every stoppable task; failures surface on the task rows. */
export const stopAllBackgroundTasks = (
	sessionRef: SessionRef,
	view: TimelineView,
	providerId: ProviderId,
): number => {
	const tasks = stoppableBackgroundTasks(view, providerId);
	for (const task of tasks)
		void stopBackgroundTask(sessionRef, task).catch(() => undefined);
	return tasks.length;
};
