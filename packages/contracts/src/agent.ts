import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

import {
	AgentItemId,
	AgentSessionId,
	AgentTurnId,
	AttemptId,
	FolderId,
} from "./ids.ts";

/**
 * Built-in driver identifiers retain their wire values. User-configured ACP
 * instances use the separate acp- namespace and do not extend this list.
 */
export const BuiltinProviderId = Schema.Literals([
	"claude",
	"codex",
	"grok",
	"gemini",
	"cursor",
	"opencode",
	"opencode2",
	"kiro",
	"pi",
	"zuse",
]);
export type BuiltinProviderId = typeof BuiltinProviderId.Type;
export const AcpProviderId = Schema.TemplateLiteral([
	"acp-",
	Schema.String,
]).check(Schema.isPattern(/^acp-[a-z0-9][a-z0-9-]{0,95}$/));
export type AcpProviderId = typeof AcpProviderId.Type;
export const ProviderId = Schema.Union([BuiltinProviderId, AcpProviderId]);
export type ProviderId = typeof ProviderId.Type;
export const isAcpProviderId = (id: string): id is AcpProviderId =>
	/^acp-[a-z0-9][a-z0-9-]{0,95}$/.test(id);

/** All persisted built-in identifiers, including legacy integrations. */
export const PROVIDER_IDS: ReadonlyArray<BuiltinProviderId> =
	BuiltinProviderId.literals;

/** Built-ins offered for new setup. Legacy IDs remain valid for saved chats. */
export const BUILTIN_PROVIDER_CHOICES: ReadonlyArray<BuiltinProviderId> =
	PROVIDER_IDS.filter((id) => id !== "gemini");

/**
 * How a session is being driven. `spawn-cli` is just a PTY launch with a known
 * argv; `sdk` runs through the in-process adapter and emits structured events.
 */
export const SessionMode = Schema.Literals(["spawn-cli", "sdk"]);
export type SessionMode = typeof SessionMode.Type;

/**
 * High-level session lifecycle state. Mirrors what the side-panel chip shows.
 */
export const AgentStatus = Schema.Literals([
	"idle",
	"starting",
	"running",
	"waiting",
	"closed",
	"error",
]);
export type AgentStatus = typeof AgentStatus.Type;

/**
 * How permission prompts behave for a session (or a sub-agent). Originally
 * declared in `session.ts`; lifted here so `AgentDefinition.permissionMode`
 * can reuse the same literal set without an import cycle.
 *
 *   - `auto` — native risk review in Codex/Claude/Grok; other providers ask.
 *   - `approval-required` — prompt every write/Bash/Network/Task/MCP call.
 *   - `auto-accept-edits` — also auto-allow Edit / Write / MultiEdit /
 *     NotebookEdit. Bash / Network / Task / MCP still prompt.
 *   - `auto-accept-edits-and-bash` — auto-allow file edits AND Bash. Network
 *     (WebFetch / WebSearch) and MCP/Other still prompt.
 *   - `full-access` — auto-allow everything except sensitive paths. Plan
 *     mode (ExitPlanMode) ALWAYS prompts regardless of runtime mode.
 */
export const RuntimeMode = Schema.Literals([
	"auto",
	"approval-required",
	"auto-accept-edits",
	"auto-accept-edits-and-bash",
	"full-access",
]);
export type RuntimeMode = typeof RuntimeMode.Type;
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "approval-required";

/**
 * SDK-level lifecycle mode. Distinct from `RuntimeMode` (which controls our
 * own auto-allow policy): this maps onto the Claude Agent SDK's
 * `Options.permissionMode`.
 *
 *   - `default` — normal operation; `canUseTool` decides each call.
 *   - `plan` — agent reads / explores only and ends turns by calling the
 *     SDK's built-in `ExitPlanMode` tool with a proposed plan.
 *   - `acceptEdits` — file edits skip the prompt; everything else goes
 *     through `canUseTool`. Equivalent to RuntimeMode `auto-accept-edits`.
 *
 * The two modes coexist: `permissionMode: 'plan'` short-circuits all
 * write/exec tools regardless of `RuntimeMode`. Approving the plan
 * switches `permissionMode` back to `default` and the existing `RuntimeMode`
 * resumes governing prompts.
 */
export const PermissionMode = Schema.Literals([
	"default",
	"plan",
	"acceptEdits",
]);
export type PermissionMode = typeof PermissionMode.Type;
export const DEFAULT_PERMISSION_MODE: PermissionMode = "default";

/**
 * Canonical reasoning effort levels exposed to the user. Providers map these
 * to their native concept:
 *   - Claude → `maxThinkingTokens` (low=5k, medium=15k, high=60k) + SDK
 *     `effort` enum (low/medium/high/xhigh/max). `ultracode` is a Claude
 *     Code preset that normalizes to `xhigh` + `settings.ultracode: true`.
 *   - Codex → `reasoning_effort` enum (supported tiers pass through).
 *   - Gemini Pro → `thinkingConfig.thinkingBudget` (low=4k, medium=16k, high=32k)
 *
 * Providers/models that don't support thinking simply omit the descriptor
 * from `ModelDescriptor.optionDescriptors`, which hides the FE picker.
 */
export const ReasoningLevel = Schema.Literals([
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
	"ultracode",
]);
export type ReasoningLevel = typeof ReasoningLevel.Type;

/**
 * A single UI control a model exposes. The renderer renders these
 * dynamically from `ModelDescriptor.optionDescriptors`, so adding a new
 * per-model knob is a wire change + driver change — no FE switch needed.
 */
export const SelectOptionDescriptor = Schema.Struct({
	kind: Schema.Literal("select"),
	id: Schema.String,
	label: Schema.String,
	options: Schema.Array(
		Schema.Struct({ id: Schema.String, label: Schema.String }),
	),
	defaultId: Schema.optional(Schema.String),

	promptInjectedValues: Schema.optional(Schema.Array(Schema.String)),
});
export type SelectOptionDescriptor = typeof SelectOptionDescriptor.Type;

export const BooleanOptionDescriptor = Schema.Struct({
	kind: Schema.Literal("boolean"),
	id: Schema.String,
	label: Schema.String,
	defaultValue: Schema.optional(Schema.Boolean),
});
export type BooleanOptionDescriptor = typeof BooleanOptionDescriptor.Type;

export const OptionDescriptor = Schema.Union([
	SelectOptionDescriptor,
	BooleanOptionDescriptor,
]);
export type OptionDescriptor = typeof OptionDescriptor.Type;

/**
 * Per-provider verdict on whether the installed CLI is new enough for the
 * SDK we ship against.
 *
 *   - `ok` — version parsed and meets/exceeds the SDK's minimum
 *   - `outdated` — version parsed but is below the minimum (`cliVersionMinRequired`
 *     carries the floor so the renderer can render "Codex 0.27.0 < 0.128.0")
 *   - `unknown` — no `--version` output, parser failed, or no minimum tracked
 *     for this provider. Treat as "let them try" so a parser bug doesn't
 *     block a legitimate session start.
 */
export const CliVersionStatus = Schema.Literals(["ok", "outdated", "unknown"]);
export type CliVersionStatus = typeof CliVersionStatus.Type;

/**
 * Version-gated Codex features. The installed Codex CLI only speaks these on
 * recent releases, so we surface support as a capability list on
 * {@link AgentAvailability} (computed from `cliVersion` against per-feature
 * floors in `availability.ts`) and the renderer shows/hides the matching
 * control. Adding a feature here is additive — pair it with a floor in
 * `CODEX_FEATURE_FLOORS` and a UI gate.
 *
 *   - `goalMode` — `thread/goal/*` RPCs (the goal banner + `/goal`).
 *   - `fastMode` — `serviceTier: "fast"` on `turn/start` (1.5× speed tier).
 */
export const CodexFeature = Schema.Literals(["goalMode", "fastMode"]);
export type CodexFeature = typeof CodexFeature.Type;

/**
 * Per-provider verdict on whether a *newer published release* exists, distinct
 * from {@link CliVersionStatus} (which is the blocking SDK floor). This layer
 * is purely informational — it powers the "update available" hover affordance
 * in settings and the launch toast, and never blocks a session.
 *
 *   - `current` — installed version is at or ahead of the latest published
 *   - `behind` — a newer version is published (`latestVersion` carries it)
 *   - `unknown` — couldn't reach the registry, parse failed, or the provider
 *     isn't published to a registry we check (e.g. curl-installed CLIs)
 */
export const LatestVersionStatus = Schema.Literals([
	"current",
	"behind",
	"unknown",
]);
export type LatestVersionStatus = typeof LatestVersionStatus.Type;

/**
 * Server-side verdict on whether a provider is usable right now. Distinct
 * from `cliVersionStatus` (which only describes the CLI version) and from
 * `authStatus` (which only describes credentials): this is the rolled-up
 * dot color the UI shows.
 *
 *   - `ready`    — installed, authenticated, version ok
 *   - `warning`  — usable but something needs attention (e.g. update
 *                   available, auth verification failed but credentials look
 *                   present)
 *   - `error`    — unusable (e.g. CLI installed but auth probe returned 401,
 *                   account/read RPC failed, etc.)
 *   - `disabled` — user toggled the provider off in settings; renderer-only
 */
export const ProviderHealthStatus = Schema.Literals([
	"ready",
	"warning",
	"error",
	"disabled",
]);
export type ProviderHealthStatus = typeof ProviderHealthStatus.Type;

/**
 * Whether the credential check actually verified the user is signed in
 * (e.g. Codex `account/read` returned a chatgpt account). `unknown` means
 * the probe couldn't reach a verification endpoint (offline, app-server
 * spawn failed) — distinct from `unauthenticated` which is a confirmed
 * "no credentials".
 */
export const ProviderAuthStatus = Schema.Literals([
	"authenticated",
	"unauthenticated",
	"unknown",
]);
export type ProviderAuthStatus = typeof ProviderAuthStatus.Type;

/** Verification state for an API key kept in the app-managed keychain. */
export const ProviderApiKeyStatus = Schema.Literals([
	"verified",
	"unverified",
	"invalid",
]);
export type ProviderApiKeyStatus = typeof ProviderApiKeyStatus.Type;

export const ProviderRuntimeKind = Schema.Literals(["cli", "bundledSdk"]);
export type ProviderRuntimeKind = typeof ProviderRuntimeKind.Type;

/**
 * Static availability report for a provider runtime and app-managed
 * credentials. Legacy CLI fields remain required for older clients;
 * consumers should prefer runtime metadata when present.
 */
export const AgentAvailability = Schema.Struct({
	providerId: ProviderId,
	displayName: Schema.String,

	runtimeKind: Schema.optional(ProviderRuntimeKind),

	runtimeAvailable: Schema.optional(Schema.Boolean),
	cliInstalled: Schema.Boolean,
	cliVersion: Schema.optional(Schema.String),
	cliPath: Schema.optional(Schema.String),
	cliLoggedIn: Schema.Boolean,
	hasApiKey: Schema.Boolean,

	apiKeyStatus: Schema.optional(ProviderApiKeyStatus),

	cliVersionStatus: Schema.optional(CliVersionStatus),

	cliVersionMinRequired: Schema.optional(Schema.String),

	capabilities: Schema.optional(Schema.Array(Schema.String)),

	cliUpgradeCommand: Schema.optional(Schema.String),

	latestVersion: Schema.optional(Schema.String),

	latestVersionStatus: Schema.optional(LatestVersionStatus),

	updateCommand: Schema.optional(Schema.String),

	authStatus: Schema.optional(ProviderAuthStatus),

	authEmail: Schema.optional(Schema.String),

	authLabel: Schema.optional(Schema.String),

	authType: Schema.optional(Schema.String),

	status: Schema.optional(ProviderHealthStatus),

	statusMessage: Schema.optional(Schema.String),

	lastCheckedAt: Schema.optional(Schema.DateFromString),
});
export type AgentAvailability = typeof AgentAvailability.Type;

/**
 * Coarse classifier for stream-side errors so the renderer can render
 * the right CTA (Retry vs "Sign in to Codex" vs "Connection lost"). The
 * default is `generic` — drivers only set this when they have positive
 * evidence (e.g. parsed a 401 from the SDK).
 */
export const AgentErrorKind = Schema.Literals(["auth", "network", "generic"]);
export type AgentErrorKind = typeof AgentErrorKind.Type;

const StartedEvent = Schema.TaggedStruct("Started", {
	sessionId: AgentSessionId,
	providerId: ProviderId,
	mode: SessionMode,
});

const StatusEvent = Schema.TaggedStruct("Status", {
	status: AgentStatus,
});

const AuthEvent = Schema.TaggedStruct("Auth", {
	sdkConfigured: Schema.Boolean,
});

const VersionEvent = Schema.TaggedStruct("Version", {
	cliVersion: Schema.optional(Schema.String),
	sdkVersion: Schema.optional(Schema.String),
});

const CapabilitiesEvent = Schema.TaggedStruct("Capabilities", {
	capabilities: Schema.Array(Schema.String),
});

/** Absolute, monotonically revised text emitted for one stable provider item. */
export const ProviderMessageCheckpoint = Schema.Struct({
	revision: Schema.Number,

	final: Schema.Boolean,
});
export type ProviderMessageCheckpoint = typeof ProviderMessageCheckpoint.Type;

const AssistantMessageEvent = Schema.TaggedStruct("AssistantMessage", {
	itemId: AgentItemId,
	text: Schema.String,
	checkpoint: Schema.optional(ProviderMessageCheckpoint),

	isPlan: Schema.optional(Schema.Boolean),

	parentItemId: Schema.optional(AgentItemId),
});

const ThinkingEvent = Schema.TaggedStruct("Thinking", {
	itemId: AgentItemId,
	text: Schema.String,
	redacted: Schema.Boolean,
	checkpoint: Schema.optional(ProviderMessageCheckpoint),
	parentItemId: Schema.optional(AgentItemId),
});

const ToolUseEvent = Schema.TaggedStruct("ToolUse", {
	itemId: AgentItemId,
	tool: Schema.String,
	input: Schema.Unknown,
	parentItemId: Schema.optional(AgentItemId),
	backgroundTask: Schema.optional(
		Schema.Struct({
			taskId: Schema.String,
		}),
	),
	subagent: Schema.optional(
		Schema.Struct({
			childSessionId: Schema.String,
			presentation: Schema.Literals(["inline", "detached"]),
		}),
	),
});

const ToolResultEvent = Schema.TaggedStruct("ToolResult", {
	itemId: AgentItemId,
	output: Schema.Unknown,
	isError: Schema.Boolean,
	parentItemId: Schema.optional(AgentItemId),
});

const PermissionRequestEvent = Schema.TaggedStruct("PermissionRequest", {
	itemId: AgentItemId,
	kind: Schema.String,
	details: Schema.Unknown,

	parentItemId: Schema.optional(AgentItemId),
});

const SubagentSummaryEvent = Schema.TaggedStruct("SubagentSummary", {
	itemId: AgentItemId,
	agentName: Schema.String,
	model: Schema.String,
	turns: Schema.Number,
	durationMs: Schema.Number,
	summary: Schema.String,
	isError: Schema.Boolean,
	childSessionId: Schema.optional(Schema.String),
	presentation: Schema.optional(Schema.Literals(["inline", "detached"])),
});

const SubagentProgressEvent = Schema.TaggedStruct("SubagentProgress", {
	rootCompleted: Schema.optional(Schema.Boolean),
	childId: Schema.String,
	parentId: Schema.String,
	childSessionId: Schema.String,
	status: Schema.String,
	durationMs: Schema.Number,
	turns: Schema.Number,
	toolCalls: Schema.Number,
	tokens: Schema.Number,
	contextPercentage: Schema.Number,
	toolsUsed: Schema.Array(Schema.String),
	errorCount: Schema.Number,
});

const UsageDeltaEvent = Schema.TaggedStruct("UsageDelta", {
	parentItemId: Schema.optional(AgentItemId),
	inputTokens: Schema.Number,
	outputTokens: Schema.Number,
	cacheReadTokens: Schema.Number,
	cacheCreationTokens: Schema.Number,
	model: Schema.String,
});

export const ContextUsagePrecision = Schema.Literals([
	"exact",
	"estimated",
	"capacity-only",
]);
export type ContextUsagePrecision = typeof ContextUsagePrecision.Type;

const ContextUsageEvent = Schema.TaggedStruct("ContextUsage", {
	providerId: ProviderId,
	usedTokens: Schema.NullOr(Schema.Number),
	windowTokens: Schema.NullOr(Schema.Number),
	precision: ContextUsagePrecision,
	source: Schema.optional(Schema.String),
});

const ContextCompactionEvent = Schema.TaggedStruct("ContextCompaction", {
	itemId: AgentItemId,
	providerId: ProviderId,
	startedAt: Schema.Number,
	durationMs: Schema.Number,
	beforeTokens: Schema.NullOr(Schema.Number),
	afterTokens: Schema.NullOr(Schema.Number),
	status: Schema.Literals(["in_progress", "completed", "failed"]),
});

export const UsageLimitScope = Schema.Literals([
	"session",
	"weekly",
	"model",
	"overall",
]);
export type UsageLimitScope = typeof UsageLimitScope.Type;

const UsageLimitEvent = Schema.TaggedStruct("UsageLimit", {
	id: Schema.optional(Schema.String),
	scope: Schema.optional(UsageLimitScope),
	providerId: ProviderId,
	label: Schema.String,
	usedPercent: Schema.NullOr(Schema.Number),

	resetsAt: Schema.NullOr(Schema.String),
	windowMinutes: Schema.NullOr(Schema.Number),
});

const ProviderTurnStartedEvent = Schema.TaggedStruct("ProviderTurnStarted", {});

const CompletedEvent = Schema.TaggedStruct("Completed", {
	reason: Schema.Literals(["ended", "interrupted", "error"]),
});

const InterruptedEvent = Schema.TaggedStruct("Interrupted", {});

const ErrorEvent = Schema.TaggedStruct("Error", {
	message: Schema.String,

	kind: Schema.optional(AgentErrorKind),

	providerId: Schema.optional(ProviderId),
});

/**
 * Driver-emitted side-channel for the SDK's resume token. Claude exposes
 * its session UUID as `session_id` on every message; Codex exposes its
 * thread id via the `thread.started` event. Each driver captures the token
 * on first sight and emits this event so the conversation domain can persist it onto
 * `sessions.cursor` / `sessions.resume_strategy`. Lifecycle-only — never
 * persisted as a chat row.
 */
export const ProviderResumeStrategy = Schema.Literals([
	"claude-session-id",
	"codex-thread-id",
	"grok-session-id",
	"cursor-session-id",
	"gemini-session-id",
	"opencode-session-id",
	"opencode2-session-id",
	"kiro-session-id",
	"pi-session-file",
	"zuse-execution-id",
]);
export type ProviderResumeStrategy = typeof ProviderResumeStrategy.Type;

/** Strong provider-native identity for one execution; never inferred from prompt text. */
export const ProviderTurnReference = Schema.Struct({
	provider: ProviderId,
	nativeThreadId: Schema.String,
	nativeTurnId: Schema.String,
});
export type ProviderTurnReference = typeof ProviderTurnReference.Type;

const NativeTurnStartedEvent = Schema.TaggedStruct("NativeTurnStarted", {
	reference: ProviderTurnReference,
});

const SessionCursorEvent = Schema.TaggedStruct("SessionCursor", {
	cursor: Schema.String,
	providerEventCursor: Schema.optional(Schema.String),
	strategy: ProviderResumeStrategy,
});

const ProviderNotificationMetadataEvent = Schema.TaggedStruct(
	"ProviderNotificationMetadata",
	{
		eventId: Schema.optional(Schema.String),
		promptId: Schema.optional(Schema.String),
		isReplay: Schema.Boolean,
		timestampMs: Schema.optional(Schema.Number),
		streamStartMs: Schema.optional(Schema.Number),
		turnStartMs: Schema.optional(Schema.Number),
		totalTokens: Schema.optional(Schema.Number),
		stopReason: Schema.optional(Schema.String),
	},
);

/**
 * Structured question shape used by both `UserQuestionEvent` and the
 * persisted `userQuestion` message row: a question with N preset options and
 * optional multi-select. The renderer always offers an additional "Other"
 * free-text field — there is no need to include it in `options`.
 */
export const UserQuestion = Schema.Struct({
	question: Schema.String,
	options: Schema.Array(Schema.String),
	multiSelect: Schema.optional(Schema.Boolean),
});
export type UserQuestion = typeof UserQuestion.Type;

const UserQuestionResolvedEvent = Schema.TaggedStruct("UserQuestionResolved", {
	itemId: AgentItemId,
	resolution: Schema.Literals(["cancelled", "timed-out"]),
});

const UserQuestionEvent = Schema.TaggedStruct("UserQuestion", {
	itemId: AgentItemId,
	questions: Schema.Array(UserQuestion),
	parentItemId: Schema.optional(AgentItemId),
});

export const PlanApprovalOutcome = Schema.Literals([
	"approved",
	"cancelled",
	"abandoned",
]);
export type PlanApprovalOutcome = typeof PlanApprovalOutcome.Type;

const PlanApprovalRequestedEvent = Schema.TaggedStruct(
	"PlanApprovalRequested",
	{
		sessionId: AgentSessionId,
		toolCallId: AgentItemId,
		plan: Schema.String,
	},
);

const PermissionModeChangedEvent = Schema.TaggedStruct(
	"PermissionModeChanged",
	{ mode: PermissionMode },
);

const GoalStatus = Schema.Literals([
	"active",
	"paused",
	"budgetLimited",
	"usageLimited",
	"blocked",
	"complete",
]);

const GoalPayload = Schema.Struct({
	threadId: Schema.String,
	objective: Schema.String,
	status: GoalStatus,
	tokenBudget: Schema.NullOr(Schema.Number),
	tokensUsed: Schema.Number,
	timeUsedSeconds: Schema.Number,
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
});

const GoalUpdatedEvent = Schema.TaggedStruct("GoalUpdated", {
	goal: GoalPayload,
});

const GoalClearedEvent = Schema.TaggedStruct("GoalCleared", {});

export const AgentEvent = Schema.Union([
	StartedEvent,
	StatusEvent,
	AuthEvent,
	VersionEvent,
	CapabilitiesEvent,
	AssistantMessageEvent,
	ThinkingEvent,
	ToolUseEvent,
	ToolResultEvent,
	PermissionRequestEvent,
	SubagentSummaryEvent,
	SubagentProgressEvent,
	UsageDeltaEvent,
	ContextUsageEvent,
	ContextCompactionEvent,
	UsageLimitEvent,
	SessionCursorEvent,
	NativeTurnStartedEvent,
	ProviderNotificationMetadataEvent,
	UserQuestionEvent,
	UserQuestionResolvedEvent,
	PlanApprovalRequestedEvent,
	PermissionModeChangedEvent,
	GoalUpdatedEvent,
	GoalClearedEvent,
	ProviderTurnStartedEvent,
	CompletedEvent,
	InterruptedEvent,
	ErrorEvent,
]);
export type AgentEvent = typeof AgentEvent.Type;

/**
 * Application-owned correlation envelope for provider runtime events.
 * Provider-native identifiers remain adapter metadata; every event that can
 * mutate a turn projection carries the exact application turn id supplied to
 * `send`/`interrupt`.
 */
export const ProviderAttemptOwnership = Schema.Struct({
	turnId: AgentTurnId,
	attemptId: AttemptId,
});
export type ProviderAttemptOwnership = typeof ProviderAttemptOwnership.Type;

export const ProviderEventEnvelope = Schema.Union([
	Schema.Struct({
		scope: Schema.Literal("session"),
		ownership: Schema.optional(ProviderAttemptOwnership),
		event: AgentEvent,
	}),
	Schema.Struct({
		scope: Schema.Literal("turn"),
		ownership: Schema.optional(ProviderAttemptOwnership),
		turnId: AgentTurnId,
		event: AgentEvent,
	}),
]);
export type ProviderEventEnvelope = typeof ProviderEventEnvelope.Type;

/**
 * Definition of a sub-agent that the main agent can delegate to. Mirror of
 * the Claude Agent SDK's `AgentDefinition` shape (subset we expose now —
 * `skills`, `mcpServers`, `memory`, `effort`, `background`, and `isolation`
 * are reserved for follow-ups).
 *
 * `permissionMode` shadows the session's runtime mode for tool calls made
 * inside this sub-agent — used by `test-runner` to keep Bash prompts on
 * even when the parent session runs in `full-access`.
 */
export const AgentDefinition = Schema.Struct({
	description: Schema.String,
	prompt: Schema.String,
	tools: Schema.optional(Schema.Array(Schema.String)),
	disallowedTools: Schema.optional(Schema.Array(Schema.String)),
	model: Schema.optional(Schema.String),
	maxTurns: Schema.optional(Schema.Number),
	permissionMode: Schema.optional(RuntimeMode),
});
export type AgentDefinition = typeof AgentDefinition.Type;

/**
 * What each model declares about itself — the source of truth the renderer
 * uses to decide whether to show the reasoning picker, plan-mode toggle,
 * and to label WebSearch result behavior. Driver behavior is keyed off the
 * same descriptors so FE and BE stay in lockstep.
 *
 *   - `optionDescriptors`: per-model knobs the composer renders (reasoning,
 *     etc.). Omitting the descriptor hides the control.
 *   - `supportsPlanMode`: whether the plan-mode toggle is shown for this
 *     model. `true` for every model today (native for Claude/Cursor,
 *     emulated via dev-instructions prefix for Codex/Grok/Gemini); set
 *     `false` only when there's a hard reason not to allow planning.
 *   - `supportsWebSearch`: `"native"` (driver emits real results),
 *     `"queryOnly"` (driver emits the query but no results), or omitted
 *     (provider doesn't search).
 */
export const ModelOption = Schema.Struct({
	id: Schema.String,
	label: Schema.String,

	badgeLabel: Schema.optional(Schema.String),

	defaultModel: Schema.optional(Schema.Boolean),

	defaultVisible: Schema.optional(Schema.Boolean),
	optionDescriptors: Schema.optional(Schema.Array(OptionDescriptor)),
	supportsPlanMode: Schema.optional(Schema.Boolean),
	supportsWebSearch: Schema.optional(Schema.Literals(["native", "queryOnly"])),
});
export type ModelOption = typeof ModelOption.Type;

/**
 * The catalog data itself (models, aliases, pricing) lives in
 * `./model-catalog/` — see `BUNDLED_MODEL_CATALOG` and the
 * catalog-parameterized helpers (`defaultModelFor`, `findModelDescriptor`,
 * `resolveModelSlug`, …). Nothing here should read a static model list.
 */

export const StartSessionInput = Schema.Struct({
	/** Internal auxiliary turn: supported adapters remove all tools and hooks. */
	outputOnly: Schema.optional(Schema.Boolean),
	folderId: FolderId,
	providerId: ProviderId,
	mode: SessionMode,
	initialPrompt: Schema.optional(Schema.String),

	initialTurnId: Schema.optional(AgentTurnId),
	initialAttemptId: Schema.optional(AttemptId),

	workspaceInstructions: Schema.optional(Schema.String),

	executionEnv: Schema.optional(Schema.Record(Schema.String, Schema.String)),

	providerAccountHome: Schema.optional(Schema.String),

	sessionId: Schema.optional(AgentSessionId),

	model: Schema.optional(Schema.String),

	agents: Schema.optional(Schema.Record(Schema.String, AgentDefinition)),

	enableSubagents: Schema.optional(Schema.Boolean),

	cwdOverride: Schema.optional(Schema.String),

	permissionMode: Schema.optional(PermissionMode),

	toolSearch: Schema.optional(Schema.Boolean),

	forkFromResume: Schema.optional(Schema.Boolean),

	modelOptions: Schema.optional(Schema.Record(Schema.String, Schema.String)),

	modelDescriptor: Schema.optional(ModelOption),
	/**
	 * Internal: narrows what a hidden server-run session may do. `read-only`
	 * lets the agent read the workspace and call the Zuse tools it was given,
	 * and nothing else: no edits, no shell writes, no other app tools, and it
	 * never prompts the user or asks a question. Nobody is watching a hidden
	 * session, so anything that would prompt is denied instead.
	 */
	toolPolicy: Schema.optional(Schema.Literals(["read-only"])),
});
export type StartSessionInput = typeof StartSessionInput.Type;
export type SessionToolPolicy = NonNullable<StartSessionInput["toolPolicy"]>;

export const SendInput = Schema.Struct({
	sessionId: AgentSessionId,
	text: Schema.String,

	modelOptions: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type SendInput = typeof SendInput.Type;

export const InterruptInput = Schema.Struct({
	sessionId: AgentSessionId,
	turnId: Schema.optional(AgentTurnId),
});
export type InterruptInput = typeof InterruptInput.Type;

export const CloseInput = Schema.Struct({
	sessionId: AgentSessionId,
});
export type CloseInput = typeof CloseInput.Type;

export const SetCredentialInput = Schema.Struct({
	providerId: ProviderId,
	apiKey: Schema.String,
});
export type SetCredentialInput = typeof SetCredentialInput.Type;

export const CredentialSetResult = Schema.Struct({
	verification: Schema.Literals(["verified", "unverified", "notChecked"]),
	warning: Schema.optional(Schema.String),
});
export type CredentialSetResult = typeof CredentialSetResult.Type;

export class ProviderNotAvailableError extends Schema.TaggedErrorClass<ProviderNotAvailableError>()(
	"ProviderNotAvailableError",
	{ providerId: ProviderId, reason: Schema.String },
) {}

export class AgentSessionNotFoundError extends Schema.TaggedErrorClass<AgentSessionNotFoundError>()(
	"AgentSessionNotFoundError",
	{ sessionId: AgentSessionId },
) {}

export class AgentSessionStartError extends Schema.TaggedErrorClass<AgentSessionStartError>()(
	"AgentSessionStartError",
	{ providerId: ProviderId, reason: Schema.String },
) {}

export class CredentialStoreError extends Schema.TaggedErrorClass<CredentialStoreError>()(
	"CredentialStoreError",
	{ providerId: ProviderId, reason: Schema.String },
) {}

export class CredentialValidationError extends Schema.TaggedErrorClass<CredentialValidationError>()(
	"CredentialValidationError",
	{ providerId: ProviderId, reason: Schema.String },
) {}

export const ProviderAvailabilityRpc = Rpc.make("provider.availability", {
	payload: Schema.Struct({ refresh: Schema.optional(Schema.Boolean) }),
	success: Schema.Array(AgentAvailability),
});

export const ProviderSetCredentialRpc = Rpc.make("provider.setCredential", {
	payload: SetCredentialInput,
	success: CredentialSetResult,
	error: Schema.Union([CredentialStoreError, CredentialValidationError]),
});

export const ProviderRemoveCredentialRpc = Rpc.make(
	"provider.removeCredential",
	{
		payload: Schema.Struct({ providerId: ProviderId }),
		success: Schema.Void,
		error: CredentialStoreError,
	},
);

export const OpencodeInventoryModel = Schema.Struct({
	id: Schema.String,
	label: Schema.String,

	variants: Schema.Array(Schema.String),
});
export type OpencodeInventoryModel = typeof OpencodeInventoryModel.Type;

export const OpencodeInventoryProvider = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	models: Schema.Array(OpencodeInventoryModel),

	connected: Schema.Boolean,

	custom: Schema.Boolean,

	apiKeyEnv: Schema.String,

	apiKeyUrl: Schema.String,
});
export type OpencodeInventoryProvider = typeof OpencodeInventoryProvider.Type;

export const OpencodeInventoryAgent = Schema.Struct({
	name: Schema.String,
	mode: Schema.Literals(["primary", "all"]),

	description: Schema.optional(Schema.NullOr(Schema.String)),
});
export type OpencodeInventoryAgent = typeof OpencodeInventoryAgent.Type;

export const OpencodeInventory = Schema.Struct({
	providers: Schema.Array(OpencodeInventoryProvider),
	agents: Schema.Array(OpencodeInventoryAgent),
});
export type OpencodeInventory = typeof OpencodeInventory.Type;

export const KiroInventoryModel = Schema.Struct({
	id: Schema.String,
	label: Schema.String,
	description: Schema.NullOr(Schema.String),
	contextWindow: Schema.NullOr(Schema.Number),
	rateMultiplier: Schema.NullOr(Schema.Number),
	supportsImages: Schema.Boolean,
});
export type KiroInventoryModel = typeof KiroInventoryModel.Type;

export const KiroInventory = Schema.Struct({
	models: Schema.Array(KiroInventoryModel),
	defaultModelId: Schema.String,
});
export type KiroInventory = typeof KiroInventory.Type;

/** A single model exposed by a user-defined OpenAI-compatible provider. */
export const OpencodeCustomModel = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
});
export type OpencodeCustomModel = typeof OpencodeCustomModel.Type;

/**
 * User-defined OpenAI-compatible provider. `id` is the slug opencode keys the
 * provider by (also the `auth.set` id); `apiKey` is only present on the
 * add/update RPC payload — it is never persisted to settings.json, only to
 * opencode's `auth.json`.
 */
export const OpencodeCustomProvider = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	baseURL: Schema.String,

	npm: Schema.String,
	models: Schema.Array(OpencodeCustomModel),
});
export type OpencodeCustomProvider = typeof OpencodeCustomProvider.Type;

export const ProviderOpencodeSetAuthRpc = Rpc.make(
	"provider.opencode.setAuth",
	{
		payload: Schema.Struct({
			providerId: Schema.String,
			apiKey: Schema.String,
		}),
		success: Schema.Void,
		error: AgentSessionStartError,
	},
);

export const ProviderOpencodeRemoveAuthRpc = Rpc.make(
	"provider.opencode.removeAuth",
	{
		payload: Schema.Struct({ providerId: Schema.String }),
		success: Schema.Void,
		error: AgentSessionStartError,
	},
);

export const ProviderOpencodeAddCustomRpc = Rpc.make(
	"provider.opencode.addCustom",
	{
		payload: Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			baseURL: Schema.String,
			npm: Schema.String,
			apiKey: Schema.String,
			models: Schema.Array(OpencodeCustomModel),
		}),
		success: Schema.Void,
		error: AgentSessionStartError,
	},
);

export const ProviderOpencodeRemoveCustomRpc = Rpc.make(
	"provider.opencode.removeCustom",
	{
		payload: Schema.Struct({ id: Schema.String }),
		success: Schema.Void,
		error: AgentSessionStartError,
	},
);

export const ProviderOpencode2SetAuthRpc = Rpc.make(
	"provider.opencode2.setAuth",
	{
		payload: Schema.Struct({
			providerId: Schema.String,
			apiKey: Schema.String,
		}),
		success: Schema.Void,
		error: AgentSessionStartError,
	},
);

export const ProviderOpencode2RemoveAuthRpc = Rpc.make(
	"provider.opencode2.removeAuth",
	{
		payload: Schema.Struct({ providerId: Schema.String }),
		success: Schema.Void,
		error: AgentSessionStartError,
	},
);

export const ProviderOpencode2AddCustomRpc = Rpc.make(
	"provider.opencode2.addCustom",
	{
		payload: Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			baseURL: Schema.String,
			npm: Schema.String,
			apiKey: Schema.String,
			models: Schema.Array(OpencodeCustomModel),
		}),
		success: Schema.Void,
		error: AgentSessionStartError,
	},
);

export const ProviderOpencode2RemoveCustomRpc = Rpc.make(
	"provider.opencode2.removeCustom",
	{
		payload: Schema.Struct({ id: Schema.String }),
		success: Schema.Void,
		error: AgentSessionStartError,
	},
);

export const LoginEvent = Schema.Union([
	Schema.TaggedStruct("url", { url: Schema.String }),
	Schema.TaggedStruct("log", { text: Schema.String }),
	Schema.TaggedStruct("done", {
		ok: Schema.Boolean,
		reason: Schema.optional(Schema.String),
	}),
]);
export type LoginEvent = typeof LoginEvent.Type;

export const ProviderStartLoginRpc = Rpc.make("provider.startLogin", {
	payload: Schema.Struct({
		providerId: ProviderId,
		accountId: Schema.optional(Schema.String),
		sessionId: Schema.optional(AgentSessionId),
	}),
	success: LoginEvent,
	error: AgentSessionStartError,
	stream: true,
});

export const ProviderUpdateEvent = Schema.Union([
	Schema.TaggedStruct("log", { text: Schema.String }),
	Schema.TaggedStruct("done", {
		ok: Schema.Boolean,
		reason: Schema.optional(Schema.String),
	}),
]);
export type ProviderUpdateEvent = typeof ProviderUpdateEvent.Type;

export const ProviderUpdateRpc = Rpc.make("provider.update", {
	payload: Schema.Struct({ providerId: ProviderId }),
	success: ProviderUpdateEvent,
	error: AgentSessionStartError,
	stream: true,
});
