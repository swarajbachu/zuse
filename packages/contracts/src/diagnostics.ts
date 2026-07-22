import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

export const DiagnosticSeverity = Schema.Literals([
	"debug",
	"info",
	"warn",
	"error",
	"fatal",
]);
export type DiagnosticSeverity = typeof DiagnosticSeverity.Type;

export const DiagnosticRecoveryStatus = Schema.Literals([
	"not-needed",
	"unresolved",
	"recovering",
	"recovered",
	"failed",
]);
export type DiagnosticRecoveryStatus = typeof DiagnosticRecoveryStatus.Type;

export const DiagnosticEvent = Schema.Struct({
	id: Schema.String,
	createdAt: Schema.String,
	severity: DiagnosticSeverity,
	source: Schema.String,
	category: Schema.String,
	message: Schema.String,
	detail: Schema.optional(Schema.String),
	fingerprint: Schema.String,
	runId: Schema.String,
	recoveryStatus: DiagnosticRecoveryStatus,
	traceId: Schema.optional(Schema.String),
	spanId: Schema.optional(Schema.String),
	projectId: Schema.optional(Schema.NullOr(Schema.String)),
	chatId: Schema.optional(Schema.NullOr(Schema.String)),
	sessionId: Schema.optional(Schema.NullOr(Schema.String)),
	providerId: Schema.optional(Schema.NullOr(Schema.String)),
	durationMs: Schema.optional(Schema.Number),
});
export type DiagnosticEvent = typeof DiagnosticEvent.Type;

export const DiagnosticFailureGroup = Schema.Struct({
	fingerprint: Schema.String,
	severity: DiagnosticSeverity,
	source: Schema.String,
	message: Schema.String,
	count: Schema.Number,
	firstSeenAt: Schema.String,
	lastSeenAt: Schema.String,
	recoveredCount: Schema.Number,
});
export type DiagnosticFailureGroup = typeof DiagnosticFailureGroup.Type;

export class DiagnosticsOverviewResult extends Schema.Class<DiagnosticsOverviewResult>(
	"DiagnosticsOverviewResult",
)({
	status: Schema.Literals(["healthy", "degraded", "failing"]),
	runId: Schema.String,
	readAt: Schema.String,
	eventCount: Schema.Number,
	errorCount: Schema.Number,
	warningCount: Schema.Number,
	fatalCount: Schema.Number,
	slowOperationCount: Schema.Number,
	parseErrorCount: Schema.Number,
	unseenCount: Schema.Number,
	storageBytes: Schema.Number,
	capturePaused: Schema.Boolean,
	previousRunUnclean: Schema.Boolean,
	latestIncidents: Schema.Array(DiagnosticEvent),
	commonFailures: Schema.Array(DiagnosticFailureGroup),
	slowestOperations: Schema.Array(DiagnosticEvent),
	topOperations: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			count: Schema.Number,
			failureCount: Schema.Number,
			averageDurationMs: Schema.Number,
			p95DurationMs: Schema.Number,
			maxDurationMs: Schema.Number,
		}),
	),
}) {}

export class DiagnosticsEventsResult extends Schema.Class<DiagnosticsEventsResult>(
	"DiagnosticsEventsResult",
)({
	events: Schema.Array(DiagnosticEvent),
	nextCursor: Schema.NullOr(Schema.String),
	total: Schema.Number,
}) {}

export const DiagnosticProcess = Schema.Struct({
	pid: Schema.Number,
	parentPid: Schema.Number,
	depth: Schema.Number,
	name: Schema.String,
	command: Schema.String,
	cpuPercent: Schema.Number,
	rssBytes: Schema.Number,
	uptimeSeconds: Schema.Number,
	childPids: Schema.Array(Schema.Number),
});
export type DiagnosticProcess = typeof DiagnosticProcess.Type;

export class DiagnosticsProcessesResult extends Schema.Class<DiagnosticsProcessesResult>(
	"DiagnosticsProcessesResult",
)({
	supported: Schema.Boolean,
	readAt: Schema.String,
	serverPid: Schema.Number,
	processes: Schema.Array(DiagnosticProcess),
	totalCpuPercent: Schema.Number,
	totalRssBytes: Schema.Number,
	error: Schema.optional(Schema.String),
}) {}

export class DiagnosticsSignalResult extends Schema.Class<DiagnosticsSignalResult>(
	"DiagnosticsSignalResult",
)({ signaled: Schema.Boolean, message: Schema.optional(Schema.String) }) {}

const DiagnosticArtifactName = Schema.String;
const DiagnosticsLogEntry = Schema.Struct({
	createdAt: Schema.String,
	level: Schema.Literals(["debug", "info", "warn", "error"]),
	source: Schema.String,
	message: Schema.String,
	detail: Schema.optional(Schema.String),
});
const DiagnosticsUiAction = Schema.Struct({
	createdAt: Schema.String,
	action: Schema.String,
	detail: Schema.optional(Schema.String),
});
const DiagnosticsClientContext = Schema.Struct({
	view: Schema.optional(Schema.String),
	settingsSection: Schema.optional(Schema.String),
	activeMainTab: Schema.optional(Schema.String),
	selectedFolderId: Schema.optional(Schema.NullOr(Schema.String)),
	selectedChatId: Schema.optional(Schema.NullOr(Schema.String)),
	activeSessionId: Schema.optional(Schema.NullOr(Schema.String)),
	openFile: Schema.optional(Schema.NullOr(Schema.String)),
	rightSidebarOpen: Schema.optional(Schema.Boolean),
	leftSidebarOpen: Schema.optional(Schema.Boolean),
	recentUiActions: Schema.Array(DiagnosticsUiAction),
	rendererLogs: Schema.Array(DiagnosticsLogEntry),
	mainProcessLogs: Schema.Array(DiagnosticsLogEntry),
});

export class DiagnosticsExportResult extends Schema.Class<DiagnosticsExportResult>(
	"DiagnosticsExportResult",
)({
	diagnosticId: Schema.String,
	createdAt: Schema.DateFromString,
	bundlePath: Schema.String,
	summary: Schema.String,
	included: Schema.Array(DiagnosticArtifactName),
}) {}

export class DiagnosticsExportError extends Schema.TaggedErrorClass<DiagnosticsExportError>()(
	"DiagnosticsExportError",
	{ reason: Schema.String },
) {}

const DiagnosticsError = DiagnosticsExportError;

export const DiagnosticsOverviewRpc = Rpc.make("diagnostics.overview", {
	payload: Schema.Struct({ since: Schema.optional(Schema.String) }),
	success: DiagnosticsOverviewResult,
	error: DiagnosticsError,
});

export const DiagnosticsEventsRpc = Rpc.make("diagnostics.events", {
	payload: Schema.Struct({
		cursor: Schema.optional(Schema.String),
		limit: Schema.optional(Schema.Number),
		severities: Schema.optional(Schema.Array(DiagnosticSeverity)),
		source: Schema.optional(Schema.String),
		search: Schema.optional(Schema.String),
		since: Schema.optional(Schema.String),
	}),
	success: DiagnosticsEventsResult,
	error: DiagnosticsError,
});

export const DiagnosticsProcessesRpc = Rpc.make("diagnostics.processes", {
	success: DiagnosticsProcessesResult,
	error: DiagnosticsError,
});

export const DiagnosticsSignalRpc = Rpc.make("diagnostics.signalProcess", {
	payload: Schema.Struct({
		pid: Schema.Number,
		signal: Schema.Literals(["interrupt", "terminate", "kill"]),
	}),
	success: DiagnosticsSignalResult,
	error: DiagnosticsError,
});

export const DiagnosticsIngestRpc = Rpc.make("diagnostics.ingest", {
	payload: Schema.Struct({ events: Schema.Array(DiagnosticEvent) }),
	success: Schema.Void,
	error: DiagnosticsError,
});

export const DiagnosticsExportRpc = Rpc.make("diagnostics.export", {
	payload: Schema.Struct({
		clientContext: Schema.optional(DiagnosticsClientContext),
		since: Schema.optional(Schema.String),
		includeSessionEvents: Schema.optional(Schema.Boolean),
	}),
	success: DiagnosticsExportResult,
	error: DiagnosticsExportError,
});
