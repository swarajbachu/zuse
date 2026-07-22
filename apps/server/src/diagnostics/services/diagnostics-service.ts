import type {
	DiagnosticEvent,
	DiagnosticSeverity,
	DiagnosticsEventsResult,
	DiagnosticsExportError,
	DiagnosticsExportResult,
	DiagnosticsOverviewResult,
	DiagnosticsProcessesResult,
	DiagnosticsSignalResult,
} from "@zuse/contracts";
import { Context, type Effect } from "effect";

export interface DiagnosticsServiceShape {
	readonly overview: (payload: {
		readonly since?: string;
	}) => Effect.Effect<DiagnosticsOverviewResult, DiagnosticsExportError>;
	readonly events: (payload: {
		readonly cursor?: string;
		readonly limit?: number;
		readonly severities?: ReadonlyArray<DiagnosticSeverity>;
		readonly source?: string;
		readonly search?: string;
		readonly since?: string;
	}) => Effect.Effect<DiagnosticsEventsResult, DiagnosticsExportError>;
	readonly ingest: (
		events: ReadonlyArray<DiagnosticEvent>,
	) => Effect.Effect<void, DiagnosticsExportError>;
	readonly processes: Effect.Effect<
		DiagnosticsProcessesResult,
		DiagnosticsExportError
	>;
	readonly signalProcess: (payload: {
		readonly pid: number;
		readonly signal: "interrupt" | "terminate" | "kill";
	}) => Effect.Effect<DiagnosticsSignalResult, DiagnosticsExportError>;
	readonly exportBundle: (payload: {
		readonly clientContext?: unknown;
		readonly since?: string;
		readonly includeSessionEvents?: boolean;
	}) => Effect.Effect<DiagnosticsExportResult, DiagnosticsExportError>;
}

export class DiagnosticsService extends Context.Service<
	DiagnosticsService,
	DiagnosticsServiceShape
>()("memoize/DiagnosticsService") {}
