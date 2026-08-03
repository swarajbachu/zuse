import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	createReadStream,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
	writeFileSync,
} from "node:fs";
import {
	appendFile,
	mkdir,
	open,
	rename,
	stat,
	unlink,
} from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import {
	type AgentAvailability,
	type DiagnosticEvent,
	type DiagnosticsCapturePayload,
	DiagnosticsCaptureResult,
	DiagnosticsEventsResult,
	DiagnosticsExportError,
	DiagnosticsExportResult,
	DiagnosticsOverviewResult,
	DiagnosticsProcessesResult,
	DiagnosticsSignalResult,
} from "@zuse/contracts";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";

import packageJson from "../../../package.json" with { type: "json" };
import { AppPaths } from "../../app-paths.ts";
import { TelemetryStore } from "../../observability/telemetry-store.ts";
import { ProviderService } from "../../provider/services/provider-service.ts";
import {
	aggregateDiagnostics,
	filterDiagnosticEvents,
	paginateDiagnosticEvents,
	sanitizeDiagnosticText,
	sanitizeDiagnosticValue,
} from "../diagnostics-model.ts";
import { DiagnosticsService } from "../services/diagnostics-service.ts";
import { writeStoredZip } from "../zip-bundle.ts";

const MAX_RECENT_ERRORS = 20;
const MAX_SESSION_EVENTS = 8;
const MAX_REDACTED_EVENTS_PER_FILE = 200;
const MAX_TEXT_PREVIEW = 240;
const execFileAsync = promisify(execFile);
const RUNTIME_RESOURCE_FILE_BYTES = 10 * 1024 * 1024;
const RUNTIME_RESOURCE_FILE_COUNT = 3;
const SUPPORT_READ_CHUNK_BYTES = 256 * 1024;

function readNewestLinesSync(
	path: string,
	maxLines: number,
	maxBytes: number,
): { readonly lines: ReadonlyArray<string>; readonly truncated: boolean } {
	const descriptor = openSync(path, "r");
	try {
		const fileSize = statSync(path).size;
		let position = fileSize;
		let bytesRead = 0;
		let text = "";
		while (position > 0 && bytesRead < maxBytes) {
			const size = Math.min(
				SUPPORT_READ_CHUNK_BYTES,
				position,
				maxBytes - bytesRead,
			);
			position -= size;
			const buffer = Buffer.allocUnsafe(size);
			const count = readSync(descriptor, buffer, 0, size, position);
			text = buffer.subarray(0, count).toString("utf8") + text;
			bytesRead += count;
			if (text.split(/\r?\n/).length > maxLines + 1) break;
		}
		const allLines = text.split(/\r?\n/).filter(Boolean);
		return {
			lines: allLines.slice(-maxLines),
			truncated: position > 0 || allLines.length > maxLines,
		};
	} finally {
		closeSync(descriptor);
	}
}

const diagnosticsError = (cause: unknown) =>
	new DiagnosticsExportError({
		reason:
			cause instanceof Error ? cause.message : "Diagnostics operation failed.",
	});

function parseElapsedSeconds(value: string): number {
	const [dayPart, timePart] = value.includes("-")
		? value.split("-", 2)
		: ["0", value];
	const parts = (timePart ?? "0")
		.split(":")
		.map((part) => Number(part))
		.reverse();
	return (
		(Number(dayPart) || 0) * 86_400 +
		(parts[0] ?? 0) +
		(parts[1] ?? 0) * 60 +
		(parts[2] ?? 0) * 3_600
	);
}

async function readProcessTree(): Promise<DiagnosticsProcessesResult> {
	const readAt = new Date().toISOString();
	if (process.platform === "win32") {
		return DiagnosticsProcessesResult.make({
			supported: false,
			readAt,
			serverPid: process.pid,
			processes: [],
			totalCpuPercent: 0,
			totalRssBytes: 0,
			error: "Process inspection is not available on this Windows build.",
		});
	}
	try {
		const { stdout } = await execFileAsync("ps", [
			"-axo",
			"pid=,ppid=,%cpu=,rss=,etime=,comm=,args=",
		]);
		const rows = stdout.split(/\r?\n/).flatMap((line) => {
			const match = line
				.trim()
				.match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
			if (!match) return [];
			return [
				{
					pid: Number(match[1]),
					parentPid: Number(match[2]),
					cpuPercent: Number(match[3]),
					rssBytes: Number(match[4]) * 1024,
					elapsed: match[5] ?? "0",
					name: basename(match[6] ?? "process"),
					command: basename(match[6] ?? "process"),
				},
			];
		});
		const byParent = new Map<number, number[]>();
		for (const row of rows)
			byParent.set(row.parentPid, [
				...(byParent.get(row.parentPid) ?? []),
				row.pid,
			]);
		const descendants: Array<(typeof rows)[number] & { depth: number }> = [];
		const visit = (pid: number, depth: number) => {
			for (const childPid of byParent.get(pid) ?? []) {
				const child = rows.find((row) => row.pid === childPid);
				if (child) {
					descendants.push({ ...child, depth });
					visit(child.pid, depth + 1);
				}
			}
		};
		visit(process.pid, 1);
		const server = rows.find((row) => row.pid === process.pid);
		const ownedRows = [
			...(server ? [{ ...server, depth: 0 }] : []),
			...descendants,
		];
		const processes = ownedRows.map((row) => ({
			pid: row.pid,
			parentPid: row.parentPid,
			depth: row.depth,
			name: row.name,
			command: row.command,
			cpuPercent: row.cpuPercent,
			rssBytes: row.rssBytes,
			uptimeSeconds: parseElapsedSeconds(row.elapsed),
			childPids: byParent.get(row.pid) ?? [],
		}));
		return DiagnosticsProcessesResult.make({
			supported: true,
			readAt,
			serverPid: process.pid,
			processes,
			totalCpuPercent: processes.reduce(
				(sum, item) => sum + item.cpuPercent,
				0,
			),
			totalRssBytes: processes.reduce((sum, item) => sum + item.rssBytes, 0),
		});
	} catch (cause) {
		return DiagnosticsProcessesResult.make({
			supported: false,
			readAt,
			serverPid: process.pid,
			processes: [],
			totalCpuPercent: 0,
			totalRssBytes: 0,
			error:
				cause instanceof Error ? cause.message : "Process inspection failed.",
		});
	}
}

const appendRuntimeResourceSnapshot = async (
	userData: string,
	fileIdentity: string,
	snapshot: DiagnosticsProcessesResult,
): Promise<void> => {
	const path = join(
		userData,
		"logs",
		`diagnostics.runtime-resources.${fileIdentity}.ndjson`,
	);
	await mkdir(join(userData, "logs"), { recursive: true });
	const line = `${JSON.stringify({
		kind: "runtime-processes",
		capturedAt: snapshot.readAt,
		supported: snapshot.supported,
		serverPid: snapshot.serverPid,
		totalCpuPercent: snapshot.totalCpuPercent,
		totalRssBytes: snapshot.totalRssBytes,
		processes: snapshot.processes.map((process) => ({
			pid: process.pid,
			parentPid: process.parentPid,
			depth: process.depth,
			name: process.name,
			cpuPercent: process.cpuPercent,
			rssBytes: process.rssBytes,
			uptimeSeconds: process.uptimeSeconds,
		})),
	})}\n`;
	const currentSize = await stat(path)
		.then((value) => value.size)
		.catch(() => 0);
	if (
		currentSize > 0 &&
		currentSize + Buffer.byteLength(line) > RUNTIME_RESOURCE_FILE_BYTES
	) {
		for (let index = RUNTIME_RESOURCE_FILE_COUNT - 1; index >= 1; index -= 1) {
			const source = index === 1 ? path : `${path}.${index - 1}`;
			const target = `${path}.${index}`;
			await unlink(target).catch(() => undefined);
			await rename(source, target).catch(() => undefined);
		}
	}
	await appendFile(path, line, "utf8");
};

interface RecentErrorRow {
	readonly message_id: string;
	readonly session_id: string;
	readonly chat_id: string | null;
	readonly project_id: string;
	readonly provider_id: string;
	readonly model: string;
	readonly kind: string;
	readonly content_json: string;
	readonly created_at: string;
}

interface SessionEventFile {
	readonly sessionId: string;
	readonly projectId: string;
	readonly sourcePath: string;
	readonly eventCount: number;
	readonly truncated: boolean;
	readonly events: ReadonlyArray<unknown>;
}

type BundleArtifactName =
	| "manifest"
	| "bundle-summary"
	| "trace-summary"
	| "recent-errors"
	| "environment"
	| "provider-status"
	| "client-context"
	| "redacted-session-events";

type ExtendedBundleArtifactName =
	| BundleArtifactName
	| "diagnostic-events"
	| "performance-history"
	| "performance-recording"
	| "process-snapshot"
	| "redaction-report"
	| "report";

const readPerformanceHistory = (
	userData: string,
	since?: string,
): {
	readonly entries: ReadonlyArray<unknown>;
	readonly parseErrors: number;
	readonly truncated: boolean;
} => {
	const bases = [join(userData, "logs", "diagnostics.host-resources.ndjson")];
	const runtimePaths = (() => {
		try {
			return readdirSync(join(userData, "logs"))
				.filter((name) => name.startsWith("diagnostics.runtime-resources"))
				.map((name) => join(userData, "logs", name));
		} catch {
			return [];
		}
	})();
	const candidates = [
		...bases.flatMap((base) => [`${base}.2`, `${base}.1`, base]),
		...runtimePaths,
	];
	let parseErrors = 0;
	let truncated = false;
	const entries: unknown[] = [];
	for (const path of candidates) {
		try {
			const newest = readNewestLinesSync(
				path,
				5_000,
				RUNTIME_RESOURCE_FILE_BYTES,
			);
			truncated ||= newest.truncated;
			for (const line of newest.lines) {
				try {
					const entry = JSON.parse(line) as {
						readonly kind?: unknown;
						readonly sample?: { readonly capturedAt?: unknown };
					};
					const capturedAt =
						typeof entry.sample?.capturedAt === "string"
							? entry.sample.capturedAt
							: typeof (entry as { readonly capturedAt?: unknown })
										.capturedAt === "string"
								? (entry as { readonly capturedAt: string }).capturedAt
								: null;
					if (
						(entry.kind !== "sample" &&
							entry.kind !== "lag" &&
							entry.kind !== "runtime-processes") ||
						capturedAt === null ||
						(since !== undefined && capturedAt < since)
					) {
						continue;
					}
					entries.push(sanitizeDiagnosticValue(entry));
					if (entries.length > 5_000) entries.splice(0, entries.length - 5_000);
				} catch {
					parseErrors += 1;
				}
			}
		} catch {
			// Missing resource history is normal.
		}
	}
	return {
		entries,
		parseErrors,
		truncated,
	};
};

const readLatestPerformanceRecording = (userData: string): unknown | null => {
	const directory = join(userData, "logs", "performance-recordings");
	try {
		const latest = readdirSync(directory)
			.filter((file) => file.endsWith(".json"))
			.map((file) => {
				const path = join(directory, file);
				return {
					path,
					mtimeMs: statSync(path).mtimeMs,
					size: statSync(path).size,
				};
			})
			.filter((file) => file.size <= 5 * 1024 * 1024)
			.sort((left, right) => right.mtimeMs - left.mtimeMs)
			.at(0);
		if (latest === undefined) return null;
		return sanitizeDiagnosticValue(
			JSON.parse(readFileSync(latest.path, "utf8")),
		);
	} catch {
		return null;
	}
};

function safeIsoForFile(date: Date): string {
	return date.toISOString().replace(/[:.]/g, "-");
}

function truncate(value: string): string {
	return value.length <= MAX_TEXT_PREVIEW
		? value
		: `${value.slice(0, MAX_TEXT_PREVIEW)}...`;
}

function summarizeUnknown(value: unknown): unknown {
	if (typeof value === "string") {
		return {
			redacted: true,
			length: value.length,
		};
	}
	if (Array.isArray(value)) {
		return value.slice(0, 20).map(summarizeUnknown);
	}
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value as Record<string, unknown>).map(
			([key, entry]) => {
				if (
					key.toLowerCase().includes("text") ||
					key.toLowerCase().includes("prompt") ||
					key.toLowerCase().includes("output") ||
					key.toLowerCase().includes("summary")
				) {
					return [key, summarizeUnknown(entry)] as const;
				}
				return [key, summarizeUnknown(entry)] as const;
			},
		);
		return Object.fromEntries(entries);
	}
	return value;
}

function readErrorMessage(contentJson: string): string {
	try {
		const parsed = JSON.parse(contentJson) as unknown;
		if (typeof parsed === "object" && parsed !== null && "message" in parsed) {
			const message = (parsed as { readonly message?: unknown }).message;
			return typeof message === "string"
				? sanitizeDiagnosticText(truncate(message))
				: "Error message unavailable";
		}
		return truncate(JSON.stringify(summarizeUnknown(parsed)));
	} catch {
		return "Could not parse persisted error content.";
	}
}

function listSessionEventFiles(
	userData: string,
): ReadonlyArray<{ projectId: string; path: string }> {
	const root = join(userData, "sessions");
	if (!existsSync(root)) return [];
	const files: Array<{ projectId: string; path: string; mtimeMs: number }> = [];
	for (const projectId of readdirSync(root)) {
		const projectDir = join(root, projectId);
		if (!statSync(projectDir).isDirectory()) continue;
		for (const entry of readdirSync(projectDir)) {
			if (!entry.endsWith(".events.ndjson")) continue;
			const path = join(projectDir, entry);
			const stat = statSync(path);
			files.push({ projectId, path, mtimeMs: stat.mtimeMs });
		}
	}
	return [...files]
		.sort((left, right) => right.mtimeMs - left.mtimeMs)
		.slice(0, MAX_SESSION_EVENTS)
		.map(({ projectId, path }) => ({ projectId, path }));
}

function redactSessionEventFile(input: {
	readonly projectId: string;
	readonly path: string;
}): SessionEventFile {
	const newest = readNewestLinesSync(
		input.path,
		MAX_REDACTED_EVENTS_PER_FILE,
		5 * 1024 * 1024,
	);
	const events = newest.lines.flatMap((line) => {
		try {
			return [summarizeUnknown(JSON.parse(line) as unknown)];
		} catch {
			return [{ parseError: true, bytes: Buffer.byteLength(line) }];
		}
	});
	const fileName = basename(input.path);
	const sessionId = fileName.replace(/\.events\.ndjson$/, "");
	return {
		projectId: input.projectId,
		sessionId,
		sourcePath: basename(input.path),
		eventCount: newest.lines.length,
		truncated: newest.truncated,
		events,
	};
}

function summarizeProvider(provider: AgentAvailability) {
	return {
		providerId: provider.providerId,
		displayName: provider.displayName,
		cliInstalled: provider.cliInstalled,
		cliVersion: provider.cliVersion,
		cliLoggedIn: provider.cliLoggedIn,
		hasApiKey: provider.hasApiKey,
		cliVersionStatus: provider.cliVersionStatus,
		latestVersionStatus: provider.latestVersionStatus,
		authStatus: provider.authStatus,
		authType: provider.authType,
		status: provider.status,
		statusMessage: provider.statusMessage,
		lastCheckedAt: provider.lastCheckedAt,
	};
}

function prettyJson(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, prettyJson(value), "utf8");
}

async function writeDiagnosticEventsJson(
	path: string,
	input: {
		readonly events: ReadonlyArray<DiagnosticEvent>;
		readonly limit: number;
		readonly truncated: boolean;
		readonly truncatedEventCount: number;
	},
): Promise<void> {
	const output = await open(path, "w");
	try {
		await output.write(
			`{\n  "limit": ${input.limit},\n  "truncated": ${input.truncated},\n  "truncatedEventCount": ${input.truncatedEventCount},\n  "events": [`,
		);
		for (let index = 0; index < input.events.length; index += 100) {
			const chunk = input.events
				.slice(index, index + 100)
				.map((event) => JSON.stringify(event))
				.join(",\n    ");
			await output.write(`${index === 0 ? "\n    " : ",\n    "}${chunk}`);
		}
		await output.write(`${input.events.length === 0 ? "" : "\n  "}]\n}\n`);
	} finally {
		await output.close();
	}
}

async function sha256File(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path, {
		highWaterMark: 64 * 1024,
	})) {
		hash.update(chunk as Buffer);
	}
	return hash.digest("hex");
}

function buildSummary(input: {
	readonly diagnosticId: string;
	readonly bundlePath: string;
	readonly version: string;
	readonly platform: string;
	readonly arch: string;
	readonly osRelease: string;
	readonly latestFailures: ReadonlyArray<{
		readonly span: string;
		readonly message: string;
	}>;
	readonly providerCount: number;
}): string {
	const topFailure = input.latestFailures[0];
	return [
		`Diagnostic ID: ${input.diagnosticId}`,
		`Bundle: ${input.bundlePath}`,
		`App: Zuse ${input.version}`,
		`Platform: ${input.platform}-${input.arch} ${input.osRelease}`,
		`Latest failure: ${topFailure ? `${topFailure.span} - ${topFailure.message}` : "none found"}`,
		`Providers captured: ${input.providerCount}`,
	].join("\n");
}

export const DiagnosticsServiceLive = Layer.effect(
	DiagnosticsService,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const paths = yield* AppPaths;
		const providerService = yield* ProviderService;
		const telemetry = yield* TelemetryStore;
		const runtimeResourceTimer = setInterval(() => {
			void readProcessTree()
				.then((snapshot) =>
					appendRuntimeResourceSnapshot(
						paths.userData,
						telemetry.fileIdentity,
						snapshot,
					),
				)
				.catch(() => undefined);
		}, 60_000);
		runtimeResourceTimer.unref?.();
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => clearInterval(runtimeResourceTimer)),
		);
		const runId = telemetry.runId;
		let overviewCache:
			| {
					readonly since: string | undefined;
					readonly version: number;
					readonly value: DiagnosticsOverviewResult;
			  }
			| undefined;
		const eventQueryCache = new Map<
			string,
			{ readonly version: number; readonly value: DiagnosticsEventsResult }
		>();
		const ingest = (incoming: ReadonlyArray<DiagnosticEvent>) =>
			Effect.sync(() => telemetry.recordMany(incoming));

		const overview = (payload: { readonly since?: string }) =>
			Effect.gen(function* () {
				const captureState = telemetry.captureState();
				const version = telemetry.overviewVersion();
				if (
					overviewCache?.version === version &&
					overviewCache.since === payload.since
				) {
					return overviewCache.value;
				}
				const all = telemetry.snapshot();
				const events = filterDiagnosticEvents(all, { since: payload.since });
				const aggregate = {
					...aggregateDiagnostics(events),
					topOperations: telemetry.operationSummaries(payload.since),
				};
				const storageBytes = yield* telemetry.storageBytes;
				const status =
					aggregate.fatalCount > 0 || aggregate.errorCount > 3
						? ("failing" as const)
						: aggregate.errorCount > 0 || aggregate.warningCount > 0
							? ("degraded" as const)
							: ("healthy" as const);
				const value = DiagnosticsOverviewResult.make({
					status,
					runId,
					readAt: new Date().toISOString(),
					...aggregate,
					parseErrorCount: telemetry.parseErrorCount,
					unseenCount: aggregate.errorCount + aggregate.fatalCount,
					storageBytes,
					capturePaused: false,
					...captureState,
					droppedEventCount: telemetry.droppedEventCount(),
					truncatedEventCount: telemetry.truncatedEventCount(),
					previousRunUnclean: events.some(
						(event) => event.source === "main.previousRunUnclean",
					),
				});
				overviewCache = { since: payload.since, version, value };
				return value;
			}).pipe(Effect.mapError(diagnosticsError));

		const capture = (payload: DiagnosticsCapturePayload) =>
			telemetry.setCapture(payload).pipe(
				Effect.map(() =>
					DiagnosticsCaptureResult.make(telemetry.captureState()),
				),
				Effect.mapError(diagnosticsError),
			);

		const events = (payload: {
			readonly cursor?: string;
			readonly limit?: number;
			readonly severities?: ReadonlyArray<
				import("@zuse/contracts").DiagnosticSeverity
			>;
			readonly source?: string;
			readonly search?: string;
			readonly since?: string;
		}) =>
			Effect.sync(() => {
				const version = telemetry.version();
				const cacheKey = JSON.stringify(payload);
				const cached = eventQueryCache.get(cacheKey);
				if (cached?.version === version) return cached.value;
				const all = telemetry.snapshot();
				const filtered = filterDiagnosticEvents(all, payload);
				const limit = Math.min(200, Math.max(1, payload.limit ?? 100));
				const page = paginateDiagnosticEvents(filtered, {
					cursor: payload.cursor,
					limit,
				});
				const value = DiagnosticsEventsResult.make({
					events: page.events,
					nextCursor: page.nextCursor,
					total: filtered.length,
				});
				if (eventQueryCache.size >= 12) {
					eventQueryCache.delete(eventQueryCache.keys().next().value ?? "");
				}
				eventQueryCache.set(cacheKey, { version, value });
				return value;
			});

		const processes = Effect.tryPromise(readProcessTree).pipe(
			Effect.mapError(diagnosticsError),
		);
		const signalProcess = (payload: {
			readonly pid: number;
			readonly signal: "interrupt" | "terminate" | "kill";
		}) =>
			Effect.gen(function* () {
				const snapshot = yield* processes;
				if (
					payload.pid === snapshot.serverPid ||
					!snapshot.processes.some((item) => item.pid === payload.pid)
				) {
					return DiagnosticsSignalResult.make({
						signaled: false,
						message: "The process is not a live descendant of the server.",
					});
				}
				const signal =
					payload.signal === "interrupt"
						? "SIGINT"
						: payload.signal === "terminate"
							? "SIGTERM"
							: "SIGKILL";
				return yield* Effect.try(() => {
					process.kill(payload.pid, signal);
					return DiagnosticsSignalResult.make({ signaled: true });
				}).pipe(Effect.mapError(diagnosticsError));
			});

		const exportBundle = (payload: {
			readonly clientContext?: unknown;
			readonly since?: string;
			readonly includeSessionEvents?: boolean;
		}) =>
			Effect.gen(function* () {
				const createdAt = new Date();
				const diagnosticId = `diag_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
				const bundleDir = join(paths.userData, "diagnostics", diagnosticId);
				yield* Effect.try(() => mkdirSync(bundleDir, { recursive: true }));

				const recentErrorRows = yield* sql<RecentErrorRow>`
            SELECT
              m.id AS message_id,
              m.session_id,
              s.chat_id,
              s.project_id,
              s.provider_id,
              s.model,
              m.kind,
              m.content_json,
              m.created_at
            FROM messages m
            INNER JOIN sessions s ON s.id = m.session_id
            WHERE m.kind = 'error'
            ORDER BY m.created_at DESC
            LIMIT ${MAX_RECENT_ERRORS}
          `;

				const providers = yield* providerService
					.availability()
					.pipe(Effect.orElseSucceed(() => []));

				const latestFailures = recentErrorRows.map((row) => ({
					traceId: null,
					span: `message.${row.kind}`,
					message: readErrorMessage(row.content_json),
					chatId: row.chat_id,
					sessionId: row.session_id,
					providerId: row.provider_id,
					model: row.model,
					occurredAt: row.created_at,
				}));

				const commonFailureMap = new Map<
					string,
					{ span: string; count: number; errorTag: string }
				>();
				for (const failure of latestFailures) {
					const key = `${failure.span}:${failure.message}`;
					const existing = commonFailureMap.get(key);
					commonFailureMap.set(key, {
						span: failure.span,
						count: (existing?.count ?? 0) + 1,
						errorTag: failure.message,
					});
				}

				const exportedEvents = yield* telemetry.exportEvents({
					since: payload.since,
				});
				const exportedOperationSummaries =
					yield* telemetry.exportOperationSummaries(payload.since);
				const diagnosticEvents = exportedEvents.events;
				const diagnosticAggregate = {
					...aggregateDiagnostics(diagnosticEvents),
					topOperations: exportedOperationSummaries,
				};
				const traceSummary = {
					latestFailures,
					slowestSpans: diagnosticAggregate.slowestOperations,
					commonFailures:
						diagnosticAggregate.commonFailures.length > 0
							? diagnosticAggregate.commonFailures
							: [...commonFailureMap.values()].sort(
									(left, right) => right.count - left.count,
								),
					operationSummaries: diagnosticAggregate.topOperations,
				};
				const recentErrors = {
					errors: latestFailures,
				};
				const environment = {
					app: "zuse",
					version: packageJson.version,
					createdAt: createdAt.toISOString(),
					platform: platform(),
					arch: arch(),
					osRelease: release(),
					node: process.version,
				};
				const providerStatus = {
					providers: providers.map(summarizeProvider),
				};
				const sessionEvents =
					payload.includeSessionEvents === true
						? yield* Effect.try(() => ({
								files: listSessionEventFiles(paths.userData).map(
									redactSessionEventFile,
								),
							}))
						: { files: [] };
				const processSnapshot = yield* processes.pipe(
					Effect.orElseSucceed(() =>
						DiagnosticsProcessesResult.make({
							supported: false,
							readAt: new Date().toISOString(),
							serverPid: process.pid,
							processes: [],
							totalCpuPercent: 0,
							totalRssBytes: 0,
							error: "Process snapshot unavailable during export.",
						}),
					),
				);
				const redactionReport = {
					rawPromptsIncluded: false,
					rawTranscriptsIncluded: false,
					terminalOutputIncluded: false,
					environmentValuesIncluded: false,
					strategy:
						"allowlisted structural fields and secret-pattern scrubbing",
				};
				const performanceHistory = readPerformanceHistory(
					paths.userData,
					payload.since,
				);
				const performanceRecording = readLatestPerformanceRecording(
					paths.userData,
				);
				const diagnosticEventsArtifact = {
					events: diagnosticEvents,
					limit: 25_000,
					truncated: exportedEvents.truncated > 0,
					truncatedEventCount: exportedEvents.truncated,
				};
				const artifacts: Record<string, unknown> = {
					"trace-summary": traceSummary,
					"recent-errors": recentErrors,
					environment,
					"provider-status": providerStatus,
					"redacted-session-events": sessionEvents,
					"performance-history": performanceHistory,
					"process-snapshot": processSnapshot,
					"redaction-report": redactionReport,
				};
				if (performanceRecording !== null) {
					artifacts["performance-recording"] = performanceRecording;
				}
				if (payload.clientContext !== undefined) {
					artifacts["client-context"] = sanitizeDiagnosticValue(
						payload.clientContext,
					);
				}

				const diagnosticWarnings = [
					latestFailures.length === 0
						? "No persisted message errors were captured."
						: null,
					payload.clientContext === undefined
						? "No renderer client context was provided."
						: null,
					exportedEvents.truncated > 0
						? `${exportedEvents.truncated} older diagnostic events were omitted.`
						: null,
				].filter((warning): warning is string => warning !== null);
				const included: ExtendedBundleArtifactName[] = [
					"manifest",
					"bundle-summary",
					"trace-summary",
					"recent-errors",
					"environment",
					"provider-status",
					...(payload.clientContext !== undefined
						? (["client-context"] as const)
						: []),
					"redacted-session-events",
					"diagnostic-events",
					"performance-history",
					...(performanceRecording !== null
						? (["performance-recording"] as const)
						: []),
					"process-snapshot",
					"redaction-report",
					"report",
				];
				const bundlePath = join(
					paths.userData,
					"diagnostics",
					`zuse-diagnostics-${safeIsoForFile(createdAt)}-${diagnosticId}.zip`,
				);
				const summary = buildSummary({
					diagnosticId,
					bundlePath,
					version: packageJson.version,
					platform: platform(),
					arch: arch(),
					osRelease: release(),
					latestFailures,
					providerCount: providers.length,
				});
				yield* Effect.tryPromise(async () => {
					const artifactFiles: Array<{ name: string; path: string }> = [];
					for (const [name, artifact] of Object.entries(artifacts)) {
						const artifactPath = join(bundleDir, `${name}.json`);
						writeJson(artifactPath, artifact);
						artifactFiles.push({ name: `${name}.json`, path: artifactPath });
					}
					const diagnosticEventsPath = join(
						bundleDir,
						"diagnostic-events.json",
					);
					await writeDiagnosticEventsJson(
						diagnosticEventsPath,
						diagnosticEventsArtifact,
					);
					artifactFiles.push({
						name: "diagnostic-events.json",
						path: diagnosticEventsPath,
					});
					const reportPath = join(bundleDir, "REPORT.md");
					writeFileSync(
						reportPath,
						`# Diagnostic report\n\n\`\`\`\n${summary}\n\`\`\`\n`,
						"utf8",
					);
					artifactFiles.push({ name: "REPORT.md", path: reportPath });

					const artifactSizes = Object.fromEntries(
						await Promise.all(
							artifactFiles.map(
								async (entry) =>
									[entry.name, (await stat(entry.path)).size] as const,
							),
						),
					);
					const bundleSummary = {
						diagnosticId,
						generatedFor: "github-bug-report",
						attachFileToIssue: true,
						pasteJsonOnlyIfAttachmentFails: true,
						artifactSizes,
						diagnosticWarnings,
					};
					const bundleSummaryPath = join(bundleDir, "bundle-summary.json");
					writeJson(bundleSummaryPath, bundleSummary);
					artifactFiles.push({
						name: "bundle-summary.json",
						path: bundleSummaryPath,
					});
					const checksums = Object.fromEntries(
						await Promise.all(
							artifactFiles.map(
								async (entry) =>
									[entry.name, await sha256File(entry.path)] as const,
							),
						),
					);
					const manifest = {
						app: "zuse",
						version: packageJson.version,
						createdAt: createdAt.toISOString(),
						platform: `${platform()}-${arch()}`,
						diagnosticId,
						included,
						redaction: {
							default:
								"content fields are excluded or summarized without previews",
							rawPromptsIncluded: false,
							rawTranscriptsIncluded: false,
						},
						checksums,
					};
					const manifestPath = join(bundleDir, "manifest.json");
					writeJson(manifestPath, manifest);
					await writeStoredZip(bundlePath, [
						{ name: "manifest.json", path: manifestPath },
						...artifactFiles,
					]);
				});
				return DiagnosticsExportResult.make({
					diagnosticId,
					createdAt,
					bundlePath,
					summary,
					included,
				});
			}).pipe(
				Effect.mapError(
					(cause) =>
						new DiagnosticsExportError({
							reason:
								cause instanceof Error
									? cause.message
									: "Failed to export diagnostics.",
						}),
				),
			);

		return {
			overview,
			events,
			ingest,
			capture,
			processes,
			signalProcess,
			exportBundle,
		} as const;
	}),
);
