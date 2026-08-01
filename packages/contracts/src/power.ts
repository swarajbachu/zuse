import { Schema } from "effect";

export const POWER_STATE_CHANNEL = "zuse:power-state" as const;
export const POWER_SUBSCRIBE_CHANNEL = "zuse:power-subscribe" as const;
export const POWER_UNSUBSCRIBE_CHANNEL = "zuse:power-unsubscribe" as const;
export const POWER_GET_STATE_CHANNEL = "zuse:power-get-state" as const;
export const POWER_START_RECORDING_CHANNEL =
	"zuse:power-start-recording" as const;
export const POWER_STOP_RECORDING_CHANNEL =
	"zuse:power-stop-recording" as const;
export const POWER_EXPORT_RECORDING_CHANNEL =
	"zuse:power-export-recording" as const;
export const POWER_REPORT_WORKLOAD_CHANNEL =
	"zuse:power-report-workload" as const;
export const POWER_REPORT_LAG_CHANNEL = "zuse:power-report-lag" as const;
export const POWER_GET_HISTORY_CHANNEL = "zuse:power-get-history" as const;
export const POWER_CLEAR_HISTORY_CHANNEL = "zuse:power-clear-history" as const;
export const POWER_RECORDING_DURATION_MINUTES = [5, 15, 30] as const;

export const PowerSource = Schema.Literals(["battery", "ac", "unknown"]);
export type PowerSource = typeof PowerSource.Type;

export const PowerThermalState = Schema.Literals([
	"unknown",
	"nominal",
	"fair",
	"serious",
	"critical",
]);
export type PowerThermalState = typeof PowerThermalState.Type;

export const PowerProcessType = Schema.Literals([
	"main",
	"renderer",
	"gpu",
	"utility",
	"other",
]);
export type PowerProcessType = typeof PowerProcessType.Type;

export const PowerMemoryKind = Schema.Literals(["private", "working-set"]);
export type PowerMemoryKind = typeof PowerMemoryKind.Type;

export const PerformanceConfidence = Schema.Literals(["low", "medium", "high"]);
export type PerformanceConfidence = typeof PerformanceConfidence.Type;

export const PerformanceCapabilityState = Schema.Literals([
	"supported",
	"estimated",
	"unavailable",
]);
export type PerformanceCapabilityState = typeof PerformanceCapabilityState.Type;

export const PerformanceCapability = Schema.Struct({
	state: PerformanceCapabilityState,
	reason: Schema.optional(Schema.String),
});
export type PerformanceCapability = typeof PerformanceCapability.Type;

export class PerformanceCapabilities extends Schema.Class<PerformanceCapabilities>(
	"PerformanceCapabilities",
)({
	processMetrics: PerformanceCapability,
	idleWakeups: PerformanceCapability,
	batteryLevel: PerformanceCapability,
	batteryDrain: PerformanceCapability,
	thermalPressure: PerformanceCapability,
	exactTemperature: PerformanceCapability,
	deepEnergy: PerformanceCapability,
}) {}

export const PowerWorkloadState = Schema.Struct({
	activeAgents: Schema.Number,
	activeTerminals: Schema.Number,
	browserSessions: Schema.Number,
	activeBrowserSessions: Schema.Number,
	browserRecordings: Schema.Number,
	indexing: Schema.Boolean,
});
export type PowerWorkloadState = typeof PowerWorkloadState.Type;

export class PowerProcessMetric extends Schema.Class<PowerProcessMetric>(
	"PowerProcessMetric",
)({
	processType: PowerProcessType,
	pid: Schema.Number,
	creationTimeMs: Schema.Number,
	name: Schema.optional(Schema.String),
	cpuPercent: Schema.Number,
	cumulativeCpuSeconds: Schema.NullOr(Schema.Number),
	idleWakeupsPerSecond: Schema.Number,
	memoryBytes: Schema.Number,
	memoryKind: PowerMemoryKind,
}) {}

export class PowerSnapshot extends Schema.Class<PowerSnapshot>("PowerSnapshot")(
	{
		capturedAt: Schema.String,
		powerSource: PowerSource,
		thermalState: PowerThermalState,
		windowVisible: Schema.Boolean,
		processes: Schema.Array(PowerProcessMetric),
		workload: PowerWorkloadState,
		totalCpuPercent: Schema.Number,
		totalIdleWakeupsPerSecond: Schema.Number,
		totalMemoryBytes: Schema.Number,
		memoryKind: PowerMemoryKind,
		logicalCpuCount: Schema.optional(Schema.Number),
		eventLoopP99Ms: Schema.optional(Schema.Number),
		batteryPercent: Schema.optional(Schema.NullOr(Schema.Number)),
		isCharging: Schema.optional(Schema.NullOr(Schema.Boolean)),
	},
) {}

export const LagKind = Schema.Literals([
	"long-task",
	"long-animation-frame",
	"animation-stall",
	"input-latency",
	"react-commit",
	"rpc",
	"event-loop",
	"gc",
]);
export type LagKind = typeof LagKind.Type;

export const StallCause = Schema.Literals([
	"script",
	"style-layout",
	"react-render",
	"input-handler",
	"rpc",
	"event-loop",
	"gc",
	"workload",
	"unknown",
]);
export type StallCause = typeof StallCause.Type;

const SanitizedStallText = Schema.String.check(
	Schema.isMaxLength(120),
	Schema.isPattern(/^[a-zA-Z0-9_.$: -]*$/),
);
const SanitizedStallContext = Schema.Array(SanitizedStallText).check(
	Schema.isMaxLength(8),
);

export class StallAttribution extends Schema.Class<StallAttribution>(
	"StallAttribution",
)({
	cause: StallCause,
	label: SanitizedStallText,
	confidence: PerformanceConfidence,
	blockingDurationMs: Schema.optional(Schema.Number),
	renderDurationMs: Schema.optional(Schema.Number),
	styleLayoutDurationMs: Schema.optional(Schema.Number),
	scriptInvoker: Schema.optional(SanitizedStallText),
	scriptFunction: Schema.optional(SanitizedStallText),
	scriptSource: Schema.optional(SanitizedStallText),
	scriptPosition: Schema.optional(Schema.Number),
	reactPhase: Schema.optional(
		Schema.Literals(["mount", "update", "nested-update"]),
	),
	reactBaseDurationMs: Schema.optional(Schema.Number),
	recentActions: SanitizedStallContext,
	activeWorkloads: SanitizedStallContext,
	relatedOperations: SanitizedStallContext,
}) {}

export class LagSample extends Schema.Class<LagSample>("LagSample")({
	id: Schema.String,
	capturedAt: Schema.String,
	kind: LagKind,
	durationMs: Schema.Number,
	source: Schema.Literals(["renderer", "main", "server"]),
	name: Schema.optional(Schema.String),
	sessionId: Schema.optional(Schema.NullOr(Schema.String)),
	attribution: Schema.optional(StallAttribution),
}) {}

export class WorkloadInterval extends Schema.Class<WorkloadInterval>(
	"WorkloadInterval",
)({
	id: Schema.String,
	kind: Schema.String,
	startedAt: Schema.String,
	endedAt: Schema.optional(Schema.NullOr(Schema.String)),
	projectId: Schema.optional(Schema.NullOr(Schema.String)),
	sessionId: Schema.optional(Schema.NullOr(Schema.String)),
	providerId: Schema.optional(Schema.NullOr(Schema.String)),
}) {}

export class PerformanceIncident extends Schema.Class<PerformanceIncident>(
	"PerformanceIncident",
)({
	id: Schema.String,
	kind: Schema.Literals([
		"cpu",
		"wakeups",
		"memory-growth",
		"battery-drain",
		"thermal",
		"lag",
	]),
	severity: Schema.Literals(["info", "warn", "error"]),
	startedAt: Schema.String,
	endedAt: Schema.String,
	message: Schema.String,
	value: Schema.Number,
	unit: Schema.String,
	occurrences: Schema.Number,
	confidence: PerformanceConfidence,
	likelyContributor: Schema.optional(Schema.String),
}) {}

export class ProcessResourceSample extends Schema.Class<ProcessResourceSample>(
	"ProcessResourceSample",
)({
	processType: PowerProcessType,
	pid: Schema.Number,
	name: Schema.optional(Schema.String),
	averageCpuPercent: Schema.Number,
	peakCpuPercent: Schema.Number,
	cpuSeconds: Schema.NullOr(Schema.Number),
	averageIdleWakeupsPerSecond: Schema.Number,
	peakMemoryBytes: Schema.Number,
	memoryGrowthBytes: Schema.Number,
}) {}

export class PerformanceOverview extends Schema.Class<PerformanceOverview>(
	"PerformanceOverview",
)({
	readAt: Schema.String,
	sampleCount: Schema.Number,
	averageCpuPercent: Schema.Number,
	peakCpuPercent: Schema.Number,
	peakMemoryBytes: Schema.Number,
	memoryGrowthBytes: Schema.Number,
	averageIdleWakeupsPerSecond: Schema.Number,
	eventLoopP99Ms: Schema.Number,
	batteryDrainPercentPerHour: Schema.NullOr(Schema.Number),
	batteryDrainConfidence: PerformanceConfidence,
	thermalState: PowerThermalState,
	responsiveness: Schema.Literals(["good", "degraded", "poor"]),
	incidents: Schema.Array(PerformanceIncident),
	hotspots: Schema.Array(ProcessResourceSample),
}) {}

export class PerformanceHistory extends Schema.Class<PerformanceHistory>(
	"PerformanceHistory",
)({
	readAt: Schema.String,
	since: Schema.String,
	capabilities: PerformanceCapabilities,
	samples: Schema.Array(PowerSnapshot),
	lagSamples: Schema.Array(LagSample),
	overview: PerformanceOverview,
	storageBytes: Schema.Number,
	partial: Schema.Boolean,
	warnings: Schema.Array(Schema.String),
}) {}

export const PowerSummary = Schema.Struct({
	startedAt: Schema.String,
	endedAt: Schema.String,
	durationMs: Schema.Number,
	sampleCount: Schema.Number,
	averageCpuPercent: Schema.Number,
	peakCpuPercent: Schema.Number,
	averageIdleWakeupsPerSecond: Schema.Number,
	peakIdleWakeupsPerSecond: Schema.Number,
	startMemoryBytes: Schema.Number,
	endMemoryBytes: Schema.Number,
	memoryChangeBytes: Schema.Number,
	peakMemoryBytes: Schema.Number,
	memoryKind: PowerMemoryKind,
	peakProcessCount: Schema.Number,
});
export type PowerSummary = typeof PowerSummary.Type;

export const PowerRecordingDurationMinutes = Schema.Literals(
	POWER_RECORDING_DURATION_MINUTES,
);
export type PowerRecordingDurationMinutes =
	typeof PowerRecordingDurationMinutes.Type;

export class PowerActiveRecording extends Schema.Class<PowerActiveRecording>(
	"PowerActiveRecording",
)({
	id: Schema.String,
	startedAt: Schema.String,
	endsAt: Schema.String,
	durationMinutes: PowerRecordingDurationMinutes,
	sampleCount: Schema.Number,
	deepProfileStatus: Schema.optional(
		Schema.Literals(["authorizing", "collecting", "complete", "unavailable"]),
	),
}) {}

export class DeepEnergySummary extends Schema.Class<DeepEnergySummary>(
	"DeepEnergySummary",
)({
	status: Schema.Literals(["complete", "unavailable", "cancelled"]),
	cpuPowerMw: Schema.NullOr(Schema.Number),
	gpuPowerMw: Schema.NullOr(Schema.Number),
	anePowerMw: Schema.NullOr(Schema.Number),
	combinedPowerMw: Schema.NullOr(Schema.Number),
	thermalPressure: Schema.optional(Schema.String),
	reason: Schema.optional(Schema.String),
}) {}

export class PowerSpikeSample extends Schema.Class<PowerSpikeSample>(
	"PowerSpikeSample",
)({
	capturedAt: Schema.String,
	totalCpuPercent: Schema.Number,
	totalIdleWakeupsPerSecond: Schema.Number,
	totalMemoryBytes: Schema.Number,
	workload: PowerWorkloadState,
}) {}

export class PowerCompletedRecording extends Schema.Class<PowerCompletedRecording>(
	"PowerCompletedRecording",
)({
	id: Schema.String,
	startedAt: Schema.String,
	endedAt: Schema.String,
	durationMinutes: PowerRecordingDurationMinutes,
	summary: PowerSummary,
	highestSamples: Schema.Array(PowerSpikeSample),
	deepEnergy: Schema.optional(DeepEnergySummary),
}) {}

export class PowerMonitorState extends Schema.Class<PowerMonitorState>(
	"PowerMonitorState",
)({
	latestSnapshot: Schema.NullOr(PowerSnapshot),
	fiveMinuteSummary: Schema.NullOr(PowerSummary),
	activeRecording: Schema.NullOr(PowerActiveRecording),
	latestRecording: Schema.NullOr(PowerCompletedRecording),
}) {}

export class PowerInteractionMeasurement extends Schema.Class<PowerInteractionMeasurement>(
	"PowerInteractionMeasurement",
)({
	recordedAt: Schema.String,
	name: Schema.String,
	durationMs: Schema.Number,
}) {}

export class PowerExportResult extends Schema.Class<PowerExportResult>(
	"PowerExportResult",
)({
	jsonPath: Schema.String,
	markdownPath: Schema.String,
}) {}
