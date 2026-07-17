import type { AgentEvent, AgentItemId } from "@zuse/contracts";
import { Schema } from "effect";

const AuthMethod = Schema.Struct({ id: Schema.String });
const McpCapabilities = Schema.Struct({
	http: Schema.optional(Schema.Boolean),
	sse: Schema.optional(Schema.Boolean),
});
const AgentCapabilities = Schema.Struct({
	loadSession: Schema.optional(Schema.Boolean),
	mcpCapabilities: Schema.optional(McpCapabilities),
});
const InitializeResult = Schema.Struct({
	agentVersion: Schema.optional(Schema.String),
	meta: Schema.optional(
		Schema.Struct({ agentVersion: Schema.optional(Schema.String) }),
	),
	_meta: Schema.optional(
		Schema.Struct({ agentVersion: Schema.optional(Schema.String) }),
	),
	authMethods: Schema.optional(Schema.Array(AuthMethod)),
	agentCapabilities: Schema.optional(AgentCapabilities),
	sessionModes: Schema.optional(Schema.Array(Schema.Unknown)),
	models: Schema.optional(Schema.Array(Schema.Unknown)),
});

export interface GrokInitializeResult {
	readonly agentVersion: string;
	readonly authMethods: ReadonlyArray<string>;
	readonly supportsSessionLoad: boolean;
	readonly mcp: { readonly http: boolean; readonly sse: boolean };
	readonly sessionModes: ReadonlyArray<unknown>;
	readonly models: ReadonlyArray<unknown>;
}

export const decodeGrokInitializeResult = (
	value: unknown,
): GrokInitializeResult => {
	const decoded = Schema.decodeUnknownSync(InitializeResult)(value);
	const agentVersion =
		decoded.agentVersion ??
		decoded.meta?.agentVersion ??
		decoded._meta?.agentVersion;
	if (agentVersion === undefined)
		throw new Error("Grok ACP initialize returned no agentVersion");
	return {
		agentVersion,
		authMethods: (decoded.authMethods ?? []).map(({ id }) => id),
		supportsSessionLoad: decoded.agentCapabilities?.loadSession === true,
		mcp: {
			http: decoded.agentCapabilities?.mcpCapabilities?.http === true,
			sse: decoded.agentCapabilities?.mcpCapabilities?.sse === true,
		},
		sessionModes: decoded.sessionModes ?? [],
		models: decoded.models ?? [],
	};
};

const NotificationMeta = Schema.Struct({
	eventId: Schema.optional(Schema.String),
	promptId: Schema.optional(Schema.String),
	isReplay: Schema.optional(Schema.Boolean),
	agentTimestampMs: Schema.optional(Schema.Number),
	streamStartMs: Schema.optional(Schema.Number),
	turnStartMs: Schema.optional(Schema.Number),
	totalTokens: Schema.optional(Schema.Number),
	stopReason: Schema.optional(Schema.String),
});
const Notification = Schema.Struct({
	sessionId: Schema.String,
	update: Schema.Record(Schema.String, Schema.Unknown),
	_meta: Schema.optional(NotificationMeta),
});

export interface GrokNotification {
	readonly sessionId: string;
	readonly update: Readonly<Record<string, unknown>>;
	readonly meta: {
		readonly eventId?: string;
		readonly promptId?: string;
		readonly isReplay: boolean;
		readonly timestampMs?: number;
		readonly streamStartMs?: number;
		readonly turnStartMs?: number;
		readonly totalTokens?: number;
		readonly stopReason?: string;
	};
}

export const decodeGrokNotification = (value: unknown): GrokNotification => {
	const decoded = Schema.decodeUnknownSync(Notification)(value);
	const meta = decoded._meta;
	return {
		sessionId: decoded.sessionId,
		update: decoded.update,
		meta: {
			...(meta?.eventId === undefined ? {} : { eventId: meta.eventId }),
			...(meta?.promptId === undefined ? {} : { promptId: meta.promptId }),
			isReplay: meta?.isReplay ?? false,
			...(meta?.agentTimestampMs === undefined
				? {}
				: { timestampMs: meta.agentTimestampMs }),
			...(meta?.streamStartMs === undefined
				? {}
				: { streamStartMs: meta.streamStartMs }),
			...(meta?.turnStartMs === undefined
				? {}
				: { turnStartMs: meta.turnStartMs }),
			...(meta?.totalTokens === undefined
				? {}
				: { totalTokens: meta.totalTokens }),
			...(meta?.stopReason !== undefined
				? { stopReason: meta.stopReason }
				: typeof decoded.update.stop_reason === "string"
					? { stopReason: decoded.update.stop_reason }
					: {}),
		},
	};
};

const PlanApprovalRequest = Schema.Struct({
	sessionId: Schema.String,
	toolCallId: Schema.String,
	planContent: Schema.optional(Schema.String),
});
export interface GrokPlanApprovalRequest {
	readonly sessionId: string;
	readonly toolCallId: string;
	readonly planContent: string;
}
export const decodePlanApprovalRequest = (
	value: unknown,
): GrokPlanApprovalRequest => {
	const decoded = Schema.decodeUnknownSync(PlanApprovalRequest)(value);
	return { ...decoded, planContent: decoded.planContent ?? "" };
};

const QuestionOption = Schema.Struct({
	label: Schema.String,
	description: Schema.String,
	preview: Schema.optional(Schema.String),
});
const NativeQuestion = Schema.Struct({
	question: Schema.String,
	options: Schema.Array(QuestionOption),
	multiSelect: Schema.optional(Schema.Boolean),
});
const AskUserQuestionRequest = Schema.Struct({
	sessionId: Schema.String,
	toolCallId: Schema.String,
	questions: Schema.Array(NativeQuestion),
	mode: Schema.Literals(["default", "plan"]),
});
export type GrokAskUserQuestionRequest = typeof AskUserQuestionRequest.Type;
export const decodeAskUserQuestionRequest = Schema.decodeUnknownSync(
	AskUserQuestionRequest,
);

export const normalizeGrokMethod = (method: string): string =>
	method.startsWith("_x.ai/") ? method.slice(1) : method;

const ExtensionEnvelope = Schema.Struct({
	method: Schema.String,
	params: Schema.optional(Schema.Unknown),
});

export interface GrokWireMethod {
	readonly method: string;
	readonly params: unknown;
	readonly extension: boolean;
}

/**
 * Provider extensions normally arrive as top-level `_x.ai/*` methods. Some
 * ACP adapters expose the same request through an `ext_method` or
 * `ext_notification` envelope, so normalize both forms at this boundary.
 */
export const decodeGrokWireMethod = (
	method: string,
	params: unknown,
): GrokWireMethod => {
	const normalized = normalizeGrokMethod(method);
	if (normalized !== "ext_method" && normalized !== "ext_notification") {
		return {
			method: normalized,
			params,
			extension: normalized.startsWith("x.ai/"),
		};
	}
	try {
		const extension = Schema.decodeUnknownSync(ExtensionEnvelope)(params);
		return {
			method: normalizeGrokMethod(extension.method),
			params: extension.params,
			extension: true,
		};
	} catch {
		return { method: normalized, params, extension: true };
	}
};

export const mapGrokMode = (
	mode: "plan" | "default" | "acceptEdits",
): "plan" | "default" => (mode === "plan" ? "plan" : "default");

const eventPosition = (
	eventId: string,
): { readonly stream: string; readonly sequence: number } | null => {
	const match = eventId.match(/-(\d+)$/);
	if (match?.[1] === undefined) return null;
	return {
		stream: eventId.slice(0, -match[0].length),
		sequence: Number.parseInt(match[1], 10),
	};
};

export interface GrokEventCursor {
	readonly shouldProcess: (eventId: string | undefined) => boolean;
	readonly commit: (eventId: string) => void;
	readonly release: (eventId: string) => void;
	readonly value: () => string | null;
	readonly resetPending: () => void;
}

export const createGrokEventCursor = (
	initial: string | null,
): GrokEventCursor => {
	let current = initial;
	const committed = new Set(initial === null ? [] : [initial]);
	const pending = new Set<string>();
	return {
		shouldProcess: (eventId) => {
			if (eventId === undefined) return true;
			if (committed.has(eventId) || pending.has(eventId)) return false;
			if (current === null) {
				pending.add(eventId);
				return true;
			}
			const next = eventPosition(eventId);
			const previous = eventPosition(current);
			const shouldProcess =
				next === null ||
				previous === null ||
				next.stream !== previous.stream ||
				next.sequence > previous.sequence;
			if (shouldProcess) pending.add(eventId);
			return shouldProcess;
		},
		commit: (eventId) => {
			pending.delete(eventId);
			committed.add(eventId);
			current = eventId;
		},
		release: (eventId) => pending.delete(eventId),
		value: () => current,
		resetPending: () => pending.clear(),
	};
};

export type GrokRpcErrorKind =
	| "auth"
	| "billing"
	| "cancellation"
	| "transport"
	| "unsupported-method"
	| "provider";

export const classifyGrokRpcError = (error: unknown): GrokRpcErrorKind => {
	if (error === null || typeof error !== "object") return "provider";
	const record = error as { readonly code?: unknown; readonly data?: unknown };
	const code = typeof record.code === "number" ? record.code : null;
	const data =
		record.data !== null && typeof record.data === "object"
			? (record.data as Readonly<Record<string, unknown>>)
			: null;
	const stableCode =
		typeof data?.code === "string"
			? data.code
			: typeof data?.kind === "string"
				? data.kind
				: null;
	if (stableCode === "unauthorized" || stableCode === "authentication_required")
		return "auth";
	if (
		stableCode === "rate_limited" ||
		stableCode === "billing_required" ||
		stableCode === "quota_exhausted"
	)
		return "billing";
	if (stableCode === "connection_lost" || stableCode === "tool_server_gone")
		return "transport";
	if (code === 401 || code === 403) return "auth";
	if (code === 402 || code === 429) return "billing";
	if (code === -32000 || code === -32002) return "auth";
	if (code === -32003 || code === -32099) return "billing";
	if (code === -32800) return "cancellation";
	if (code === -32601) return "unsupported-method";
	if (code === -32004 || code === -32005 || code === -32098) return "transport";
	return "provider";
};

export type GrokLifecycleState =
	| "start"
	| "authentication"
	| "idle"
	| "running"
	| "waiting-for-input"
	| "reconnecting"
	| "error"
	| "closed";

const lifecycleTransitions: Readonly<
	Record<GrokLifecycleState, ReadonlySet<GrokLifecycleState>>
> = {
	start: new Set(["authentication", "error", "closed"]),
	authentication: new Set(["idle", "error", "closed"]),
	idle: new Set(["running", "reconnecting", "error", "closed"]),
	running: new Set([
		"idle",
		"waiting-for-input",
		"reconnecting",
		"error",
		"closed",
	]),
	"waiting-for-input": new Set([
		"running",
		"idle",
		"reconnecting",
		"error",
		"closed",
	]),
	reconnecting: new Set(["idle", "running", "error", "closed"]),
	error: new Set(["closed"]),
	closed: new Set(),
};

export interface GrokLifecycle {
	readonly current: () => GrokLifecycleState;
	readonly transition: (next: GrokLifecycleState) => void;
}

export const createGrokLifecycle = (): GrokLifecycle => {
	let state: GrokLifecycleState = "start";
	return {
		current: () => state,
		transition: (next) => {
			if (next === state) return;
			if (!lifecycleTransitions[state].has(next)) {
				throw new Error(
					`Invalid Grok lifecycle transition: ${state} -> ${next}`,
				);
			}
			state = next;
		},
	};
};

export const GROK_MINIMUM_VERSION = "0.2.101";
export const GROK_UPDATE_COMMAND =
	"curl -fsSL https://x.ai/cli/install.sh | bash";

export const isSupportedGrokVersion = (raw: string): boolean => {
	const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
	if (match === null) return false;
	const actual = match.slice(1, 4).map((part) => Number.parseInt(part, 10));
	const minimum = [0, 2, 101];
	for (let index = 0; index < minimum.length; index += 1) {
		const actualPart = actual[index] ?? 0;
		const minimumPart = minimum[index] ?? 0;
		if (actualPart !== minimumPart) return actualPart > minimumPart;
	}
	return true;
};

const numberField = (
	record: Readonly<Record<string, unknown>>,
	key: string,
): number => (typeof record[key] === "number" ? record[key] : 0);
const stringField = (
	record: Readonly<Record<string, unknown>>,
	key: string,
): string => (typeof record[key] === "string" ? record[key] : "");

/** Translate provider extension notifications without text/tool-id inference. */
export const translateGrokExtensionUpdate = (
	update: Readonly<Record<string, unknown>>,
	now = Date.now(),
): ReadonlyArray<AgentEvent> => {
	const tag = update.sessionUpdate;
	if (tag === "turn_completed") {
		const usage =
			update.usage !== null && typeof update.usage === "object"
				? (update.usage as Readonly<Record<string, unknown>>)
				: null;
		const totals =
			usage?.totals !== null && typeof usage?.totals === "object"
				? (usage.totals as Readonly<Record<string, unknown>>)
				: usage;
		const usageEvent: AgentEvent[] =
			totals === null
				? []
				: [
						{
							_tag: "UsageDelta",
							inputTokens: numberField(totals, "inputTokens"),
							outputTokens: numberField(totals, "outputTokens"),
							cacheReadTokens: numberField(totals, "cachedReadTokens"),
							cacheCreationTokens: 0,
							model: stringField(update, "model"),
						},
					];
		return [...usageEvent, { _tag: "Status", status: "idle" }];
	}
	if (tag === "auto_compact_started") {
		return [
			{
				_tag: "ContextCompaction",
				itemId: `grok-compact-${now}` as AgentItemId,
				providerId: "grok",
				startedAt: now,
				durationMs: 0,
				beforeTokens: numberField(update, "tokens_used"),
				afterTokens: null,
				status: "in_progress",
			},
		];
	}
	if (tag === "auto_compact_completed") {
		const elapsedMs = numberField(update, "elapsed_ms");
		return [
			{
				_tag: "ContextCompaction",
				itemId: `grok-compact-${now - elapsedMs}` as AgentItemId,
				providerId: "grok",
				startedAt: now - elapsedMs,
				durationMs: elapsedMs,
				beforeTokens:
					typeof update.tokens_before === "number"
						? update.tokens_before
						: null,
				afterTokens: numberField(update, "tokens_after"),
				status: "completed",
			},
		];
	}
	if (tag === "retry_state") {
		return [
			{
				_tag: "Status",
				status: update.type === "retrying" ? "running" : "idle",
			},
		];
	}
	if (tag === "auto_recovery_started")
		return [{ _tag: "Status", status: "running" }];
	if (tag === "auto_recovery_exhausted")
		return [{ _tag: "Status", status: "error" }];
	if (tag === "goal_updated") {
		const statusRaw = stringField(update, "status");
		if (statusRaw === "cleared") return [{ _tag: "GoalCleared" }];
		const status =
			statusRaw === "paused" || statusRaw.endsWith("_paused")
				? "paused"
				: statusRaw === "blocked"
					? "blocked"
					: statusRaw === "complete" || statusRaw === "completed"
						? "complete"
						: statusRaw === "budget_limited"
							? "budgetLimited"
							: statusRaw === "usage_limited"
								? "usageLimited"
								: "active";
		const elapsedMs = numberField(update, "elapsed_ms");
		return [
			{
				_tag: "GoalUpdated",
				goal: {
					threadId: stringField(update, "goal_id"),
					objective: stringField(update, "objective"),
					status,
					tokenBudget:
						typeof update.token_budget === "number"
							? update.token_budget
							: null,
					tokensUsed: numberField(update, "tokens_used"),
					timeUsedSeconds: elapsedMs / 1_000,
					createdAt: now - elapsedMs,
					updatedAt: now,
				},
			},
		];
	}
	if (tag === "subagent_spawned") {
		const childId = stringField(update, "subagent_id");
		return [
			{
				_tag: "ToolUse",
				itemId: childId as AgentItemId,
				tool: "Agent",
				input: {
					description: stringField(update, "description"),
					subagent_type: stringField(update, "subagent_type"),
					model: stringField(update, "model"),
				},
				subagent: {
					childSessionId: stringField(update, "child_session_id"),
					presentation: "inline",
				},
			},
		];
	}
	if (tag === "subagent_progress") {
		return [
			{
				_tag: "SubagentProgress",
				childId: stringField(update, "subagent_id"),
				parentId: stringField(update, "parent_session_id"),
				childSessionId: stringField(update, "child_session_id"),
				status: "running",
				durationMs: numberField(update, "duration_ms"),
				turns: numberField(update, "turn_count"),
				toolCalls: numberField(update, "tool_call_count"),
				tokens: numberField(update, "tokens_used"),
				contextPercentage: numberField(update, "context_usage_pct"),
				toolsUsed: Array.isArray(update.tools_used)
					? update.tools_used.filter(
							(tool): tool is string => typeof tool === "string",
						)
					: [],
				errorCount: numberField(update, "error_count"),
			},
		];
	}
	if (tag === "subagent_finished") {
		const status = stringField(update, "status");
		return [
			{
				_tag: "SubagentSummary",
				itemId: stringField(update, "subagent_id") as AgentItemId,
				agentName: stringField(update, "subagent_id"),
				model: stringField(update, "model"),
				turns: numberField(update, "turns"),
				durationMs: numberField(update, "duration_ms"),
				summary:
					typeof update.output === "string"
						? update.output
						: stringField(update, "error"),
				isError: status === "failed" || status === "cancelled",
				childSessionId: stringField(update, "child_session_id"),
				presentation: "inline",
			},
		];
	}
	return [];
};

/** Dedicated x.ai extension methods whose payload is an `{ update }` envelope. */
export const translateGrokExtensionMethod = (
	method: string,
	params: unknown,
): ReadonlyArray<AgentEvent> => {
	if (params === null || typeof params !== "object") return [];
	const envelope = params as Readonly<Record<string, unknown>>;
	const update =
		envelope.update !== null && typeof envelope.update === "object"
			? (envelope.update as Readonly<Record<string, unknown>>)
			: envelope;
	if (method === "x.ai/task_backgrounded") {
		const itemId =
			stringField(update, "tool_call_id") || stringField(update, "task_id");
		if (itemId.length === 0) return [];
		return [
			{
				_tag: "ToolUse",
				itemId: itemId as AgentItemId,
				tool: "BackgroundTask",
				input: {
					taskId: stringField(update, "task_id"),
					command: stringField(update, "command"),
					cwd: stringField(update, "cwd"),
					description: stringField(update, "description"),
				},
			},
		];
	}
	if (method === "x.ai/task_completed") {
		const snapshot =
			update.task_snapshot !== null && typeof update.task_snapshot === "object"
				? (update.task_snapshot as Readonly<Record<string, unknown>>)
				: update;
		const itemId =
			stringField(snapshot, "tool_call_id") || stringField(snapshot, "task_id");
		if (itemId.length === 0) return [];
		const status = stringField(snapshot, "status");
		return [
			{
				_tag: "ToolResult",
				itemId: itemId as AgentItemId,
				output: snapshot,
				isError: status === "failed" || status === "cancelled",
			},
		];
	}
	return [];
};
