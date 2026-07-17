import {
	recordDiagnosticEvent,
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
}

export async function trackRendererRpc<A>(
	name: string,
	operation: () => Promise<A>,
): Promise<A> {
	const startedAt = performance.now();
	try {
		return await operation();
	} finally {
		const durationMs = performance.now() - startedAt;
		if (durationMs >= 250) {
			recordDiagnosticEvent({
				level: durationMs >= 1_000 ? "warn" : "info",
				source: "renderer.rpc.slow",
				message: name,
				detail: `durationMs=${durationMs.toFixed(1)}`,
			});
		}
	}
}
