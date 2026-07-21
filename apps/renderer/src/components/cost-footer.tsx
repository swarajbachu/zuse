import {
	type AgentItemId,
	type Message,
	MODEL_PRICING,
	type SessionId,
} from "@zuse/contracts";
import { useMemo } from "react";

import { useMessagesStore } from "../store/messages.ts";

const EMPTY: ReadonlyArray<Message> = [];

const MODEL_LABEL: Record<string, string> = {
	"claude-sonnet-5": "Sonnet",
	"claude-fable-5": "Fable",
	"claude-opus-4-7": "Opus",
	"claude-sonnet-4-6": "Sonnet",
	"claude-haiku-4-5": "Haiku",
};

const labelForModel = (model: string): string => MODEL_LABEL[model] ?? model;

const formatTokens = (n: number): string => {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
};

const formatUsd = (n: number): string => {
	if (Math.abs(n) < 0.01) return "$0.00";
	return `$${n.toFixed(2)}`;
};

interface UsageBucket {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
}

const newBucket = (): UsageBucket => ({
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheCreationTokens: 0,
});

const addBucket = (
	acc: UsageBucket,
	delta: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheCreationTokens: number;
	},
): void => {
	acc.inputTokens += delta.inputTokens;
	acc.outputTokens += delta.outputTokens;
	acc.cacheReadTokens += delta.cacheReadTokens;
	acc.cacheCreationTokens += delta.cacheCreationTokens;
};

const usdFor = (model: string, b: UsageBucket): number => {
	const p = MODEL_PRICING[model];
	if (!p) return 0;
	return (
		(b.inputTokens * p.input +
			b.outputTokens * p.output +
			b.cacheReadTokens * p.cacheRead +
			b.cacheCreationTokens * p.cacheCreate) /
		1_000_000
	);
};

interface AgentSlot {
	// For sub-agents this is the parent's `Agent` tool_use itemId; null for
	// the main agent.
	readonly parentItemId: AgentItemId | null;
	readonly agentName: string | null;
	readonly model: string;
	readonly bucket: UsageBucket;
}

/**
 * Per-session cost surface. Walks every `usage` MessageContent the
 * messages stream has delivered so far, buckets them by parentItemId +
 * model, and prints a compact one-liner per agent plus an estimated
 * "saved" figure (cost if every sub-agent turn had run on the main
 * model). Hidden when no usage rows exist.
 */
/**
 * Compact token-usage chip for the composer footer — same summary as
 * `CostFooter`, styled to sit beside the session timer.
 */
export function CostChip({ sessionId }: { sessionId: SessionId }) {
	const messages = useMessagesStore(
		(s) => s.messagesBySession[sessionId] ?? EMPTY,
	);
	const summary = useCostSummary(messages);
	if (summary === null || summary.lines.length === 0) return null;

	return (
		<span
			className="hidden rounded-md border border-border/60 bg-background px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground sm:inline"
			title={
				summary.saved > 0.005
					? `${summary.lines.join(" · ")} — saved ~${formatUsd(summary.saved)}`
					: summary.lines.join(" · ")
			}
		>
			{summary.lines.join(" · ")}
		</span>
	);
}

function useCostSummary(messages: ReadonlyArray<Message>) {
	return useMemo(() => {
		const slots = new Map<string, AgentSlot>();
		// Resolve sub-agent name from the parent's `Agent` tool_use input.
		const agentNameById = new Map<AgentItemId, string>();
		let mainModel: string | null = null;

		for (const m of messages) {
			const c = m.content;
			if (
				c._tag === "tool_use" &&
				(c.tool === "Agent" || c.tool === "Task") &&
				c.input !== null &&
				typeof c.input === "object"
			) {
				const subagentType = (c.input as Record<string, unknown>).subagent_type;
				if (typeof subagentType === "string") {
					agentNameById.set(c.itemId, subagentType);
				}
			}
			if (c._tag !== "usage") continue;
			const slotKey = `${c.parentItemId ?? "_main"}::${c.model}`;
			let slot = slots.get(slotKey);
			if (slot === undefined) {
				slot = {
					parentItemId: c.parentItemId ?? null,
					agentName: c.parentItemId
						? (agentNameById.get(c.parentItemId) ?? "agent")
						: null,
					model: c.model,
					bucket: newBucket(),
				};
				slots.set(slotKey, slot);
			}
			addBucket(slot.bucket, c);
			if (c.parentItemId === undefined) mainModel = c.model;
		}

		if (slots.size === 0) return null;

		let actualUsd = 0;
		let counterfactualUsd = 0;
		const lines: string[] = [];
		const slotList = Array.from(slots.values()).sort((a, b) => {
			// Main agent first, then sub-agents alphabetical.
			if (a.parentItemId === null && b.parentItemId !== null) return -1;
			if (a.parentItemId !== null && b.parentItemId === null) return 1;
			return (a.agentName ?? "").localeCompare(b.agentName ?? "");
		});
		for (const slot of slotList) {
			const cost = usdFor(slot.model, slot.bucket);
			actualUsd += cost;
			const counterModel =
				slot.parentItemId === null ? slot.model : (mainModel ?? slot.model);
			counterfactualUsd += usdFor(counterModel, slot.bucket);
			// Sub-agent `result` events sometimes ship without a model field —
			// the driver tags those "unknown". Tokens are real, so still print
			// them; drop the unhelpful label.
			const tokens = `${formatTokens(slot.bucket.inputTokens)} in / ${formatTokens(slot.bucket.outputTokens)} out`;
			if (slot.model === "unknown") {
				lines.push(tokens);
				continue;
			}
			const label =
				slot.parentItemId === null
					? labelForModel(slot.model)
					: `${labelForModel(slot.model)} (${slot.agentName})`;
			lines.push(`${label}: ${tokens}`);
		}
		const saved = counterfactualUsd - actualUsd;
		return { lines, saved };
	}, [messages]);
}
