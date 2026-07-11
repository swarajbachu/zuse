/** Canonical mapping between durable message content and provider transcripts. */
import type {
	AgentEvent,
	Message,
	MessageContent,
	MessageRole,
} from "@zuse/contracts";

export const orchestrationErrorText = (error: unknown): string => {
	if (typeof error === "object" && error !== null) {
		const record = error as Record<string, unknown>;
		if (typeof record.reason === "string") return record.reason;
		if (typeof record._tag === "string") return record._tag;
	}
	return "Operation failed.";
};

export const messageContentToText = (content: MessageContent): string => {
	switch (content._tag) {
		case "user":
		case "user_rich":
		case "assistant":
		case "thinking":
			return content.text;
		case "tool_use":
			return `[tool_use: ${content.tool}]`;
		case "tool_result":
			return String(content.output);
		case "error":
			return `[error: ${content.message}]`;
		case "subagent_summary":
			return content.summary;
		default:
			return `[${content._tag}]`;
	}
};

const transcriptSkipKinds: ReadonlySet<string> = new Set([
	"usage",
	"context_usage",
	"context_compaction",
	"usage_limit",
]);

export const shouldIncludeInTranscript = (content: MessageContent): boolean =>
	!transcriptSkipKinds.has(content._tag);

const clampBlock = (value: string, max = 2000): string =>
	value.length > max
		? `${value.slice(0, max)}\n… (${value.length - max} more chars truncated)`
		: value;

const stringifyUnknown = (value: unknown): string => {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
};

export const transcriptToMarkdown = (
	title: string,
	messages: ReadonlyArray<Message>,
): string => {
	const lines: string[] = [`# Transcript — ${title}`, ""];
	for (const message of messages) {
		const content = message.content;
		if (!shouldIncludeInTranscript(content)) continue;
		switch (content._tag) {
			case "user":
			case "user_rich":
				lines.push("## User", "", content.text.trim(), "");
				break;
			case "assistant":
				lines.push("## Assistant", "", content.text.trim(), "");
				break;
			case "thinking":
				if (!content.redacted && content.text.trim().length > 0) {
					lines.push(
						`> _(thinking)_ ${content.text.trim().replace(/\n/g, "\n> ")}`,
						"",
					);
				}
				break;
			case "tool_use":
				lines.push(
					`### 🛠 ${content.tool}`,
					"",
					"```json",
					clampBlock(stringifyUnknown(content.input)),
					"```",
					"",
				);
				break;
			case "tool_result":
				lines.push(
					content.isError ? "### ⚠ Tool result (error)" : "### Tool result",
					"",
					"```",
					clampBlock(stringifyUnknown(content.output)),
					"```",
					"",
				);
				break;
			case "error":
				lines.push(`> **Error:** ${content.message}`, "");
				break;
			case "interrupted":
				lines.push("> _(interrupted by user)_", "");
				break;
			case "subagent_summary":
				lines.push(
					`### Sub-agent ${content.agentName}`,
					"",
					content.summary.trim(),
					"",
				);
				break;
			default:
				break;
		}
	}
	return `${lines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd()}\n`;
};

export const parentItemIdOfContent = (
	content: MessageContent,
): string | null => {
	switch (content._tag) {
		case "assistant":
		case "thinking":
		case "tool_use":
		case "tool_result":
		case "usage":
		case "user_question":
		case "user_question_answer":
			return content.parentItemId ?? null;
		default:
			return null;
	}
};

export const roleForContent = (content: MessageContent): MessageRole => {
	switch (content._tag) {
		case "user":
		case "user_rich":
		case "user_question_answer":
			return "user";
		case "assistant":
		case "thinking":
		case "tool_use":
		case "subagent_summary":
		case "user_question":
			return "assistant";
		case "tool_result":
			return "tool";
		default:
			return "system";
	}
};

export const eventToContent = (event: AgentEvent): MessageContent | null => {
	switch (event._tag) {
		case "AssistantMessage":
			return {
				_tag: "assistant",
				text: event.text,
				parentItemId: event.parentItemId,
			};
		case "Thinking":
			return {
				_tag: "thinking",
				itemId: event.itemId,
				text: event.text,
				redacted: event.redacted,
				parentItemId: event.parentItemId,
			};
		case "ToolUse":
			return {
				_tag: "tool_use",
				itemId: event.itemId,
				tool: event.tool,
				input: event.input,
				parentItemId: event.parentItemId,
				subagent: event.subagent,
			};
		case "ToolResult":
			return {
				_tag: "tool_result",
				itemId: event.itemId,
				output: event.output,
				isError: event.isError,
				parentItemId: event.parentItemId,
			};
		case "SubagentSummary":
			return {
				_tag: "subagent_summary",
				itemId: event.itemId,
				agentName: event.agentName,
				model: event.model,
				turns: event.turns,
				durationMs: event.durationMs,
				summary: event.summary,
				isError: event.isError,
				childSessionId: event.childSessionId,
				presentation: event.presentation,
			};
		case "UsageDelta":
			return {
				_tag: "usage",
				parentItemId: event.parentItemId,
				inputTokens: event.inputTokens,
				outputTokens: event.outputTokens,
				cacheReadTokens: event.cacheReadTokens,
				cacheCreationTokens: event.cacheCreationTokens,
				model: event.model,
			};
		case "ContextUsage":
			return {
				_tag: "context_usage",
				providerId: event.providerId,
				usedTokens: event.usedTokens,
				windowTokens: event.windowTokens,
				precision: event.precision,
				source: event.source,
			};
		case "ContextCompaction":
			return {
				_tag: "context_compaction",
				itemId: event.itemId,
				providerId: event.providerId,
				startedAt: event.startedAt,
				durationMs: event.durationMs,
				beforeTokens: event.beforeTokens,
				afterTokens: event.afterTokens,
				status: event.status,
			};
		case "UsageLimit":
			return {
				_tag: "usage_limit",
				providerId: event.providerId,
				label: event.label,
				usedPercent: event.usedPercent,
				resetsAt: event.resetsAt,
				windowMinutes: event.windowMinutes,
			};
		case "Error":
			return { _tag: "error", message: event.message };
		case "Interrupted":
			return { _tag: "interrupted" };
		case "UserQuestion":
			return {
				_tag: "user_question",
				itemId: event.itemId,
				questions: event.questions,
				parentItemId: event.parentItemId,
			};
		default:
			return null;
	}
};
