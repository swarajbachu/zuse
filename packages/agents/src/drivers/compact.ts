import type { AgentEvent, AgentItemId, ProviderId } from "@zuse/contracts";

export interface CompactSnapshot {
	readonly itemId: AgentItemId;
	readonly startedAt: number;
	readonly beforeTokens: number | null;
}

let compactCounter = 0;

export const nextCompactItemId = (): AgentItemId =>
	`compact_${Date.now()}_${++compactCounter}` as AgentItemId;

export const isCompactCommand = (text: string): boolean =>
	/^\/compact(?:\s|$)/.test(text.trim());

export const startCompactSnapshot = (
	beforeTokens: number | null,
	itemId: AgentItemId = nextCompactItemId(),
): CompactSnapshot => ({
	itemId,
	startedAt: Date.now(),
	beforeTokens,
});

export const startCompactEvent = ({
	providerId,
	snapshot,
}: {
	readonly providerId: ProviderId;
	readonly snapshot: CompactSnapshot;
}): AgentEvent => ({
	_tag: "ContextCompaction",
	itemId: snapshot.itemId,
	providerId,
	startedAt: snapshot.startedAt,
	durationMs: 0,
	beforeTokens: snapshot.beforeTokens,
	afterTokens: null,
	status: "in_progress",
});

export const finishCompactEvent = ({
	itemId,
	providerId,
	snapshot,
	afterTokens,
	durationMs,
}: {
	readonly itemId: AgentItemId;
	readonly providerId: ProviderId;
	readonly snapshot: CompactSnapshot | null;
	readonly afterTokens: number | null;
	readonly durationMs?: number;
}): AgentEvent => {
	const now = Date.now();
	const startedAt = snapshot?.startedAt ?? now;
	const beforeTokens = snapshot?.beforeTokens ?? null;
	const exactAfterTokens =
		afterTokens !== null && afterTokens !== beforeTokens ? afterTokens : null;
	return {
		_tag: "ContextCompaction",
		itemId,
		providerId,
		startedAt,
		durationMs: Math.max(0, durationMs ?? now - startedAt),
		beforeTokens,
		afterTokens: exactAfterTokens,
		status: "completed",
	};
};
