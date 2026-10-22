import type { WorkflowAgentProgress, WorkflowProgress } from "@zuse/contracts";

const text = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim().length > 0 ? value : undefined;
const number = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

const agentState = (
	entry: Record<string, unknown>,
): WorkflowAgentProgress["state"] => {
	switch (entry.state) {
		case "done":
			return "done";
		case "error":
			return "failed";
		case "progress":
			return "running";
		default:
			// The CLI reports "start" both while an agent waits for a
			// concurrency slot and once it runs; only a running agent has a start.
			return number(entry.startedAt) === undefined ? "queued" : "running";
	}
};

/**
 * Reduce the CLI's `task_progress.workflow_progress` snapshot to the phases
 * and agents a transcript can show. Volatile counters (tokens, last tool,
 * heartbeat times) are dropped so unchanged runs produce identical snapshots.
 */
export function claudeWorkflowProgress(raw: unknown): WorkflowProgress | null {
	if (!Array.isArray(raw)) return null;
	const phases: Array<WorkflowProgress["phases"][number]> = [];
	const agents: WorkflowAgentProgress[] = [];
	for (const value of raw) {
		if (value === null || typeof value !== "object") continue;
		const entry = value as Record<string, unknown>;
		const index = number(entry.index);
		if (index === undefined) continue;
		if (entry.type === "workflow_phase") {
			const title = text(entry.title);
			if (title !== undefined) phases.push({ index, title });
			continue;
		}
		if (entry.type !== "workflow_agent") continue;
		const label = text(entry.label);
		if (label === undefined) continue;
		const phaseIndex = number(entry.phaseIndex);
		const phaseTitle = text(entry.phaseTitle);
		const model = text(entry.model);
		const startedAt = number(entry.startedAt);
		const durationMs = number(entry.durationMs);
		const promptPreview = text(entry.promptPreview);
		const resultPreview = text(entry.resultPreview);
		const error = text(entry.error);
		agents.push({
			index,
			label,
			state: agentState(entry),
			...(phaseIndex === undefined ? {} : { phaseIndex }),
			...(phaseTitle === undefined ? {} : { phaseTitle }),
			...(model === undefined ? {} : { model }),
			...(startedAt === undefined ? {} : { startedAt }),
			...(durationMs === undefined ? {} : { durationMs }),
			...(promptPreview === undefined ? {} : { promptPreview }),
			...(resultPreview === undefined ? {} : { resultPreview }),
			...(error === undefined ? {} : { error }),
		});
	}
	if (phases.length === 0 && agents.length === 0) return null;
	phases.sort((a, b) => a.index - b.index);
	agents.sort((a, b) => a.index - b.index);
	return { phases, agents };
}
