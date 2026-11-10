import { isToolTreeBranch } from "@zuse/client-runtime/timeline";
import type { Message } from "@zuse/contracts";

/** Reasoning and tool traffic that folds under a turn's "N tool calls" tree. */
export const isToolActivity = (message: Message): boolean =>
	message.content._tag === "thinking" ||
	(message.content._tag === "tool_use" &&
		message.content.tool !== "ExitPlanMode") ||
	message.content._tag === "tool_result" ||
	message.content._tag === "context_compaction" ||
	message.content._tag === "subagent_summary";

/** Rows that render nothing must not split one tree into two. */
const joinsToolActivity = (message: Message): boolean =>
	message.content._tag === "usage" ||
	message.content._tag === "context_usage" ||
	(message.content._tag === "assistant" &&
		message.content.text.trim().length === 0);

export const countToolCalls = (messages: readonly Message[]): number =>
	messages.filter(
		(message) =>
			message.content._tag === "tool_use" &&
			message.content.tool !== "ExitPlanMode",
	).length;

export type ToolTreePosition = "branch" | "last" | "through" | null;

/** Where each row sits on the trunk; the trunk stops at the final branch. */
export const toolTreePositions = (
	messages: readonly Message[],
): ReadonlyMap<string, ToolTreePosition> => {
	const lastBranch = messages.findLastIndex(isToolTreeBranch);
	return new Map(
		messages.map((message, index): [string, ToolTreePosition] => [
			message.id,
			index === lastBranch
				? "last"
				: index > lastBranch
					? null
					: isToolTreeBranch(message)
						? "branch"
						: "through",
		]),
	);
};

export type TurnBodySegment =
	| { readonly kind: "message"; readonly message: Message }
	| {
			readonly kind: "activity";
			readonly id: string;
			readonly messages: readonly Message[];
			readonly toolCount: number;
	  };

/** Split a live turn into narrative rows and consecutive tool-activity trees. */
export const segmentTurnBody = (
	body: readonly Message[],
): TurnBodySegment[] => {
	const segments: TurnBodySegment[] = [];
	let run: Message[] = [];
	const flush = () => {
		const toolCount = countToolCalls(run);
		const first = run[0];
		if (first !== undefined && toolCount > 0)
			segments.push({
				kind: "activity",
				id: `tools:${first.id}`,
				messages: run,
				toolCount,
			});
		else for (const message of run) segments.push({ kind: "message", message });
		run = [];
	};
	for (const message of body) {
		if (
			isToolActivity(message) ||
			(run.length > 0 && joinsToolActivity(message))
		) {
			run.push(message);
			continue;
		}
		flush();
		segments.push({ kind: "message", message });
	}
	flush();
	return segments;
};
