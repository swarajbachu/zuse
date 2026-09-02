import {
	recordPowerInteraction,
	recordUiAction,
} from "./diagnostics-recorder.ts";

export type RendererInteractionStage =
	| "click"
	| "first-atom-commit"
	| "first-react-commit"
	| "entity-acknowledged"
	| "queue-persisted"
	| "provider-ready"
	| "queue-claimed"
	| "first-transcript-message";

export type RendererStartupMilestone =
	| "rpc-connected"
	| "settings-cache-hydrated"
	| "settings-live"
	| "environment-catalog-started"
	| "projects-visible"
	| "shell-live";

const recordedStartupMilestones = new Set<RendererStartupMilestone>();

export function markRendererStartupMilestone(
	milestone: RendererStartupMilestone,
): void {
	if (recordedStartupMilestones.has(milestone)) return;
	recordedStartupMilestones.add(milestone);
	const elapsed = performance.now();
	performance.mark(`renderer.startup.${milestone}`);
	recordUiAction(
		"startup.milestone",
		`name=${milestone} elapsedMs=${elapsed.toFixed(1)}`,
	);
}

const markName = (sessionId: string, stage: RendererInteractionStage) =>
	`renderer.chat.${sessionId}.${stage}`;

export function markRendererInteraction(
	sessionId: string,
	stage: RendererInteractionStage,
): void {
	const click = performance
		.getEntriesByName(markName(sessionId, "click"))
		.at(-1);
	if (stage !== "click" && click === undefined) return;
	performance.mark(markName(sessionId, stage));
	const elapsed =
		click === undefined ? undefined : performance.now() - click.startTime;
	recordUiAction(
		`chat.${stage}`,
		elapsed === undefined
			? `session=${sessionId}`
			: `session=${sessionId} elapsedMs=${elapsed.toFixed(1)}`,
	);
	if (elapsed !== undefined) recordPowerInteraction(`chat.${stage}`, elapsed);
}

/**
 * Compatibility shim for the three interaction-marking call sites that used
 * to own RPC timing. The shared client boundary now measures every unary RPC.
 */
export async function trackRendererRpc<A>(
	_name: string,
	operation: () => Promise<A>,
): Promise<A> {
	return operation();
}
