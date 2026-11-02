import { Effect, Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";
import {
	AgentDefinition,
	AgentErrorKind,
	BackgroundTaskOutcome,
	ContextUsagePrecision,
	PermissionMode,
	PlanApprovalOutcome,
	ProviderId,
	ProviderMessageCheckpoint,
	RuntimeMode,
	UsageLimitScope,
	UserQuestion,
} from "./agent.ts";
import {
	AttemptReason,
	ProviderRef,
	ProviderThreadStatus,
	TurnStatus,
} from "./agent-engine.ts";
import { WorkspaceActor } from "./collaboration.ts";
import {
	AttachmentRef,
	ComposerAnnotation,
	ComposerInput,
	FileRef,
	SkillRef,
} from "./composer.ts";
import { DirectoryUnavailableError } from "./fs.ts";
import {
	AgentItemId,
	AgentSessionId,
	AgentTurnId,
	AttemptId,
	ChatId,
	CommandId,
	FolderId,
	MessageId,
	ProviderThreadId,
	WorktreeId,
} from "./ids.ts";
import { NameProvenanceField } from "./naming.ts";
import { PermissionRequest } from "./permission.ts";
import { Worktree } from "./worktree.ts";

export {
	DEFAULT_PERMISSION_MODE,
	DEFAULT_RUNTIME_MODE,
	PermissionMode,
	RuntimeMode,
} from "./agent.ts";
export { ChatId } from "./ids.ts";

/**
 * A session is one chat thread inside a project. The id matches the underlying
 * provider session id (`AgentSessionId`) so the persistence layer and the
 * provider's in-memory map stay in lockstep.
 */
export const SessionId = AgentSessionId;
export type SessionId = AgentSessionId;

/**
 * Persisted lifecycle state of a session. Mirrors the `sessions.status` column.
 * `booting`  — row exists; provider boot (CLI spawn + SDK handshake) is in
 *              flight on a background fiber. Transitions to `idle`/`running`
 *              on success, `error` on failure. Stale `booting` rows from a
 *              crashed daemon are cleaned up at boot.
 * `idle`     — row exists but no provider session is currently driving it.
 * `running`  — provider session is alive and its event stream is being consumed.
 * `closed`   — turn ended normally or session was closed by the user.
 * `error`    — provider terminated the session with an error.
 */
export const SessionStatus = Schema.Literals([
	"booting",
	"idle",
	"running",
	"closed",
	"error",
]);
export type SessionStatus = typeof SessionStatus.Type;

/**
 * The provider-native conversation currently backing a session. A session
 * accumulates provider threads over time; this is the active one, with the
 * native handle kept as a reference so the app never depends on it as
 * identity. `nativeHeadRef` is the provider's replay cursor when it has one.
 */
export const SessionProviderThread = Schema.Struct({
	id: ProviderThreadId,
	provider: ProviderId,
	nativeThreadRef: ProviderRef,
	nativeHeadRef: Schema.NullOr(ProviderRef),
	status: ProviderThreadStatus,
	firstTurnOrdinal: Schema.NullOr(Schema.Number),
	lastTurnOrdinal: Schema.NullOr(Schema.Number),
	createdAt: Schema.DateFromString,
	updatedAt: Schema.DateFromString,
});
export type SessionProviderThread = typeof SessionProviderThread.Type;

export class Session extends Schema.Class<Session>("Session")({
	id: SessionId,
	/** Durable app-managed delegation parent; absent on older runtimes. */
	parentSessionId: Schema.optional(Schema.NullOr(SessionId)),
	projectId: FolderId,
	title: Schema.String,
	titleProvenance: NameProvenanceField,
	providerId: ProviderId,
	model: Schema.String,
	status: SessionStatus,
	archivedAt: Schema.NullOr(Schema.DateFromString),
	/** Active provider-native conversation, or null before the first turn. */
	providerThread: Schema.NullOr(SessionProviderThread),
	runtimeMode: RuntimeMode,
	/**
	 * Optional git worktree the session runs in. When null, the session runs
	 * in the project's main checkout (`projects.path`). Mirrors the owning
	 * chat's `worktreeId` — sessions in a chat always share its worktree;
	 * server-side `chat.setWorktree` updates both. Locked once the chat has
	 * any message recorded.
	 */
	worktreeId: Schema.NullOr(WorktreeId),
	/**
	 * Chat (sidebar entry) this session belongs to. Every session is a tab
	 * inside exactly one chat — the chat row is the container; sessions are
	 * its uniform members. CASCADEs on chat delete.
	 */
	chatId: ChatId,
	/**
	 * If this session was forked from another, the source session id. Null
	 * for sessions started fresh. Reserved for the upcoming "fork from
	 * message" feature — column ships now so the future capability is a
	 * pure code change.
	 */
	forkedFromSessionId: Schema.NullOr(SessionId),
	/**
	 * The message in the source session the fork branched from, when
	 * applicable. Paired with `forkedFromSessionId`.
	 */
	forkedFromMessageId: Schema.NullOr(MessageId),
	/**
	 * SDK lifecycle mode. Distinct from `runtimeMode` (our own auto-allow
	 * policy). `plan` means the agent is currently restricted to read-only
	 * tools and is expected to end its turn by calling `ExitPlanMode`.
	 */
	permissionMode: PermissionMode,
	/**
	 * Whether deferred tool loading was enabled at session start. Mirrors
	 * `StartSessionInput.toolSearch`. No behavioural effect today; reserved
	 * for the 0.04 code-index MCP servers.
	 */
	toolSearch: Schema.Boolean,
	createdAt: Schema.DateFromString,
	updatedAt: Schema.DateFromString,
}) {}

/**
 * Conventional chat-message role. `tool` is used for tool_result rows so
 * markdown renderers can pick a distinct visual treatment without sniffing
 * `content._tag`.
 */
export const MessageRole = Schema.Literals([
	"user",
	"assistant",
	"system",
	"tool",
]);
export type MessageRole = typeof MessageRole.Type;

/**
 * Attribution for a user-role message injected by ANOTHER agent (via the
 * zuse-orchestration create_thread / send_to_thread tools) rather than typed
 * by the human. Additive + optional: old rows decode without it.
 */
export const MessageOrigin = Schema.Struct({
	title: Schema.optional(Schema.String),
	/** Remote attribution is descriptive and never a cross-database foreign key. */
	environmentId: Schema.optional(Schema.String),
	masterId: Schema.optional(Schema.String),
	chatId: ChatId,
	sessionId: SessionId,
	providerId: ProviderId,
});
export type MessageOrigin = typeof MessageOrigin.Type;

/**
 * External chat surface a user-role message was submitted from. Display-only:
 * `text` is the person's own words, while the message `text` stays the full
 * prompt the agent received (thread context included). Additive + optional.
 */
export const MessageSource = Schema.TaggedStruct("slack", {
	text: Schema.String,
	author: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
	/** Channel name without `#`; omitted for direct messages. */
	channel: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
});
export type MessageSource = typeof MessageSource.Type;

const UserContent = Schema.TaggedStruct("user", {
	text: Schema.String,
	actor: Schema.optional(WorkspaceActor),
	origin: Schema.optional(MessageOrigin),
	origins: Schema.optional(Schema.Array(MessageOrigin)),
	source: Schema.optional(MessageSource),
	goal: Schema.optional(Schema.Boolean),
});

const UserRichContent = Schema.TaggedStruct("user_rich", {
	text: Schema.String,
	actor: Schema.optional(WorkspaceActor),
	attachments: Schema.Array(AttachmentRef),
	fileRefs: Schema.Array(FileRef),
	skillRefs: Schema.Array(SkillRef),

	annotations: Schema.Array(ComposerAnnotation).pipe(
		Schema.withDecodingDefaultType(Effect.succeed([])),
	),
	origin: Schema.optional(MessageOrigin),
	origins: Schema.optional(Schema.Array(MessageOrigin)),
	source: Schema.optional(MessageSource),
	goal: Schema.optional(Schema.Boolean),
});

const AssistantContent = Schema.TaggedStruct("assistant", {
	itemId: Schema.optional(AgentItemId),
	text: Schema.String,
	checkpoint: Schema.optional(ProviderMessageCheckpoint),

	isPlan: Schema.optional(Schema.Boolean),
	parentItemId: Schema.optional(AgentItemId),
});

const ThinkingContent = Schema.TaggedStruct("thinking", {
	itemId: AgentItemId,
	text: Schema.String,
	redacted: Schema.Boolean,
	checkpoint: Schema.optional(ProviderMessageCheckpoint),
	parentItemId: Schema.optional(AgentItemId),
});

const ToolUseContent = Schema.TaggedStruct("tool_use", {
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

const ToolResultContent = Schema.TaggedStruct("tool_result", {
	itemId: AgentItemId,
	output: Schema.Unknown,
	isError: Schema.Boolean,
	parentItemId: Schema.optional(AgentItemId),
	backgroundOutcome: Schema.optional(BackgroundTaskOutcome),
});

const ErrorContent = Schema.TaggedStruct("error", {
	message: Schema.String,

	kind: Schema.optional(AgentErrorKind),
});

const InterruptedContent = Schema.TaggedStruct("interrupted", {});

const ModelSwitchContent = Schema.TaggedStruct("model_switch", {
	fromProviderId: ProviderId,
	fromModel: Schema.String,
	toProviderId: ProviderId,
	toModel: Schema.String,
	context: Schema.Literals(["preserved", "handoff"]),
});

const SubagentSummaryContent = Schema.TaggedStruct("subagent_summary", {
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

const SubagentProgressContent = Schema.TaggedStruct("subagent_progress", {
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

const UsageContent = Schema.TaggedStruct("usage", {
	parentItemId: Schema.optional(AgentItemId),
	inputTokens: Schema.Number,
	outputTokens: Schema.Number,
	cacheReadTokens: Schema.Number,
	cacheCreationTokens: Schema.Number,
	model: Schema.String,
});

const ContextUsageContent = Schema.TaggedStruct("context_usage", {
	providerId: ProviderId,
	usedTokens: Schema.NullOr(Schema.Number),
	windowTokens: Schema.NullOr(Schema.Number),
	precision: ContextUsagePrecision,
	source: Schema.optional(Schema.String),
});

const ContextCompactionContent = Schema.TaggedStruct("context_compaction", {
	itemId: AgentItemId,
	providerId: ProviderId,
	startedAt: Schema.Number,
	durationMs: Schema.Number,
	beforeTokens: Schema.NullOr(Schema.Number),
	afterTokens: Schema.NullOr(Schema.Number),
	status: Schema.Literals(["in_progress", "completed", "failed"]).pipe(
		Schema.withDecodingDefaultType(Effect.succeed("completed" as const)),
	),
});

const UsageLimitContent = Schema.TaggedStruct("usage_limit", {
	id: Schema.optional(Schema.String),
	scope: Schema.optional(UsageLimitScope),
	providerId: ProviderId,
	label: Schema.String,
	usedPercent: Schema.NullOr(Schema.Number),

	resetsAt: Schema.NullOr(Schema.String),
	windowMinutes: Schema.NullOr(Schema.Number),
});

const UserQuestionContent = Schema.TaggedStruct("user_question", {
	itemId: AgentItemId,
	questions: Schema.Array(UserQuestion),
	parentItemId: Schema.optional(AgentItemId),
});

const UserQuestionCoordinate = Schema.Number.check(
	Schema.isInt(),
	Schema.makeFilter((value) =>
		value >= 0 ? undefined : "Question coordinates cannot be negative.",
	),
);

export const UserQuestionAnswer = Schema.Struct({
	questionIndex: UserQuestionCoordinate,
	selected: Schema.Array(UserQuestionCoordinate),
	other: Schema.optional(Schema.String),
});
export type UserQuestionAnswer = typeof UserQuestionAnswer.Type;

const UserQuestionAnswerContent = Schema.TaggedStruct("user_question_answer", {
	resolution: Schema.optional(Schema.Literals(["cancelled", "timed-out"])),
	itemId: AgentItemId,
	answers: Schema.Array(UserQuestionAnswer),
	parentItemId: Schema.optional(AgentItemId),
});

const UiSpecContent = Schema.TaggedStruct("ui_spec", {
	spec: Schema.String,
	version: Schema.Literal(1),
});

/**
 * Tagged-union of all renderable message payloads. Persisted as the JSON blob
 * in `messages.content_json`; the `_tag` mirrors the `messages.kind` column.
 * Keep the shape additive — new tags become new rendered variants in the
 * renderer without touching existing rows.
 */
export const MessageContent = Schema.Union([
	UserContent,
	UserRichContent,
	AssistantContent,
	ThinkingContent,
	ToolUseContent,
	ToolResultContent,
	ErrorContent,
	InterruptedContent,
	ModelSwitchContent,
	SubagentSummaryContent,
	SubagentProgressContent,
	UsageContent,
	ContextUsageContent,
	ContextCompactionContent,
	UsageLimitContent,
	UserQuestionContent,
	UserQuestionAnswerContent,
	UiSpecContent,
]);
export type MessageContent = typeof MessageContent.Type;

export class Message extends Schema.Class<Message>("Message")({
	id: MessageId,
	sessionId: SessionId,
	role: MessageRole,
	content: MessageContent,
	createdAt: Schema.DateFromString,
}) {}

/**
 * A `Message` tagged with its global monotonic `sequence` from the event log.
 * Clients record the highest `sequence` they have seen per session and pass it
 * back as `sinceSequence` on reconnect to resume gap-free (no full replay, no
 * in-memory dedup Set). This is what `messages.stream` emits.
 */
export class MessageEnvelope extends Schema.Class<MessageEnvelope>(
	"MessageEnvelope",
)({
	sequence: Schema.Number,
	message: Message,
}) {}

/** Persisted queue payload; actor is populated only by the server. */
export const QueuedMessageInput = Schema.Struct({
	...ComposerInput.fields,
	actor: Schema.optional(WorkspaceActor),
});

export class QueuedMessage extends Schema.Class<QueuedMessage>("QueuedMessage")(
	{
		id: Schema.String,
		sessionId: SessionId,
		input: ComposerInput,
		actor: Schema.optional(WorkspaceActor),
		position: Schema.Number,
		createdAt: Schema.DateFromString,
		updatedAt: Schema.DateFromString,
		/** Held items are durable and visible but cannot be claimed yet. */
		ready: Schema.Boolean.pipe(
			Schema.withConstructorDefault(Effect.succeed(true)),
			Schema.withDecodingDefaultType(Effect.succeed(true)),
		),
	},
) {}

export class QueuedMessageNotFoundError extends Schema.TaggedErrorClass<QueuedMessageNotFoundError>()(
	"QueuedMessageNotFoundError",
	{ sessionId: SessionId, queueId: Schema.String },
) {}

/** Queue bounds keep the canonical reconnect snapshot below its wire budget. */
export const MAX_SESSION_QUEUE_ITEMS = 100;
export const MAX_SESSION_QUEUE_INPUT_BYTES = 128 * 1024;
export const MAX_SESSION_QUEUE_TOTAL_BYTES = 384 * 1024;

export class QueuedMessageCapacityError extends Schema.TaggedErrorClass<QueuedMessageCapacityError>()(
	"QueuedMessageCapacityError",
	{
		sessionId: SessionId,
		reason: Schema.Literals([
			"too-many-items",
			"item-too-large",
			"queue-too-large",
		]),
		limit: Schema.Number,
		actual: Schema.Number,
	},
) {}

export class QueueState extends Schema.Class<QueueState>("QueueState")({
	items: Schema.Array(QueuedMessage),
	paused: Schema.Boolean,
}) {}

export const SessionTimelineTurnPhase = Schema.Literals([
	"requested",
	"starting",
	"running",
	"interrupt-requested",
	"interrupt-acknowledged",
]);
export type SessionTimelineTurnPhase = typeof SessionTimelineTurnPhase.Type;

/** One provider execution of a turn. Retries and recovery add attempts. */
export const SessionAttempt = Schema.Struct({
	id: AttemptId,
	ordinal: Schema.Number,
	reason: AttemptReason,
});
export type SessionAttempt = typeof SessionAttempt.Type;

/**
 * A counted user turn as the timeline sees it. `phase` tracks the interrupt
 * handshake for the UI; `status` is the durable lifecycle state.
 */
export const SessionTurn = Schema.Struct({
	id: AgentTurnId,
	ordinal: Schema.Number,
	status: TurnStatus,
	phase: SessionTimelineTurnPhase,
	attempt: SessionAttempt,
	providerThreadId: Schema.NullOr(ProviderThreadId),
	requestedAt: Schema.DateFromString,
	completedAt: Schema.NullOr(Schema.DateFromString),
});
export type SessionTurn = typeof SessionTurn.Type;

/**
 * An unresolved, user-blocking interaction reconstructed from the durable
 * session stream. Resolution removes the interaction from the projection;
 * transient submission state belongs to the client command overlay.
 */
export const SessionInteraction = Schema.Union([
	Schema.TaggedStruct("Plan", {
		id: AgentItemId,
		requestedAt: Schema.DateFromString,
		recoveryState: Schema.optional(Schema.Literals(["expired", "uncertain"])),
	}),
	Schema.TaggedStruct("Question", {
		id: AgentItemId,
		recoveryState: Schema.optional(Schema.Literal("expired")),
		questions: Schema.Array(UserQuestion),
		requestedAt: Schema.DateFromString,
	}),
	Schema.TaggedStruct("Permission", {
		id: Schema.String,
		request: PermissionRequest,
	}),
]);
export type SessionInteraction = typeof SessionInteraction.Type;

export const SessionRuntimeObservation = Schema.Struct({
	state: Schema.Literals([
		"idle",
		"starting",
		"running",
		"finalizing",
		"blocked",
		"stalled",
		"unavailable",
	]),
	observedAt: Schema.Number,
	attemptId: Schema.NullOr(Schema.String),
	lastProviderActivityAt: Schema.NullOr(Schema.Number),
});
export type SessionRuntimeObservation = typeof SessionRuntimeObservation.Type;

/** Durable provider execution tree. Native children are scoped to their owning attempt. */
export const SessionExecutionStep = Schema.Struct({
	checkpointCapability: Schema.Literal("unsupported"),
	id: Schema.String,
	turnId: Schema.String,
	attemptId: Schema.String,
	itemId: Schema.String,
	parentItemId: Schema.NullOr(Schema.String),
	kind: Schema.Literals(["tool", "background", "subagent"]),
	label: Schema.String,
	status: Schema.Literals(["running", "completed", "failed", "cancelled"]),
	childSessionId: Schema.NullOr(Schema.String),
	nativeChildId: Schema.NullOr(Schema.String),
	rootCompletedAt: Schema.NullOr(Schema.Number),
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
});
export type SessionExecutionStep = typeof SessionExecutionStep.Type;

export class SessionTimelineProjection extends Schema.Class<SessionTimelineProjection>(
	"SessionTimelineProjection",
)({
	messages: Schema.Array(Message),
	executionSteps: Schema.optional(Schema.Array(SessionExecutionStep)),
	executionStepsTruncated: Schema.optional(Schema.Boolean),
	runtimeObservation: Schema.optional(SessionRuntimeObservation),
	/** Sequence immediately before the oldest materialized message, if any. */
	olderMessageSequence: Schema.optional(Schema.NullOr(Schema.Number)),
	status: SessionStatus,
	/** The turn currently in flight, or null when the session is idle. */
	activeTurn: Schema.NullOr(SessionTurn).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed(null)),
	),
	/** Number of counted turns so far; the next turn gets `turnCount + 1`. */
	turnCount: Schema.Number.pipe(
		Schema.withDecodingDefaultKey(Effect.succeed(0)),
	),
	queue: QueueState,
	permissionMode: PermissionMode,
	runtimeMode: RuntimeMode,
	interactions: Schema.Array(SessionInteraction).pipe(
		Schema.withConstructorDefault(Effect.succeed([])),
		Schema.withDecodingDefaultType(Effect.succeed([])),
	),
}) {}

/** Canonical result of settling an agent turn. */
export const TurnSettlementOutcome = Schema.Literals([
	"completed",
	"interrupted",
	"error",
]);
export type TurnSettlementOutcome = typeof TurnSettlementOutcome.Type;

export const SessionTimelineEvent = Schema.Union([
	Schema.TaggedStruct("Noop", {}),
	Schema.TaggedStruct("MessagePersisted", {
		message: Message,
		turnId: Schema.optional(Schema.NullOr(AgentTurnId)),
	}),
	Schema.TaggedStruct("StatusSet", { status: SessionStatus }),
	Schema.TaggedStruct("TurnStarted", { turn: SessionTurn }),

	Schema.TaggedStruct("TurnUpdated", {
		turn: SessionTurn,
		updatedAt: Schema.optional(Schema.Number),
	}),
	Schema.TaggedStruct("TurnPhaseSet", {
		turnId: AgentTurnId,
		phase: SessionTimelineTurnPhase,
	}),
	Schema.TaggedStruct("TranscriptRolledBack", {
		rolledBackTurnIds: Schema.optional(Schema.Array(Schema.String)),
		rolledBackAt: Schema.optional(Schema.Number),
		removedMessageIds: Schema.Array(MessageId),
	}),
	Schema.TaggedStruct("TurnFinalizing", { turnId: AgentTurnId }),
	Schema.TaggedStruct("TurnSettled", {
		turnId: AgentTurnId,
		outcome: TurnSettlementOutcome,
		settledAt: Schema.optional(Schema.Number),
	}),
	Schema.TaggedStruct("PermissionModeSet", { permissionMode: PermissionMode }),
	Schema.TaggedStruct("RuntimeModeSet", { runtimeMode: RuntimeMode }),
	Schema.TaggedStruct("PermissionRequested", { request: PermissionRequest }),
	Schema.TaggedStruct("PermissionResolved", { requestId: Schema.String }),
	Schema.TaggedStruct("PermissionExpired", { requestId: Schema.String }),
	Schema.TaggedStruct("QuestionExpired", { itemId: AgentItemId }),
	Schema.TaggedStruct("PlanExpired", {
		itemId: AgentItemId,
		reason: Schema.Literals(["expired", "uncertain"]),
	}),
	Schema.TaggedStruct("QuestionResolved", {
		itemId: AgentItemId,
		resolution: Schema.Literal("cancelled"),
	}),
	Schema.TaggedStruct("QueuePausedSet", { paused: Schema.Boolean }),
	Schema.TaggedStruct("QueueEnqueued", { item: QueuedMessage }),
	Schema.TaggedStruct("QueueUpdated", {
		queueId: Schema.String,
		input: ComposerInput,
		updatedAt: Schema.DateFromString,
		ready: Schema.Boolean,
	}),
	Schema.TaggedStruct("QueueRemoved", { queueId: Schema.String }),
	Schema.TaggedStruct("QueueReordered", {
		queueIds: Schema.Array(Schema.String),
	}),
]);
export type SessionTimelineEvent = typeof SessionTimelineEvent.Type;

/** Durable cursor for one database epoch and one session stream. */
export const SessionStreamCursor = Schema.Struct({
	epoch: Schema.String,
	version: Schema.Number,
});
export type SessionStreamCursor = typeof SessionStreamCursor.Type;

export const SessionTimelineFrame = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("runtime"),
		sessionId: SessionId,
		cursor: SessionStreamCursor,
		observation: SessionRuntimeObservation,
	}),
	Schema.Struct({
		kind: Schema.Literal("snapshot"),
		sessionId: SessionId,
		throughVersion: Schema.Number,
		projection: SessionTimelineProjection,

		cursor: Schema.optional(SessionStreamCursor),

		olderMessageSequence: Schema.optional(Schema.NullOr(Schema.Number)),

		totalMessageCount: Schema.optional(Schema.Number),

		historyMode: Schema.optional(Schema.Literal("background")),
	}),
	Schema.Struct({
		kind: Schema.Literal("snapshot-chunk"),
		sessionId: SessionId,
		throughVersion: Schema.Number,
		messages: Schema.Array(Message),

		olderMessageSequence: Schema.NullOr(Schema.Number),
		cursor: Schema.optional(SessionStreamCursor),
	}),
	Schema.Struct({
		kind: Schema.Literal("event"),
		sessionId: SessionId,
		streamVersion: Schema.Number,
		eventId: Schema.String,
		event: SessionTimelineEvent,
		cursor: Schema.optional(SessionStreamCursor),
	}),
	Schema.Struct({
		kind: Schema.Literal("synchronized"),
		sessionId: SessionId,
		throughVersion: Schema.Number,
		cursor: Schema.optional(SessionStreamCursor),
	}),
	Schema.Struct({
		kind: Schema.Literal("reset-required"),
		sessionId: SessionId,
		throughVersion: Schema.Number,
		cursor: SessionStreamCursor,
		reason: Schema.Literals(["restored", "compacted", "cursor-invalid"]),
	}),
]);
export type SessionTimelineFrame = typeof SessionTimelineFrame.Type;

export class SessionNotFoundError extends Schema.TaggedErrorClass<SessionNotFoundError>()(
	"SessionNotFoundError",
	{ sessionId: SessionId },
) {}

export class QuestionResolutionError extends Schema.TaggedErrorClass<QuestionResolutionError>()(
	"QuestionResolutionError",
	{ sessionId: SessionId, itemId: AgentItemId, reason: Schema.String },
) {}

export class PlanResolutionError extends Schema.TaggedErrorClass<PlanResolutionError>()(
	"PlanResolutionError",
	{ sessionId: SessionId, itemId: AgentItemId, reason: Schema.String },
) {}

export class SessionStartError extends Schema.TaggedErrorClass<SessionStartError>()(
	"SessionStartError",
	{ providerId: ProviderId, reason: Schema.String },
) {}

export class ChatCreationConflictError extends Schema.TaggedErrorClass<ChatCreationConflictError>()(
	"ChatCreationConflictError",
	{ operationId: Schema.String, reason: Schema.String },
) {}

export class GoalUnsupportedError extends Schema.TaggedErrorClass<GoalUnsupportedError>()(
	"GoalUnsupportedError",
	{ providerId: ProviderId },
) {}

export const ThreadGoalStatus = Schema.Literals([
	"active",
	"paused",
	"budgetLimited",
	"usageLimited",
	"blocked",
	"complete",
]);
export type ThreadGoalStatus = typeof ThreadGoalStatus.Type;

export class ThreadGoal extends Schema.Class<ThreadGoal>("ThreadGoal")({
	threadId: Schema.String,
	objective: Schema.String,
	status: ThreadGoalStatus,
	tokenBudget: Schema.NullOr(Schema.Number),
	tokensUsed: Schema.Number,
	timeUsedSeconds: Schema.Number,
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
}) {}

export const ThreadGoalSetInput = Schema.Struct({
	objective: Schema.optional(Schema.String),
	status: Schema.optional(ThreadGoalStatus),
	tokenBudget: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type ThreadGoalSetInput = typeof ThreadGoalSetInput.Type;

/**
 * Raised by `session.setWorktree` when the session already has at least one
 * recorded user message. cwd cannot be changed mid-conversation — the
 * renderer collapses the picker to a read-only chip in this case.
 */
export class SessionAlreadyStartedError extends Schema.TaggedErrorClass<SessionAlreadyStartedError>()(
	"SessionAlreadyStartedError",
	{ sessionId: SessionId },
) {}

export class SessionConfigurationError extends Schema.TaggedErrorClass<SessionConfigurationError>()(
	"SessionConfigurationError",
	{ sessionId: SessionId, reason: Schema.String },
) {}

export const SessionListRpc = Rpc.make("session.list", {
	payload: Schema.Struct({
		projectId: FolderId,
		includeArchived: Schema.optional(Schema.Boolean),
	}),
	success: Schema.Array(Session),
});

export const SessionGetRpc = Rpc.make("session.get", {
	payload: Schema.Struct({ sessionId: SessionId }),
	success: Session,
	error: SessionNotFoundError,
});

export const SessionSummaryChange = Schema.Union([
	Schema.Struct({
		_tag: Schema.Literal("snapshot"),
		cursor: Schema.Number,
		sessions: Schema.Array(Session),
	}),
	Schema.Struct({
		_tag: Schema.Literal("change"),
		sequence: Schema.Number,
		session: Session,
	}),
	Schema.Struct({
		_tag: Schema.Literal("remove"),
		sequence: Schema.Number,
		sessionId: SessionId,
	}),
]);
export type SessionSummaryChange = typeof SessionSummaryChange.Type;

/** One authoritative snapshot followed by cursor-ordered session summary changes. */
export const SessionStreamChangesRpc = Rpc.make("session.streamChanges", {
	payload: Schema.Struct({ projectId: FolderId }),
	success: SessionSummaryChange,
	stream: true,
});

export const SessionCreateRpc = Rpc.make("session.create", {
	payload: Schema.Struct({
		sessionId: Schema.optional(SessionId),

		chatId: ChatId,
		providerId: ProviderId,
		model: Schema.String,
		title: Schema.optional(Schema.String),
		initialPrompt: Schema.optional(Schema.String),
		runtimeMode: Schema.optional(RuntimeMode),

		agents: Schema.optional(Schema.Record(Schema.String, AgentDefinition)),
		enableSubagents: Schema.optional(Schema.Boolean),

		permissionMode: Schema.optional(PermissionMode),
		modelOptions: Schema.optional(Schema.Record(Schema.String, Schema.String)),

		toolSearch: Schema.optional(Schema.Boolean),
	}),
	success: Session,
	error: SessionStartError,
});

/**
 * Switch the worktree a session runs in. Allowed only before the first user
 * message is recorded — `SessionAlreadyStartedError` otherwise. `null` means
 * "run in the main checkout."
 */
export const SessionSetWorktreeRpc = Rpc.make("session.setWorktree", {
	payload: Schema.Struct({
		sessionId: SessionId,
		worktreeId: Schema.NullOr(WorktreeId),
	}),
	success: Schema.Void,
	error: Schema.Union([SessionNotFoundError, SessionAlreadyStartedError]),
});

export const SessionRenameRpc = Rpc.make("session.rename", {
	payload: Schema.Struct({
		commandId: CommandId,
		sessionId: SessionId,
		title: Schema.String,
	}),
	success: Session,
	error: SessionNotFoundError,
});

export const SessionSetModelRpc = Rpc.make("session.setModel", {
	payload: Schema.Struct({ sessionId: SessionId, model: Schema.String }),
	success: Schema.Void,
	error: Schema.Union([SessionNotFoundError, SessionConfigurationError]),
});

/**
 * Switch an idle conversation to another provider with a durable context handoff.
 */
export const SessionSetProviderRpc = Rpc.make("session.setProvider", {
	payload: Schema.Struct({
		sessionId: SessionId,
		providerId: ProviderId,
		model: Schema.String,
	}),
	success: Schema.Void,
	error: Schema.Union([
		SessionNotFoundError,
		SessionConfigurationError,

		SessionAlreadyStartedError,
	]),
});

export const SessionArchiveRpc = Rpc.make("session.archive", {
	payload: Schema.Struct({ sessionId: SessionId }),
	success: Schema.Void,
	error: SessionNotFoundError,
});

export const SessionUnarchiveRpc = Rpc.make("session.unarchive", {
	payload: Schema.Struct({ sessionId: SessionId }),
	success: Schema.Void,
	error: SessionNotFoundError,
});

export const SessionDeleteRpc = Rpc.make("session.delete", {
	payload: Schema.Struct({ sessionId: SessionId }),
	success: Schema.Void,
	error: SessionNotFoundError,
});

/**
 * Where a forked conversation lands. `tab` creates a new session inside the
 * source chat (sharing its worktree); `chat` creates a fresh sidebar chat
 * (with its own worktree) for isolated parallel exploration.
 */
export const ForkDestination = Schema.Literals(["tab", "chat"]);
export type ForkDestination = typeof ForkDestination.Type;

/**
 * How the fork inherited its context. `resume` means the provider forked the
 * live transcript so the new session has real agent memory (Claude
 * `forkSession` / Codex `thread/fork`); `copy` means the visible transcript
 * was replayed into the new session (no KV memory) because the fork point was
 * not the conversation tail, or the provider lacks native fork support.
 */
export const ForkMode = Schema.Literals(["resume", "copy"]);
export type ForkMode = typeof ForkMode.Type;

/**
 * Serialise a session's transcript to Markdown, optionally truncated at
 * `uptoMessageId` (inclusive). Backs the "Attach transcript" handoff button
 * and the copy-mode fork context file.
 */
export const SessionExportTranscriptRpc = Rpc.make("session.exportTranscript", {
	payload: Schema.Struct({
		sessionId: SessionId,
		uptoMessageId: Schema.optional(MessageId),
	}),
	success: Schema.Struct({ markdown: Schema.String }),
	error: SessionNotFoundError,
});

/**
 * The most recent `ExitPlanMode` plan text for a session, or `null` if it has
 * never proposed a plan. Backs the plan context chip between sessions in one
 * chat — cheap enough to probe candidate sources without hydrating their full
 * message log.
 */
export const SessionLatestPlanRpc = Rpc.make("session.latestPlan", {
	payload: Schema.Struct({ sessionId: SessionId }),
	success: Schema.Struct({ plan: Schema.NullOr(Schema.String) }),
	error: SessionNotFoundError,
});

/**
 * A chat is the sidebar-level container. It owns a workspace (project +
 * optional worktree) and a title; the actual conversations live in its
 * child sessions, every one of which carries the chat's `chatId`. The
 * chat row itself has no provider state and no messages — it's metadata.
 *
 * `activeSessionId` is the last tab the user was on, persisted server-side
 * so a future tab restore works across reloads / devices.
 */
export class Chat extends Schema.Class<Chat>("Chat")({
	id: ChatId,
	/** Connection-specific presentation hint; RPC authorization remains authoritative. */
	readOnly: Schema.optional(Schema.Boolean),
	projectId: FolderId,
	worktreeId: Schema.NullOr(WorktreeId),
	title: Schema.String,
	titleProvenance: NameProvenanceField,
	activeSessionId: Schema.NullOr(SessionId),
	/**
	 * Lineage. When an agent spawns this chat via the orchestration
	 * control-plane tools, this records the session that spawned it so the
	 * sidebar can nest agent-spawned chats under their parent and badge them.
	 * `null` for user-created chats.
	 */
	originSessionId: Schema.NullOr(SessionId),
	archivedAt: Schema.NullOr(Schema.DateFromString),
	/**
	 * Read/unread tracking. `lastMessageAt` advances every time a message is
	 * persisted in any of the chat's sessions; `lastReadAt` advances when the
	 * user views the chat. A chat is unread when `lastMessageAt > lastReadAt`.
	 * `lastMessageAt` is null until the first message; `lastReadAt` is seeded to
	 * the creation time so a freshly created chat starts read.
	 */
	/** Latest user message across all threads; used for sidebar recency. */
	lastUserMessageAt: Schema.optional(Schema.NullOr(Schema.DateFromString)),
	lastMessageAt: Schema.NullOr(Schema.DateFromString),
	lastReadAt: Schema.NullOr(Schema.DateFromString),
	createdAt: Schema.DateFromString,
	updatedAt: Schema.DateFromString,
}) {}

export class ChatNotFoundError extends Schema.TaggedErrorClass<ChatNotFoundError>()(
	"ChatNotFoundError",
	{ chatId: ChatId },
) {}

export class ChatNotArchivedError extends Schema.TaggedErrorClass<ChatNotArchivedError>()(
	"ChatNotArchivedError",
	{ chatId: ChatId },
) {}

/**
 * Raised by `chat.setWorktree` when any session in the chat already has a
 * recorded user message. Worktrees are immutable past the first message —
 * mirrors the per-session `SessionAlreadyStartedError` semantics.
 */
export class ChatAlreadyStartedError extends Schema.TaggedErrorClass<ChatAlreadyStartedError>()(
	"ChatAlreadyStartedError",
	{ chatId: ChatId },
) {}

export class ChatArchiveScriptError extends Schema.TaggedErrorClass<ChatArchiveScriptError>()(
	"ChatArchiveScriptError",
	{
		chatId: ChatId,
		exitCode: Schema.NullOr(Schema.Number),
		signal: Schema.NullOr(Schema.String),
		output: Schema.String,
	},
) {}

export class ChatArchiveTimeoutError extends Schema.TaggedErrorClass<ChatArchiveTimeoutError>()(
	"ChatArchiveTimeoutError",
	{ chatId: ChatId, timeoutMs: Schema.Number, output: Schema.String },
) {}

export class ChatArchiveWorktreeError extends Schema.TaggedErrorClass<ChatArchiveWorktreeError>()(
	"ChatArchiveWorktreeError",
	{ chatId: ChatId, reason: Schema.String },
) {}

export const ChatArchiveJobStatus = Schema.Literals([
	"queued",
	"running",
	"completed",
	"failed",
	"forced",
	"cancelled",
]);
export type ChatArchiveJobStatus = typeof ChatArchiveJobStatus.Type;

export const ChatArchiveJob = Schema.Struct({
	chatId: ChatId,
	status: ChatArchiveJobStatus,
	phase: Schema.String,
	error: Schema.NullOr(Schema.String),
	cleanupOutput: Schema.String,
	updatedAt: Schema.DateFromString,
});
export type ChatArchiveJob = typeof ChatArchiveJob.Type;

export const ChatDirectoryStatus = Schema.Union([
	Schema.TaggedStruct("available", {}),
	Schema.TaggedStruct("unavailable", {
		reason: Schema.Literals(["project-missing", "worktree-missing"]),
	}),
]);
export type ChatDirectoryStatus = typeof ChatDirectoryStatus.Type;

const ChatArchiveErrors = Schema.Union([
	ChatNotFoundError,
	ChatArchiveWorktreeError,
]);

const WorktreeCheckpointSummary = Schema.Struct({
	archiveCommit: Schema.String,
	checkpointCreated: Schema.Boolean,
	archiveRef: Schema.NullOr(Schema.String),
	branch: Schema.String,
});

export const ChatArchiveResult = Schema.Struct({
	chat: Chat,
	checkpoint: Schema.NullOr(WorktreeCheckpointSummary),
	job: Schema.NullOr(ChatArchiveJob),
});
export type ChatArchiveResult = typeof ChatArchiveResult.Type;

export const ChatUnarchiveResult = Schema.Struct({
	chat: Chat,
	sessions: Schema.Array(Session),
	worktree: Schema.NullOr(Worktree),
	directoryStatus: ChatDirectoryStatus,
	restoreNotice: Schema.optional(Schema.Literal("branch-advanced")),
});
export type ChatUnarchiveResult = typeof ChatUnarchiveResult.Type;

export const ChatArchivePreview = Schema.Struct({
	chat: Chat,
	sessions: Schema.Array(Session),
});
export type ChatArchivePreview = typeof ChatArchivePreview.Type;

export const ChatListRpc = Rpc.make("chat.list", {
	payload: Schema.Struct({
		projectId: FolderId,
		includeArchived: Schema.optional(Schema.Boolean),
	}),
	success: Schema.Array(Chat),
});

export const ChatGetRpc = Rpc.make("chat.get", {
	payload: Schema.Struct({ chatId: ChatId }),
	success: Chat,
	error: ChatNotFoundError,
});

export const ChatArchivePreviewRpc = Rpc.make("chat.archivePreview", {
	payload: Schema.Struct({ chatId: ChatId }),
	success: ChatArchivePreview,
	error: Schema.Union([ChatNotFoundError, ChatNotArchivedError]),
});

/**
 * Create a new chat AND its initial session in one transaction. Returns
 * both so the renderer can land on the new session immediately without a
 * follow-up round-trip. The chat's `activeSessionId` is set to the new
 * session id.
 *
 * When `initialPrompt` is supplied, `initialMessage` is the persisted user
 * message — the renderer seeds it into its messages store so the chat view
 * never flashes the empty state while the live stream is connecting.
 */
export const ChatWorkspacePolicy = Schema.Union([
	Schema.TaggedStruct("fresh", {}),
	Schema.TaggedStruct("existing", { worktreeId: WorktreeId }),
	Schema.TaggedStruct("main", {}),
]);
export type ChatWorkspacePolicy = typeof ChatWorkspacePolicy.Type;

export const ChatCreationPhase = Schema.Literals([
	"persisted",
	"creating_workspace",
	"running_setup",
	"starting_agent",
	"running",
	"failed",
	"cancelling",
	"cancelled",
]);
export type ChatCreationPhase = typeof ChatCreationPhase.Type;

export const ChatCreationFailureStage = Schema.Literals([
	"workspace",
	"setup",
	"provider",
	"configuration",
	"legacy_unknown",
	"legacy_inconsistent",
]);
export type ChatCreationFailureStage = typeof ChatCreationFailureStage.Type;

export const ChatCreationOperation = Schema.Struct({
	operationId: Schema.String,
	chatId: ChatId,
	initialSessionId: SessionId,
	projectId: FolderId,
	providerId: ProviderId,
	model: Schema.String,
	title: Schema.NullOr(Schema.String),
	runtimeMode: RuntimeMode,
	permissionMode: PermissionMode,
	toolSearch: Schema.Boolean,
	prompt: Schema.NullOr(Schema.String),
	startupInput: Schema.NullOr(ComposerInput),
	startupQueueId: Schema.NullOr(Schema.String),
	startupReady: Schema.Boolean,
	workspacePolicy: ChatWorkspacePolicy,
	worktreeId: Schema.NullOr(WorktreeId),
	phase: ChatCreationPhase,
	failureStage: Schema.NullOr(ChatCreationFailureStage),
	retryable: Schema.Boolean,
	attempts: Schema.Struct({
		workspace: Schema.Number,
		setup: Schema.Number,
		provider: Schema.Number,
	}),
	setupBypassed: Schema.Boolean,
	leaseEpoch: Schema.Number,
	fingerprintVersion: Schema.Number,
	phaseStartedAt: Schema.DateFromString,
	error: Schema.NullOr(Schema.String),
	createdAt: Schema.DateFromString,
	updatedAt: Schema.DateFromString,
});
export type ChatCreationOperation = typeof ChatCreationOperation.Type;

export const ChatCreationListRpc = Rpc.make("chat.creation.list", {
	payload: Schema.Struct({ projectId: FolderId }),
	success: Schema.Array(ChatCreationOperation),
});

export const ChatCreationSummaryChange = Schema.Union([
	Schema.Struct({
		_tag: Schema.Literal("snapshot"),
		operations: Schema.Array(ChatCreationOperation),
	}),
	Schema.Struct({
		_tag: Schema.Literal("change"),
		operation: ChatCreationOperation,
	}),
]);
export type ChatCreationSummaryChange = typeof ChatCreationSummaryChange.Type;

export const ChatCreationStreamRpc = Rpc.make("chat.creation.stream", {
	payload: Schema.Struct({ projectId: FolderId }),
	success: ChatCreationSummaryChange,
	stream: true,
});

export const ChatCreationDiscardRpc = Rpc.make("chat.creation.discard", {
	payload: Schema.Struct({ operationId: Schema.String }),
	success: Schema.Struct({ discarded: Schema.Boolean }),
});

export const ChatCreationRecoveryAction = Schema.Literals([
	"retry_workspace",
	"retry_setup",
	"continue_anyway",
	"retry_agent",
]);
export type ChatCreationRecoveryAction = typeof ChatCreationRecoveryAction.Type;

export const ChatCreationRecoverRpc = Rpc.make("chat.creation.recover", {
	payload: Schema.Struct({
		operationId: Schema.String,
		action: ChatCreationRecoveryAction,
		expectedPhase: ChatCreationPhase,
		expectedFailureStage: Schema.NullOr(ChatCreationFailureStage),
		expectedAttempt: Schema.Number,
	}),
	success: ChatCreationOperation,
});

export const ChatCreateRpc = Rpc.make("chat.create", {
	payload: Schema.Struct({
		operationId: Schema.optional(Schema.String),
		chatId: Schema.optional(ChatId),
		initialSessionId: Schema.optional(SessionId),
		projectId: FolderId,
		providerId: ProviderId,
		model: Schema.String,
		title: Schema.optional(Schema.String),
		initialPrompt: Schema.optional(Schema.String),
		runtimeMode: Schema.optional(RuntimeMode),
		worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),

		workspacePolicy: Schema.optional(ChatWorkspacePolicy),
		startupInput: Schema.optional(ComposerInput),
		startupQueueId: Schema.optional(Schema.String),

		startupReady: Schema.optional(Schema.Boolean),
		agents: Schema.optional(Schema.Record(Schema.String, AgentDefinition)),
		enableSubagents: Schema.optional(Schema.Boolean),
		permissionMode: Schema.optional(PermissionMode),
		toolSearch: Schema.optional(Schema.Boolean),

		originSessionId: Schema.optional(SessionId),
		modelOptions: Schema.optional(Schema.Record(Schema.String, Schema.String)),

		background: Schema.optional(Schema.Boolean),
	}),
	success: Schema.Struct({
		chat: Chat,
		initialSession: Session,
		initialMessage: Schema.NullOr(Message),
	}),
	error: Schema.Union([SessionStartError, ChatCreationConflictError]),
});

export const ChatRenameRpc = Rpc.make("chat.rename", {
	payload: Schema.Struct({ chatId: ChatId, title: Schema.String }),
	success: Chat,
	error: ChatNotFoundError,
});

/**
 * Branch a conversation from a specific message into a new tab or chat. The
 * server picks `resume` vs `copy` based on the fork point and provider; the
 * new session records `forkedFromSessionId` / `forkedFromMessageId`.
 * `providerId` / `model` default to the source session's; `worktreeId` only
 * applies to `destination: "chat"`. (Declared here — below `Chat` — because
 * its success payload references the `Chat` class.)
 */
export const SessionForkRpc = Rpc.make("session.fork", {
	payload: Schema.Struct({
		commandId: Schema.optional(Schema.String),
		sourceSessionId: SessionId,
		fromMessageId: MessageId,
		nativeChildStepId: Schema.optional(Schema.String),
		destination: ForkDestination,
		providerId: Schema.optional(ProviderId),
		model: Schema.optional(Schema.String),
		worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
		title: Schema.optional(Schema.String),
	}),
	success: Schema.Struct({
		chat: Chat,
		session: Session,
		forkMode: ForkMode,
	}),
	error: Schema.Union([SessionNotFoundError, SessionStartError]),
});

/**
 * Snapshot-plus-live feed of chat rows for one project. Each subscription
 * first emits the current non-archived chats, then carries live patches. The
 * server subscribes before reading the snapshot, so reconnecting clients cannot
 * miss a chat/session mutation in the handoff between backfill and live events.
 */
export const ChatSummaryChange = Schema.Union([
	Schema.Struct({
		_tag: Schema.Literal("snapshot"),
		chats: Schema.Array(Chat),
	}),
	Schema.Struct({
		_tag: Schema.Literal("change"),
		chat: Chat,
	}),
]);
export type ChatSummaryChange = typeof ChatSummaryChange.Type;

export const ChatStreamChangesRpc = Rpc.make("chat.streamChanges", {
	payload: Schema.Struct({ projectId: FolderId }),
	success: ChatSummaryChange,
	stream: true,
});

/**
 * Mark a chat read by stamping `last_read_at` to "now". Returns the refreshed
 * chat so the renderer can reconcile its optimistic patch. Idempotent.
 */
export const ChatMarkReadRpc = Rpc.make("chat.markRead", {
	payload: Schema.Struct({ chatId: ChatId }),
	success: Chat,
	error: ChatNotFoundError,
});

export const ChatSetWorktreeRpc = Rpc.make("chat.setWorktree", {
	payload: Schema.Struct({
		chatId: ChatId,
		worktreeId: Schema.NullOr(WorktreeId),
	}),
	success: Chat,
	error: Schema.Union([ChatNotFoundError, ChatAlreadyStartedError]),
});

/**
 * Record the user's last-active tab within this chat. Called whenever the
 * tab strip selection changes so a future click on this chat's sidebar
 * row restores the correct tab. No-op if `sessionId` doesn't belong to
 * the chat (defensive against races).
 */
export const ChatSetActiveSessionRpc = Rpc.make("chat.setActiveSession", {
	payload: Schema.Struct({ chatId: ChatId, sessionId: SessionId }),
	success: Schema.Void,
	error: ChatNotFoundError,
});

export const ChatArchiveRpc = Rpc.make("chat.archive", {
	payload: Schema.Struct({
		chatId: ChatId,

		force: Schema.optional(Schema.Boolean),
	}),
	success: ChatArchiveResult,
	error: ChatArchiveErrors,
});

export const ChatArchiveStatusRpc = Rpc.make("chat.archiveStatus", {
	payload: Schema.Struct({ chatId: ChatId }),
	success: Schema.NullOr(ChatArchiveJob),
	error: ChatNotFoundError,
});

export const ChatArchiveJobsRpc = Rpc.make("chat.archiveJobs", {
	payload: Schema.Struct({ projectId: FolderId }),
	success: Schema.Array(ChatArchiveJob),
});

export const ChatDirectoryStatusRpc = Rpc.make("chat.directoryStatus", {
	payload: Schema.Struct({ chatId: ChatId }),
	success: ChatDirectoryStatus,
	error: ChatNotFoundError,
});

export const ChatUnarchiveRpc = Rpc.make("chat.unarchive", {
	payload: Schema.Struct({ chatId: ChatId }),
	success: ChatUnarchiveResult,
	error: Schema.Union([ChatNotFoundError, ChatArchiveWorktreeError]),
});

export const ChatDeleteRpc = Rpc.make("chat.delete", {
	payload: Schema.Struct({ chatId: ChatId }),
	success: Schema.Void,
	error: ChatNotFoundError,
});

export const MessagesListRpc = Rpc.make("messages.list", {
	payload: Schema.Struct({ sessionId: SessionId }),
	success: Schema.Array(Message),
	error: SessionNotFoundError,
});

/**
 * Send a user turn. The legacy `text` field stays accepted alongside the
 * richer `input` form so the renderer can migrate the composer to
 * `ComposerInput` in a follow-up phase without a wire flag-day. Server
 * prefers `input` when both are present.
 */
export class SessionInputBlockedError extends Schema.TaggedErrorClass<SessionInputBlockedError>()(
	"SessionInputBlockedError",
	{
		sessionId: SessionId,
		requestId: Schema.String,
		kind: Schema.Literals(["permission", "question", "plan"]),
		message: Schema.String,
	},
) {}

export const MessagesSendRpc = Rpc.make("messages.send", {
	payload: Schema.Struct({
		commandId: CommandId,
		sessionId: SessionId,
		text: Schema.optional(Schema.String),
		input: Schema.optional(ComposerInput),
		asGoal: Schema.optional(Schema.Boolean),
		modelOptions: Schema.optional(Schema.Record(Schema.String, Schema.String)),

		clientMessageId: Schema.optional(MessageId),
	}),
	success: Schema.Void,
	error: Schema.Union([
		SessionNotFoundError,
		DirectoryUnavailableError,
		SessionInputBlockedError,
	]),
});

/** Durable outcome of an exact-turn interrupt request. */
export const TurnInterruptReceipt = Schema.Union([
	Schema.TaggedStruct("requested", {
		turnId: AgentTurnId,
	}),
	Schema.TaggedStruct("not-active", {
		reason: Schema.Literals(["no-active-turn", "turn-mismatch"]),
		expectedTurnId: Schema.NullOr(AgentTurnId),
		actualTurnId: Schema.NullOr(AgentTurnId),
	}),
]);
export type TurnInterruptReceipt = typeof TurnInterruptReceipt.Type;

export const MessagesInterruptRpc = Rpc.make("messages.interrupt", {
	payload: Schema.Struct({
		commandId: CommandId,
		sessionId: SessionId,

		expectedTurnId: Schema.optional(AgentTurnId),
	}),
	success: TurnInterruptReceipt,
	error: SessionNotFoundError,
});

export class BackgroundTaskStopError extends Schema.TaggedErrorClass<BackgroundTaskStopError>()(
	"BackgroundTaskStopError",
	{ reason: Schema.String },
) {}

export const MessagesBackgroundStopRpc = Rpc.make("messages.background.stop", {
	payload: Schema.Struct({
		commandId: CommandId,
		sessionId: SessionId,
		turnId: AgentTurnId,
		attemptId: AttemptId,
		taskId: Schema.String,
	}),
	success: Schema.Void,
	error: Schema.Union([SessionNotFoundError, BackgroundTaskStopError]),
});

export const MessagesQueueListRpc = Rpc.make("messages.queue.list", {
	payload: Schema.Struct({ sessionId: SessionId }),
	success: QueueState,
	error: SessionNotFoundError,
});

export const MessagesQueueAddRpc = Rpc.make("messages.queue.add", {
	payload: Schema.Struct({
		commandId: CommandId,
		sessionId: SessionId,

		queueId: Schema.optional(Schema.String),
		input: ComposerInput,

		ready: Schema.optional(Schema.Boolean),

		flush: Schema.optional(Schema.Boolean),

		rejectIfBlocked: Schema.optional(Schema.Boolean),
	}),
	success: QueuedMessage,
	error: Schema.Union([
		SessionNotFoundError,
		QueuedMessageCapacityError,
		SessionInputBlockedError,
	]),
});

export const MessagesQueueUpdateRpc = Rpc.make("messages.queue.update", {
	payload: Schema.Struct({
		commandId: CommandId,
		sessionId: SessionId,
		queueId: Schema.String,
		input: ComposerInput,
	}),
	success: QueuedMessage,
	error: Schema.Union([
		SessionNotFoundError,
		QueuedMessageNotFoundError,
		QueuedMessageCapacityError,
	]),
});

export const MessagesQueueDeleteRpc = Rpc.make("messages.queue.delete", {
	payload: Schema.Struct({
		commandId: CommandId,
		sessionId: SessionId,
		queueId: Schema.String,
	}),
	success: Schema.Void,
	error: SessionNotFoundError,
});

/**
 * Run one durable queued item next. The server owns the idle-vs-running
 * decision, active-turn resolution, interruption, and successor identity.
 */
export const MessagesQueueRunNextRpc = Rpc.make("messages.queue.runNext", {
	payload: Schema.Struct({
		commandId: CommandId,
		sessionId: SessionId,
		queueId: Schema.String,
	}),
	success: Schema.Void,
	error: SessionNotFoundError,
});

export const MessagesQueueReorderRpc = Rpc.make("messages.queue.reorder", {
	payload: Schema.Struct({
		commandId: CommandId,
		sessionId: SessionId,
		queueIds: Schema.Array(Schema.String),
	}),
	success: Schema.Array(QueuedMessage),
	error: SessionNotFoundError,
});

export const MessagesQueueFlushRpc = Rpc.make("messages.queue.flush", {
	payload: Schema.Struct({ commandId: CommandId, sessionId: SessionId }),
	success: Schema.Void,
	error: SessionNotFoundError,
});

export const MessagesQueueResumeRpc = Rpc.make("messages.queue.resume", {
	payload: Schema.Struct({ commandId: CommandId, sessionId: SessionId }),
	success: Schema.Void,
	error: SessionNotFoundError,
});

/**
 * Re-open a stopped or failed session against the provider. A persisted
 * cursor resumes provider context when supported; without one, the provider
 * starts a fresh process attached to the same durable application session.
 */
export const SessionResumeRpc = Rpc.make("session.resume", {
	payload: Schema.Struct({ sessionId: SessionId }),
	success: Session,
	error: Schema.Union([SessionNotFoundError, SessionStartError]),
});

/**
 * Set the per-session permission posture. Takes effect on the next tool call —
 * if a turn is in flight when the toggle changes, the running canUseTool
 * callbacks observe the new mode without restarting the SDK.
 */
export class SessionModeUnsupportedError extends Schema.TaggedErrorClass<SessionModeUnsupportedError>()(
	"SessionModeUnsupportedError",
	{ message: Schema.String },
) {}

export const SessionSetRuntimeModeRpc = Rpc.make("session.setRuntimeMode", {
	payload: Schema.Struct({
		commandId: CommandId,
		sessionId: SessionId,
		runtimeMode: RuntimeMode,
	}),
	success: Schema.Void,
	error: Schema.Union([SessionNotFoundError, SessionModeUnsupportedError]),
});

/**
 * Switch the SDK lifecycle mode (plan / default / acceptEdits) on a live
 * session. Calls `Query.setPermissionMode` under the hood; the driver
 * emits a `PermissionModeChanged` event so the renderer chip stays in
 * sync without polling.
 */
export const SessionSetPermissionModeRpc = Rpc.make(
	"session.setPermissionMode",
	{
		payload: Schema.Struct({
			commandId: CommandId,
			sessionId: SessionId,
			mode: PermissionMode,
		}),
		success: Schema.Void,
		error: Schema.Union([SessionNotFoundError, SessionModeUnsupportedError]),
	},
);

/**
 * Resolve the pending question callback identified by its application `itemId`.
 * The driver returns the answers as the tool result, the SDK turn unwinds,
 * and the renderer paints a paired `user_question_answer` row.
 */
export const QuestionAttachment = Schema.Struct({
	sessionId: SessionId,
	itemId: AgentItemId,
});
export type QuestionAttachment = typeof QuestionAttachment.Type;

/**
 * Ephemeral provider-callback availability. Unlike the durable question row,
 * these entries intentionally start empty after every server restart and are
 * republished only when the replacement provider reissues the question.
 */
export const QuestionAttachmentChange = Schema.Union([
	Schema.Struct({
		_tag: Schema.Literal("snapshot"),
		attachments: Schema.Array(QuestionAttachment),
	}),
	Schema.Struct({
		_tag: Schema.Literal("change"),
		attachment: QuestionAttachment,
	}),
	Schema.Struct({
		_tag: Schema.Literal("remove"),
		sessionId: SessionId,
		itemId: AgentItemId,
	}),
]);
export type QuestionAttachmentChange = typeof QuestionAttachmentChange.Type;

/** Live blocking-question callbacks across sessions in one environment. */
export const SessionQuestionAttachmentsRpc = Rpc.make(
	"session.questionAttachments",
	{
		payload: Schema.Struct({}),
		success: QuestionAttachmentChange,
		stream: true,
	},
);

export const SessionAnswerQuestionRpc = Rpc.make("session.answerQuestion", {
	payload: Schema.Struct({
		commandId: CommandId,
		sessionId: SessionId,
		itemId: AgentItemId,
		answers: Schema.Array(UserQuestionAnswer),
	}),
	success: Schema.Void,
	error: Schema.Union([SessionNotFoundError, QuestionResolutionError]),
});

export const SessionCancelQuestionRpc = Rpc.make("session.cancelQuestion", {
	payload: Schema.Struct({
		sessionId: SessionId,
		itemId: AgentItemId,
	}),
	success: Schema.Void,
	error: Schema.Union([SessionNotFoundError, QuestionResolutionError]),
});

export const SessionPlanRespondRpc = Rpc.make("session.plan.respond", {
	payload: Schema.Struct({
		commandId: CommandId,
		sessionId: SessionId,
		toolCallId: Schema.String,
		outcome: PlanApprovalOutcome,
		feedback: Schema.optional(Schema.String),
	}),
	success: Schema.Void,
	error: Schema.Union([SessionNotFoundError, PlanResolutionError]),
});

/** Ordered durable session-domain feed with cursor-based replay. */
export const SessionEventsRpc = Rpc.make("session.events", {
	payload: Schema.Struct({
		sessionId: SessionId,
		afterVersion: Schema.optional(Schema.Number),
		streamEpoch: Schema.optional(Schema.String),
		hasProjection: Schema.optional(Schema.Boolean),
		includeRuntime: Schema.optional(Schema.Boolean),
		historyMode: Schema.optional(Schema.Literal("background")),
	}),
	success: SessionTimelineFrame,
	error: SessionNotFoundError,
	stream: true,
});

/** Lightweight durable cursor used to detect an open-but-stalled event stream. */
export const SessionEventsHeadRpc = Rpc.make("session.events.head", {
	payload: Schema.Struct({ sessionId: SessionId }),
	success: Schema.Struct({
		throughVersion: Schema.Number,
		streamEpoch: Schema.optional(Schema.String),
	}),
	error: SessionNotFoundError,
});

/** Older timeline messages, newest page first on the wire then rendered ascending. */
export const SessionMessagesPageRpc = Rpc.make("session.messages.page", {
	payload: Schema.Struct({
		sessionId: SessionId,
		beforeSequence: Schema.optional(Schema.Number),
		limit: Schema.optional(Schema.Number),
	}),
	success: Schema.Struct({
		messages: Schema.Array(Message),
		olderMessageSequence: Schema.NullOr(Schema.Number),
	}),
	error: SessionNotFoundError,
});

export const SessionGoalGetRpc = Rpc.make("session.goal.get", {
	payload: Schema.Struct({ sessionId: SessionId }),
	success: Schema.NullOr(ThreadGoal),
	error: Schema.Union([SessionNotFoundError, GoalUnsupportedError]),
});

export const SessionGoalSetRpc = Rpc.make("session.goal.set", {
	payload: Schema.Struct({
		sessionId: SessionId,
		goal: ThreadGoalSetInput,
	}),
	success: ThreadGoal,
	error: Schema.Union([
		SessionNotFoundError,
		SessionStartError,
		GoalUnsupportedError,
	]),
});

export const SessionGoalClearRpc = Rpc.make("session.goal.clear", {
	payload: Schema.Struct({ sessionId: SessionId }),
	success: Schema.Void,
	error: Schema.Union([SessionNotFoundError, GoalUnsupportedError]),
});

export const SessionGoalStreamRpc = Rpc.make("session.goal.stream", {
	payload: Schema.Struct({ sessionId: SessionId }),
	success: Schema.Struct({
		sessionId: SessionId,
		goal: Schema.NullOr(ThreadGoal),
	}),
	error: Schema.Union([SessionNotFoundError, GoalUnsupportedError]),
	stream: true,
});
