import type { ToolCategory } from "./events.ts";

export interface TurnUsageDelta {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheCreationTokens: number;
}

export interface TurnAnalyticsSnapshot {
	readonly input_tokens: number;
	readonly output_tokens: number;
	readonly cache_read_tokens: number;
	readonly cache_creation_tokens: number;
	readonly tool_count: number;
	readonly tool_failure_count: number;
	readonly browser_tool_count: number;
	readonly shell_tool_count: number;
	readonly fs_tool_count: number;
	readonly git_tool_count: number;
	readonly mcp_tool_count: number;
	readonly subagent_tool_count: number;
	readonly other_tool_count: number;
	readonly subagent_failure_count: number;
	readonly compaction_count: number;
}

const emptyToolCounts = (): Record<ToolCategory, number> => ({
	browser: 0,
	shell: 0,
	files: 0,
	git: 0,
	mcp: 0,
	subagent: 0,
	other: 0,
});

export class TurnAnalyticsAccumulator {
	#inputTokens = 0;
	#outputTokens = 0;
	#cacheReadTokens = 0;
	#cacheCreationTokens = 0;
	#toolCount = 0;
	#toolFailureCount = 0;
	#toolCounts = emptyToolCounts();
	#observedToolIds = new Set<string>();
	#completedToolIds = new Set<string>();
	#subagentFailureCount = 0;
	#compactionCount = 0;

	recordUsage(delta: TurnUsageDelta): void {
		this.#inputTokens += delta.inputTokens;
		this.#outputTokens += delta.outputTokens;
		this.#cacheReadTokens += delta.cacheReadTokens;
		this.#cacheCreationTokens += delta.cacheCreationTokens;
	}

	recordToolUse(itemId: string, category: ToolCategory): void {
		if (this.#observedToolIds.has(itemId)) return;
		this.#observedToolIds.add(itemId);
		this.#toolCount += 1;
		this.#toolCounts[category] += 1;
	}

	recordToolResult(itemId: string, failed: boolean): void {
		if (
			!this.#observedToolIds.has(itemId) ||
			this.#completedToolIds.has(itemId)
		) {
			return;
		}
		this.#completedToolIds.add(itemId);
		if (failed) this.#toolFailureCount += 1;
	}

	recordSubagentResult(failed: boolean): void {
		if (failed) this.#subagentFailureCount += 1;
	}

	recordCompaction(): void {
		this.#compactionCount += 1;
	}

	snapshot(): TurnAnalyticsSnapshot {
		return {
			input_tokens: this.#inputTokens,
			output_tokens: this.#outputTokens,
			cache_read_tokens: this.#cacheReadTokens,
			cache_creation_tokens: this.#cacheCreationTokens,
			tool_count: this.#toolCount,
			tool_failure_count: this.#toolFailureCount,
			browser_tool_count: this.#toolCounts.browser,
			shell_tool_count: this.#toolCounts.shell,
			fs_tool_count: this.#toolCounts.files,
			git_tool_count: this.#toolCounts.git,
			mcp_tool_count: this.#toolCounts.mcp,
			subagent_tool_count: this.#toolCounts.subagent,
			other_tool_count: this.#toolCounts.other,
			subagent_failure_count: this.#subagentFailureCount,
			compaction_count: this.#compactionCount,
		};
	}
}
