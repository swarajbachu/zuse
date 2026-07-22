import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import {
	type AgentAvailability,
	DiagnosticEvent,
	DiagnosticsEventsResult,
	DiagnosticsExportError,
	DiagnosticsExportResult,
	DiagnosticsOverviewResult,
	DiagnosticsProcessesResult,
	DiagnosticsSignalResult,
} from "@zuse/contracts";
import { Effect, Layer, Ref, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

import packageJson from "../../../package.json" with { type: "json" };
import { AppPaths } from "../../app-paths.ts";
import { ProviderService } from "../../provider/services/provider-service.ts";
import {
	aggregateDiagnostics,
	diagnosticFingerprint,
	filterDiagnosticEvents,
	sanitizeDiagnosticText,
	sanitizeDiagnosticValue,
} from "../diagnostics-model.ts";
import { DiagnosticsService } from "../services/diagnostics-service.ts";
import { createStoredZip } from "../zip-bundle.ts";

const MAX_RECENT_ERRORS = 20;
const MAX_SESSION_EVENTS = 8;
const MAX_REDACTED_EVENTS_PER_FILE = 200;
const MAX_TEXT_PREVIEW = 240;
const MAX_DIAGNOSTIC_EVENTS = 100_000;
const MAX_DIAGNOSTIC_FILE_BYTES = 20 * 1024 * 1024;
const DIAGNOSTIC_FILE_COUNT = 5;
const DIAGNOSTIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const execFileAsync = promisify(execFile);

const diagnosticsError = (cause: unknown) =>
	new DiagnosticsExportError({
		reason:
			cause instanceof Error ? cause.message : "Diagnostics operation failed.",
	});

function loadPersistedEvents(path: string): {
	events: DiagnosticEvent[];
	parseErrors: number;
} {
	let parseErrors = 0;
	const retainedFiles = Array.from(
		{ length: DIAGNOSTIC_FILE_COUNT },
		(_, index) =>
			index === DIAGNOSTIC_FILE_COUNT - 1
				? path
				: `${path}.${DIAGNOSTIC_FILE_COUNT - 1 - index}`,
	).filter((file) => {
		if (!existsSync(file)) return false;
		if (Date.now() - statSync(file).mtimeMs <= DIAGNOSTIC_RETENTION_MS)
			return true;
		try {
			unlinkSync(file);
		} catch {
			// Retention is best-effort and must never block diagnostics startup.
		}
		return false;
	});
	const lines = retainedFiles.flatMap((file) =>
		readFileSync(file, "utf8").split(/\r?\n/),
	);
	const events = lines
		.filter(Boolean)
		.slice(-MAX_DIAGNOSTIC_EVENTS)
		.flatMap((line) => {
			try {
				return [Schema.decodeUnknownSync(DiagnosticEvent)(JSON.parse(line))];
			} catch {
				parseErrors += 1;
				return [];
			}
		});
	return { events, parseErrors };
}

function sanitizeEvent(event: DiagnosticEvent): DiagnosticEvent {
	const message = sanitizeDiagnosticText(event.message);
	const detail = event.detail
		? sanitizeDiagnosticText(event.detail)
		: undefined;
	return {
		...event,
		message,
		detail,
		fingerprint: diagnosticFingerprint({
			source: event.source,
			category: event.category,
			message,
		}),
	};
}

async function rotateAndAppend(
	path: string,
	events: ReadonlyArray<DiagnosticEvent>,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const chunk = events.map((event) => `${JSON.stringify(event)}\n`).join("");
	const currentSize = await stat(path)
		.then((value) => value.size)
		.catch(() => 0);
	if (
		currentSize > 0 &&
		currentSize + Buffer.byteLength(chunk) > MAX_DIAGNOSTIC_FILE_BYTES
	) {
		for (let index = DIAGNOSTIC_FILE_COUNT - 1; index >= 1; index -= 1) {
			const source = index === 1 ? path : `${path}.${index - 1}`;
			const target = `${path}.${index}`;
			await rename(source, target).catch(() => undefined);
		}
	}
	await appendFile(path, chunk, "utf8");
}

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
	| "process-snapshot"
	| "redaction-report"
	| "report";

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
	const text = readFileSync(input.path, "utf8");
	const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
	const events = lines.slice(-MAX_REDACTED_EVENTS_PER_FILE).flatMap((line) => {
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
		eventCount: lines.length,
		truncated: lines.length > MAX_REDACTED_EVENTS_PER_FILE,
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

function jsonByteLength(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value));
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, prettyJson(value), "utf8");
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
		const runId = `run_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
		const eventsPath = join(
			paths.userData,
			"logs",
			"diagnostics.events.ndjson",
		);
		const loaded = yield* Effect.try(() =>
			loadPersistedEvents(eventsPath),
		).pipe(
			Effect.orElseSucceed(() => ({
				events: [] as DiagnosticEvent[],
				parseErrors: 0,
			})),
		);
		const eventRef = yield* Ref.make<ReadonlyArray<DiagnosticEvent>>(
			loaded.events,
		);
		let persistChain: Promise<void> = Promise.resolve();
		const persistEvents = (events: ReadonlyArray<DiagnosticEvent>) => {
			persistChain = persistChain
				.catch(() => undefined)
				.then(() => rotateAndAppend(eventsPath, events));
			return persistChain;
		};

		const ingest = (incoming: ReadonlyArray<DiagnosticEvent>) => {
			const sanitized = incoming.map(sanitizeEvent);
			return Effect.gen(function* () {
				yield* Ref.update(eventRef, (current) =>
					[...current, ...sanitized].slice(-MAX_DIAGNOSTIC_EVENTS),
				);
				yield* Effect.tryPromise(() => persistEvents(sanitized));
			}).pipe(Effect.mapError(diagnosticsError));
		};

		const overview = (payload: { readonly since?: string }) =>
			Effect.gen(function* () {
				const all = yield* Ref.get(eventRef);
				const events = filterDiagnosticEvents(all, { since: payload.since });
				const aggregate = aggregateDiagnostics(events);
				const storageBytes = yield* Effect.try(() =>
					Array.from({ length: DIAGNOSTIC_FILE_COUNT }, (_, index) =>
						index === 0 ? eventsPath : `${eventsPath}.${index}`,
					)
						.filter(existsSync)
						.reduce((total, file) => total + statSync(file).size, 0),
				).pipe(Effect.orElseSucceed(() => 0));
				const status =
					aggregate.fatalCount > 0 || aggregate.errorCount > 3
						? ("failing" as const)
						: aggregate.errorCount > 0 || aggregate.warningCount > 0
							? ("degraded" as const)
							: ("healthy" as const);
				return DiagnosticsOverviewResult.make({
					status,
					runId,
					readAt: new Date().toISOString(),
					...aggregate,
					parseErrorCount: loaded.parseErrors,
					unseenCount: aggregate.errorCount + aggregate.fatalCount,
					storageBytes,
					capturePaused: false,
					previousRunUnclean: events.some(
						(event) => event.source === "main.previousRunUnclean",
					),
					topOperations: [],
				});
			}).pipe(Effect.mapError(diagnosticsError));

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
			Effect.gen(function* () {
				const all = yield* Ref.get(eventRef);
				const filtered = [...filterDiagnosticEvents(all, payload)].sort(
					(a, b) => b.createdAt.localeCompare(a.createdAt),
				);
				const offset = Math.max(0, Number(payload.cursor ?? "0") || 0);
				const limit = Math.min(200, Math.max(1, payload.limit ?? 100));
				return DiagnosticsEventsResult.make({
					events: filtered.slice(offset, offset + limit),
					nextCursor:
						offset + limit < filtered.length ? String(offset + limit) : null,
					total: filtered.length,
				});
			}).pipe(Effect.mapError(diagnosticsError));

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

				const traceSummary = {
					latestFailures,
					slowestSpans: [],
					commonFailures: [...commonFailureMap.values()].sort(
						(left, right) => right.count - left.count,
					),
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
				const diagnosticEvents = filterDiagnosticEvents(
					yield* Ref.get(eventRef),
					{ since: payload.since },
				);
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
				const artifacts: Record<string, unknown> = {
					"trace-summary": traceSummary,
					"recent-errors": recentErrors,
					environment,
					"provider-status": providerStatus,
					"redacted-session-events": sessionEvents,
					"diagnostic-events": { events: diagnosticEvents },
					"process-snapshot": processSnapshot,
					"redaction-report": redactionReport,
				};
				if (payload.clientContext !== undefined) {
					artifacts["client-context"] = sanitizeDiagnosticValue(
						payload.clientContext,
					);
				}

				const artifactSizes = Object.fromEntries(
					Object.entries(artifacts).map(([name, artifact]) => [
						name,
						jsonByteLength(artifact),
					]),
				);
				const diagnosticWarnings = [
					latestFailures.length === 0
						? "No persisted message errors were captured."
						: null,
					payload.clientContext === undefined
						? "No renderer client context was provided."
						: null,
				].filter((warning): warning is string => warning !== null);
				const bundleSummary = {
					diagnosticId,
					generatedFor: "github-bug-report",
					attachFileToIssue: true,
					pasteJsonOnlyIfAttachmentFails: true,
					artifactSizes,
					diagnosticWarnings,
				};
				artifacts["bundle-summary"] = bundleSummary;
				artifactSizes["bundle-summary"] = jsonByteLength(bundleSummary);

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
				const report = Buffer.from(
					`# Diagnostic report\n\n\`\`\`\n${summary}\n\`\`\`\n`,
				);
				const artifactEntries = Object.entries(artifacts).map(
					([name, artifact]) => ({
						name: `${name}.json`,
						data: Buffer.from(prettyJson(artifact)),
					}),
				);
				const checksums = Object.fromEntries(
					[{ name: "REPORT.md", data: report }, ...artifactEntries].map(
						(entry) => [
							entry.name,
							createHash("sha256").update(entry.data).digest("hex"),
						],
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

				yield* Effect.try(() => {
					writeJson(join(bundleDir, "manifest.json"), manifest);
					writeJson(join(bundleDir, "bundle-summary.json"), bundleSummary);
					writeJson(join(bundleDir, "trace-summary.json"), traceSummary);
					writeJson(join(bundleDir, "recent-errors.json"), recentErrors);
					writeJson(join(bundleDir, "environment.json"), environment);
					writeJson(join(bundleDir, "provider-status.json"), providerStatus);
					if (payload.clientContext !== undefined) {
						writeJson(
							join(bundleDir, "client-context.json"),
							artifacts["client-context"],
						);
					}
					writeJson(
						join(bundleDir, "session-events-redacted.json"),
						sessionEvents,
					);
				});

				yield* Effect.try(() => {
					const entries = [
						{
							name: "manifest.json",
							data: Buffer.from(prettyJson(manifest)),
						},
						{
							name: "REPORT.md",
							data: report,
						},
						...artifactEntries,
					];
					writeFileSync(bundlePath, createStoredZip(entries));
					copyFileSync(bundlePath, join(bundleDir, basename(bundlePath)));
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
			processes,
			signalProcess,
			exportBundle,
		} as const;
	}),
);
