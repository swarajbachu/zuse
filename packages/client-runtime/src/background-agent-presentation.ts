import type {
	AgentTurnId,
	AttemptId,
	BackgroundTaskOutcome,
	SessionExecutionStep,
	SessionTimelineProjection,
} from "@zuse/contracts";
import type { ResourceView } from "./resource-state.ts";

export type RunningBackgroundTask = Readonly<{
	id: string;
	description: string;
	startedAtMs: number;
	kind: "agent" | "process";
	taskId: string;
	turnId: AgentTurnId | null;
	attemptId: AttemptId | null;
}>;

export type EndedBackgroundProcess = Readonly<{
	id: string;
	description: string;
	startedAtMs: number;
	/** Null when only the launch survives, so the end time is unknown. */
	endedAtMs: number | null;
	outcome: BackgroundTaskOutcome;
}>;

/** Cached or disconnected history cannot say what is running right now. */
const isLiveTimeline = (
	view: ResourceView<SessionTimelineProjection>,
): view is ResourceView<SessionTimelineProjection> & {
	readonly data: SessionTimelineProjection;
} =>
	view.origin === "runtime" &&
	view.connection === "connected" &&
	view.data !== null &&
	view.data.status !== "error" &&
	view.data.status !== "closed";

const launchDescription = (input: unknown): string =>
	input !== null &&
	typeof input === "object" &&
	"description" in input &&
	typeof input.description === "string"
		? input.description
		: "";

/** Background agent launches outlive a parent reply. A launch acknowledgement
 * is not completion: only the matching subagent summary settles that run.
 * Historical checkpoints cannot establish that a process is still alive: a
 * process is running only while its execution step is, unless the step list
 * was truncated and the transcript is the only evidence left. */
export const runningBackgroundTasks = (
	view: ResourceView<SessionTimelineProjection>,
): ReadonlyArray<RunningBackgroundTask> => {
	if (!isLiveTimeline(view)) return [];
	const pending = new Map<string, RunningBackgroundTask>();
	const completed = new Set<string>();
	const backgroundTasks = new Set<string>();
	for (const message of view.data.messages) {
		const content = message.content;
		if (
			content._tag === "tool_use" &&
			(content.subagent?.presentation === "detached" ||
				content.backgroundTask !== undefined)
		) {
			if (content.backgroundTask !== undefined)
				backgroundTasks.add(content.itemId);
			const description = launchDescription(content.input);
			if (!pending.has(content.itemId))
				pending.set(content.itemId, {
					id: content.itemId,
					description,
					startedAtMs: message.createdAt.getTime(),
					kind: content.backgroundTask === undefined ? "agent" : "process",
					taskId:
						content.backgroundTask?.taskId ??
						content.subagent?.childSessionId ??
						content.itemId,
					turnId: null,
					attemptId: null,
				});
		} else if (content._tag === "subagent_summary")
			completed.add(content.itemId);
		else if (
			content._tag === "tool_result" &&
			backgroundTasks.has(content.itemId)
		)
			completed.add(content.itemId);
	}
	const seen = new Set<string>();
	const live = new Set<string>();
	for (const step of [...(view.data.executionSteps ?? [])].sort(
		(a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt,
	)) {
		if (seen.has(step.itemId)) continue;
		seen.add(step.itemId);
		if (step.status !== "running") {
			completed.add(step.itemId);
		} else if (
			step.nativeChildId !== null &&
			(pending.has(step.itemId) ||
				step.rootCompletedAt !== null ||
				step.kind === "background")
		) {
			live.add(step.itemId);
			pending.set(step.itemId, {
				id: step.itemId,
				description: pending.get(step.itemId)?.description || step.label,
				startedAtMs: step.createdAt,
				kind: step.kind === "background" ? "process" : "agent",
				taskId: step.nativeChildId,
				turnId: step.turnId as AgentTurnId,
				attemptId: step.attemptId as AttemptId,
			});
		}
	}
	for (const id of completed) pending.delete(id);
	if (view.data.executionStepsTruncated !== true)
		for (const task of pending.values())
			if (task.kind === "process" && !live.has(task.id))
				pending.delete(task.id);
	return [...pending.values()];
};

/** Running background shells; detached agents belong with the other agents. */
export const runningBackgroundProcesses = (
	view: ResourceView<SessionTimelineProjection>,
): ReadonlyArray<RunningBackgroundTask> =>
	runningBackgroundTasks(view).filter((task) => task.kind === "process");

/**
 * Background shells that are no longer running, most recent first. A result
 * message carries the native outcome; a settled step is the fallback; a launch
 * with neither stopped without a recorded end.
 */
export const endedBackgroundProcesses = (
	view: ResourceView<SessionTimelineProjection>,
): ReadonlyArray<EndedBackgroundProcess> => {
	if (!isLiveTimeline(view)) return [];
	const running = new Set(runningBackgroundProcesses(view).map((t) => t.id));
	const launches = new Map<
		string,
		{ readonly description: string; readonly startedAtMs: number }
	>();
	const ends = new Map<
		string,
		{ readonly outcome: BackgroundTaskOutcome; readonly at: number }
	>();
	for (const message of view.data.messages) {
		const content = message.content;
		if (content._tag === "tool_use" && content.backgroundTask !== undefined) {
			if (!launches.has(content.itemId))
				launches.set(content.itemId, {
					description: launchDescription(content.input),
					startedAtMs: message.createdAt.getTime(),
				});
		} else if (content._tag === "tool_result" && launches.has(content.itemId))
			ends.set(content.itemId, {
				outcome:
					content.backgroundOutcome ??
					(content.isError ? "failed" : "completed"),
				at: message.createdAt.getTime(),
			});
	}
	const steps = new Map<string, SessionExecutionStep>();
	for (const step of view.data.executionSteps ?? []) {
		if (step.kind !== "background") continue;
		const seen = steps.get(step.itemId);
		if (seen === undefined || step.updatedAt > seen.updatedAt)
			steps.set(step.itemId, step);
	}
	const ended: EndedBackgroundProcess[] = [];
	for (const id of new Set([...launches.keys(), ...steps.keys()])) {
		if (running.has(id)) continue;
		const launch = launches.get(id);
		const step = steps.get(id);
		const end =
			ends.get(id) ??
			(step === undefined || step.status === "running"
				? undefined
				: {
						outcome:
							step.status === "completed"
								? ("completed" as const)
								: step.status === "failed"
									? ("failed" as const)
									: ("stopped" as const),
						at: step.updatedAt,
					});
		ended.push({
			id,
			description: launch?.description || step?.label || "",
			startedAtMs: launch?.startedAtMs ?? step?.createdAt ?? 0,
			endedAtMs: end?.at ?? null,
			outcome: end?.outcome ?? "stopped",
		});
	}
	return ended.sort(
		(a, b) => (b.endedAtMs ?? b.startedAtMs) - (a.endedAtMs ?? a.startedAtMs),
	);
};

/** Compatibility projection for count and compact activity consumers. */
export const runningBackgroundAgents = (
	view: ResourceView<SessionTimelineProjection>,
) =>
	runningBackgroundTasks(view)
		.filter((task) => task.kind === "agent")
		.map(({ id, description, startedAtMs }) => ({
			id,
			description,
			startedAtMs,
		}));

/** Count detached agents using the same live-transcript completion rules as the task rows. */
export const countRunningBackgroundAgents = (
	view: ResourceView<SessionTimelineProjection>,
): number => runningBackgroundAgents(view).length;
