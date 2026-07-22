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

let installed = false;
let flushTimer: number | null = null;
let flushing = false;

function pushBounded<T>(items: T[], item: T, limit: number): void {
	items.push(item);
	if (items.length > limit) items.splice(0, items.length - limit);
}

function stringifyDiagnosticPart(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof Error) return `${value.name}: ${value.message}`;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

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

export function installRendererDiagnostics(): void {
	if (installed || typeof window === "undefined") return;
	installed = true;

	const originalWarn = console.warn.bind(console);
	const originalError = console.error.bind(console);
	console.warn = (...args: unknown[]) => {
		recordDiagnosticEvent({
			level: "warn",
			source: "renderer.console",
			message: args.map(stringifyDiagnosticPart).join(" "),
		});
		originalWarn(...args);
	};
	console.error = (...args: unknown[]) => {
		recordDiagnosticEvent({
			level: "error",
			source: "renderer.console",
			message: args.map(stringifyDiagnosticPart).join(" "),
		});
		originalError(...args);
	};

	window.addEventListener("error", (event) => {
		recordDiagnosticEvent({
			level: "error",
			source: "renderer.window.error",
			message: event.message,
			detail: event.error instanceof Error ? event.error.stack : undefined,
		});
	});
	window.addEventListener("unhandledrejection", (event) => {
		recordDiagnosticEvent({
			level: "error",
			source: "renderer.unhandledrejection",
			message: stringifyDiagnosticPart(event.reason),
		});
	});
}
