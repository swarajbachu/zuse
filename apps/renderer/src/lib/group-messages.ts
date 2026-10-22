import { nativeBackgroundChildren } from "@zuse/client-runtime/native-background";
import type {
	AgentItemId,
	Message,
	SessionExecutionStep,
} from "@zuse/contracts";
import { subagentDisplayName } from "./subagent-metadata.ts";

export type RenderGroup =
	| { readonly kind: "single"; readonly message: Message }
	| {
			readonly kind: "subagent";
			readonly parent: Message;
			readonly parentItemId: AgentItemId;
			readonly agentName: string;
			readonly prompt: string;
			readonly modelRequested: string | undefined;
			readonly workflowInput?: unknown;
			readonly childSessionId: string | undefined;
			readonly presentation: "inline" | "detached";
			readonly rootCompleted?: boolean;
			readonly children: ReadonlyArray<Message>;
			readonly summary: {
				readonly text: string;
				readonly turns: number;
				readonly durationMs: number;
				readonly model: string;
				readonly isError: boolean;
			} | null;
	  };

export type DetachedSubagentGroup = Extract<
	RenderGroup,
	{ readonly kind: "subagent" }
> & {
	readonly childSessionId: string;
};

/** Detached subagents in transcript order, shared by the pane and shortcuts. */
export const detachedSubagentGroups = (
	messages: ReadonlyArray<Message>,
	steps: readonly SessionExecutionStep[] = [],
): DetachedSubagentGroup[] =>
	groupMessages(messages, steps).flatMap((group) =>
		group.kind === "subagent" &&
		group.presentation === "detached" &&
		group.childSessionId !== undefined
			? [{ ...group, childSessionId: group.childSessionId }]
			: [],
	);

export const isAgentToolUse = (m: Message): boolean =>
	(() => {
		if (m.content._tag === "tool_use" && m.content.subagent !== undefined)
			return true;
		if (
			m.content._tag !== "tool_use" ||
			(m.content.tool !== "Agent" &&
				m.content.tool !== "Task" &&
				m.content.tool !== "Workflow") ||
			m.content.input === null ||
			typeof m.content.input !== "object"
		) {
			return false;
		}
		const input = m.content.input as Record<string, unknown>;
		return m.content.tool === "Workflow" || typeof input.prompt === "string";
	})();

/**
 * Walk the message log once and produce a flat render order where each
 * `Agent` tool_use becomes a single SubagentRow that owns its nested
 * messages and the closing summary. Top-level messages whose
 * `parentItemId` is set are dropped from the top-level pass — they appear
 * inside the wrapper instead. The paired `tool_result` for an Agent
 * tool_use is also dropped (the SubagentSummary supersedes it). `usage`
 * rows feed the cost footer and never render in the timeline.
 */
export function groupMessages(
	messages: ReadonlyArray<Message>,
	steps: readonly SessionExecutionStep[] = [],
): ReadonlyArray<RenderGroup> {
	const out: RenderGroup[] = [];
	const background = nativeBackgroundChildren(messages, steps);

	const childrenByParent = new Map<AgentItemId, Message[]>();
	const summariesByItemId = new Map<AgentItemId, Message>();
	const canonicalAgentByItemId = new Map<
		AgentItemId,
		{ readonly parent: Message; readonly enriched: Message }
	>();
	const completedCompactionItemIds = new Set<AgentItemId>();
	for (const m of messages) {
		const c = m.content;
		if (isAgentToolUse(m) && c._tag === "tool_use") {
			const existing = canonicalAgentByItemId.get(c.itemId);
			canonicalAgentByItemId.set(c.itemId, {
				parent: existing?.parent ?? m,
				enriched:
					c.subagent !== undefined || existing === undefined
						? m
						: existing.enriched,
			});
		}
		if (c._tag === "subagent_summary") {
			summariesByItemId.set(c.itemId, m);
			continue;
		}
		if (
			c._tag === "context_compaction" &&
			(c.status ?? "completed") !== "in_progress"
		) {
			completedCompactionItemIds.add(c.itemId);
		}
		if ("parentItemId" in c && c.parentItemId !== undefined) {
			const list = childrenByParent.get(c.parentItemId) ?? [];
			list.push(m);
			childrenByParent.set(c.parentItemId, list);
		}
	}

	const agentItemIds = new Set<AgentItemId>();
	for (const m of messages) {
		if (isAgentToolUse(m) && m.content._tag === "tool_use") {
			agentItemIds.add(m.content.itemId);
		}
	}

	for (const m of messages) {
		const c = m.content;
		if (c._tag === "usage") continue;
		if (c._tag === "subagent_summary") continue;
		if (
			c._tag === "context_compaction" &&
			c.status === "in_progress" &&
			completedCompactionItemIds.has(c.itemId)
		) {
			continue;
		}
		if ("parentItemId" in c && c.parentItemId !== undefined) continue;
		if (c._tag === "tool_result" && agentItemIds.has(c.itemId)) continue;
		if (isAgentToolUse(m) && c._tag === "tool_use") {
			const canonical = canonicalAgentByItemId.get(c.itemId);
			if (canonical === undefined || canonical.parent.id !== m.id) continue;
			const enrichedContent = canonical.enriched.content;
			if (enrichedContent._tag !== "tool_use") continue;
			const inputObj =
				enrichedContent.input !== null &&
				typeof enrichedContent.input === "object"
					? (enrichedContent.input as Record<string, unknown>)
					: {};
			const agentName = subagentDisplayName(inputObj);
			const modelRequested =
				typeof inputObj.model === "string"
					? (inputObj.model as string)
					: undefined;
			const prompt =
				typeof inputObj.prompt === "string"
					? (inputObj.prompt as string)
					: typeof inputObj.description === "string"
						? (inputObj.description as string)
						: "";
			const summaryRow = summariesByItemId.get(enrichedContent.itemId);
			const summary =
				summaryRow !== undefined &&
				summaryRow.content._tag === "subagent_summary"
					? {
							text: summaryRow.content.summary,
							turns: summaryRow.content.turns,
							durationMs: summaryRow.content.durationMs,
							model: summaryRow.content.model,
							isError: summaryRow.content.isError,
						}
					: null;
			out.push({
				kind: "subagent",
				parent: canonical.parent,
				parentItemId: enrichedContent.itemId,
				agentName,
				prompt,
				modelRequested,
				...(enrichedContent.tool === "Workflow"
					? { workflowInput: enrichedContent.input }
					: {}),
				childSessionId: enrichedContent.subagent?.childSessionId,
				presentation: enrichedContent.subagent?.presentation ?? "inline",
				rootCompleted:
					enrichedContent.subagent === undefined
						? false
						: background.has(enrichedContent.subagent.childSessionId),
				children: childrenByParent.get(enrichedContent.itemId) ?? [],
				summary,
			});
			continue;
		}
		out.push({ kind: "single", message: m });
	}
	return out;
}
