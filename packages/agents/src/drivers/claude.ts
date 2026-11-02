import {
	type Options,
	type Query,
	query,
	type SDKMessage,
	type SDKUserMessage,
	type PermissionMode as SdkPermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
import {
	decidePermission,
	isSensitivePath,
} from "@zuse/agents/kernel/permission-policy";
import {
	type AgentEvent,
	type AgentItemId,
	type AgentSessionId,
	AgentSessionStartError,
	type AttachmentRef,
	type PermissionDecision,
	type PermissionKind,
	type PermissionMode,
	type RuntimeMode,
	type StartSessionInput,
	type UserQuestion,
	type UserQuestionAnswer,
	WORKFLOW_PROGRESS_KEY,
} from "@zuse/contracts";
import { fractionToPercent } from "@zuse/utils/usage-values";
import { type Cause, Effect, Queue, Stream } from "effect";
import { AttachmentService } from "../kernel/attachment-service.ts";
import type {
	ProviderDriverEvent,
	ProviderSessionHandle,
	QuestionCallbackReleased,
} from "../kernel/driver.ts";
import { ProviderCheckpointBatcher } from "../kernel/provider-checkpoint-batcher.ts";
import {
	issueProviderMcpSession,
	type SessionTools,
} from "../kernel/provider-mcp-session.ts";
import { withProviderStartup } from "../kernel/provider-startup.ts";
import { makeBoundedQuestionCallbackRegistry } from "../kernel/user-question-answer.ts";
import type { BrowserSend } from "./browser-tools.ts";
import {
	scrubInheritedClaudeMarkers,
	withClaudeTaskTracking,
} from "./claude-env.ts";
import { claudeForkPoint, claudeResumeOptions } from "./claude-fork-point.ts";
import { makeClaudeProcessOwner } from "./claude-process.ts";
import { claudeWorkflowProgress } from "./claude-workflow-progress.ts";
import { applyClaudeWorktreeEnv } from "./claude-worktree-prompt.ts";
import {
	type CompactSnapshot,
	finishCompactEvent,
	isCompactCommand,
	startCompactEvent,
	startCompactSnapshot,
} from "./compact.ts";
import { READ_ONLY_ORCHESTRATION_TOOLS } from "./orchestration-tools.ts";
import { pluginCliEnv } from "./plugin-tools.ts";
import { isolatedProviderAccountEnv } from "./provider-account-env.ts";

/**
 * Live-only handle for one Claude SDK conversation. The orchestrator
 * (`ProviderService`) owns the map of sessionId → handle and forwards wire
 * RPCs to these methods.
 */
export interface ClaudeSessionHandle extends ProviderSessionHandle {
	readonly events: Stream.Stream<ProviderDriverEvent>;
	readonly send: (
		text: string,
		attachments?: ReadonlyArray<AttachmentRef>,
		fileRefs?: unknown,
		skillRefs?: unknown,
	) => Effect.Effect<void>;
	readonly interrupt: () => Effect.Effect<void>;
	readonly close: () => Effect.Effect<void>;
	/**
	 * Switch SDK lifecycle mode (plan / default / acceptEdits) on a live
	 * session. Emits `PermissionModeChanged` as a side-effect so the
	 * renderer chip stays in sync without polling.
	 */
	readonly setPermissionMode: (mode: PermissionMode) => Effect.Effect<void>;
	/**
	 * Resolve the pending `AskUserQuestion` tool call identified by `itemId`
	 * with the user's answers. The SDK turn unwinds with the answers as the
	 * tool result. No-op if the question is unknown (already cancelled or
	 * answered).
	 */
	readonly answerQuestion: (
		itemId: AgentItemId,
		answers: ReadonlyArray<UserQuestionAnswer>,
	) => Effect.Effect<void, Error>;
}

const toSdkPermissionMode = (mode: PermissionMode): SdkPermissionMode =>
	mode satisfies SdkPermissionMode;

export const runtimeModeToSdkPermissionMode = (
	runtimeMode: RuntimeMode,
	permissionMode: PermissionMode,
): SdkPermissionMode => {
	if (permissionMode === "plan") return toSdkPermissionMode(permissionMode);
	switch (runtimeMode) {
		case "auto":
			return "auto";
		case "full-access":
			return "bypassPermissions" as SdkPermissionMode;
		case "auto-accept-edits":
		case "auto-accept-edits-and-bash":
			return "acceptEdits" as SdkPermissionMode;
		case "approval-required":
			return toSdkPermissionMode(permissionMode);
	}
};

const ZUSE_MCP_NAME = "zuse";
const ASK_USER_QUESTION_TOOL = "ask_user_question";
const ASK_USER_QUESTION_FQN = `mcp__${ZUSE_MCP_NAME}__${ASK_USER_QUESTION_TOOL}`;

/**
 * Anthropic accepts these media types as image content blocks. Anything else
 * (HEIC, BMP, raw bytes) gets dropped with a console warning rather than
 * forwarded as an unsupported block — the SDK would reject the whole turn.
 */
const SUPPORTED_IMAGE_MIME = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);

type AnthropicImageMediaType =
	| "image/png"
	| "image/jpeg"
	| "image/gif"
	| "image/webp";

type UserContentBlock =
	| { type: "text"; text: string }
	| {
			type: "image";
			source: {
				type: "base64";
				media_type: AnthropicImageMediaType;
				data: string;
			};
	  }
	| {
			type: "document";
			source: {
				type: "base64";
				media_type: "application/pdf";
				data: string;
			};
			title?: string;
	  };

class UserInputChannel implements AsyncIterable<SDKUserMessage> {
	private buffer: SDKUserMessage[] = [];
	private waiting: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
	private closed = false;

	push(message: SDKUserMessage): void {
		if (this.closed) return;
		if (this.waiting !== null) {
			const resolve = this.waiting;
			this.waiting = null;
			resolve({ value: message, done: false });
			return;
		}
		this.buffer.push(message);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.waiting !== null) {
			const resolve = this.waiting;
			this.waiting = null;
			resolve({ value: undefined, done: true });
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
		return {
			next: () =>
				new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
					const next = this.buffer.shift();
					if (next !== undefined) {
						resolve({ value: next, done: false });
						return;
					}
					if (this.closed) {
						resolve({ value: undefined, done: true });
						return;
					}
					this.waiting = resolve;
				}),
		};
	}
}

export const makeClaudeUserMessage = (
	text: string,
	attachmentBlocks: ReadonlyArray<UserContentBlock> = [],
): SDKUserMessage => ({
	type: "user",
	message: {
		role: "user",
		content: [...attachmentBlocks, { type: "text", text }],
	},
	parent_tool_use_id: null,
});

let itemCounter = 0;
const nextItemId = (): AgentItemId =>
	`i_${Date.now()}_${++itemCounter}` as AgentItemId;

/**
 * Per-turn accumulator for thinking_delta / redacted_thinking blocks. The
 * SDK delivers raw `content_block_*` events when `includePartialMessages`
 * is on; we stitch them back together because the completed assistant
 * message has the `thinking` field stripped (SDK policy).
 *
 * Keyed by `index` from the stream events, which is stable within one
 * message but resets per turn — `message_start` clears the map.
 */
interface ThinkingAccumulator {
	kind: "text" | "thinking" | "redacted_thinking";
	readonly itemId: AgentItemId;
	text: string;
	signatureLength: number;
	revision: number;
	readonly parentItemId: AgentItemId | undefined;
}

interface PendingAgent {
	readonly agentName: string;
	readonly model: string;
	readonly startedAt: number;
	readonly background: boolean;
	turnCount: number;
}

interface TranslateState {
	thinkingByIndex: Map<number, ThinkingAccumulator>;
	currentMessageId: string | null;
	/**
	 * SDK message ids observed via `message_start`. The partial-message stream
	 * owns text and thinking rows for these messages; the completed `assistant`
	 * snapshot only contributes tool uses. The SDK delivers that snapshot
	 * either before or after `content_block_stop` depending on the CLI version,
	 * so ownership must not depend on ordering. Cleared when the turn ends.
	 */
	readonly streamedMessageIds: Set<string>;

	pendingAgents: Map<string, PendingAgent>;
	workflowInputs: Map<string, unknown>;
	/** Launched workflow runs by tool item, with the last progress sent. */
	workflowRuns: Map<
		string,
		{
			readonly input: Record<string, unknown>;
			readonly taskId: string;
			progress: string;
		}
	>;

	backgroundTaskParents: Map<string, AgentItemId>;

	backgroundShellInputs: Map<
		string,
		{ readonly input: unknown; readonly parentItemId: AgentItemId | undefined }
	>;

	localBackgroundTasks: Map<string, AgentItemId>;
	/**
	 * Most recent `parent_tool_use_id` seen on an SDK message. The Claude
	 * SDK's `canUseTool` callback signature does not include a parent id,
	 * so the driver attributes a permission request to the parent of the
	 * latest in-flight assistant message. SDK currently runs sub-agents
	 * serially; if it ever parallelises, this attribution races.
	 */
	latestParentItemId: AgentItemId | undefined;

	askUserQuestionIds: Set<string>;
	pendingTaskCreates: Set<string>;
	/**
	 * Tool-use ids for in-flight `ExitPlanMode` calls. When the matching
	 * `tool_result` lands with `is_error === false`, the SDK has already
	 * flipped its internal `permissionMode` to `default`; we mirror that
	 * by emitting a `PermissionModeChanged` event so ConversationServices
	 * persists the new mode and the chip auto-untoggles.
	 */
	exitPlanModeIds: Set<string>;

	lastContextUsedTokens: number | null;
	pendingCompact: CompactSnapshot | null;

	emittedAuthError: boolean;
	/**
	 * Set when the user interrupts the running turn (`handle.interrupt`). The SDK
	 * ends an interrupted turn with an `error_during_execution` result, which
	 * would otherwise surface as a bogus error bubble; while this flag is set the
	 * translator emits an `Interrupted` event instead. The shared turn protocol
	 * owns terminal synthesis. Reset per turn once consumed.
	 */
	interrupted: boolean;

	topLevelTurnOpen: boolean;
}

const newTranslateState = (
	options: { readonly topLevelTurnOpen?: boolean } = {},
): TranslateState => ({
	thinkingByIndex: new Map(),
	currentMessageId: null,
	streamedMessageIds: new Set(),
	pendingAgents: new Map(),
	workflowInputs: new Map(),
	workflowRuns: new Map(),
	backgroundTaskParents: new Map(),
	backgroundShellInputs: new Map(),
	localBackgroundTasks: new Map(),
	latestParentItemId: undefined,
	askUserQuestionIds: new Set(),
	pendingTaskCreates: new Set(),
	exitPlanModeIds: new Set(),
	lastContextUsedTokens: null,
	pendingCompact: null,
	emittedAuthError: false,
	interrupted: false,
	topLevelTurnOpen: options.topLevelTurnOpen ?? false,
});

const isAgentToolUse = (block: { type?: string; name?: string }): boolean =>
	block.type === "tool_use" &&
	(block.name === "Agent" ||
		block.name === "Task" ||
		block.name === "Workflow");

const extractTextFromContent = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) => {
				if (typeof block === "string") return block;
				if (block && typeof block === "object" && "text" in block) {
					const t = (block as { text?: unknown }).text;
					return typeof t === "string" ? t : "";
				}
				return "";
			})
			.join("\n");
	}
	return "";
};

const THINKING_DEBUG = process.env.MEMOIZE_DEBUG_THINKING === "1";
const tlog = (event: string, payload: Record<string, unknown> = {}): void => {
	if (!THINKING_DEBUG) return;
	let line: string;
	try {
		line = JSON.stringify({ event, ...payload });
	} catch {
		line = JSON.stringify({ event, error: "unserializable payload" });
	}
	// eslint-disable-next-line no-console
	console.error(`[claude-driver/thinking] ${line}`);
};
const summarize = (value: unknown, max = 200): string => {
	try {
		const s = typeof value === "string" ? value : JSON.stringify(value);
		return s.length > max ? `${s.slice(0, max)}…(${s.length}b)` : s;
	} catch {
		return String(value);
	}
};

const contextWindowFromModelUsage = (
	msg: SDKMessage,
	model: string,
): number | null => {
	const modelUsage = (
		msg as { modelUsage?: Record<string, { contextWindow?: unknown }> }
	).modelUsage;
	if (modelUsage === undefined) return null;
	const windowOf = (entry: { contextWindow?: unknown } | undefined) =>
		typeof entry?.contextWindow === "number" && entry.contextWindow > 0
			? entry.contextWindow
			: null;
	const exact = windowOf(modelUsage[model]);
	if (exact !== null) return exact;
	let max: number | null = null;
	for (const entry of Object.values(modelUsage)) {
		const w = windowOf(entry);
		if (w !== null && (max === null || w > max)) max = w;
	}
	return max;
};

interface ClaudeRateLimitInfo {
	readonly status?: string;
	readonly resetsAt?: number;
	readonly rateLimitType?: string;
	readonly utilization?: number;
}

const CLAUDE_LIMIT_LABELS: Record<string, string> = {
	five_hour: "5-hour limit",
	seven_day: "Weekly limit",
	seven_day_opus: "Opus only",
	seven_day_sonnet: "Sonnet only",
	seven_day_overage_included: "Model weekly limit",
	overage: "Overage",
};

const CLAUDE_LIMIT_WINDOW_MINUTES: Record<string, number> = {
	five_hour: 5 * 60,
	seven_day: 7 * 24 * 60,
	seven_day_opus: 7 * 24 * 60,
	seven_day_overage_included: 7 * 24 * 60,
	seven_day_sonnet: 7 * 24 * 60,
};

const claudeRateLimitEvents = (
	info: ClaudeRateLimitInfo,
): ReadonlyArray<AgentEvent> => {
	const type = info.rateLimitType;
	if (type === undefined) return [];
	const usedPercent = fractionToPercent(info.utilization);
	const resetsAt =
		typeof info.resetsAt === "number" && Number.isFinite(info.resetsAt)
			? new Date(
					info.resetsAt > 1e12 ? info.resetsAt : info.resetsAt * 1000,
				).toISOString()
			: null;
	return [
		{
			_tag: "UsageLimit",
			providerId: "claude",
			id: type,
			scope:
				type === "five_hour"
					? "session"
					: type === "seven_day"
						? "weekly"
						: type.startsWith("seven_day_")
							? "model"
							: "overall",
			label: CLAUDE_LIMIT_LABELS[type] ?? "Usage limit",
			usedPercent,
			resetsAt,
			windowMinutes: CLAUDE_LIMIT_WINDOW_MINUTES[type] ?? null,
		},
	];
};

export const claudeAuthFailureText = (msg: SDKMessage): string | null => {
	if (msg.type !== "assistant" || msg.error !== "authentication_failed")
		return null;
	if (msg.parent_tool_use_id !== null) return null;
	const content = msg.message.content;
	const text = Array.isArray(content)
		? content
				.flatMap((block) =>
					block.type === "text" && typeof block.text === "string"
						? [block.text.trim()]
						: [],
				)
				.filter((part) => part.length > 0)
				.join("\n")
		: "";
	return text.length > 0 ? text : "Authentication failed.";
};

/**
 * Pull the human-readable error text out of a `result` message. Treat only
 * explicit failure signals as provider errors. Claude can return assistant
 * prose in `result` even when `subtype` is not exactly `"success"`; rendering
 * that prose as an Error creates a bogus "Provider error" bubble.
 */
export const claudeResultErrorText = (msg: SDKMessage): string | null => {
	const m = msg as {
		subtype?: string;
		is_error?: boolean;
		result?: unknown;
		errors?: unknown;
		api_error_status?: unknown;
	};
	const status =
		typeof m.api_error_status === "number" ? m.api_error_status : null;
	const errors = Array.isArray(m.errors)
		? m.errors.filter((e): e is string => typeof e === "string")
		: [];
	const isError =
		m.is_error === true ||
		errors.length > 0 ||
		(status !== null && status >= 400);
	if (!isError) {
		const subtype = typeof m.subtype === "string" ? m.subtype : "";
		const hasResult =
			typeof m.result === "string" && m.result.trim().length > 0;
		if (subtype.startsWith("error") && !hasResult) {
			return "The agent run ended with an error.";
		}
		return null;
	}
	const parts: string[] = [];
	if (typeof m.result === "string" && m.result.trim().length > 0) {
		parts.push(m.result.trim());
	}
	parts.push(...errors);
	if (status !== null) parts.push(`API Error: ${status}`);
	const text = parts.join("\n").trim();
	return text.length > 0 ? text : "The agent run ended with an error.";
};

/**
 * Translate one SDKMessage into zero-or-more wire AgentEvents, announcing
 * turns the CLI starts on its own. Claude Code wakes its main agent when a
 * background task finishes; that turn has no application send, so the first
 * top-level output while no turn is open is preceded by `ProviderTurnStarted`.
 */
const translate = (
	msg: SDKMessage,
	state: TranslateState,
): ReadonlyArray<AgentEvent> => {
	const type = (msg as { type?: unknown }).type;
	const opensTurn =
		!state.topLevelTurnOpen &&
		(type === "stream_event" || type === "assistant" || type === "user") &&
		typeof (msg as { parent_tool_use_id?: unknown }).parent_tool_use_id !==
			"string";
	if (!opensTurn) return translateMessage(msg, state);
	state.topLevelTurnOpen = true;
	return [{ _tag: "ProviderTurnStarted" }, ...translateMessage(msg, state)];
};

const translateMessage = (
	msg: SDKMessage,
	state: TranslateState,
): ReadonlyArray<AgentEvent> => {
	tlog("sdk-msg", {
		type: (msg as { type?: unknown }).type,
		hasMessage: "message" in (msg as object),
		sessionId: (msg as { session_id?: unknown }).session_id,
	});

	const parentItemId =
		typeof (msg as { parent_tool_use_id?: unknown }).parent_tool_use_id ===
		"string"
			? ((msg as { parent_tool_use_id: string })
					.parent_tool_use_id as AgentItemId)
			: undefined;
	state.latestParentItemId = parentItemId;

	if (msg.type === "assistant") {
		const authFailure = claudeAuthFailureText(msg);
		if (authFailure !== null) {
			state.emittedAuthError = true;
			return [
				{
					_tag: "Error",
					message: authFailure,
					kind: "auth",
					providerId: "claude",
				},
			];
		}
		const out: AgentEvent[] = [];
		const content = msg.message.content;
		const messageId =
			typeof (msg.message as { id?: unknown }).id === "string"
				? (msg.message as { id: string }).id
				: state.currentMessageId;
		const streamed =
			messageId !== null && state.streamedMessageIds.has(messageId);
		const blockTypes: string[] = [];
		// Each assistant message inside a sub-agent counts as one of its
		// turns. The SDK exposes only the parent's `Agent` tool_use start
		// and the eventual tool_result; we tally turns here so the
		// SubagentSummary reflects how much work the sub-agent did.
		if (parentItemId !== undefined) {
			const pending = state.pendingAgents.get(parentItemId);
			if (pending !== undefined) pending.turnCount += 1;
		} else {
			const usage = (msg.message as { usage?: unknown }).usage as
				| Record<string, unknown>
				| undefined;
			if (usage !== undefined) {
				const tok = (key: string): number => {
					const v = usage[key];
					return typeof v === "number" ? v : 0;
				};
				const used =
					tok("input_tokens") +
					tok("cache_read_input_tokens") +
					tok("cache_creation_input_tokens") +
					tok("output_tokens");
				if (used > 0) state.lastContextUsedTokens = used;
			}
		}
		if (Array.isArray(content)) {
			for (const [blockIndex, block] of content.entries()) {
				blockTypes.push(String((block as { type?: unknown }).type));
				if (block.type === "text" && typeof block.text === "string") {
					if (streamed) continue;
					out.push({
						_tag: "AssistantMessage",
						itemId:
							messageId !== null
								? (`${messageId}:text:${blockIndex}` as AgentItemId)
								: nextItemId(),
						text: block.text,
						parentItemId,
					});
				} else if (block.type === "tool_use") {
					const id =
						typeof (block as { id?: unknown }).id === "string"
							? ((block as { id: string }).id as AgentItemId)
							: nextItemId();

					if (isAskUserQuestion(block.name)) {
						state.askUserQuestionIds.add(id as string);
						continue;
					}
					// ExitPlanMode: track so we can detect the paired tool_result
					// and emit `PermissionModeChanged` when it succeeds. The SDK
					// flips its internal permissionMode to `default` once the
					// tool runs; we mirror that into our session row.
					if (block.name === "ExitPlanMode") {
						state.exitPlanModeIds.add(id as string);
					}
					if (block.name === "Workflow") {
						state.workflowInputs.set(id as string, block.input);
					}
					if (block.name === "TaskCreate") state.pendingTaskCreates.add(id);
					if (block.name === "Bash") {
						state.backgroundShellInputs.set(id as string, {
							input: block.input,
							parentItemId,
						});
					}

					if (isAgentToolUse(block)) {
						const inputObj = (block as { input?: unknown }).input as
							| Record<string, unknown>
							| undefined;
						const subagentType =
							typeof inputObj?.subagent_type === "string"
								? (inputObj.subagent_type as string)
								: "agent";
						const requestedModel =
							typeof inputObj?.model === "string"
								? (inputObj.model as string)
								: "inherit";
						const background =
							block.name === "Workflow" ||
							inputObj?.run_in_background === true ||
							inputObj?.is_background === true;
						state.pendingAgents.set(id as string, {
							agentName: subagentType,
							model: requestedModel,
							startedAt: Date.now(),
							background,
							turnCount: 0,
						});
					}
					out.push({
						_tag: "ToolUse",
						itemId: id,
						tool: block.name,
						input: block.input,
						parentItemId,
					});
				} else if (
					block.type === "thinking" &&
					typeof (block as { thinking?: unknown }).thinking === "string"
				) {
					const text = (block as { thinking: string }).thinking;
					tlog("assistant.thinking-block", {
						textLen: text.length,
						streamed,
						preview: summarize(text),
					});
					if (!streamed) {
						out.push({
							_tag: "Thinking",
							itemId: nextItemId(),
							text,
							redacted: false,
							parentItemId,
						});
					}
				} else if (block.type === "redacted_thinking") {
					tlog("assistant.redacted-thinking-block", { streamed });
					if (!streamed) {
						out.push({
							_tag: "Thinking",
							itemId: nextItemId(),
							text: "",
							redacted: true,
							parentItemId,
						});
					}
				}
			}
		}
		tlog("assistant.blocks", { types: blockTypes, emitted: out.length });
		return out;
	}
	if (msg.type === "stream_event") {
		const ev = (msg as { event?: unknown }).event as
			| Record<string, unknown>
			| undefined;
		if (ev === undefined || typeof ev.type !== "string") {
			tlog("stream_event.malformed", { event: summarize(ev) });
			return [];
		}
		if (ev.type === "message_start") {
			state.thinkingByIndex.clear();
			const message = ev.message as Record<string, unknown> | undefined;
			state.currentMessageId =
				typeof message?.id === "string" ? message.id : null;
			if (state.currentMessageId !== null) {
				state.streamedMessageIds.add(state.currentMessageId);
			}
			tlog("stream_event.message_start");
			return [];
		}
		if (ev.type === "content_block_start") {
			const index = typeof ev.index === "number" ? ev.index : null;
			const block = ev.content_block as Record<string, unknown> | undefined;
			tlog("stream_event.content_block_start", {
				index,
				blockType: block?.type,
				block: summarize(block),
			});
			if (index === null || block === undefined) return [];
			if (block.type === "text") {
				state.thinkingByIndex.set(index, {
					kind: "text",
					itemId:
						`${state.currentMessageId ?? "message"}:text:${index}` as AgentItemId,
					text: typeof block.text === "string" ? block.text : "",
					signatureLength: 0,
					revision: 0,
					parentItemId,
				});
			} else if (block.type === "thinking") {
				state.thinkingByIndex.set(index, {
					kind: "thinking",
					itemId:
						`${state.currentMessageId ?? "message"}:thinking:${index}` as AgentItemId,
					text: "",
					signatureLength: 0,
					revision: 0,
					parentItemId,
				});
			} else if (block.type === "redacted_thinking") {
				state.thinkingByIndex.set(index, {
					kind: "redacted_thinking",
					itemId:
						`${state.currentMessageId ?? "message"}:redacted-thinking:${index}` as AgentItemId,
					text: "",
					signatureLength: 0,
					revision: 0,
					parentItemId,
				});
			}
			return [];
		}
		if (ev.type === "content_block_delta") {
			const index = typeof ev.index === "number" ? ev.index : null;
			const delta = ev.delta as Record<string, unknown> | undefined;
			if (index === null || delta === undefined) {
				tlog("stream_event.content_block_delta.malformed", {
					index,
					delta: summarize(delta),
				});
				return [];
			}
			const acc = state.thinkingByIndex.get(index);
			if (delta.type === "text_delta") {
				const chunk = typeof delta.text === "string" ? delta.text : "";
				if (acc?.kind !== "text" || chunk.length === 0) return [];
				acc.text += chunk;
				acc.revision += 1;
				return [
					{
						_tag: "AssistantMessage",
						itemId: acc.itemId,
						text: acc.text,
						parentItemId: acc.parentItemId,
						checkpoint: { revision: acc.revision, final: false },
					},
				];
			}
			if (delta.type === "thinking_delta") {
				const chunk = typeof delta.thinking === "string" ? delta.thinking : "";
				tlog("stream_event.thinking_delta", {
					index,
					chunkLen: chunk.length,
					chunkPreview: summarize(chunk, 80),
					haveAccumulator: acc !== undefined,
				});
				if (acc !== undefined && acc.kind === "thinking") {
					acc.text += chunk;
					acc.revision += 1;
					return [
						{
							_tag: "Thinking",
							itemId: acc.itemId,
							text: acc.text,
							redacted: false,
							parentItemId: acc.parentItemId,
							checkpoint: { revision: acc.revision, final: false },
						},
					];
				}
			} else if (delta.type === "signature_delta") {
				const sig = typeof delta.signature === "string" ? delta.signature : "";
				tlog("stream_event.signature_delta", { index, sigLen: sig.length });
				if (acc !== undefined) acc.signatureLength += sig.length;
			} else if (
				delta.type !== "text_delta" &&
				delta.type !== "input_json_delta"
			) {
				tlog("stream_event.other_delta", {
					index,
					deltaType: delta.type,
					delta: summarize(delta),
				});
			}
			return [];
		}
		if (ev.type === "content_block_stop") {
			const index = typeof ev.index === "number" ? ev.index : null;
			if (index === null) return [];
			const acc = state.thinkingByIndex.get(index);
			if (acc === undefined) return [];
			state.thinkingByIndex.delete(index);
			tlog("stream_event.content_block_stop[thinking]", {
				index,
				kind: acc.kind,
				textLen: acc.text.length,
				signatureLen: acc.signatureLength,
				textPreview: summarize(acc.text),
			});

			if (acc.kind === "text") {
				return acc.text.length === 0
					? []
					: [
							{
								_tag: "AssistantMessage",
								itemId: acc.itemId,
								text: acc.text,
								parentItemId: acc.parentItemId,
								checkpoint: {
									revision: acc.revision + 1,
									final: true,
								},
							},
						];
			}
			if (acc.kind === "redacted_thinking") {
				return [
					{
						_tag: "Thinking",
						itemId: acc.itemId,
						text: "",
						redacted: true,
						parentItemId: acc.parentItemId,
						checkpoint: { revision: acc.revision + 1, final: true },
					},
				];
			}
			if (acc.text.length > 0) {
				return [
					{
						_tag: "Thinking",
						itemId: acc.itemId,
						text: acc.text,
						redacted: false,
						parentItemId: acc.parentItemId,
						checkpoint: { revision: acc.revision + 1, final: true },
					},
				];
			}

			if (acc.signatureLength > 0) {
				return [
					{
						_tag: "Thinking",
						itemId: acc.itemId,
						text: "",
						redacted: false,
						parentItemId: acc.parentItemId,
						checkpoint: { revision: acc.revision + 1, final: true },
					},
				];
			}
			return [];
		}
		return [];
	}
	if (msg.type === "user") {
		const out: AgentEvent[] = [];
		const content = msg.message.content;
		if (Array.isArray(content)) {
			for (const block of content) {
				if (block.type === "tool_result") {
					const id =
						typeof (block as { tool_use_id?: unknown }).tool_use_id === "string"
							? ((block as { tool_use_id: string }).tool_use_id as AgentItemId)
							: nextItemId();

					if (state.askUserQuestionIds.has(id as string)) {
						state.askUserQuestionIds.delete(id as string);
						continue;
					}

					if (state.exitPlanModeIds.has(id as string)) {
						state.exitPlanModeIds.delete(id as string);
						if (block.is_error !== true) {
							out.push({
								_tag: "PermissionModeChanged",
								mode: "default",
							});
						}
					}
					out.push({
						_tag: "ToolResult",
						itemId: id,
						output:
							state.pendingTaskCreates.delete(id) &&
							content.filter((b) => b.type === "tool_result").length === 1 &&
							msg.tool_use_result != null &&
							block.is_error !== true
								? msg.tool_use_result
								: (block.content ?? null),
						isError: block.is_error === true,
						parentItemId,
					});
					// Was this the parent's `Agent` tool_result? Pop a closing
					// SubagentSummary that the wrapper-row footer reads when
					// collapsed. The summary's text is the sub-agent's final
					// assistant message that the SDK packs into `tool_result.content`.
					const pending = state.pendingAgents.get(id as string);
					if (
						pending !== undefined &&
						(!pending.background ||
							(state.workflowInputs.has(id) && block.is_error === true))
					) {
						state.workflowInputs.delete(id);
						state.pendingAgents.delete(id as string);
						out.push({
							_tag: "SubagentSummary",
							itemId: id,
							agentName: pending.agentName,
							model: pending.model,
							turns: pending.turnCount,
							durationMs: Date.now() - pending.startedAt,
							summary: extractTextFromContent(block.content),
							isError: block.is_error === true,
						});
					}
				}
			}
		}
		return out;
	}
	if (msg.type === "result") {
		const out: AgentEvent[] = [];

		const usage = (msg as { usage?: unknown }).usage as
			| Record<string, unknown>
			| undefined;
		const modelOnResult =
			typeof (msg as unknown as { model?: unknown }).model === "string"
				? (msg as unknown as { model: string }).model
				: "unknown";
		if (usage !== undefined) {
			const num = (key: string): number => {
				const v = usage[key];
				return typeof v === "number" ? v : 0;
			};
			const compactAfterTokens =
				state.pendingCompact !== null ? num("output_tokens") : 0;
			out.push({
				_tag: "UsageDelta",
				parentItemId,
				inputTokens: num("input_tokens"),
				outputTokens: num("output_tokens"),
				cacheReadTokens: num("cache_read_input_tokens"),
				cacheCreationTokens: num("cache_creation_input_tokens"),
				model: modelOnResult,
			});
			if (state.pendingCompact !== null && compactAfterTokens > 0) {
				state.lastContextUsedTokens = compactAfterTokens;
			}
		}
		// The session-level `result` (no parent_tool_use_id) closes the turn.
		// A sub-agent's `result` does NOT close the parent's turn — the SDK
		// continues running until the parent emits its own top-level result.
		if (parentItemId === undefined) {
			state.topLevelTurnOpen = false;
			state.streamedMessageIds.clear();
			state.pendingTaskCreates.clear();

			if (state.lastContextUsedTokens !== null) {
				out.push({
					_tag: "ContextUsage",
					providerId: "claude",
					usedTokens: state.lastContextUsedTokens,
					windowTokens: contextWindowFromModelUsage(msg, modelOnResult),
					precision: "exact",
					source: "Claude usage",
				});
			}
			if (state.pendingCompact !== null) {
				out.push(
					finishCompactEvent({
						itemId: state.pendingCompact.itemId,
						providerId: "claude",
						snapshot: state.pendingCompact,
						afterTokens: state.lastContextUsedTokens,
					}),
				);
				state.pendingCompact = null;
			}
			// The user interrupted this turn. The SDK ends it with an
			// `error_during_execution` result, but that's a normal user action — emit
			// a muted `Interrupted` badge + non-error completion instead of an Error
			// bubble, and skip the failed-result handling below.
			if (state.interrupted) {
				out.push({ _tag: "Interrupted" });
				state.interrupted = false;
				state.emittedAuthError = false;
				return out;
			}

			const resultError = claudeResultErrorText(msg);
			if (resultError !== null && !state.emittedAuthError) {
				out.push({ _tag: "Error", message: resultError });
			}
			out.push(
				resultError === null
					? { _tag: "Completed", reason: "ended" }
					: { _tag: "Completed", reason: "error" },
			);

			state.emittedAuthError = false;
		}
		return out;
	}
	if (msg.type === "system" && msg.subtype === "task_started") {
		if (msg.task_type === "local_bash") {
			const itemId = `background_task_${msg.task_id}` as AgentItemId;
			state.localBackgroundTasks.set(msg.task_id, itemId);
			const shell =
				msg.tool_use_id === undefined
					? undefined
					: state.backgroundShellInputs.get(msg.tool_use_id);
			const originalInput = shell?.input;
			if (msg.tool_use_id !== undefined) {
				state.backgroundShellInputs.delete(msg.tool_use_id);
			}
			const input =
				originalInput !== null && typeof originalInput === "object"
					? {
							...(originalInput as Record<string, unknown>),
							description: msg.description,
							task_id: msg.task_id,
						}
					: {
							description: msg.description,
							task_id: msg.task_id,
						};
			return [
				{
					_tag: "ToolUse",
					itemId,
					tool: "Bash",
					input,
					backgroundTask: { taskId: msg.task_id },

					...(shell?.parentItemId === undefined
						? {}
						: { parentItemId: shell.parentItemId }),
				},
			];
		}
		if (msg.skip_transcript === true) return [];
		const itemId = (msg.tool_use_id ?? `task_${msg.task_id}`) as AgentItemId;
		const workflow =
			msg.task_type === "local_workflow" || state.workflowInputs.has(itemId);
		const workflowInput = state.workflowInputs.get(itemId);
		const existing = state.pendingAgents.get(itemId as string);
		state.backgroundTaskParents.set(msg.task_id, itemId);
		state.pendingAgents.set(itemId as string, {
			agentName:
				msg.workflow_name ?? msg.task_type ?? existing?.agentName ?? "agent",
			model: existing?.model ?? "inherit",
			startedAt: existing?.startedAt ?? Date.now(),
			background: true,
			turnCount: existing?.turnCount ?? 0,
		});
		const input = {
			...(workflowInput !== null && typeof workflowInput === "object"
				? workflowInput
				: {}),
			...(workflow
				? { workflow_name: msg.workflow_name, task_type: msg.task_type }
				: {}),
			description: msg.description,
			prompt: msg.prompt ?? msg.description,
			subagent_type: msg.task_type ?? "agent",
			run_in_background: true,
			task_id: msg.task_id,
		};
		if (workflow) {
			state.workflowRuns.set(itemId, {
				input,
				taskId: msg.task_id,
				progress: "",
			});
		}
		return [
			{
				_tag: "ToolUse",
				itemId,
				tool: workflow ? "Workflow" : "Agent",
				input,
				subagent: {
					childSessionId: msg.task_id,
					presentation: "detached",
				},
			},
		];
	}
	if (msg.type === "system" && msg.subtype === "task_progress") {
		if (state.localBackgroundTasks.has(msg.task_id)) return [];
		const itemId =
			(msg.tool_use_id as AgentItemId | undefined) ??
			state.backgroundTaskParents.get(msg.task_id);
		if (itemId === undefined) return [];
		const pending = state.pendingAgents.get(itemId as string);
		if (pending !== undefined) pending.turnCount += 1;
		const run = state.workflowRuns.get(itemId);
		const progress =
			run === undefined
				? null
				: claudeWorkflowProgress(
						(msg as { workflow_progress?: unknown }).workflow_progress,
					);
		if (run !== undefined && progress !== null) {
			// Workflow agents run inside the CLI and never stream their own
			// messages; re-issuing the launch with the latest snapshot updates the
			// one workflow row in place.
			const serialized = JSON.stringify(progress);
			if (serialized === run.progress) return [];
			run.progress = serialized;
			return [
				{
					_tag: "ToolUse",
					itemId,
					tool: "Workflow",
					input: { ...run.input, [WORKFLOW_PROGRESS_KEY]: progress },
					subagent: { childSessionId: run.taskId, presentation: "detached" },
				},
			];
		}
		// Progress descriptions narrate tool calls the child already streams;
		// as transcript text they would duplicate every call and split its tree.
		return [];
	}
	if (msg.type === "system" && msg.subtype === "task_notification") {
		const backgroundTaskItemId = state.localBackgroundTasks.get(msg.task_id);
		if (backgroundTaskItemId !== undefined) {
			return [
				{
					_tag: "ToolResult",
					itemId: backgroundTaskItemId,
					output: msg.summary,
					isError: msg.status !== "completed",
					// Older CLIs may report statuses outside the typed union.
					backgroundOutcome:
						msg.status === "completed" || msg.status === "stopped"
							? msg.status
							: "failed",
				},
			];
		}
		if (msg.skip_transcript === true) return [];
		const itemId =
			(msg.tool_use_id as AgentItemId | undefined) ??
			state.backgroundTaskParents.get(msg.task_id) ??
			(`task_${msg.task_id}` as AgentItemId);
		const pending = state.pendingAgents.get(itemId as string);
		if (pending === undefined) return [];
		const summary = msg.summary.trim();
		const out: AgentEvent[] = [];
		if (summary.length > 0) {
			out.push({
				_tag: "AssistantMessage",
				itemId: nextItemId(),
				text: summary,
				parentItemId: itemId,
			});
		}
		out.push({
			_tag: "SubagentSummary",
			itemId,
			agentName: pending?.agentName ?? "agent",
			model: pending?.model ?? "inherit",
			turns: pending?.turnCount ?? 0,
			durationMs:
				msg.usage?.duration_ms ??
				(pending === undefined ? 0 : Date.now() - pending.startedAt),
			summary,
			isError: msg.status !== "completed",
			childSessionId: msg.task_id,
			presentation: "detached",
		});
		state.pendingAgents.delete(itemId as string);
		state.workflowInputs.delete(itemId);
		state.workflowRuns.delete(itemId);
		state.backgroundTaskParents.delete(msg.task_id);
		return out;
	}
	if ((msg as { type?: unknown }).type === "rate_limit_event") {
		const info = (msg as { rate_limit_info?: ClaudeRateLimitInfo })
			.rate_limit_info;
		return info === undefined ? [] : claudeRateLimitEvents(info);
	}
	return [];
};

/**
 * Translates a recorded SDK message sequence. Recorded transcripts are read
 * as one turn unless `liveTurns` asks for the live session's turn tracking.
 */
export const translateClaudeSdkMessages = (
	messages: ReadonlyArray<SDKMessage>,
	options: { readonly liveTurns?: boolean } = {},
): ReadonlyArray<AgentEvent> => {
	const state = newTranslateState({
		topLevelTurnOpen: options.liveTurns !== true,
	});
	return messages.flatMap((message) => translate(message, state));
};

const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
	"Read",
	"LS",
	"Glob",
	"Grep",
	"NotebookRead",
	"BashOutput",
	"TodoWrite",
	"TaskCreate",
	"TaskUpdate",
	"TaskGet",
	"TaskList",
	ASK_USER_QUESTION_FQN,

	`mcp__${ZUSE_MCP_NAME}__browser_navigate`,
	`mcp__${ZUSE_MCP_NAME}__browser_screenshot`,
	`mcp__${ZUSE_MCP_NAME}__browser_snapshot`,
	`mcp__${ZUSE_MCP_NAME}__browser_wait`,

	`mcp__${ZUSE_MCP_NAME}__browser_scroll`,
	`mcp__${ZUSE_MCP_NAME}__browser_hover`,
	`mcp__${ZUSE_MCP_NAME}__browser_read`,
	`mcp__${ZUSE_MCP_NAME}__browser_console`,
	`mcp__${ZUSE_MCP_NAME}__browser_network`,
	`mcp__${ZUSE_MCP_NAME}__browser_history`,
	`mcp__${ZUSE_MCP_NAME}__browser_status`,
	`mcp__${ZUSE_MCP_NAME}__browser_resize`,
	`mcp__${ZUSE_MCP_NAME}__browser_wait_for`,
	`mcp__${ZUSE_MCP_NAME}__browser_inspect`,
	...Array.from(
		READ_ONLY_ORCHESTRATION_TOOLS,
		(name) => `mcp__${ZUSE_MCP_NAME}__${name}`,
	),
]);

type ToolPolicy =
	| { readonly kind: "auto-allow" }
	| { readonly kind: "prompt"; readonly forcePrompt: boolean };

const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set([
	"Edit",
	"Write",
	"MultiEdit",
	"NotebookEdit",
]);

const editPathOf = (toolInput: Record<string, unknown>): string =>
	typeof toolInput.file_path === "string"
		? toolInput.file_path
		: typeof toolInput.notebook_path === "string"
			? (toolInput.notebook_path as string)
			: "";

const SDK_BUILTIN_ASK_USER_QUESTION = "AskUserQuestion";

const isAskUserQuestion = (toolName: string): boolean =>
	toolName === ASK_USER_QUESTION_FQN ||
	toolName === ASK_USER_QUESTION_TOOL ||
	toolName === SDK_BUILTIN_ASK_USER_QUESTION ||
	toolName.endsWith(`__${ASK_USER_QUESTION_TOOL}`);

/**
 * Reduce native `AskUserQuestion` input to the composer question card.
 * Returns null when the input has no usable question, so the tool is denied
 * and the model can retry with valid input.
 */
export const claudeNativeUserQuestions = (
	toolInput: Record<string, unknown>,
): ReadonlyArray<UserQuestion> | null => {
	const raw = toolInput.questions;
	if (!Array.isArray(raw) || raw.length === 0) return null;
	const questions: UserQuestion[] = [];
	for (const value of raw) {
		if (value === null || typeof value !== "object") return null;
		const record = value as Record<string, unknown>;
		if (
			typeof record.question !== "string" ||
			record.question.trim().length === 0 ||
			!Array.isArray(record.options)
		)
			return null;
		const options = record.options.flatMap((option: unknown) => {
			const label =
				option !== null && typeof option === "object"
					? (option as { label?: unknown }).label
					: option;
			return typeof label === "string" && label.length > 0 ? [label] : [];
		});
		questions.push({
			question: record.question,
			options,
			...(record.multiSelect === true ? { multiSelect: true } : {}),
		});
	}
	return questions;
};

/**
 * Map composer answers onto the native tool's `answers`, keyed by the exact
 * question text. Picked labels are comma-separated; free text either is the
 * answer or, alongside picks, travels as the question's notes.
 */
export const claudeNativeQuestionAnswers = (
	questions: ReadonlyArray<UserQuestion>,
	answers: ReadonlyArray<UserQuestionAnswer>,
): {
	readonly answers: Record<string, string>;
	readonly annotations?: Record<string, { readonly notes: string }>;
} => {
	const byQuestion: Record<string, string> = {};
	const notes: Record<string, { readonly notes: string }> = {};
	for (const answer of answers) {
		const question = questions[answer.questionIndex];
		if (question === undefined) continue;
		const labels = answer.selected.flatMap((index) => {
			const label = question.options[index];
			return label === undefined ? [] : [label];
		});
		const other = answer.other?.trim() ?? "";
		if (labels.length === 0) {
			byQuestion[question.question] = other;
			continue;
		}
		byQuestion[question.question] = labels.join(", ");
		if (other.length > 0) notes[question.question] = { notes: other };
	}
	return Object.keys(notes).length > 0
		? { answers: byQuestion, annotations: notes }
		: { answers: byQuestion };
};

type ClaudeQuestionResolver = (
	answers: ReadonlyArray<UserQuestionAnswer> | null,
) => void;

/**
 * Surface a native `AskUserQuestion` as the composer question and wait for
 * the user. The SDK aborts `signal` when the turn is interrupted, which
 * releases the card instead of leaving it to outlive its callback.
 */
export const awaitClaudeUserQuestion = (input: {
	readonly pending: ReturnType<
		typeof makeBoundedQuestionCallbackRegistry<ClaudeQuestionResolver>
	>;
	readonly emit: (event: ProviderDriverEvent) => void;
	readonly itemId: AgentItemId;
	readonly questions: ReadonlyArray<UserQuestion>;
	readonly parentItemId: AgentItemId | undefined;
	readonly signal: AbortSignal;
}): Promise<ReadonlyArray<UserQuestionAnswer> | null> =>
	new Promise((resolve) => {
		const { pending, emit, itemId, signal } = input;
		if (signal.aborted) {
			resolve(null);
			return;
		}
		const onAbort = () => {
			if (!pending.delete(itemId)) return;
			resolve(null);
			emit({ _tag: "QuestionCallbackReleased", itemId, reason: "cancelled" });
		};
		const settle: ClaudeQuestionResolver = (answers) => {
			signal.removeEventListener("abort", onAbort);
			resolve(answers);
		};
		if (pending.register(itemId, settle) !== "accepted") {
			resolve(null);
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		emit({
			_tag: "UserQuestion",
			itemId,
			questions: input.questions,
			parentItemId: input.parentItemId,
		});
	});

export const claudeToolPermissionPolicy = (
	toolName: string,
	toolInput: Record<string, unknown>,
	runtimeMode: RuntimeMode,
): ToolPolicy => {
	if (toolName === "ExitPlanMode") {
		return { kind: "prompt", forcePrompt: true };
	}

	if (isAskUserQuestion(toolName)) {
		return { kind: "auto-allow" };
	}

	if (
		toolName.endsWith("__browser_login") ||
		toolName.endsWith("__browser_evaluate")
	) {
		return { kind: "prompt", forcePrompt: true };
	}
	const path =
		toolName === "Read"
			? typeof toolInput.file_path === "string"
				? toolInput.file_path
				: ""
			: FILE_EDIT_TOOLS.has(toolName)
				? editPathOf(toolInput)
				: "";
	const sensitive = path.length > 0 && isSensitivePath(path);
	const category = READ_ONLY_TOOLS.has(toolName)
		? "read"
		: FILE_EDIT_TOOLS.has(toolName)
			? "edit"
			: toolName === "Bash"
				? "execute"
				: "other";
	return decidePermission({
		runtimeMode,
		permissionMode: "default",
		category,
		sensitive,
	}) === "allow"
		? { kind: "auto-allow" }
		: { kind: "prompt", forcePrompt: sensitive };
};

/**
 * Tools a `read-only` session never sees. Hiding them, rather than denying
 * each call, keeps the model from spending turns retrying a write.
 */
export const CLAUDE_READ_ONLY_DISALLOWED_TOOLS: ReadonlyArray<string> = [
	"Bash",
	"BashOutput",
	"KillShell",
	"Edit",
	"MultiEdit",
	"Write",
	"NotebookEdit",
	"WebFetch",
	"WebSearch",
	"Agent",
	"Task",
	"TodoWrite",
	"TaskCreate",
	"TaskUpdate",
	"ExitPlanMode",
	"AskUserQuestion",
];

/**
 * A `read-only` session decides on its own and never prompts: nobody is
 * watching it. Plain reads outside sensitive paths and the session's own
 * Zuse tools are allowed; everything else is denied.
 */
export const claudeReadOnlyToolAllowed = (
	toolName: string,
	toolInput: Record<string, unknown>,
	sessionToolNames: ReadonlySet<string>,
): boolean => {
	if (sessionToolNames.has(toolName)) return true;
	if (!READ_ONLY_TOOLS.has(toolName) || toolName.startsWith("mcp__"))
		return false;
	if (CLAUDE_READ_ONLY_DISALLOWED_TOOLS.includes(toolName)) return false;
	const path =
		typeof toolInput.file_path === "string"
			? toolInput.file_path
			: typeof toolInput.path === "string"
				? toolInput.path
				: "";
	return path.length === 0 || !isSensitivePath(path);
};

const kindForTool = (
	toolName: string,
	toolInput: Record<string, unknown>,
): PermissionKind => {
	switch (toolName) {
		case "Bash": {
			const command =
				typeof toolInput.command === "string"
					? toolInput.command
					: JSON.stringify(toolInput);
			return { _tag: "Bash", command };
		}
		case "Edit":
		case "Write":
		case "MultiEdit":
		case "NotebookEdit": {
			const path =
				typeof toolInput.file_path === "string"
					? toolInput.file_path
					: typeof toolInput.notebook_path === "string"
						? (toolInput.notebook_path as string)
						: "(unknown)";
			return { _tag: "FileWrite", path };
		}
		case "WebFetch":
		case "WebSearch": {
			const url =
				typeof toolInput.url === "string"
					? toolInput.url
					: typeof toolInput.query === "string"
						? `search:${toolInput.query as string}`
						: "(unknown)";
			return { _tag: "Network", url };
		}
		default: {
			const summary = JSON.stringify(toolInput).slice(0, 120);
			return { _tag: "Other", tool: toolName, summary };
		}
	}
};

/**
 * Hook the driver passes into the SDK's `canUseTool`. Returning a
 * `PermissionDecision` lets the orchestrator (`ProviderService`) plug
 * `PermissionService.request` in directly without the driver reaching
 * across modules. `forcePrompt` flows through to the broker so sensitive
 * paths can't be silenced by prior `AllowForSession` / `AlwaysAllow` rows.
 */
export type RequestPermission = (
	sessionId: AgentSessionId,
	kind: PermissionKind,
	options: { readonly forcePrompt: boolean },
) => Promise<PermissionDecision>;

type ClaudeSdkEffort = "low" | "medium" | "high" | "xhigh" | "max";
type EffortAndSettings = {
	effort?: ClaudeSdkEffort;
	settings?: Record<string, unknown>;
};
const effortAndSettings = (
	modelOptions: Readonly<Record<string, string>> | undefined,
): EffortAndSettings => {
	const raw =
		modelOptions?.["effort"] ?? modelOptions?.["reasoning"] ?? undefined;
	const ultracode = raw === "ultracode";
	const ultrathink = raw === "ultrathink";
	const sdkEffort: ClaudeSdkEffort | undefined = (() => {
		if (ultrathink) return undefined;
		if (ultracode) return "xhigh";
		if (
			raw === "low" ||
			raw === "medium" ||
			raw === "high" ||
			raw === "xhigh" ||
			raw === "max"
		) {
			return raw;
		}
		return "high";
	})();

	const settings: Record<string, unknown> = {};
	if (ultracode) settings["ultracode"] = true;
	if (modelOptions?.["fastMode"] === "true") settings["fastMode"] = true;
	if (modelOptions?.["thinking"] === "true") {
		settings["alwaysThinkingEnabled"] = true;
	} else if (modelOptions?.["thinking"] === "false") {
		settings["alwaysThinkingEnabled"] = false;
	}

	return {
		...(sdkEffort !== undefined ? { effort: sdkEffort } : {}),
		...(Object.keys(settings).length > 0 ? { settings } : {}),
	};
};

/**
 * If the user's effort selection is `ultrathink`, prepend the literal word
 * to the prompt and unset the SDK effort knob. Driver hooks call this before
 * forwarding the user's text to the SDK.
 */
export const applyUltrathinkPrefix = (
	modelOptions: Readonly<Record<string, string>> | undefined,
	text: string,
): string => {
	const raw =
		modelOptions?.["effort"] ?? modelOptions?.["reasoning"] ?? undefined;
	return raw === "ultrathink" ? `ultrathink\n\n${text}` : text;
};

/**
 * Spin up a streaming-input Claude conversation. The SDK is driven by an
 * AsyncIterable we push into from `send()`; the SDK's outbound async generator
 * is consumed by a forked daemon that translates messages into wire events
 * and offers them to the per-session mailbox.
 *
 * `apiKey` is the keychain-stored API key, if any. When non-null we set
 * `ANTHROPIC_API_KEY` on the spawned `claude` subprocess. When null we omit
 * the SDK's `env` option entirely so `process.env` is inherited — that lets
 * the spawned `claude` CLI find its own OAuth credentials (macOS keychain
 * entry "Claude Code-credentials" or `~/.claude/.credentials.json`). This
 * is the primary auth path; API keys are a fallback.
 *
 * `requestPermission` is the bridge to `PermissionService`. It returns a
 * decision the caller honors via the SDK's allow/deny contract; the driver
 * itself stays free of any DB or PubSub wiring.
 */
/**
 * Live read of the per-session runtime mode. Called inside `canUseTool` so
 * the user toggling the chat header takes effect on the next tool call —
 * no SDK restart needed.
 */
export type GetRuntimeMode = () => RuntimeMode;

export interface ClaudeManagedCredential {
	readonly kind: "api-key" | "oauth-token";
	readonly secret: string;
}

export const applyClaudeCredentialEnv = (
	base: NodeJS.ProcessEnv,
	credential: ClaudeManagedCredential | null,
): NodeJS.ProcessEnv => {
	const env = { ...base };
	if (credential === null) return env;
	delete env.ANTHROPIC_API_KEY;
	delete env.CLAUDE_CODE_OAUTH_TOKEN;
	if (credential.kind === "api-key") {
		env.ANTHROPIC_API_KEY = credential.secret;
	} else {
		env.CLAUDE_CODE_OAUTH_TOKEN = credential.secret;
	}
	return env;
};

export const startClaudeSession = (
	input: StartSessionInput,
	cwd: string,
	credential: ClaudeManagedCredential | string | null,
	claudeExecutablePath: string | null,
	sessionId: AgentSessionId,
	requestPermission: RequestPermission,
	getRuntimeMode: GetRuntimeMode,
	resumeCursor: string | null = null,
	browserSend: BrowserSend,
	sessionTools: SessionTools | null = null,

	skillAllowlist: ReadonlyArray<string> | undefined = undefined,
	resumeHead: string | null = null,
): Effect.Effect<
	ClaudeSessionHandle,
	AgentSessionStartError,
	AttachmentService
> =>
	withProviderStartup(function* (startup) {
		const attachments = yield* AttachmentService;
		const events = yield* Queue.make<ProviderDriverEvent, Cause.Done>();
		const inputChannel = new UserInputChannel();
		const abort = new AbortController();
		const processes = makeClaudeProcessOwner();
		startup.add(processes.close);
		startup.add(() => {
			inputChannel.close();
			abort.abort();
			Queue.endUnsafe(events);
		});

		const buildAttachmentBlocks = (
			refs: ReadonlyArray<AttachmentRef>,
		): Promise<ReadonlyArray<UserContentBlock>> =>
			Promise.all(
				refs.map(async (ref): Promise<UserContentBlock | null> => {
					if (ref.id.startsWith("pending-")) {
						console.warn(
							`[claude.attach] skipping pending attachment id=${ref.id} (upload didn't finish before send)`,
						);
						return null;
					}
					// Browsers report "image/jpg" sometimes — Anthropic only accepts
					// the canonical "image/jpeg" name.
					const normalizedMime =
						ref.mimeType.toLowerCase() === "image/jpg"
							? "image/jpeg"
							: ref.mimeType.toLowerCase();
					const isImage = SUPPORTED_IMAGE_MIME.has(normalizedMime);
					const isPdf = normalizedMime === "application/pdf";
					if (!isImage && !isPdf) {
						console.warn(
							`[claude.attach] dropping unsupported mime id=${ref.id} mime=${ref.mimeType}`,
						);
						return null;
					}
					const blob = await Effect.runPromise(attachments.read(ref.id));
					if (blob === null) {
						console.warn(
							`[claude.attach] blob not found id=${ref.id} (db row missing or file deleted)`,
						);
						return null;
					}
					const base64 = Buffer.from(blob.bytes).toString("base64");
					console.log(
						`[claude.attach] built ${
							isPdf ? "document" : "image"
						} block id=${ref.id} mime=${normalizedMime} bytes=${blob.bytes.byteLength} base64Len=${base64.length}`,
					);
					if (isPdf) {
						return {
							type: "document",
							source: {
								type: "base64",
								media_type: "application/pdf",
								data: base64,
							},
							title: ref.originalName,
						};
					}
					return {
						type: "image",
						source: {
							type: "base64",
							media_type: normalizedMime as AnthropicImageMediaType,
							data: base64,
						},
					};
				}),
			).then((blocks) =>
				blocks.filter((b): b is NonNullable<typeof b> => b !== null),
			);

		if (input.initialPrompt !== undefined && input.initialPrompt.length > 0) {
			inputChannel.push(makeClaudeUserMessage(input.initialPrompt));
		}

		// Pass `process.env` through, but scrub any "we are inside another
		// Claude Code session" markers that Claude Code injects into its child
		// shells. When memoize is launched from a Claude Code terminal (very
		// common during dev), the shell inherits CLAUDECODE=1,
		// CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_EXECPATH, and friends — which
		// confuses the spawned `claude` binary's auth resolver into thinking
		// it's a nested SDK call from a different Claude installation, and the
		// `EXECPATH` even redirects to a sibling app's bundled binary with its
		// own auth state. The result is "Invalid API key · Fix external API
		// key" even with a perfectly valid `claude /login`.
		//
		// The SDK adds back its own `CLAUDE_CODE_ENTRYPOINT="sdk-ts"` for
		// telemetry purposes (we read it back in error messages); that's fine
		// because it lets the binary know IT is the SDK process, not its parent.
		//
		// `pathToClaudeCodeExecutable` points at the user's globally-installed
		// `claude`. Without it, the SDK falls back to its bundled native CLI —
		// shipped as an optional native dep that doesn't always install (yields
		// "Native CLI binary for darwin-arm64 not found").
		// Shared driver-side state. Lives outside `options` so the pump (which
		// calls `translate`) and the `canUseTool` callback see the same map of
		// pending Agent invocations and the same `latestParentItemId`. Built
		// here, populated by `translate`, read by `canUseTool`.
		const translateState = newTranslateState({
			topLevelTurnOpen:
				input.initialPrompt !== undefined && input.initialPrompt.length > 0,
		});
		const emit = (event: AgentEvent): void => {
			Queue.offerUnsafe(events, event);
		};
		const checkpointBatcher = new ProviderCheckpointBatcher({ emit });

		const pendingQuestions =
			makeBoundedQuestionCallbackRegistry<ClaudeQuestionResolver>();
		const releasePendingQuestions = (
			reason: QuestionCallbackReleased["reason"],
		): void => {
			for (const [itemId, resolve] of pendingQuestions.drain()) {
				resolve(null);
				Queue.offerUnsafe(events, {
					_tag: "QuestionCallbackReleased",
					itemId: itemId as AgentItemId,
					reason,
				});
			}
		};
		startup.add(() => releasePendingQuestions("closed"));
		let currentPermissionMode = input.permissionMode ?? "default";

		const mcpGatewaySession = yield* issueProviderMcpSession(startup, {
			providerId: "claude",
			sessionId,
			cwd,
			browserSend,
			requestPermission: (kind, options) =>
				requestPermission(sessionId, kind, options),
			getRuntimeMode,
			getPermissionMode: () => currentPermissionMode,
			sessionTools,
			toolPolicy: input.toolPolicy,
		});

		const managedCredential =
			typeof credential === "string"
				? ({ kind: "api-key", secret: credential } as const)
				: credential;
		const credentialEnv = applyClaudeCredentialEnv(
			applyClaudeWorktreeEnv(
				scrubInheritedClaudeMarkers({
					...process.env,
					...input.executionEnv,
					...pluginCliEnv(mcpGatewaySession.endpoint, mcpGatewaySession.token),

					ENABLE_CLAUDEAI_MCP_SERVERS: "false",
				}),
				cwd,
			),
			managedCredential,
		);
		const env = input.providerAccountHome
			? isolatedProviderAccountEnv(
					"claude",
					input.providerAccountHome,
					credentialEnv,
				)
			: credentialEnv;

		const agentsMap = input.agents ?? {};
		const subagentsEffective =
			(input.enableSubagents ?? Object.keys(agentsMap).length > 0) &&
			Object.keys(agentsMap).length > 0;
		// `allowedTools` is a strict allow-list when set: anything not listed
		// gets disallowed. So when sub-agents are on we must also list our
		// gateway server (allowing the whole server keeps the list stable as
		// its tool set changes).
		const subagentOptions = subagentsEffective
			? ({
					agents: agentsMap,
					allowedTools: ["Agent", `mcp__${ZUSE_MCP_NAME}`],
				} as Pick<Options, "agents" | "allowedTools">)
			: {};
		// Claude's native `AskUserQuestion` always reaches `canUseTool` (it
		// requires user interaction in every permission mode), where it is
		// answered from the composer question card. Keeping it native avoids
		// MCP tool-call timeouts while the user is deciding.
		const readOnly = input.toolPolicy === "read-only";
		const disallowedTools: ReadonlyArray<string> = [];
		const sessionToolNames: ReadonlySet<string> = new Set(
			(sessionTools?.toolsets ?? []).flatMap((toolset) =>
				toolset.definitions.map(
					(definition) => `mcp__${ZUSE_MCP_NAME}__${definition.name}`,
				),
			),
		);
		const initialSdkPermissionMode = runtimeModeToSdkPermissionMode(
			getRuntimeMode(),
			currentPermissionMode,
		);
		const options: Options = {
			spawnClaudeCodeProcess: processes.spawn,
			cwd,
			systemPrompt: {
				type: "preset",
				preset: "claude_code",
				append: input.workspaceInstructions,
			},
			abortController: abort,
			...(claudeExecutablePath !== null
				? { pathToClaudeCodeExecutable: claudeExecutablePath }
				: {}),
			...(input.model !== undefined ? { model: input.model } : {}),
			...(skillAllowlist !== undefined ? { skills: [...skillAllowlist] } : {}),
			...subagentOptions,
			disallowedTools: [
				...(subagentOptions.allowedTools === undefined
					? disallowedTools
					: disallowedTools.filter(
							(t) => !subagentOptions.allowedTools?.includes(t),
						)),
				...(readOnly ? CLAUDE_READ_ONLY_DISALLOWED_TOOLS : []),
			],

			strictMcpConfig: true,
			mcpServers: {
				[ZUSE_MCP_NAME]: {
					type: "http",
					url: mcpGatewaySession.endpoint,
					headers: {
						Authorization: `Bearer ${mcpGatewaySession.token}`,
					},
					alwaysLoad: !(input.toolSearch ?? false),
				},
			},
			permissionMode: initialSdkPermissionMode,
			...(initialSdkPermissionMode === "bypassPermissions"
				? { allowDangerouslySkipPermissions: true }
				: {}),
			// Reasoning effort: mapped from FE picker via `input.modelOptions
			// .effort` (or legacy `reasoning`). The per-model descriptor in
			// the resolved model catalog declares which tiers each model
			// exposes. Special values:
			//   - `ultracode`  → SDK `effort: "xhigh"` + `settings.ultracode: true`
			//   - `ultrathink` → prompt-injected at `send()` time; SDK `effort`
			//                    stays unset.
			// Falls back to "high" when omitted.
			//
			// Do not force `display: "summarized"` here. The SDK translates it to
			// `--thinking-display`, but still-supported Claude Code installations
			// (including the npm Windows CLI) do not recognize that flag and exit
			// before the first turn. Adaptive thinking itself is supported and its
			// provider default remains preferable to making the session unusable.
			...effortAndSettings(input.modelOptions),
			thinking: { type: "adaptive" },
			forwardSubagentText: true,

			includePartialMessages: true,
			env: (readOnly || input.outputOnly
				? env
				: withClaudeTaskTracking(env)) as Options["env"],

			canUseTool: async (toolName, toolInput, { signal }) => {
				if (input.outputOnly)
					return {
						behavior: "deny",
						message: "Tools are disabled for this auxiliary turn.",
					};
				if (readOnly) {
					return claudeReadOnlyToolAllowed(
						toolName,
						toolInput,
						sessionToolNames,
					)
						? { behavior: "allow", updatedInput: toolInput }
						: {
								behavior: "deny",
								message: "This session can only read the workspace.",
							};
				}
				if (toolName === SDK_BUILTIN_ASK_USER_QUESTION) {
					const questions = claudeNativeUserQuestions(toolInput);
					if (questions === null) {
						return {
							behavior: "deny",
							message:
								"AskUserQuestion needs at least one question with question text and options.",
						};
					}
					const answers = await awaitClaudeUserQuestion({
						pending: pendingQuestions,
						emit: (event) => Queue.offerUnsafe(events, event),
						itemId: nextItemId(),
						questions,
						parentItemId: translateState.latestParentItemId,
						signal,
					});
					if (answers === null) {
						return {
							behavior: "deny",
							message: "The user dismissed the question without answering.",
						};
					}
					return {
						behavior: "allow",
						updatedInput: {
							...toolInput,
							...claudeNativeQuestionAnswers(questions, answers),
						},
					};
				}
				const policy = claudeToolPermissionPolicy(
					toolName,
					toolInput,
					getRuntimeMode(),
				);
				// One-line debug so if the auto-allow ever misses (e.g. SDK
				// changes the MCP-tool naming convention) we can see the
				// exact toolName arriving and patch `isAskUserQuestion`.
				// eslint-disable-next-line no-console
				console.log(
					`[claude.canUseTool] tool=${toolName} policy=${policy.kind}`,
				);
				if (policy.kind === "auto-allow") {
					return { behavior: "allow", updatedInput: toolInput };
				}
				const kind = kindForTool(toolName, toolInput);
				Queue.offerUnsafe(events, {
					_tag: "PermissionRequest",
					itemId: nextItemId(),
					kind: toolName,
					details: toolInput,
					// Best-effort attribution. SDK's `canUseTool` callback doesn't
					// include `parent_tool_use_id`, so we tag with the most recent
					// value seen on an SDK message. Sub-agents currently run
					// serially in the SDK; if that changes, this attribution races.
					parentItemId: translateState.latestParentItemId,
				});
				const decision = await requestPermission(sessionId, kind, {
					forcePrompt: policy.forcePrompt,
				});
				if (decision._tag === "Deny") {
					return {
						behavior: "deny",
						message: "User denied this tool call.",
					};
				}

				return { behavior: "allow", updatedInput: toolInput };
			},
		};

		Queue.offerUnsafe(events, {
			_tag: "Started",
			sessionId,
			providerId: "claude",
			mode: "sdk",
		});

		const resumeOptions = yield* Effect.try({
			try: () =>
				claudeResumeOptions(
					resumeCursor,
					input.forkFromResume === true,
					resumeHead,
				),
			catch: (cause) =>
				new AgentSessionStartError({
					providerId: "claude",
					reason:
						cause instanceof Error
							? cause.message
							: "Invalid native fork boundary",
				}),
		});
		Object.assign(options, resumeOptions);

		if (input.outputOnly) {
			options.tools = [];
			options.allowedTools = [];
			options.agents = {};
			options.mcpServers = {};
			options.settingSources = [];
			options.settings = { disableAllHooks: true };
			options.maxTurns = 1;
			options.persistSession = false;
			options.systemPrompt =
				input.workspaceInstructions ?? "Return only the requested text.";
		}

		let q: Query;
		try {
			q = query({ prompt: inputChannel, options });
		} catch (cause) {
			void mcpGatewaySession.close();
			yield* Queue.end(events);
			return yield* Effect.fail(
				new AgentSessionStartError({
					providerId: "claude",
					reason: cause instanceof Error ? cause.message : String(cause),
				}),
			);
		}

		let cursorAnnounced = false;
		const pump = Effect.tryPromise({
			try: async () => {
				for await (const msg of q) {
					if (!cursorAnnounced) {
						const sid = (msg as { session_id?: unknown }).session_id;
						if (typeof sid === "string" && sid.length > 0) {
							cursorAnnounced = true;
							Queue.offerUnsafe(events, {
								_tag: "SessionCursor",
								cursor: sid,
								strategy: "claude-session-id",
							});
						}
					}
					const translated = translate(msg, translateState);
					for (const ev of translated) {
						checkpointBatcher.offer(ev);
					}
					const point = claudeForkPoint(msg);
					if (point !== null && typeof msg.session_id === "string")
						checkpointBatcher.offer({
							_tag: "SessionCursor",
							cursor: msg.session_id,
							strategy: "claude-session-id",
							providerEventCursor: point,
						});
				}
			},
			catch: (cause) => cause,
		}).pipe(
			Effect.catch((cause) =>
				Effect.sync(() => {
					if (translateState.interrupted) {
						translateState.interrupted = false;
						Queue.offerUnsafe(events, { _tag: "Interrupted" });
						return;
					}
					Queue.offerUnsafe(events, {
						_tag: "Error",
						message: cause instanceof Error ? cause.message : String(cause),
					});
				}),
			),
			Effect.ensuring(
				Effect.sync(() => {
					checkpointBatcher.flush();
					releasePendingQuestions("transport_lost");
					void mcpGatewaySession.close();
					Queue.endUnsafe(events);
				}),
			),
		);

		yield* Effect.forkDetach(pump);

		const handle: ClaudeSessionHandle = {
			events: Stream.fromQueue(events),
			send: (text, attachmentRefs) =>
				Effect.promise(async () => {
					const compactCommand = isCompactCommand(text);
					if (compactCommand) {
						translateState.pendingCompact = startCompactSnapshot(
							translateState.lastContextUsedTokens,
						);
						Queue.offerUnsafe(
							events,
							startCompactEvent({
								providerId: "claude",
								snapshot: translateState.pendingCompact,
							}),
						);
					}

					const promptText = compactCommand
						? text.trim()
						: applyUltrathinkPrefix(input.modelOptions, text);
					console.log(
						`[claude.send] sessionId=${sessionId} textLen=${promptText.length} attachments=${attachmentRefs?.length ?? 0}`,
					);
					const attachmentBlocks =
						attachmentRefs !== undefined && attachmentRefs.length > 0
							? await buildAttachmentBlocks(attachmentRefs)
							: [];
					console.log(
						`[claude.send] pushing user message: attachmentBlocks=${attachmentBlocks.length} content=${JSON.stringify(
							[
								...attachmentBlocks.map((b) =>
									b.type === "text"
										? { type: "text", textLen: b.text.length }
										: {
												type: b.type,
												media_type: b.source.media_type,
												base64Len: b.source.data.length,
											},
								),
								{ type: "text", textLen: promptText.length },
							],
						)}`,
					);
					translateState.topLevelTurnOpen = true;
					inputChannel.push(
						makeClaudeUserMessage(promptText, attachmentBlocks),
					);
				}),
			stopBackgroundTask: (taskId) =>
				Effect.tryPromise({
					try: () => q.stopTask(taskId),
					catch: (cause) =>
						cause instanceof Error ? cause : new Error(String(cause)),
				}),
			interrupt: () =>
				Effect.sync(() => {
					translateState.interrupted = true;
					releasePendingQuestions("cancelled");
				}).pipe(
					Effect.andThen(
						Effect.tryPromise({
							try: () => q.interrupt(),
							catch: (cause) => cause,
						}),
					),
					Effect.catch(() => Effect.void),
				),
			close: () =>
				Effect.sync(() => {
					checkpointBatcher.flush();

					releasePendingQuestions("closed");
					inputChannel.close();
					abort.abort();
					void mcpGatewaySession.close();
				}).pipe(Effect.andThen(Effect.promise(processes.close))),
			setPermissionMode: (mode) =>
				Effect.tryPromise({
					try: () =>
						q.setPermissionMode(
							runtimeModeToSdkPermissionMode(getRuntimeMode(), mode),
						),
					catch: (cause) => cause,
				}).pipe(
					Effect.tap(() =>
						Effect.sync(() => {
							currentPermissionMode = mode;
							Queue.offerUnsafe(events, {
								_tag: "PermissionModeChanged",
								mode,
							});
						}),
					),
					Effect.catch(() => Effect.void),
				),
			answerQuestion: (itemId, answers) =>
				Effect.try({
					try: () => {
						pendingQuestions.take(itemId)(answers);
					},
					catch: (cause) =>
						cause instanceof Error ? cause : new Error(String(cause)),
				}),
			cancelQuestion: (itemId) =>
				Effect.try({
					try: () => {
						pendingQuestions.take(itemId)(null);
					},
					catch: (cause) =>
						cause instanceof Error ? cause : new Error(String(cause)),
				}),
		};
		return handle;
	});
