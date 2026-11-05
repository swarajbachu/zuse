import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";
import { ProviderId, RuntimeMode } from "./agent.ts";
import { FolderId, WorktreeId } from "./ids.ts";
import { SessionId } from "./session.ts";

const ShortText = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(200),
);
const TaskText = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(100_000),
);
const Timestamp = Schema.Number.check(
	Schema.isInt(),
	Schema.isGreaterThanOrEqualTo(0),
);
export const TaskSchedule = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("once"), at: Timestamp }),
	Schema.Struct({
		kind: Schema.Literal("interval"),
		everyMs: Schema.Number.check(
			Schema.isInt(),
			Schema.isGreaterThanOrEqualTo(60_000),
		),
		startAt: Schema.optional(Timestamp),
	}),
	Schema.Struct({ kind: Schema.Literal("webhook") }),
]);
export type TaskSchedule = typeof TaskSchedule.Type;
export const ScheduledTask = Schema.Struct({
	id: Schema.String,
	sessionId: SessionId,
	title: Schema.String,
	prompt: Schema.String,
	schedule: TaskSchedule,
	enabled: Schema.Boolean,
	nextRunAt: Schema.NullOr(Timestamp),
	lastRunAt: Schema.NullOr(Timestamp),
	lastError: Schema.NullOr(Schema.String),
	createdAt: Timestamp,
});
export type ScheduledTask = typeof ScheduledTask.Type;
export const ScheduledTaskCreate = Schema.Struct({
	sessionId: SessionId,
	clientRequestId: ShortText,
	title: ShortText,
	prompt: TaskText,
	schedule: TaskSchedule,
});
export type ScheduledTaskCreate = typeof ScheduledTaskCreate.Type;
export const ScheduledTaskUpdate = Schema.Struct({
	sessionId: SessionId,
	taskId: Schema.String,
	title: Schema.optional(ShortText),
	prompt: Schema.optional(TaskText),
	schedule: Schema.optional(TaskSchedule),
	enabled: Schema.optional(Schema.Boolean),
});
export type ScheduledTaskUpdate = typeof ScheduledTaskUpdate.Type;
export class AutomationError extends Schema.TaggedErrorClass<AutomationError>()(
	"AutomationError",
	{ message: Schema.String },
) {}
const EnvName = Schema.String.check(
	Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
);
export const SecretRequest = Schema.Struct({
	id: Schema.String,
	sessionId: SessionId,
	label: Schema.String,
	reason: Schema.String,
	environmentVariable: EnvName,
	status: Schema.Literals(["pending", "provided", "cancelled"]),
	reference: Schema.NullOr(Schema.String),
	createdAt: Timestamp,
});
export type SecretRequest = typeof SecretRequest.Type;
export const SecretRequestCreate = Schema.Struct({
	sessionId: SessionId,
	clientRequestId: ShortText,
	label: ShortText,
	reason: Schema.String.check(Schema.isMaxLength(2000)),
	environmentVariable: EnvName,
});
export type SecretRequestCreate = typeof SecretRequestCreate.Type;
export const ScheduleCreateRpc = Rpc.make("schedule.create", {
	payload: ScheduledTaskCreate,
	success: ScheduledTask,
	error: AutomationError,
});
export const ScheduleListRpc = Rpc.make("schedule.list", {
	payload: Schema.Struct({ sessionId: SessionId }),
	success: Schema.Array(ScheduledTask),
	error: AutomationError,
});
export const ScheduleUpdateRpc = Rpc.make("schedule.update", {
	payload: ScheduledTaskUpdate,
	success: ScheduledTask,
	error: AutomationError,
});
export const ScheduleDeleteRpc = Rpc.make("schedule.delete", {
	payload: Schema.Struct({ sessionId: SessionId, taskId: Schema.String }),
	success: Schema.Void,
	error: AutomationError,
});

export const ScheduleTriggerRpc = Rpc.make("schedule.trigger", {
	payload: Schema.Struct({
		sessionId: SessionId,
		taskId: Schema.String,
		eventId: ShortText,
	}),
	success: Schema.Void,
	error: AutomationError,
});
export const SecretRequestRpc = Rpc.make("secrets.request", {
	payload: SecretRequestCreate,
	success: SecretRequest,
	error: AutomationError,
});
export const SecretListRpc = Rpc.make("secrets.list", {
	payload: Schema.Struct({ sessionId: SessionId }),
	success: Schema.Array(SecretRequest),
	error: AutomationError,
});
export const SecretRespondRpc = Rpc.make("secrets.respond", {
	payload: Schema.Struct({
		sessionId: SessionId,
		requestId: Schema.String,
		value: Schema.optional(
			Schema.Redacted(
				Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536)),
			),
		),
	}),
	success: SecretRequest,
	error: AutomationError,
});

const NonEmpty = Schema.String.check(
	Schema.isPattern(/\S/u),
	Schema.isMinLength(1),
	Schema.isMaxLength(200),
);
const BoundedText = Schema.String.check(Schema.isMaxLength(2000));
const Prompt = Schema.String.check(
	Schema.isPattern(/\S/u),
	Schema.isMaxLength(30000),
);
const Names = Schema.Array(NonEmpty).check(Schema.isMaxLength(100));
const Metadata = Schema.Record(NonEmpty, BoundedText).check(
	Schema.isMaxProperties(100),
);
const EventContext = Schema.Record(
	NonEmpty,
	Schema.String.check(Schema.isMaxLength(60000)),
).check(
	Schema.isMaxProperties(100),
	Schema.makeFilter((value) =>
		JSON.stringify(value).length <= 60000
			? undefined
			: "Event context exceeds 60,000 characters.",
	),
);
const PositiveInt = Schema.Number.check(
	Schema.isInt(),
	Schema.isGreaterThan(0),
);
export const AutomationTrigger = Schema.Union([
	Schema.Struct({
		_tag: Schema.Literal("schedule"),
		cron: NonEmpty,
		timezone: NonEmpty,
		onceAt: Schema.optional(Schema.String),
	}),
	Schema.Struct({
		_tag: Schema.Literal("github"),
		events: Schema.Array(
			Schema.Literals([
				"issue_comment",
				"issues",
				"pull_request",
				"pull_request_review",
				"pull_request_review_comment",
				"check_run",
				"push",
			]),
		).check(Schema.isMinLength(1), Schema.isMaxLength(7)),
		repositories: Names,
		actions: Names,
	}),
	Schema.Struct({
		_tag: Schema.Literal("slack"),
		events: Schema.Array(
			Schema.Literals(["mention", "message", "reaction"]),
		).check(Schema.isMinLength(1), Schema.isMaxLength(3)),
		channelIds: Names,
		keywords: Names,
		includeBotMessages: Schema.Boolean,
	}),
	Schema.Struct({
		_tag: Schema.Literals([
			"webhook",
			"security_scan",
			"snapshot_build",
			"manual",
		]),
	}),
]);
export type AutomationTrigger = typeof AutomationTrigger.Type;
/** Run each trigger as a cloud agent on this sandbox provider. */
export const AutomationCloudMachine = Schema.Struct({
	providerId: NonEmpty,
	/** Try the account's other available providers when this one cannot start. */
	fallback: Schema.Boolean,
});
export type AutomationCloudMachine = typeof AutomationCloudMachine.Type;
export const AutomationConfig = Schema.Struct({
	projectId: FolderId,
	name: NonEmpty,
	description: BoundedText,
	enabled: Schema.Boolean,
	triggers: Schema.Array(AutomationTrigger).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(20),
	),
	action: Schema.Literals([
		"new_session",
		"existing_session",
		"auto_triage",
		"code_scan",
	]),
	sessionId: Schema.NullOr(SessionId),
	prompt: Prompt,
	providerId: ProviderId,
	model: NonEmpty,
	modelOptions: Metadata,
	runtimeMode: RuntimeMode,
	runAs: Schema.Literals(["owner", "system"]),
	worktreeId: Schema.NullOr(WorktreeId),
	environment: Schema.Literals(["local", "cloud"]),
	/** Native MCP server names; empty inherits the provider configuration. */
	mcpServerIds: Names,
	allowChildSessions: Schema.Boolean,
	/** enabled=false denies networking; nonempty allowedDomains restrict enabled networking. */
	network: Schema.Struct({
		enabled: Schema.Boolean,
		allowedDomains: Names,
	}),
	metadata: Metadata,
	spendLimitUsd: Schema.NullOr(Schema.Number.check(Schema.isGreaterThan(0))),
	rateLimit: Schema.Struct({
		count: PositiveInt.check(Schema.isLessThanOrEqualTo(10000)),
		windowSeconds: PositiveInt.check(Schema.isLessThanOrEqualTo(2592000)),
	}),
	queue: Schema.Struct({
		enabled: Schema.Boolean,
		maxConcurrency: PositiveInt.check(Schema.isLessThanOrEqualTo(20)),
	}),
	notifications: Schema.Array(
		Schema.Struct({
			channel: Schema.Literals(["email", "slack"]),
			destination: NonEmpty,
		}),
	).check(Schema.isMaxLength(20)),
	/** Absent or null runs sessions in the runtime that owns the automation. */
	cloudMachine: Schema.optional(Schema.NullOr(AutomationCloudMachine)),
});
export type AutomationConfig = typeof AutomationConfig.Type;
export const Automation = Schema.Struct({
	id: Schema.String,
	revision: PositiveInt,
	config: AutomationConfig,
	createdAt: Schema.String,
	updatedAt: Schema.String,
	nextRunAt: Schema.NullOr(Schema.String),
	webhook: Schema.optional(
		Schema.Struct({ url: Schema.String, token: Schema.String }),
	),
});
export type Automation = typeof Automation.Type;
export const AutomationRun = Schema.Struct({
	id: Schema.String,
	automationId: Schema.String,
	eventId: Schema.String,
	source: Schema.String,
	status: Schema.Literals([
		"queued",
		"running",
		"completed",
		"failed",
		"cancelled",
		"cancelling",
		"skipped",
	]),
	sessionId: Schema.NullOr(SessionId),
	chatId: Schema.NullOr(Schema.String),
	createdAt: Schema.String,
	startedAt: Schema.NullOr(Schema.String),
	finishedAt: Schema.NullOr(Schema.String),
	error: Schema.NullOr(Schema.String),
	/** Sandbox provider of the cloud agent this run started, if any. */
	cloudProviderId: Schema.optional(Schema.NullOr(Schema.String)),
	cloudWorkspaceId: Schema.optional(Schema.NullOr(Schema.String)),
});
export type AutomationRun = typeof AutomationRun.Type;
export const AutomationDispatchInput = Schema.Struct({
	automationId: Schema.String,
	eventId: NonEmpty,
	source: Schema.Literals([
		"slack",
		"github",
		"webhook",
		"security_scan",
		"snapshot_build",
		"schedule",
	]),
	prompt: Schema.String.check(Schema.isMaxLength(60000)),
	context: EventContext,
});
export type AutomationDispatchInput = typeof AutomationDispatchInput.Type;
export const AutomationListRpc = Rpc.make("automation.list", {
	payload: Schema.Struct({ projectId: Schema.optional(FolderId) }),
	success: Schema.Array(Automation),
	error: AutomationError,
});
export const AutomationGetRpc = Rpc.make("automation.get", {
	payload: Schema.Struct({ id: Schema.String }),
	success: Automation,
	error: AutomationError,
});
export const AutomationSaveRpc = Rpc.make("automation.save", {
	payload: Schema.Struct({
		id: Schema.optional(Schema.String),
		expectedRevision: Schema.optional(PositiveInt),
		requestId: Schema.optional(NonEmpty),
		config: AutomationConfig,
	}),
	success: Automation,
	error: AutomationError,
});
export const AutomationDeleteRpc = Rpc.make("automation.delete", {
	payload: Schema.Struct({ id: Schema.String }),
	success: Schema.Void,
	error: AutomationError,
});
export const AutomationRunRpc = Rpc.make("automation.run", {
	payload: Schema.Struct({ id: Schema.String, requestId: NonEmpty }),
	success: AutomationRun,
	error: AutomationError,
});
export const AutomationRunsRpc = Rpc.make("automation.runs", {
	payload: Schema.Struct({
		id: Schema.String,
		limit: Schema.optional(PositiveInt),
	}),
	success: Schema.Array(AutomationRun),
	error: AutomationError,
});
export const AutomationCancelRpc = Rpc.make("automation.cancel", {
	payload: Schema.Struct({ runId: Schema.String }),
	success: AutomationRun,
	error: AutomationError,
});
export const AutomationDispatchRpc = Rpc.make("automation.dispatch", {
	payload: AutomationDispatchInput,
	success: AutomationRun,
	error: AutomationError,
});

export const AutomationTemplate = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	description: BoundedText,
	category: Schema.String,
	integrations: Schema.Array(Schema.String),
	prompt: Schema.String,
	trigger: AutomationTrigger,
	action: AutomationConfig.fields.action,
});
export type AutomationTemplate = typeof AutomationTemplate.Type;
export const AutomationTemplatesRpc = Rpc.make("automation.templates", {
	payload: Schema.Struct({}),
	success: Schema.Array(AutomationTemplate),
});
export const AutomationCapabilities = Schema.Struct({
	environment: Schema.Literals(["local", "cloud"]),
	networkIsolation: Schema.Boolean,
	spendLimits: Schema.Boolean,
	spendLimitProviders: Schema.Array(ProviderId),
	mcpSelectionProviders: Schema.Array(ProviderId),
	mcpSelection: Schema.Boolean,
	systemIdentity: Schema.Boolean,
	emailNotifications: Schema.Boolean,
	slackNotifications: Schema.Boolean,
	/** Whether this runtime can start runs as cloud agents. */
	cloudMachines: Schema.optional(Schema.Boolean),
});
export type AutomationCapabilities = typeof AutomationCapabilities.Type;
export const AutomationCapabilitiesRpc = Rpc.make("automation.capabilities", {
	payload: Schema.Struct({}),
	success: AutomationCapabilities,
});
