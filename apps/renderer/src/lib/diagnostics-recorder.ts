import type { PowerInteractionMeasurement } from "@zuse/contracts";

export type DiagnosticLogLevel = "debug" | "info" | "warn" | "error";

export interface DiagnosticLogEntry {
	readonly createdAt: string;
	readonly level: DiagnosticLogLevel;
	readonly source: string;
	readonly message: string;
	readonly detail?: string;
}

export interface DiagnosticUiAction {
	readonly createdAt: string;
	readonly action: string;
	readonly detail?: string;
}

const LOG_LIMIT = 200;
const ACTION_LIMIT = 100;
const rendererLogs: DiagnosticLogEntry[] = [];
const pendingRendererLogs: DiagnosticLogEntry[] = [];
const uiActions: DiagnosticUiAction[] = [];
const rendererRunId = `renderer_${crypto.randomUUID?.() ?? Date.now().toString(36)}`;
const powerInteractions: PowerInteractionMeasurement[] = [];

let installed = false;
let flushTimer: number | null = null;
let flushing = false;

function pushBounded<T>(items: T[], item: T, limit: number): void {
	items.push(item);
	if (items.length > limit) items.splice(0, items.length - limit);
}

const diagnosticValueKind = (value: unknown): string => {
	if (value instanceof Error) return value.name || "Error";
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
};

const sanitizedStackFrames = (error: Error): string | undefined => {
	const frames = error.stack?.split(/\r?\n/).slice(1, 21).join("\n").trim();
	return frames || undefined;
};

export const summarizeDiagnosticError = (
	error: Error,
	fallback: string,
): { readonly message: string; readonly detail?: string } => {
	const detail = sanitizedStackFrames(error);
	const firstFrameName = /^\s*at\s+([^\s(]+)/.exec(detail ?? "")?.[1];
	return {
		message: `${error.name || fallback} at ${firstFrameName ?? "unknown"}`,
		...(detail === undefined ? {} : { detail }),
	};
};

export function persistFatalRendererDiagnostic(
	source:
		| "renderer.window.error"
		| "renderer.unhandledrejection"
		| "renderer.react.root",
	error: Error,
): void {
	try {
		const frameNames = (error.stack?.split(/\r?\n/).slice(1, 21) ?? []).flatMap(
			(frame) => {
				const name = /^\s*at\s+([^\s(]+)/.exec(frame)?.[1];
				return name === undefined ? [] : [name];
			},
		);
		window.zuse?.app?.recordFatalDiagnostic?.({
			source,
			errorName: error.name || "Error",
			frameNames,
		});
	} catch {
		// The synchronous crash path is best effort and cannot mask the failure.
	}
}

export const summarizeDiagnosticArguments = (
	args: ReadonlyArray<unknown>,
): string =>
	`argumentTypes=${args.map(diagnosticValueKind).join(",") || "none"} count=${args.length}`;

export function recordDiagnosticEvent(input: {
	readonly level: DiagnosticLogLevel;
	readonly source: string;
	readonly message: string;
	readonly detail?: string;
}): void {
	const entry = {
		createdAt: new Date().toISOString(),
		level: input.level,
		source: input.source,
		message: input.message.slice(0, 2000),
		detail: input.detail?.slice(0, 4000),
	} satisfies DiagnosticLogEntry;
	pushBounded(rendererLogs, entry, LOG_LIMIT);
	pushBounded(pendingRendererLogs, entry, LOG_LIMIT);
	scheduleDiagnosticsFlush();
}

function scheduleDiagnosticsFlush(): void {
	if (typeof window === "undefined" || flushTimer !== null) return;
	flushTimer = window.setTimeout(() => {
		flushTimer = null;
		void flushRendererDiagnostics();
	}, 250);
}

export async function flushRendererDiagnostics(): Promise<void> {
	if (flushing || pendingRendererLogs.length === 0) return;
	flushing = true;
	const pending = pendingRendererLogs.slice();
	try {
		const [{ getRpcClient }, { Effect }] = await Promise.all([
			import("./rpc-client.ts"),
			import("effect"),
		]);
		const client = await getRpcClient();
		await Effect.runPromise(
			client["diagnostics.ingest"]({
				events: pending.map((entry, index) => ({
					id: `renderer_${Date.now().toString(36)}_${index}`,
					createdAt: entry.createdAt,
					severity: entry.level,
					source: entry.source,
					category: entry.source.split(".")[1] ?? "renderer",
					message: entry.message,
					detail: entry.detail,
					fingerprint: `${entry.source}:${entry.message.slice(0, 160)}`,
					runId: rendererRunId,
					recoveryStatus: entry.level === "error" ? "unresolved" : "not-needed",
				})),
			}),
		);
		pendingRendererLogs.splice(0, pending.length);
	} catch {
		// Diagnostics transport is best-effort and must never create another error.
	} finally {
		flushing = false;
		if (pendingRendererLogs.length > 0) scheduleDiagnosticsFlush();
	}
}

export function recordUiAction(action: string, detail?: string): void {
	pushBounded(
		uiActions,
		{
			createdAt: new Date().toISOString(),
			action,
			detail: detail?.slice(0, 1000),
		},
		ACTION_LIMIT,
	);
}

export function getRendererDiagnosticLogs(): ReadonlyArray<DiagnosticLogEntry> {
	return rendererLogs.slice();
}

export function getDiagnosticUiActions(): ReadonlyArray<DiagnosticUiAction> {
	return uiActions.slice();
}

export function recordPowerInteraction(name: string, durationMs: number): void {
	if (!/^chat\.[a-z0-9._-]{1,100}$/i.test(name)) return;
	if (!Number.isFinite(durationMs) || durationMs < 0) return;
	pushBounded(
		powerInteractions,
		{
			recordedAt: new Date().toISOString(),
			name,
			durationMs,
		},
		ACTION_LIMIT,
	);
}

export function getPowerInteractionMeasurements(
	since: string | null = null,
): ReadonlyArray<PowerInteractionMeasurement> {
	const sinceMs = since === null ? Number.NEGATIVE_INFINITY : Date.parse(since);
	return powerInteractions.filter(
		(item) => Date.parse(item.recordedAt) >= sinceMs,
	);
}

export function installRendererDiagnostics(): void {
	if (installed || typeof window === "undefined") return;
	installed = true;
	void import("./renderer-lag-monitor.ts")
		.then(({ installRendererLagMonitor }) => {
			installRendererLagMonitor((samples) => {
				window.zuse?.power?.reportLagSamples?.(samples);
				for (const sample of samples.filter((item) => item.durationMs >= 500)) {
					recordDiagnosticEvent({
						level: "warn",
						source: "renderer.lag",
						message: sample.name ?? `renderer.${sample.kind}`,
						detail: `durationMs=${sample.durationMs.toFixed(1)}`,
					});
				}
			});
		})
		.catch(() => undefined);

	const originalWarn = console.warn.bind(console);
	const originalError = console.error.bind(console);
	console.warn = (...args: unknown[]) => {
		recordDiagnosticEvent({
			level: "warn",
			source: "renderer.console",
			message: "Renderer console warning",
			detail: summarizeDiagnosticArguments(args),
		});
		originalWarn(...args);
	};
	console.error = (...args: unknown[]) => {
		recordDiagnosticEvent({
			level: "error",
			source: "renderer.console",
			message: "Renderer console error",
			detail: summarizeDiagnosticArguments(args),
		});
		originalError(...args);
	};

	window.addEventListener("error", (event) => {
		if (event.error instanceof Error) {
			persistFatalRendererDiagnostic("renderer.window.error", event.error);
		}
		const summary =
			event.error instanceof Error
				? summarizeDiagnosticError(event.error, "RendererError")
				: { message: "RendererError at unknown" };
		recordDiagnosticEvent({
			level: "error",
			source: "renderer.window.error",
			...summary,
		});
	});
	window.addEventListener("unhandledrejection", (event) => {
		if (event.reason instanceof Error) {
			persistFatalRendererDiagnostic(
				"renderer.unhandledrejection",
				event.reason,
			);
		}
		const summary =
			event.reason instanceof Error
				? summarizeDiagnosticError(event.reason, "UnhandledRejection")
				: {
						message: "UnhandledRejection at unknown",
						detail: `reasonType=${diagnosticValueKind(event.reason)}`,
					};
		recordDiagnosticEvent({
			level: "error",
			source: "renderer.unhandledrejection",
			...summary,
		});
	});
}
