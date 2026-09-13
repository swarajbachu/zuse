import {
	BUNDLED_MODEL_CATALOG,
	modelsForProvider,
	PROVIDER_IDS,
	type ProviderId,
} from "@zuse/contracts";
import { Predicate, Schema } from "effect";

export const ANALYTICS_SCHEMA_VERSION = 2;

export const AnalyticsSurface = Schema.Literals(["desktop", "ios", "android"]);
export type AnalyticsSurface = typeof AnalyticsSurface.Type;

export const AnalyticsIdentityKind = Schema.Literals(["anonymous", "account"]);
export type AnalyticsIdentityKind = typeof AnalyticsIdentityKind.Type;

export const AnalyticsEventName = Schema.Literals([
	"app opened",
	"app backgrounded",
	"app active interval",
	"screen viewed",
	"control activated",
	"onboarding step viewed",
	"onboarding step completed",
	"onboarding completed",
	"project added",
	"project removed",
	"chat created",
	"chat archived",
	"chat restored",
	"session created",
	"session forked",
	"message submitted",
	"model changed",
	"queue action performed",
	"plan decided",
	"permission decided",
	"turn started",
	"turn completed",
	"turn failed",
	"turn interrupted",
	"provider startup completed",
	"provider startup failed",
	"context compacted",
	"usage limit reached",
	"subagent started",
	"subagent completed",
	"pairing attempted",
	"pairing completed",
	"pairing failed",
	"connection attempted",
	"connection established",
	"connection failed",
	"connection restored",
	"notification permission decided",
	"notification opened",
	"outbox outcome",
	"app error",
	"operation completed",
	"update installed",
	"diagnostics exported",
]);
export type AnalyticsEventName = typeof AnalyticsEventName.Type;

const ANALYTICS_EVENT_NAMES = new Set<string>(AnalyticsEventName.literals);
export const isAnalyticsEventName = (
	value: string,
): value is AnalyticsEventName => ANALYTICS_EVENT_NAMES.has(value);

export type AnalyticsScalar = string | number | boolean;
export type AnalyticsProperties = Readonly<Record<string, AnalyticsScalar>>;

const COMMON_KEYS = new Set([
	"analytics_schema_version",
	"surface",
	"os",
	"architecture",
	"app_version",
	"release_channel",
	"identity_kind",
	"authenticated",
	"timezone",
	"local_hour",
	"local_weekday",
]);

const EVENT_KEYS: Record<AnalyticsEventName, ReadonlySet<string>> = {
	"app opened": new Set(["launch_type"]),
	"app backgrounded": new Set(["active_seconds"]),
	"app active interval": new Set(["active_seconds"]),
	"screen viewed": new Set(["screen"]),
	"control activated": new Set(["screen", "control", "interaction_source"]),
	"onboarding step viewed": new Set(["step"]),
	"onboarding step completed": new Set(["step"]),
	"onboarding completed": new Set(["provider_count"]),
	"project added": new Set(["source", "has_git"]),
	"project removed": new Set([]),
	"chat created": new Set(["provider", "model", "runtime_mode"]),
	"chat archived": new Set(["outcome"]),
	"chat restored": new Set(["outcome"]),
	"session created": new Set([
		"provider",
		"model",
		"runtime_mode",
		"permission_mode",
	]),
	"session forked": new Set(["provider", "model", "fork_mode"]),
	"message submitted": new Set([
		"provider",
		"model",
		"attachment_count",
		"input_length_bucket",
	]),
	"model changed": new Set(["provider", "model"]),
	"queue action performed": new Set(["action"]),
	"plan decided": new Set(["decision"]),
	"permission decided": new Set(["decision", "tool_category"]),
	"turn started": new Set(["provider", "model"]),
	"turn completed": new Set([
		"provider",
		"model",
		"duration_ms",
		"input_tokens",
		"output_tokens",
		"cache_read_tokens",
		"cache_creation_tokens",
		"reasoning_tokens",
		"cost_usd",
		"error_code",
		"tool_count",
		"tool_failure_count",
		"browser_tool_count",
		"shell_tool_count",
		"fs_tool_count",
		"git_tool_count",
		"mcp_tool_count",
		"subagent_tool_count",
		"other_tool_count",
		"subagent_failure_count",
		"compaction_count",
	]),
	"turn failed": new Set([
		"provider",
		"model",
		"duration_ms",
		"error_code",
		"tool_count",
		"tool_failure_count",
		"browser_tool_count",
		"shell_tool_count",
		"fs_tool_count",
		"git_tool_count",
		"mcp_tool_count",
		"subagent_tool_count",
		"other_tool_count",
		"subagent_failure_count",
		"compaction_count",
	]),
	"turn interrupted": new Set([
		"provider",
		"model",
		"duration_ms",
		"tool_count",
		"tool_failure_count",
		"browser_tool_count",
		"shell_tool_count",
		"fs_tool_count",
		"git_tool_count",
		"mcp_tool_count",
		"subagent_tool_count",
		"other_tool_count",
		"subagent_failure_count",
		"compaction_count",
	]),
	"provider startup completed": new Set([
		"provider",
		"model",
		"duration_ms",
		"resumed",
	]),
	"provider startup failed": new Set([
		"provider",
		"model",
		"duration_ms",
		"error_code",
	]),
	"context compacted": new Set(["provider", "model", "tokens"]),
	"usage limit reached": new Set(["provider", "scope"]),
	"subagent started": new Set(["provider", "model"]),
	"subagent completed": new Set(["provider", "model", "outcome"]),
	"pairing attempted": new Set(["connection_kind"]),
	"pairing completed": new Set(["connection_kind", "duration_ms"]),
	"pairing failed": new Set(["connection_kind", "duration_ms", "error_code"]),
	"connection attempted": new Set(["connection_kind"]),
	"connection established": new Set(["connection_kind", "duration_ms"]),
	"connection failed": new Set([
		"connection_kind",
		"duration_ms",
		"error_code",
	]),
	"connection restored": new Set(["connection_kind", "duration_ms"]),
	"notification permission decided": new Set(["decision"]),
	"notification opened": new Set(["notification_kind"]),
	"outbox outcome": new Set(["outcome", "queued_count"]),
	"app error": new Set(["error_code", "error_fingerprint", "fatal"]),
	"operation completed": new Set([
		"operation",
		"outcome",
		"duration_ms",
		"duration_bucket",
		"error_code",
	]),
	"update installed": new Set(["previous_version"]),
	"diagnostics exported": new Set(["outcome"]),
};

const SENSITIVE_KEY =
	/(prompt|response|reasoning(?!_tokens)|thinking|content|text|input(?!_(tokens|length_bucket))|output(?!_tokens)|command|code|file|path|url|repo|project_name|branch|chat_id|session_id|project_id|title|mcp_name|server_name|diagnostic|email|name|organization|token(?!s)|secret|password|credential|stack|trace)/i;

const SENSITIVE_VALUE =
	/(?:https?:\/\/|file:|[A-Za-z]:\\|\/(?:Users|home|private|tmp)\/|\S+@\S+|\r|\n)/i;
const STABLE_VALUE = /^[a-z0-9][a-z0-9._:-]{0,79}$/i;
const CONTROL_ID = /^[a-z0-9]+(?:[.-][a-z0-9-]+)+$/i;
const KNOWN_SCREENS = new Set([
	"onboarding",
	"chat",
	"file",
	"changes",
	"archives",
	"usage",
	"settings",
	"chats",
	"new chat",
	"nearby connection",
	"manual connection",
	"connection scanner",
	"connection pairing",
	"plan viewer",
	"session",
	"sessions",
	"chat threads",
	"files",
	"review",
	"tool details",
	"other",
	"unknown",
]);

const scalar = (value: unknown): value is AnalyticsScalar =>
	Predicate.isString(value) ||
	Predicate.isNumber(value) ||
	Predicate.isBoolean(value);

/**
 * Fail-closed payload filtering. Unknown events, unknown keys, suspicious keys,
 * non-finite numbers, and unbounded strings are discarded before delivery.
 */
export const sanitizeAnalyticsProperties = (
	event: AnalyticsEventName,
	properties: Readonly<Record<string, unknown>>,
): Record<string, AnalyticsScalar> => {
	const allowed = EVENT_KEYS[event];
	const output: Record<string, AnalyticsScalar> = {};
	for (const [key, value] of Object.entries(properties)) {
		if (SENSITIVE_KEY.test(key)) continue;
		if (!COMMON_KEYS.has(key) && !allowed.has(key)) continue;
		if (!scalar(value)) continue;
		if (typeof value === "number" && !Number.isFinite(value)) continue;
		if (typeof value === "string") {
			const normalized = normalizeStringProperty(key, value);
			if (normalized === null) continue;
			output[key] = normalized;
			continue;
		}
		output[key] = value;
	}
	output.analytics_schema_version = ANALYTICS_SCHEMA_VERSION;
	return output;
};

// Allowlists come from the bundled snapshot: telemetry must never leak a
// user-typed custom slug, and live-only ids are reported as `custom` until
// they land in the curated catalog.
const knownModelIds = new Map<ProviderId, ReadonlySet<string>>(
	PROVIDER_IDS.map((provider) => [
		provider,
		new Set(
			modelsForProvider(BUNDLED_MODEL_CATALOG, provider).map(
				(model) => model.id,
			),
		),
	]),
);
const allKnownModelIds = new Set(
	PROVIDER_IDS.flatMap((provider) =>
		modelsForProvider(BUNDLED_MODEL_CATALOG, provider).map((model) => model.id),
	),
);

const normalizeStringProperty = (key: string, value: string): string | null => {
	if (key === "model")
		return value === "custom" || allKnownModelIds.has(value) ? value : "custom";
	if (key === "provider") {
		return (PROVIDER_IDS as ReadonlyArray<string>).includes(value)
			? value
			: "other";
	}
	if (key === "screen") return KNOWN_SCREENS.has(value) ? value : "other";
	if (key === "control") return CONTROL_ID.test(value) ? value : null;
	if (key === "timezone")
		return value.length <= 64 && !SENSITIVE_VALUE.test(value)
			? value
			: "unknown";
	if (SENSITIVE_VALUE.test(value)) return null;
	return STABLE_VALUE.test(value) ? value : null;
};

export const safeModelId = (provider: ProviderId, model: string): string =>
	knownModelIds.get(provider)?.has(model) === true ? model : "custom";

export const TOOL_CATEGORIES = [
	"browser",
	"shell",
	"files",
	"git",
	"mcp",
	"subagent",
	"other",
] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

export const classifyTool = (tool: string): ToolCategory => {
	const normalized = tool.toLowerCase();
	if (normalized.includes("browser") || normalized.includes("web")) {
		return "browser";
	}
	if (
		normalized.includes("bash") ||
		normalized.includes("shell") ||
		normalized.includes("terminal") ||
		normalized.includes("exec")
	) {
		return "shell";
	}
	if (
		normalized.includes("file") ||
		normalized.includes("read") ||
		normalized.includes("write") ||
		normalized.includes("edit") ||
		normalized.includes("patch")
	) {
		return "files";
	}
	if (normalized.includes("git") || normalized.includes("worktree")) {
		return "git";
	}
	if (
		normalized.includes("agent") ||
		normalized.includes("task") ||
		normalized.includes("collab")
	) {
		return "subagent";
	}
	if (normalized.includes("mcp") || normalized.includes("tool")) return "mcp";
	return "other";
};

export const inputLengthBucket = (length: number): string => {
	if (length <= 0) return "empty";
	if (length <= 100) return "1-100";
	if (length <= 500) return "101-500";
	if (length <= 2_000) return "501-2000";
	return "2001+";
};

export const durationBucket = (durationMs: number): string => {
	if (durationMs < 250) return "under-250ms";
	if (durationMs < 1_000) return "250-999ms";
	if (durationMs < 5_000) return "1-4s";
	if (durationMs < 30_000) return "5-29s";
	return "30s+";
};
