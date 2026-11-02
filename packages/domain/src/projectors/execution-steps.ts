import type { MessageContent, SessionExecutionStep } from "@zuse/contracts";

export interface ExecutionIdentity {
	sessionId: string;
	turnId: string;
	attemptId: string;
	at: number;
}
export const executionStepItem = (content: MessageContent): string | null =>
	content._tag === "tool_use" ||
	content._tag === "tool_result" ||
	content._tag === "subagent_summary"
		? content.itemId
		: null;
export const evolveExecutionStep = (
	previous: SessionExecutionStep | null,
	identity: ExecutionIdentity,
	content: MessageContent,
): SessionExecutionStep | null => {
	if (content._tag === "tool_use") {
		if (previous !== null) {
			if (
				previous.kind === "tool" &&
				(content.subagent !== undefined || content.backgroundTask !== undefined)
			)
				return {
					...previous,
					kind: content.subagent !== undefined ? "subagent" : "background",
					status: "running",
					nativeChildId:
						content.subagent?.childSessionId ??
						content.backgroundTask?.taskId ??
						null,
					childSessionId:
						content.subagent === undefined ? null : `native:${previous.id}`,
					updatedAt: identity.at,
				};
			return previous;
		}
		const id = JSON.stringify([
			identity.sessionId,
			identity.turnId,
			identity.attemptId,
			content.itemId,
		]);
		return {
			id,
			turnId: identity.turnId,
			attemptId: identity.attemptId,
			itemId: content.itemId,
			parentItemId: content.parentItemId ?? null,
			kind:
				content.subagent !== undefined
					? "subagent"
					: content.backgroundTask !== undefined
						? "background"
						: "tool",
			label: content.tool,
			status: "running",
			childSessionId: content.subagent === undefined ? null : `native:${id}`,
			nativeChildId:
				content.subagent?.childSessionId ??
				content.backgroundTask?.taskId ??
				null,
			rootCompletedAt: null,
			createdAt: identity.at,
			updatedAt: identity.at,
			checkpointCapability: "unsupported",
		};
	}
	if (previous === null || previous.status !== "running") return previous;
	if (
		content._tag === "subagent_summary" ||
		(content._tag === "tool_result" && previous.kind !== "subagent")
	)
		return {
			...previous,
			status:
				content._tag === "tool_result" &&
				content.backgroundOutcome === "stopped"
					? "cancelled"
					: content.isError
						? "failed"
						: "completed",
			updatedAt: identity.at,
		};
	if (content._tag === "subagent_progress")
		return {
			...previous,
			rootCompletedAt:
				content.rootCompleted === true
					? (previous.rootCompletedAt ?? identity.at)
					: previous.rootCompletedAt,
			updatedAt: identity.at,
		};
	return previous;
};
export const applyExecutionMessage = (
	steps: readonly SessionExecutionStep[],
	identity: ExecutionIdentity,
	content: MessageContent,
): readonly SessionExecutionStep[] => {
	const item = executionStepItem(content);
	if (item === null && content._tag !== "subagent_progress") return steps;
	const index = steps.findIndex(
		(step) =>
			step.turnId === identity.turnId &&
			step.attemptId === identity.attemptId &&
			(item !== null
				? step.itemId === item
				: content._tag === "subagent_progress" &&
					step.nativeChildId === content.childSessionId),
	);
	const previous = steps[index] ?? null;
	const next = evolveExecutionStep(previous, identity, content);
	if (next === null || next === previous) return steps;
	const updated = [...steps];
	if (index < 0) updated.push(next);
	else updated[index] = next;
	return updated
		.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
		.slice(0, 200);
};
export const settleExecutionSteps = (
	steps: readonly SessionExecutionStep[],
	turnId: string,
	status: "failed" | "cancelled",
	at: number,
) =>
	steps.map((step) =>
		step.turnId === turnId && step.status === "running"
			? { ...step, status, updatedAt: at }
			: step,
	);
