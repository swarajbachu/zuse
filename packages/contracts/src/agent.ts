import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

import { AgentItemId, AgentSessionId, AgentTurnId, FolderId } from "./ids.ts";

/**
 * Identifier for a provider implementation (driver). v1 ships claude + codex;
 * the literal union is the contract — adding a new provider is an additive
 * change here plus a new driver in `@zuse/agents`.
 */
export const ProviderId = Schema.Literals([
  "claude",
  "codex",
  "grok",
  "gemini",
  "cursor",
  "opencode",
]);
export type ProviderId = typeof ProviderId.Type;

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
 *   - `approval-required` — prompt every write/Bash/Network/Task/MCP call.
 *   - `auto-accept-edits` — also auto-allow Edit / Write / MultiEdit /
 *     NotebookEdit. Bash / Network / Task / MCP still prompt.
 *   - `auto-accept-edits-and-bash` — auto-allow file edits AND Bash. Network
 *     (WebFetch / WebSearch) and MCP/Other still prompt.
 *   - `full-access` — auto-allow everything except sensitive paths. Plan
 *     mode (ExitPlanMode) ALWAYS prompts regardless of runtime mode.
 */
export const RuntimeMode = Schema.Literals([
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
  /**
   * Option ids in this list are *prompt-injected* rather than forwarded to
   * the SDK as a knob value. The driver prepends the option id (e.g. the
   * literal word for a prompt-only mode) to the user prompt and unsets the
   * underlying SDK field.
   */
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

/**
 * Static availability report for a provider — does the user have the CLI on
 * PATH, is the CLI logged in (so the SDK can ride the local OAuth subprocess),
 * is an API key stored in the keychain. Either `cliLoggedIn` or `hasApiKey`
 * is enough to start a session; the renderer should treat them as equivalent
 * "ready" signals and prefer CLI login as the primary path.
 */
export const AgentAvailability = Schema.Struct({
  providerId: ProviderId,
  displayName: Schema.String,
  cliInstalled: Schema.Boolean,
  cliVersion: Schema.optional(Schema.String),
  cliPath: Schema.optional(Schema.String),
  cliLoggedIn: Schema.Boolean,
  hasApiKey: Schema.Boolean,
  /**
   * Computed verdict on whether `cliVersion` meets the SDK's minimum. The
   * renderer renders an "Upgrade Codex" card when this is `"outdated"` so
   * the user sees the upgrade path *before* attempting to start a session.
   */
  cliVersionStatus: Schema.optional(CliVersionStatus),
  /**
   * Minimum CLI version the bundled SDK requires (e.g. `"0.128.0"`). Set in
   * tandem with `cliVersionStatus`; rendered inside the upgrade card.
   */
  cliVersionMinRequired: Schema.optional(Schema.String),
  /**
   * Version-gated features the *installed CLI* supports, computed by comparing
   * `cliVersion` against per-feature floors (see `CODEX_FEATURE_FLOORS` in
   * availability.ts). Values are {@link CodexFeature} ids. Empty/omitted when
   * the version is unknown or no features are gated for this provider. The
   * renderer reads this to show/hide feature controls *before* a session
   * exists (the live `model/list` `serviceTiers` refine it per-model once a
   * session is connected — see the `Capabilities` event).
   */
  capabilities: Schema.optional(Schema.Array(Schema.String)),
  /**
   * One-line shell command we recommend the user run to fix an outdated
   * CLI. Co-located with the version probe so renderer doesn't need its
   * own per-provider install lookup.
   */
  cliUpgradeCommand: Schema.optional(Schema.String),
  /**
   * Latest version published to the registry (e.g. `"1.0.140"`), when we were
   * able to resolve one. Set in tandem with `latestVersionStatus`.
   */
  latestVersion: Schema.optional(Schema.String),
  /**
   * Verdict on whether a newer published release exists. Drives the
   * informational "update available" UI (hover icon + launch toast) — never
   * blocks a session. `"unknown"` for providers we don't version-check (no
   * registry package) or when the registry lookup failed.
   */
  latestVersionStatus: Schema.optional(LatestVersionStatus),
  /**
   * Copy-able one-liner the user can run to update to the latest published
   * release (e.g. `"npm i -g @openai/codex@latest"`). Distinct from
   * `cliUpgradeCommand` (which targets the blocking SDK floor) — though they
   * often coincide.
   */
  updateCommand: Schema.optional(Schema.String),
  /**
   * Verified auth state. Distinct from `cliLoggedIn` (which only checks for
   * a credential file): set when an out-of-process probe (Codex
   * `account/read`, Claude credentials.json parse, etc.) confirmed the
   * credential is live.
   */
  authStatus: Schema.optional(ProviderAuthStatus),
  /** Account email pulled from the verified credential, when available. */
  authEmail: Schema.optional(Schema.String),
  /** Human-readable subscription label, e.g. "ChatGPT Plus Subscription". */
  authLabel: Schema.optional(Schema.String),
  /** Kind of credential, e.g. "chatgpt", "apiKey", "amazonBedrock". */
  authType: Schema.optional(Schema.String),
  /**
   * Rolled-up health verdict for the dot color in settings. Optional so
   * older clients without server-side classification just see a neutral
   * card — the renderer falls back to deriving from cliInstalled / login.
   */
  status: Schema.optional(ProviderHealthStatus),
  /**
   * One-line user-facing detail to render under the headline when status
   * is `warning` or `error` — typically the underlying probe error.
   */
  statusMessage: Schema.optional(Schema.String),
  /**
   * Wall-clock time of the most recent probe. Renderer renders this as
   * "Checked X ago" in the providers settings header. Encoded as an ISO
   * string over the wire so it survives the RPC's JSON hop.
   */
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

// ---------------------------------------------------------------------------
// Provider event union consumed by the conversation runtime. The split is
// intentionally broad so ingestion can handle each kind without a giant
// switch on payload shape.
// ---------------------------------------------------------------------------

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

const AssistantMessageEvent = Schema.TaggedStruct("AssistantMessage", {
  itemId: AgentItemId,
  text: Schema.String,
  /** True when the provider emitted a dedicated final plan item. */
  isPlan: Schema.optional(Schema.Boolean),
  // `parentItemId` is set when this message originated inside a sub-agent —
  // the value is the parent's `Agent` tool_use itemId so the renderer can
  // group nested rows under one collapsible wrapper. Absent for top-level.
  parentItemId: Schema.optional(AgentItemId),
});

const ThinkingEvent = Schema.TaggedStruct("Thinking", {
  itemId: AgentItemId,
  text: Schema.String,
  redacted: Schema.Boolean,
  parentItemId: Schema.optional(AgentItemId),
});

/**
 * Normalized Tool-Call Contract
 * -----------------------------
 * All drivers emit `ToolUseEvent` / `ToolResultEvent` with the canonical
 * shape Claude produces. The renderer at
 * `apps/renderer/src/components/tool-row.tsx` switches on `tool` and reads
 * specific keys out of `input` — to keep every provider's row rendering
 * identical, ACP drivers translate native frames into these shapes
 * (`@zuse/agents/drivers/acp/translate`).
 *
 *   tool          input keys                              result `output`
 *   ---------     ------------------------------------    -------------------
 *   Edit          { file_path, old_string, new_string }   diff text or {}
 *   MultiEdit     { file_path, edits: [...] }             diff text or {}
 *   Write         { file_path, content }                  ""
 *   Read          { file_path, offset?, limit? }          file slice (string
 *                                                          or [{type:"text"}])
 *   Bash          { command, description? }               stdout/stderr text
 *                 `description` only when it's a human-written summary
 *                 distinct from the command — drivers must not echo the
 *                 command / first line / title into it (see
 *                 `isRedundantShellDescription` in `shell-display.ts`).
 *   Grep          { pattern, path?, glob?, output_mode? } match listing
 *   Glob          { pattern, path? }                      file listing
 *   WebSearch     { query }                               result array (or
 *                                                          empty for
 *                                                          `queryOnly` models)
 *   WebFetch      { url, prompt? }                        page summary text
 *   TodoWrite     { todos: [...] }                        ""
 *
 * Adding a new tool: extend this block AND add a `case` in tool-row.tsx so
 * the renderer knows how to label/render it. Unknown tools fall through to
 * the default Wrench row, which is correct but unstyled.
 */
const ToolUseEvent = Schema.TaggedStruct("ToolUse", {
  itemId: AgentItemId,
  tool: Schema.String,
  input: Schema.Unknown,
  parentItemId: Schema.optional(AgentItemId),
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

/**
 * Phase 3 surface — the SDK asks the user before doing something dangerous
 * (running a shell command, writing outside the workspace, etc.). v2 just
 * auto-denies and emits this so the UI can toast "Phase 3 will let you allow
 * this."
 */
const PermissionRequestEvent = Schema.TaggedStruct("PermissionRequest", {
  itemId: AgentItemId,
  kind: Schema.String,
  details: Schema.Unknown,
  // Carries the parent Agent tool_use itemId when the requesting tool ran
  // inside a sub-agent context. The toast prepends "via <name> · <model> ·"
  // when set so the user sees who's actually asking.
  parentItemId: Schema.optional(AgentItemId),
});

/**
 * Closing summary for a sub-agent run. Emitted when the parent's
 * `Agent` tool_result lands; the wrapper-row footer reads from this when
 * collapsed.
 */
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

/**
 * Per-turn token usage. Emitted on every SDK `result` message; tagged with
 * `parentItemId` when the result belongs to a sub-agent. The renderer
 * accumulates these into the per-agent footer.
 */
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
  status: Schema.Literals(["in_progress", "completed"]),
});

const UsageLimitEvent = Schema.TaggedStruct("UsageLimit", {
  providerId: ProviderId,
  label: Schema.String,
  usedPercent: Schema.NullOr(Schema.Number),
  // ISO-8601 string, not a `Date` schema: the value crosses IPC and the
  // persistence layer as JSON, and a `DateFromString` transform trips the
  // struct constructor (which validates against the decoded `Date` side).
  resetsAt: Schema.NullOr(Schema.String),
  windowMinutes: Schema.NullOr(Schema.Number),
});

const CompletedEvent = Schema.TaggedStruct("Completed", {
  reason: Schema.Literals(["ended", "interrupted", "error"]),
});

/**
 * Emitted when the user interrupts a running turn. Unlike `Error`, this is a
 * normal user action — the renderer shows a muted "Interrupted by user" badge
 * (no red error bubble) and the session stays out of the error state. Drivers
 * emit this in place of `Error` when they know the turn ended because of an
 * explicit interrupt (see the Claude driver, which otherwise surfaces the
 * SDK's `error_during_execution` result as a bogus error).
 */
const InterruptedEvent = Schema.TaggedStruct("Interrupted", {});

const ErrorEvent = Schema.TaggedStruct("Error", {
  message: Schema.String,
  /**
   * Optional classifier so the renderer can pick the right CTA without
   * regexing the message. Drivers set this when they have positive evidence
   * (e.g. Codex SDK reported a 401, or fetch threw ECONN). Absent → the
   * renderer falls back to its own heuristic classification.
   */
  kind: Schema.optional(AgentErrorKind),
  /** Provider that produced the error, when known. */
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
const SessionCursorEvent = Schema.TaggedStruct("SessionCursor", {
  cursor: Schema.String,
  strategy: Schema.Literals([
    "claude-session-id",
    "codex-thread-id",
    "grok-session-id",
    "cursor-session-id",
    "gemini-session-id",
    "opencode-session-id",
  ]),
});

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

/**
 * Emitted when the agent calls the in-process `AskUserQuestion` tool. The
 * renderer subscribes to this and renders a question card. `itemId` is the
 * SDK's `tool_use.id` so the eventual answer maps back to a single tool
 * call.
 */
const UserQuestionEvent = Schema.TaggedStruct("UserQuestion", {
  itemId: AgentItemId,
  questions: Schema.Array(UserQuestion),
  parentItemId: Schema.optional(AgentItemId),
});

/**
 * Emitted when `Query.setPermissionMode` succeeds. The renderer uses it to
 * keep the chat-header chip in sync without a round-trip.
 */
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
  UsageDeltaEvent,
  ContextUsageEvent,
  ContextCompactionEvent,
  UsageLimitEvent,
  SessionCursorEvent,
  UserQuestionEvent,
  PermissionModeChangedEvent,
  GoalUpdatedEvent,
  GoalClearedEvent,
  CompletedEvent,
  InterruptedEvent,
  ErrorEvent,
]);
export type AgentEvent = typeof AgentEvent.Type;

// ---------------------------------------------------------------------------
// RPC inputs
// ---------------------------------------------------------------------------

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

export const StartSessionInput = Schema.Struct({
  folderId: FolderId,
  providerId: ProviderId,
  mode: SessionMode,
  initialPrompt: Schema.optional(Schema.String),
  /**
   * Internal Zuse-provided workspace context. The renderer does not set this;
   * ProviderService fills it after resolving the project/worktree cwd so
   * drivers can pass it through native system/developer instruction channels
   * where available.
   */
  workspaceInstructions: Schema.optional(Schema.String),
  // Optional caller-supplied id. When omitted, ProviderService mints a fresh
  // one. The conversation domain uses this to lazy-restart a closed session without
  // moving its persisted history to a new row.
  sessionId: Schema.optional(AgentSessionId),
  // Optional provider-specific model id (e.g. "claude-opus-4-7"). Drivers
  // forward it to the SDK; omitting it lets the SDK pick its own default.
  model: Schema.optional(Schema.String),
  // Sub-agents the main agent may delegate to. Keys are the `subagent_type`
  // the SDK reports back on `Agent` tool_use blocks; values define each
  // sub-agent's prompt, tool subset, model, and permission mode. Empty /
  // omitted means no sub-agents — session behaves as before.
  agents: Schema.optional(Schema.Record(Schema.String, AgentDefinition)),
  // Master toggle. When the renderer wants to start a Claude session with
  // sub-agents disabled even though presets exist, it sends this as false.
  // Defaults true when `agents` is non-empty; the driver only adds `Agent`
  // to `allowedTools` when the effective value is true.
  enableSubagents: Schema.optional(Schema.Boolean),
  /**
   * Optional absolute path the agent should run in. When omitted, the
   * provider resolves cwd from `folderId` (the project's main checkout).
   * The conversation domain populates this with a worktree path when a session was
   * created against a worktree, so the SDK runs in the worktree dir.
   */
  cwdOverride: Schema.optional(Schema.String),
  /**
   * SDK lifecycle mode passed to `Options.permissionMode`. Defaults to
   * `default`. Pass `plan` to start the session in plan mode — the agent
   * will explore read-only and propose a plan via `ExitPlanMode`.
   */
  permissionMode: Schema.optional(PermissionMode),
  /**
   * When true, future MCP servers register without `alwaysLoad`, letting
   * the SDK delegate to its built-in tool search instead of inflating the
   * tool list every turn. No-op today (no MCP tools shipped yet); ready
   * for 0.04.
   */
  toolSearch: Schema.optional(Schema.Boolean),
  /**
   * When true AND a resume cursor is supplied, the driver FORKS the resumed
   * transcript into a fresh provider session instead of continuing it
   * (Claude `Options.forkSession`, Codex `thread/fork`), leaving the source
   * transcript untouched. Ignored without a resume cursor, and by providers
   * that lack native fork support (they fall back to a transcript copy at a
   * higher layer). Backs the "Fork chat" feature.
   */
  forkFromResume: Schema.optional(Schema.Boolean),
  /**
   * Opaque per-model knob values. Keys map to
   * `ModelDescriptor.optionDescriptors[].id` (e.g. `"reasoning"`); values
   * are the selected option id (for example, `"low"` or `"ultra"`) for
   * selects or `"true" | "false"` for booleans. Drivers consume what they support
   * and ignore the rest — the FE composer renders only the descriptors
   * the current model declared, so no value should arrive that the driver
   * can't interpret.
   */
  modelOptions: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type StartSessionInput = typeof StartSessionInput.Type;

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
export interface ModelOption {
  readonly id: string;
  readonly label: string;
  /**
   * Optional small picker badge for launch/newness callouts.
   */
  readonly badgeLabel?: string;
  /**
   * Preferred default for this provider. When omitted, the first visible model
   * remains the fallback default.
   */
  readonly defaultModel?: boolean;
  /**
   * Whether this model appears in normal picker/default selectors before the
   * user opts it back in from provider settings. Omitted means visible.
   */
  readonly defaultVisible?: boolean;
  readonly optionDescriptors?: ReadonlyArray<OptionDescriptor>;
  readonly supportsPlanMode?: boolean;
  readonly supportsWebSearch?: "native" | "queryOnly";
}

/**
 * Reasoning descriptor for Codex/Gemini/Cursor and the `reasoning` knob name
 * used across non-Claude providers. Models can append provider-supported
 * tiers beyond the standard low/medium/high set.
 */
const reasoningSelectDescriptor = (
  defaultId: ReasoningLevel = "medium",
  additionalOptions: ReadonlyArray<{ id: ReasoningLevel; label: string }> = [],
): SelectOptionDescriptor => ({
  kind: "select",
  id: "reasoning",
  label: "Reasoning",
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
    ...additionalOptions,
  ],
  defaultId,
});

const extraHighReasoningOption = {
  id: "xhigh",
  label: "Extra High",
} as const;

const gpt56ExtendedReasoningOptions = [
  extraHighReasoningOption,
  { id: "max", label: "Max" },
  { id: "ultra", label: "Ultra" },
] as const;

const gpt56Model = (id: string, label: string): ModelOption => ({
  id,
  label,
  optionDescriptors: [
    reasoningSelectDescriptor("medium", gpt56ExtendedReasoningOptions),
  ],
  supportsPlanMode: true,
  supportsWebSearch: "native",
});

/**
 * Per-model effort descriptor for the Claude provider. Each model declares
 * its own supported tiers (see `MODELS_BY_PROVIDER.claude` below); `ultracode`
 * is special — see `ReasoningLevel` docs. The knob id is `effort` rather
 * than `reasoning` to make driver-side mapping explicit.
 */
const claudeEffortDescriptor = (args: {
  options: ReadonlyArray<{ id: string; label: string }>;
  defaultId: string;
  promptInjectedValues?: ReadonlyArray<string>;
}): SelectOptionDescriptor => ({
  kind: "select",
  id: "effort",
  label: "Reasoning",
  options: args.options,
  defaultId: args.defaultId,
  ...(args.promptInjectedValues !== undefined
    ? { promptInjectedValues: args.promptInjectedValues }
    : {}),
});

/**
 * Boolean descriptor for a per-model toggle. Used by Claude (`fastMode` halves
 * the token cost and roughly doubles throughput at the cost of some quality;
 * `thinking` enables Haiku 4.5's always-on adaptive thinking) and by Codex
 * (`fastMode` → `serviceTier: "fast"`, the 1.5× speed tier on the latest
 * models). The driver keys behavior off the descriptor `id`.
 */
const booleanDescriptor = (
  id: string,
  label: string,
): BooleanOptionDescriptor => ({
  kind: "boolean",
  id,
  label,
});

/**
 * Standard `contextWindow` descriptor used by every Claude 4.x model that
 * supports the 1M variant. Driver-side, picking `"1m"` rewrites the API
 * model id to `${slug}[1m]`. We default to `"1m"` because Anthropic now
 * routes most Claude 4.x sessions to the 1M window by default.
 */
const claudeContextWindowDescriptor = (): SelectOptionDescriptor => ({
  kind: "select",
  id: "contextWindow",
  label: "Context Window",
  options: [
    { id: "200k", label: "200k" },
    { id: "1m", label: "1M" },
  ],
  defaultId: "1m",
});

const staticContextWindowDescriptor = (
  id: string,
  label: string,
): SelectOptionDescriptor => ({
  kind: "select",
  id: "contextWindow",
  label: "Context Window",
  options: [{ id, label }],
  defaultId: id,
});

export const MODELS_BY_PROVIDER: Record<
  ProviderId,
  ReadonlyArray<ModelOption>
> = {
  // Claude catalog. Effort tiers and per-model knobs match
  // the published Claude Agent SDK contract. Ordering = newest first so the
  // picker accordion opens on the latest recommended model by default.
  claude: [
    {
      id: "claude-fable-5",
      label: "Fable 5",
      badgeLabel: "Available now",
      optionDescriptors: [
        claudeEffortDescriptor({
          options: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
            { id: "xhigh", label: "Extra High" },
            { id: "max", label: "Max" },
            { id: "ultracode", label: "Ultracode" },
          ],
          defaultId: "high",
        }),
        booleanDescriptor("fastMode", "Fast Mode"),
        claudeContextWindowDescriptor(),
      ],
      supportsPlanMode: true,
      supportsWebSearch: "native",
    },
    {
      id: "claude-sonnet-5",
      label: "Sonnet 5",
      badgeLabel: "New",
      defaultModel: true,
      optionDescriptors: [
        claudeEffortDescriptor({
          options: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
            { id: "max", label: "Max" },
            { id: "ultracode", label: "Ultracode" },
          ],
          defaultId: "high",
        }),
        claudeContextWindowDescriptor(),
      ],
      supportsPlanMode: true,
      supportsWebSearch: "native",
    },
    {
      id: "claude-opus-4-8",
      label: "Opus 4.8",
      optionDescriptors: [
        claudeEffortDescriptor({
          options: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
            { id: "xhigh", label: "Extra High" },
            { id: "max", label: "Max" },
            { id: "ultracode", label: "Ultracode" },
          ],
          defaultId: "high",
        }),
        booleanDescriptor("fastMode", "Fast Mode"),
        claudeContextWindowDescriptor(),
      ],
      supportsPlanMode: true,
      supportsWebSearch: "native",
    },
    {
      id: "claude-opus-4-7",
      label: "Opus 4.7",
      optionDescriptors: [
        claudeEffortDescriptor({
          options: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
            { id: "xhigh", label: "Extra High" },
            { id: "max", label: "Max" },
            { id: "ultracode", label: "Ultracode" },
          ],
          defaultId: "xhigh",
        }),
        booleanDescriptor("fastMode", "Fast Mode"),
        claudeContextWindowDescriptor(),
      ],
      supportsPlanMode: true,
      supportsWebSearch: "native",
    },
    {
      id: "claude-opus-4-6",
      label: "Opus 4.6",
      optionDescriptors: [
        claudeEffortDescriptor({
          options: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
            { id: "max", label: "Max" },
            { id: "ultracode", label: "Ultracode" },
          ],
          defaultId: "high",
        }),
        booleanDescriptor("fastMode", "Fast Mode"),
        claudeContextWindowDescriptor(),
      ],
      supportsPlanMode: true,
      supportsWebSearch: "native",
    },
    {
      id: "claude-sonnet-4-6",
      label: "Sonnet 4.6",
      defaultVisible: false,
      optionDescriptors: [
        claudeEffortDescriptor({
          options: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
            { id: "max", label: "Max" },
            { id: "ultracode", label: "Ultracode" },
          ],
          defaultId: "high",
        }),
        claudeContextWindowDescriptor(),
      ],
      supportsPlanMode: true,
      supportsWebSearch: "native",
    },
    {
      id: "claude-haiku-4-5",
      label: "Haiku 4.5",
      optionDescriptors: [booleanDescriptor("thinking", "Thinking")],
      supportsPlanMode: true,
      supportsWebSearch: "native",
    },
  ],
  codex: [
    gpt56Model("gpt-5.6-sol", "GPT-5.6 Sol"),
    gpt56Model("gpt-5.6-terra", "GPT-5.6 Terra"),
    gpt56Model("gpt-5.6-luna", "GPT-5.6 Luna"),
    {
      id: "gpt-5.5",
      label: "GPT-5.5",
      defaultModel: true,
      // Fast tier supported — see gpt-5.4 note above.
      optionDescriptors: [
        reasoningSelectDescriptor("medium", [extraHighReasoningOption]),
        booleanDescriptor("fastMode", "Fast"),
      ],
      supportsPlanMode: true,
      supportsWebSearch: "native",
    },
    {
      id: "gpt-5.4",
      label: "GPT-5.4",
      // `fastMode` → `serviceTier: "fast"`. OpenAI only offers the fast tier on
      // the latest models (GPT-5.4 / GPT-5.5); older Codex CLIs don't accept
      // the field, so the toggle is additionally gated on the `fastMode`
      // capability (CLI version) + the live model's `serviceTiers`.
      optionDescriptors: [
        reasoningSelectDescriptor("medium"),
        booleanDescriptor("fastMode", "Fast"),
      ],
      supportsPlanMode: true,
      supportsWebSearch: "native",
    },
    {
      id: "gpt-5.4-mini",
      label: "GPT-5.4 mini",
      optionDescriptors: [reasoningSelectDescriptor("medium")],
      supportsPlanMode: true,
      supportsWebSearch: "native",
    },
    {
      id: "gpt-5.3-codex",
      label: "GPT-5.3 Codex",
      defaultVisible: false,
      optionDescriptors: [reasoningSelectDescriptor("medium")],
      supportsPlanMode: true,
      supportsWebSearch: "native",
    },
    {
      id: "gpt-5.3-codex-spark",
      label: "GPT-5.3 Codex Spark",
      defaultVisible: false,
      optionDescriptors: [reasoningSelectDescriptor("medium")],
      supportsPlanMode: true,
      supportsWebSearch: "native",
    },
  ],
  // Seed list — Grok CLI's `-m` flag accepts any model id it knows, so a
  // custom slug typed by the user still works; this list is just what the
  // picker shows by default. `grok-build` unlocks with a paid Grok entitlement
  // such as SuperGrok or X Premium+. Passing a slug the account can't access yields
  // a clean 403 surfaced through grok's streaming-json `type: "error"`
  // envelope, so no client-side validation needed.
  grok: [
    {
      id: "grok-build",
      label: "Grok Build",
      supportsPlanMode: true,
      supportsWebSearch: "queryOnly",
    },
    {
      id: "grok-4.5",
      label: "Grok 4.5",
      supportsPlanMode: true,
      supportsWebSearch: "queryOnly",
    },
    {
      id: "grok-composer-2.5-fast",
      label: "Grok Composer 2.5 Fast",
      supportsPlanMode: true,
      supportsWebSearch: "queryOnly",
    },
    {
      id: "grok-4",
      label: "Grok 4",
      defaultVisible: false,
      supportsPlanMode: true,
      supportsWebSearch: "queryOnly",
    },
    {
      id: "grok-4-fast",
      label: "Grok 4 Fast",
      supportsPlanMode: true,
      supportsWebSearch: "queryOnly",
    },
    {
      id: "grok-code-fast-1",
      label: "Grok Code Fast",
      defaultVisible: false,
      supportsPlanMode: true,
      supportsWebSearch: "queryOnly",
    },
  ],
  // Gemini CLI accepts any model slug it knows via the ACP `_meta.model`
  // hint; this list is just what the picker offers by default. Gemini's
  // ACP server does not expose a runtime reasoning-effort knob (the
  // native gemini CLI doesn't show one either), so no reasoning descriptor
  // is declared — the FE picker is hidden across the whole provider.
  gemini: [
    {
      id: "gemini-3-pro-preview",
      label: "Gemini 3 Pro",
      supportsPlanMode: true,
      supportsWebSearch: "queryOnly",
    },
    {
      id: "gemini-3-flash-preview",
      label: "Gemini 3 Flash",
      supportsPlanMode: true,
      supportsWebSearch: "queryOnly",
    },
    {
      id: "gemini-2.5-pro",
      label: "Gemini 2.5 Pro",
      defaultVisible: false,
      supportsPlanMode: true,
      supportsWebSearch: "queryOnly",
    },
    {
      id: "gemini-2.5-flash",
      label: "Gemini 2.5 Flash",
      defaultVisible: false,
      supportsPlanMode: true,
      supportsWebSearch: "queryOnly",
    },
  ],
  // Cursor's CLI exposes its full catalog through `cursor-agent models`
  // (113 entries as of 2026-05). We surface a curated shortlist here; custom
  // slugs typed in the picker still work because this is just the default
  // seed, not a whitelist. Selection is applied at session start via ACP
  // `session/set_config_option { configId: "model" }`. Plan mode lands
  // natively via `setSessionMode("plan")`.
  // Cursor's ACP server validates model slugs against its OWN list which
  // differs from `cursor-agent --list-models`. The valid set lives in the
  // `models.availableModels` block returned by `session/new` — slugs like
  // `composer-2-fast` (the CLI default) are rejected by ACP with -32602.
  // The seed below uses ACP-valid IDs only. The `default` slug means
  // "Auto" (cursor picks). Custom slugs typed in the picker still work.
  cursor: [
    { id: "default", label: "Auto", supportsPlanMode: true },
    { id: "composer-2", label: "Composer 2", supportsPlanMode: true },
    { id: "composer-2.5", label: "Composer 2.5", supportsPlanMode: true },
    { id: "gpt-5.5", label: "GPT-5.5", supportsPlanMode: true },
    {
      id: "gpt-5.3-codex",
      label: "Codex 5.3",
      defaultVisible: false,
      supportsPlanMode: true,
    },
    {
      id: "claude-sonnet-4-6",
      label: "Sonnet 4.6",
      optionDescriptors: [staticContextWindowDescriptor("1m", "1M")],
      supportsPlanMode: true,
    },
    {
      id: "claude-opus-4-7",
      label: "Opus 4.7",
      defaultVisible: false,
      optionDescriptors: [staticContextWindowDescriptor("1m", "1M")],
      supportsPlanMode: true,
    },
    {
      id: "gemini-3.1-pro",
      label: "Gemini 3.1 Pro",
      defaultVisible: false,
      supportsPlanMode: true,
    },
  ],
  // OpenCode is a meta-provider: it spawns a local `opencode serve` and
  // forwards prompts to whichever underlying provider (anthropic, openai,
  // google, …) the user has authenticated locally via `opencode auth login`.
  // Model ids carry a `<providerID>/<modelID>` slug so the driver can split
  // them on the slash before calling `session.prompt`.
  //
  // The list below is the static seed shown when the inventory RPC hasn't
  // resolved yet (or fails). At runtime the renderer calls
  // `agent.opencodeInventory` and replaces this list with the
  // dynamically-discovered set of connected providers + models. The
  // dedicated plan-mode toggle covers build/plan agent switching, so we
  // don't expose an agent dropdown per-model. Reasoning/variant pickers
  // are rendered dynamically from each model's `variants` array.
  opencode: [
    {
      id: "anthropic/claude-sonnet-4-5",
      label: "Anthropic · Claude Sonnet 4.5",
      supportsPlanMode: true,
    },
    {
      id: "openai/gpt-5",
      label: "OpenAI · GPT-5",
      supportsPlanMode: true,
    },
    {
      id: "google/gemini-2.5-pro",
      label: "Google · Gemini 2.5 Pro",
      supportsPlanMode: true,
    },
  ],
};

export const defaultModelFor = (providerId: ProviderId): string =>
  (MODELS_BY_PROVIDER[providerId].find(
    (m) => m.defaultModel === true && m.defaultVisible !== false,
  ) ??
    MODELS_BY_PROVIDER[providerId].find((m) => m.defaultVisible !== false) ??
    MODELS_BY_PROVIDER[providerId][0]!)!.id;

export type ModelEnabledByProvider = Record<
  ProviderId,
  Record<string, boolean>
>;

export const defaultModelEnabledByProvider = (): ModelEnabledByProvider => {
  const out = {} as ModelEnabledByProvider;
  for (const providerId of Object.keys(MODELS_BY_PROVIDER) as ProviderId[]) {
    out[providerId] = {};
    for (const model of MODELS_BY_PROVIDER[providerId]) {
      out[providerId][model.id] = model.defaultVisible !== false;
    }
  }
  return out;
};

export const isModelVisible = (
  providerId: ProviderId,
  modelId: string,
  modelEnabledByProvider?: Partial<
    Record<ProviderId, Partial<Record<string, boolean>>>
  >,
): boolean => {
  const override = modelEnabledByProvider?.[providerId]?.[modelId];
  if (typeof override === "boolean") return override;
  const descriptor = findModelDescriptor(providerId, modelId);
  if (descriptor === undefined) return true;
  return descriptor.defaultVisible !== false;
};

export const visibleModelsForProvider = (
  providerId: ProviderId,
  modelEnabledByProvider?: Partial<
    Record<ProviderId, Partial<Record<string, boolean>>>
  >,
  options?: { readonly includeModelId?: string | null },
): ReadonlyArray<ModelOption> => {
  const includeModelId = options?.includeModelId ?? null;
  return MODELS_BY_PROVIDER[providerId].filter(
    (model) =>
      isModelVisible(providerId, model.id, modelEnabledByProvider) ||
      model.id === includeModelId,
  );
};

/**
 * Look up a model's descriptor by `(providerId, modelId)`. Returns
 * `undefined` when the slug isn't in our curated list (e.g. user typed
 * a custom slug), in which case the caller should fall through to
 * provider-level defaults.
 */
export const findModelDescriptor = (
  providerId: ProviderId,
  modelId: string,
): ModelOption | undefined =>
  MODELS_BY_PROVIDER[providerId].find((m) => m.id === modelId);

/**
 * Aliases for codex model slugs that no longer work — current Codex CLI rejects
 * `gpt-5-codex` / `gpt-5` when the user is on a ChatGPT account. We rewrite
 * persisted user settings and incoming requests through this map so existing
 * sessions don't crash.
 */
export const MODEL_ALIASES_BY_PROVIDER: Record<
  ProviderId,
  Record<string, string>
> = {
  // Short / vendor-formatted slugs and pre-pricing-reset names route to the
  // canonical 4.x slugs above, so a user typing `opus` or `sonnet-4.6`
  // resolves to the current model id.
  claude: {
    opus: "claude-opus-4-8",
    "opus-4.8": "claude-opus-4-8",
    "claude-opus-4.8": "claude-opus-4-8",
    "opus-4.7": "claude-opus-4-7",
    "claude-opus-4.7": "claude-opus-4-7",
    "opus-4.6": "claude-opus-4-6",
    "claude-opus-4.6": "claude-opus-4-6",
    fable: "claude-fable-5",
    "fable-5": "claude-fable-5",
    "claude-fable-5": "claude-fable-5",
    sonnet: "claude-sonnet-5",
    "sonnet-5": "claude-sonnet-5",
    "claude-sonnet-5": "claude-sonnet-5",
    "sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4.6": "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5",
    "haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4.5": "claude-haiku-4-5",
  },
  codex: {
    "gpt-5-codex": "gpt-5.5",
    "gpt-5": "gpt-5.5",
  },
  grok: {
    "grok-4.5-latest": "grok-4.5",
    "grok-build-latest": "grok-4.5",
  },
  gemini: {
    "gemini-3-pro": "gemini-3-pro-preview",
    "gemini-3.1-pro-preview": "gemini-3-pro-preview",
  },
  // Cursor retired the old `gpt-5` / `sonnet-4*` / `opus-4.x` slugs sometime
  // around 2025-11. Existing user settings persisted by earlier builds get
  // re-aliased to current cursor catalogue entries so re-opening the app
  // doesn't send the agent a slug it'll silently ignore.
  cursor: {
    // Legacy slugs from earlier builds (pre-2025.11 cursor-agent CLI list).
    "gpt-5": "composer-2",
    "sonnet-4": "claude-sonnet-4-6",
    "sonnet-4-thinking": "claude-sonnet-4-6",
    "opus-4.1": "claude-opus-4-7",
    // CLI slugs (from `cursor-agent --list-models`) that the ACP server
    // rejects with -32602: it has its own narrower set. Re-route to the
    // closest ACP-valid neighbour so a previously persisted user choice
    // doesn't crash on session start.
    "composer-2-fast": "composer-2",
    "composer-2.5-fast": "composer-2.5",
    "gpt-5.5-medium": "gpt-5.5",
    "gpt-5.5-medium-fast": "gpt-5.5",
    "gpt-5.5-high": "gpt-5.5",
    "gpt-5.5-high-fast": "gpt-5.5",
    "gpt-5.5-low": "gpt-5.5",
    "gpt-5.5-low-fast": "gpt-5.5",
    "gpt-5.5-extra-high": "gpt-5.5",
    "gpt-5.5-extra-high-fast": "gpt-5.5",
    "gpt-5.5-none": "gpt-5.5",
    "gpt-5.5-none-fast": "gpt-5.5",
    "gpt-5.4-high": "gpt-5.4",
    "gpt-5.4-high-fast": "gpt-5.4",
    "gpt-5.3-codex-fast": "gpt-5.3-codex",
    auto: "default",
  },
  opencode: {},
};

export const resolveModelSlug = (
  providerId: ProviderId,
  slug: string,
): string => MODEL_ALIASES_BY_PROVIDER[providerId][slug] ?? slug;

/**
 * Per-million-token USD pricing used by the renderer to compute the
 * "saved ~$X" line in the per-agent cost footer. Numbers are reference
 * values — keep aligned with vendor pricing pages. The wire stays just
 * numbers; conversion to currency happens renderer-side.
 */
export interface ModelPricing {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreate: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // 2026-05 Anthropic pricing reset — every Opus 4.x tier landed at the
  // same $5/$25 per-million numbers. `fastMode` (Opus only) doubles those
  // to $10 in / $50 out for ~2.5x throughput; we don't encode that here,
  // the renderer's cost footer applies the multiplier when the session
  // flips the boolean. 1M context window: no per-token premium.
  "claude-opus-4-8": {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheCreate: 6.25,
  },
  "claude-opus-4-7": {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheCreate: 6.25,
  },
  "claude-opus-4-6": {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheCreate: 6.25,
  },
  "claude-fable-5": {
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheCreate: 12.5,
  },
  "claude-sonnet-5": {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheCreate: 3.75,
  },
  "claude-sonnet-4-6": {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheCreate: 3.75,
  },
  "claude-haiku-4-5": {
    input: 1,
    output: 5,
    cacheRead: 0.1,
    cacheCreate: 1.25,
  },
};

export const SendInput = Schema.Struct({
  sessionId: AgentSessionId,
  text: Schema.String,
  /**
   * Per-turn override of the session's `modelOptions` (see
   * `StartSessionInput.modelOptions`). When omitted, drivers reuse the
   * value supplied at session start.
   */
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

// ---------------------------------------------------------------------------
// Wire errors
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// RPC definitions. Not yet registered in `MemoizeRpcs` — handlers come
// online in PR 3 (availability), PR 4 (credentials), PR 5/6 (sessions). Each
// of those PRs adds its RPC to the group when its handler exists.
// ---------------------------------------------------------------------------

export const ProviderAvailabilityRpc = Rpc.make("provider.availability", {
  payload: Schema.Struct({ refresh: Schema.optional(Schema.Boolean) }),
  success: Schema.Array(AgentAvailability),
});

export const ProviderSetCredentialRpc = Rpc.make("provider.setCredential", {
  payload: SetCredentialInput,
  success: Schema.Void,
  error: CredentialStoreError,
});

// ---------------------------------------------------------------------------
// OpenCode dynamic inventory — single RPC the renderer calls when the user
// opens the model picker for the opencode provider. Returns the
// SDK-discovered set of connected providers + their models, and the set of
// locally-defined agents (build, plan, plus any custom ones). The renderer
// merges this into the static `MODELS_BY_PROVIDER.opencode` seed so the
// picker reflects what the user actually has connected/configured.
//
// Lives next to the per-provider availability probe so it's discoverable
// alongside the other agent.* RPCs; the handler short-lives an
// `opencode serve` to make the SDK calls and tears it down on return.
// ---------------------------------------------------------------------------

export const OpencodeInventoryModel = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  /**
   * Variant names exposed by this opencode model — e.g. `["high", "medium",
   * "low"]` for reasoning models, `["super-high"]` for some, or `[]` for
   * models without a variant axis. Sourced from `provider.list()`'s
   * per-model `variants` map. The renderer renders a "reasoning" picker
   * only when this array is non-empty.
   */
  variants: Schema.Array(Schema.String),
});
export type OpencodeInventoryModel = typeof OpencodeInventoryModel.Type;

export const OpencodeInventoryProvider = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  models: Schema.Array(OpencodeInventoryModel),
  /**
   * `true` when opencode reports this provider in `provider.list().connected`
   * — i.e. it has a stored credential (via `auth.set`) or an injected custom
   * definition — so its models are actually usable. The catalog now returns
   * every provider opencode knows about (~150), most of them unconnected; the
   * settings UI uses this flag to split "connected" from "available to add".
   */
  connected: Schema.Boolean,
  /**
   * `true` for user-defined OpenAI-compatible providers we inject via
   * `OPENCODE_CONFIG_CONTENT` (see `settings.opencodeCustomProviders`), as
   * opposed to entries from opencode's built-in models.dev catalog.
   */
  custom: Schema.Boolean,
  /**
   * Name of the environment variable this provider's key is read from
   * (`provider.list().env[0]`, e.g. `"OPENAI_API_KEY"`, `"GITHUB_TOKEN"`).
   * Used as the API-key input placeholder. Empty for oauth-only / custom.
   */
  apiKeyEnv: Schema.String,
  /**
   * models.dev doc URL for this provider (the "Get an API key" link).
   * Empty when unknown (custom providers, or if the catalog fetch failed).
   */
  apiKeyUrl: Schema.String,
});
export type OpencodeInventoryProvider = typeof OpencodeInventoryProvider.Type;

export const OpencodeInventoryAgent = Schema.Struct({
  name: Schema.String,
  mode: Schema.Literals(["primary", "all"]),
  description: Schema.optional(Schema.String),
});
export type OpencodeInventoryAgent = typeof OpencodeInventoryAgent.Type;

export const OpencodeInventory = Schema.Struct({
  providers: Schema.Array(OpencodeInventoryProvider),
  agents: Schema.Array(OpencodeInventoryAgent),
});
export type OpencodeInventory = typeof OpencodeInventory.Type;

export const ProviderOpencodeInventoryRpc = Rpc.make(
  "provider.opencode.inventory",
  {
    payload: Schema.Struct({}),
    success: OpencodeInventory,
    // Reused — `AgentSessionStartError` already carries `providerId` + `reason`
    // and the failure mode here ("opencode not installed", "spawn failed") is
    // the same shape the renderer already knows how to surface.
    error: AgentSessionStartError,
  },
);

// ---------------------------------------------------------------------------
// OpenCode provider management. The settings UI lets the user connect any of
// opencode's ~150 catalog providers by pasting an API key, and define custom
// OpenAI-compatible providers from a base URL. Keys are written through to
// opencode's own persistent `auth.json` (via the SDK `auth.set`) so they also
// work when the user runs `opencode` in a terminal; custom provider *shapes*
// live in our settings.json and are injected at spawn. Each handler
// short-lives an `opencode serve` to make the SDK call, mirroring
// `agent.opencodeInventory`.
// ---------------------------------------------------------------------------

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
  /**
   * The AI-SDK provider package opencode loads for this endpoint (e.g.
   * `"@ai-sdk/openai-compatible"`, `"@openrouter/ai-sdk-provider"`). Picked
   * from a small preset list in the UI; defaults to OpenAI-compatible.
   */
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

// ---------------------------------------------------------------------------
// One-click sign-in flow. The renderer subscribes to `provider.startLogin`,
// which spawns the provider's `login` subcommand server-side, extracts the
// OAuth URL the CLI prints, and reports progress back as a stream of
// `LoginEvent`s. Today only `cursor` has a real handler; other providers
// resolve to an immediate `done(ok=false)`.
// ---------------------------------------------------------------------------

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
  payload: Schema.Struct({ providerId: ProviderId }),
  success: LoginEvent,
  error: AgentSessionStartError,
  stream: true,
});

// ---------------------------------------------------------------------------
// One-click provider CLI update. The renderer subscribes to
// `agent.updateProvider`, which spawns the provider's install/upgrade command
// in a login shell (so `npm`/`bun` are on PATH and `curl … | bash` installers
// work), streams the command's output back as `log` lines, and ends with a
// terminal `done`. On success the renderer re-probes availability so the new
// version is reflected immediately.
// ---------------------------------------------------------------------------

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
