import type { SessionTimelineProjection } from "@zuse/contracts";
import type { ResourceView } from "./resource-state.ts";

/** Background agent launches outlive a parent reply. A launch acknowledgement
 * is not completion: only the matching subagent summary settles that run.
 * Historical checkpoints cannot establish that a process is still alive. */
export const runningBackgroundAgents = (
	view: ResourceView<SessionTimelineProjection>,
): ReadonlyArray<{
	readonly id: string;
	readonly description: string;
	readonly startedAtMs: number;
}> => {
	if (
		view.origin !== "runtime" ||
		view.connection !== "connected" ||
		view.data === null ||
		view.data.status === "error" ||
		view.data.status === "closed"
	)
		return [];
	const pending = new Map<
		string,
		{ id: string; description: string; startedAtMs: number }
	>();
	const completed = new Set<string>();
	for (const message of view.data.messages) {
		const content = message.content;
		if (
			content._tag === "tool_use" &&
			content.subagent?.presentation === "detached"
		) {
			const input = content.input;
			const description =
				input !== null &&
				typeof input === "object" &&
				"description" in input &&
				typeof input.description === "string"
					? input.description
					: "";
			if (!pending.has(content.itemId))
				pending.set(content.itemId, {
					id: content.itemId,
					description,
					startedAtMs: message.createdAt.getTime(),
				});
		} else if (content._tag === "subagent_summary")
			completed.add(content.itemId);
	}
	for (const id of completed) pending.delete(id);
	return [...pending.values()];
};

/** Count detached agents using the same live-transcript completion rules as the task rows. */
export const countRunningBackgroundAgents = (
	view: ResourceView<SessionTimelineProjection>,
): number => runningBackgroundAgents(view).length;
