import type { SubagentReference } from "./subagent-metadata.ts";

export interface SubagentWaitResult {
	readonly output: unknown;
	readonly isError: boolean;
	readonly completedAt: Date;
}

export function subagentTaskIdForBlockingWait(
	input: unknown,
	subagentsByTaskId: ReadonlyMap<string, SubagentReference>,
): string | null {
	if (input === null || typeof input !== "object") return null;
	const record = input as Record<string, unknown>;
	if (record.block !== true || typeof record.task_id !== "string") return null;
	return subagentsByTaskId.has(record.task_id) ? record.task_id : null;
}

export interface SubagentWaitView {
	readonly agentName: string;
	readonly status: "waiting" | "finished" | "error";
	readonly elapsedMs: number;
	readonly timeoutMs: number;
}

export function formatSubagentWaitDuration(ms: number): string {
	if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms - minutes * 60_000) / 1000);
	return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export function subagentWaitLabel(status: SubagentWaitView["status"]): string {
	if (status === "waiting") return "Waiting for subagent";
	if (status === "error") return "Couldn’t wait for subagent";
	return "Finished waiting for subagent";
}

export function subagentWaitAccessibleTiming(view: SubagentWaitView): string {
	if (view.status === "waiting") {
		return view.timeoutMs > 0
			? `Maximum wait ${formatSubagentWaitDuration(view.timeoutMs)}.`
			: "Waiting until the subagent responds.";
	}
	return `Wait duration ${formatSubagentWaitDuration(view.elapsedMs)}.`;
}

export function deriveSubagentWaitView({
	input,
	result,
	startedAt,
	now,
	subagentsByTaskId,
}: {
	readonly input: unknown;
	readonly result: SubagentWaitResult | undefined;
	readonly startedAt: Date;
	readonly now: Date;
	readonly subagentsByTaskId: ReadonlyMap<string, SubagentReference>;
}): SubagentWaitView | null {
	const taskId = subagentTaskIdForBlockingWait(input, subagentsByTaskId);
	if (taskId === null || input === null || typeof input !== "object")
		return null;
	const record = input as Record<string, unknown>;
	const subagent = subagentsByTaskId.get(taskId);
	if (subagent === undefined) return null;

	const timeoutMs =
		typeof record.timeout === "number" && Number.isFinite(record.timeout)
			? Math.max(0, record.timeout)
			: 0;
	const endedAt = result?.completedAt ?? now;
	return {
		agentName: subagent.agentName,
		status:
			result === undefined ? "waiting" : result.isError ? "error" : "finished",
		elapsedMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
		timeoutMs,
	};
}
