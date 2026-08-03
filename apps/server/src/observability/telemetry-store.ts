import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import {
	appendFile,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

import {
	type DiagnosticCaptureMode,
	type DiagnosticEvent,
	DiagnosticEvent as DiagnosticEventSchema,
	type DiagnosticRuntimeKind,
	type DiagnosticsCapturePayload,
} from "@zuse/contracts";
import { Context, Duration, Effect, Layer, Schema } from "effect";

import { AppPaths } from "../app-paths.ts";
import {
	diagnosticFingerprint,
	sanitizeDiagnosticText,
} from "../diagnostics/diagnostics-model.ts";

export const INCIDENT_EVENT_LIMIT = 5_000;
export const FULL_TRACE_EVENT_LIMIT = 20_000;
export const FULL_TRACE_BYTE_LIMIT = 10 * 1024 * 1024;
export const SUPPORT_EVENT_LIMIT = 25_000;
const INCIDENT_FILE_BYTES = 5 * 1024 * 1024;
const INCIDENT_FILE_COUNT = 3;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const ROLLUP_INTERVAL_MS = 5 * 60 * 1_000;
const MAX_ROLLUPS = RETENTION_MS / ROLLUP_INTERVAL_MS;
const MAX_OPERATIONS_PER_ROLLUP = 64;
const PERSIST_BATCH_MS = 250;
const PERSIST_BATCH_SIZE = 250;
const MAX_PENDING_PERSISTENCE_EVENTS = 1_000;
const READ_CHUNK_BYTES = 256 * 1024;
const ROLLUP_FILE_BYTES = 32 * 1024 * 1024;
const DURATION_BUCKETS = [
	10,
	25,
	50,
	100,
	250,
	500,
	1_000,
	2_500,
	5_000,
	10_000,
	30_000,
	60_000,
	120_000,
	300_000,
	600_000,
	1_800_000,
	3_600_000,
	21_600_000,
	86_400_000,
	Number.MAX_SAFE_INTEGER,
];

export type TelemetryOperationOutcome =
	| "success"
	| "failure"
	| "interrupted"
	| "done";

export interface TelemetryOperation {
	readonly name: string;
	readonly durationMs: number;
	readonly outcome: TelemetryOperationOutcome;
}

export interface OperationSummary {
	readonly name: string;
	readonly count: number;
	readonly failureCount: number;
	readonly averageDurationMs: number;
	readonly p95DurationMs: number;
	readonly maxDurationMs: number;
}

interface OperationCell {
	count: number;
	failureCount: number;
	totalDurationMs: number;
	maxDurationMs: number;
	durationBuckets: number[];
}

interface OperationRollup {
	readonly bucketStart: number;
	readonly operations: Record<string, OperationCell>;
	readonly migrationSource?: string;
}

interface PersistedEvent {
	readonly path: string;
	readonly event: DiagnosticEvent;
}

class EventRingBuffer {
	private readonly values: Array<
		{ readonly event: DiagnosticEvent; readonly bytes: number } | undefined
	>;
	private start = 0;
	private length = 0;
	private bytes = 0;

	constructor(
		private readonly capacity: number,
		private readonly byteCapacity = Number.POSITIVE_INFINITY,
	) {
		this.values = new Array(capacity);
	}

	clear(): void {
		this.values.fill(undefined);
		this.start = 0;
		this.length = 0;
		this.bytes = 0;
	}

	pushMany(events: ReadonlyArray<DiagnosticEvent>): number {
		let dropped = 0;
		for (const event of events) {
			const bytes = Buffer.byteLength(JSON.stringify(event)) + 1;
			if (bytes > this.byteCapacity) {
				dropped += 1;
				continue;
			}
			while (
				this.length > 0 &&
				(this.length >= this.capacity || this.bytes + bytes > this.byteCapacity)
			) {
				const removed = this.values[this.start];
				if (removed !== undefined) this.bytes -= removed.bytes;
				this.values[this.start] = undefined;
				this.start = (this.start + 1) % this.capacity;
				this.length -= 1;
				dropped += 1;
			}
			const index = (this.start + this.length) % this.capacity;
			this.values[index] = { event, bytes };
			this.length += 1;
			this.bytes += bytes;
		}
		return dropped;
	}

	snapshot(): ReadonlyArray<DiagnosticEvent> {
		const snapshot: DiagnosticEvent[] = [];
		for (let offset = 0; offset < this.length; offset += 1) {
			const value = this.values[(this.start + offset) % this.capacity];
			if (value !== undefined) snapshot.push(value.event);
		}
		return snapshot;
	}
}

const retainedPaths = (path: string): ReadonlyArray<string> =>
	Array.from({ length: INCIDENT_FILE_COUNT }, (_, index) =>
		index === 0 ? path : `${path}.${index}`,
	);

const isIncidentEvent = (event: DiagnosticEvent): boolean =>
	event.severity === "warn" ||
	event.severity === "error" ||
	event.severity === "fatal" ||
	(event.durationMs ?? 0) >= 1_000;

export const shouldPersistOperationEvent = (
	operation: TelemetryOperation,
	captureMode: DiagnosticCaptureMode,
): boolean =>
	captureMode === "full" ||
	operation.outcome === "failure" ||
	operation.outcome === "interrupted" ||
	(operation.outcome !== "done" && operation.durationMs >= 1_000);

const sanitizeEvent = (
	event: DiagnosticEvent,
	runtimeKind: DiagnosticRuntimeKind,
	captureMode: DiagnosticCaptureMode,
): DiagnosticEvent => {
	const message = sanitizeDiagnosticText(event.message);
	const detail =
		event.detail === undefined
			? undefined
			: sanitizeDiagnosticText(event.detail);
	return {
		...event,
		message,
		...(detail === undefined ? {} : { detail }),
		fingerprint: diagnosticFingerprint({
			source: event.source,
			category: event.category,
			message,
		}),
		runtimeKind: event.runtimeKind ?? runtimeKind,
		captureMode: event.captureMode ?? captureMode,
	};
};

export const telemetryFileIdentity = (
	kind: DiagnosticRuntimeKind,
	instance: string,
): string =>
	`${kind}-${createHash("sha256").update(instance).digest("hex").slice(0, 12)}`;

export const legacyMigrationSource = (
	path: string,
	size: number,
	mtimeMs: number,
): string =>
	createHash("sha256")
		.update(`${path}:${size}:${mtimeMs}`)
		.digest("hex")
		.slice(0, 24);

const parseEventLine = (
	line: string,
): { readonly event?: DiagnosticEvent; readonly parseError: boolean } => {
	try {
		return {
			event: Schema.decodeUnknownSync(DiagnosticEventSchema)(JSON.parse(line)),
			parseError: false,
		};
	} catch {
		return { parseError: true };
	}
};

const readNewestLines = async (
	path: string,
	maxLines: number,
	maxBytes: number,
): Promise<string[]> => {
	const handle = await open(path, "r");
	try {
		const file = await handle.stat();
		let position = file.size;
		let bytesRead = 0;
		let text = "";
		while (position > 0 && bytesRead < maxBytes) {
			const size = Math.min(READ_CHUNK_BYTES, position, maxBytes - bytesRead);
			position -= size;
			const buffer = Buffer.allocUnsafe(size);
			const result = await handle.read(buffer, 0, size, position);
			text = buffer.subarray(0, result.bytesRead).toString("utf8") + text;
			bytesRead += result.bytesRead;
			const lines = text.split(/\r?\n/);
			if (lines.length > maxLines + 1) break;
		}
		return text.split(/\r?\n/).filter(Boolean).slice(-maxLines);
	} finally {
		await handle.close();
	}
};

const isRetainedEvent = (event: DiagnosticEvent, now = Date.now()): boolean => {
	const createdAt = Date.parse(event.createdAt);
	return Number.isFinite(createdAt) && now - createdAt <= RETENTION_MS;
};

const compactEventFile = async (
	path: string,
	cutoff: number,
): Promise<void> => {
	if (!existsSync(path)) return;
	const temporaryPath = `${path}.${process.pid}.retention.tmp`;
	const output = await open(temporaryPath, "w");
	let retained = 0;
	try {
		try {
			const reader = createInterface({
				input: createReadStream(path),
				crlfDelay: Number.POSITIVE_INFINITY,
			});
			for await (const line of reader) {
				if (line.length === 0) continue;
				const parsed = parseEventLine(line);
				if (
					parsed.event !== undefined &&
					Date.parse(parsed.event.createdAt) >= cutoff
				) {
					await output.write(`${JSON.stringify(parsed.event)}\n`);
					retained += 1;
				}
			}
		} finally {
			await output.close();
		}
		if (retained === 0) {
			await unlink(path).catch(() => undefined);
			await unlink(temporaryPath).catch(() => undefined);
			return;
		}
		await rename(temporaryPath, path);
	} catch (cause) {
		await output.close().catch(() => undefined);
		await unlink(temporaryPath).catch(() => undefined);
		throw cause;
	}
};

const readPersistedEventKeys = async (
	paths: ReadonlyArray<string>,
): Promise<Set<string>> => {
	const keys = new Set<string>();
	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			const reader = createInterface({
				input: createReadStream(path),
				crlfDelay: Number.POSITIVE_INFINITY,
			});
			for await (const line of reader) {
				if (line.length === 0) continue;
				const parsed = parseEventLine(line);
				if (parsed.event !== undefined)
					keys.add(`${parsed.event.runId}:${parsed.event.id}`);
			}
		} catch {
			// A rotated file can disappear while a different runtime is exporting.
		}
	}
	return keys;
};

const appendEvents = async (
	path: string,
	events: ReadonlyArray<DiagnosticEvent>,
): Promise<void> => {
	if (events.length === 0) return;
	await mkdir(dirname(path), { recursive: true });
	const chunk = events.map((event) => `${JSON.stringify(event)}\n`).join("");
	const currentSize = await stat(path)
		.then((value) => value.size)
		.catch(() => 0);
	if (
		currentSize > 0 &&
		currentSize + Buffer.byteLength(chunk) > INCIDENT_FILE_BYTES
	) {
		for (let index = INCIDENT_FILE_COUNT - 1; index >= 1; index -= 1) {
			const source = index === 1 ? path : `${path}.${index - 1}`;
			const target = `${path}.${index}`;
			await unlink(target).catch(() => undefined);
			await rename(source, target).catch(() => undefined);
		}
	}
	await appendFile(path, chunk, "utf8");
};

const appendFullTraceEvents = async (
	path: string,
	events: ReadonlyArray<DiagnosticEvent>,
): Promise<void> => {
	if (events.length === 0) return;
	await mkdir(dirname(path), { recursive: true });
	const chunk = Buffer.from(
		events.map((event) => `${JSON.stringify(event)}\n`).join(""),
	);
	const currentSize = await stat(path)
		.then((value) => value.size)
		.catch(() => 0);
	if (currentSize + chunk.length <= FULL_TRACE_BYTE_LIMIT) {
		await appendFile(path, chunk);
		return;
	}
	const existing = await readFile(path).catch(() => Buffer.alloc(0));
	const combined = Buffer.concat([existing, chunk]);
	const bounded = combined.subarray(
		Math.max(0, combined.length - FULL_TRACE_BYTE_LIMIT),
	);
	const firstNewline = bounded.indexOf(10);
	const completeLines =
		firstNewline >= 0 ? bounded.subarray(firstNewline + 1) : bounded;
	const temporaryPath = `${path}.${process.pid}.tmp`;
	await writeFile(temporaryPath, completeLines);
	await rename(temporaryPath, path);
};

const emptyCell = (): OperationCell => ({
	count: 0,
	failureCount: 0,
	totalDurationMs: 0,
	maxDurationMs: 0,
	durationBuckets: DURATION_BUCKETS.map(() => 0),
});

const mergeCell = (target: OperationCell, source: OperationCell): void => {
	target.count += source.count;
	target.failureCount += source.failureCount;
	target.totalDurationMs += source.totalDurationMs;
	target.maxDurationMs = Math.max(target.maxDurationMs, source.maxDurationMs);
	for (let index = 0; index < target.durationBuckets.length; index += 1) {
		target.durationBuckets[index] =
			(target.durationBuckets[index] ?? 0) +
			(source.durationBuckets[index] ?? 0);
	}
};

const addOperationToRollup = (
	rollup: OperationRollup,
	operation: TelemetryOperation,
	operationCount: number,
): number => {
	let name = operation.name;
	let nextOperationCount = operationCount;
	if (rollup.operations[name] === undefined) {
		if (operationCount >= MAX_OPERATIONS_PER_ROLLUP) name = "other";
		else nextOperationCount += 1;
	}
	const cell = rollup.operations[name] ?? emptyCell();
	cell.count += 1;
	if (operation.outcome === "failure" || operation.outcome === "interrupted")
		cell.failureCount += 1;
	cell.totalDurationMs += operation.durationMs;
	cell.maxDurationMs = Math.max(cell.maxDurationMs, operation.durationMs);
	const bucketIndex = DURATION_BUCKETS.findIndex(
		(limit) => operation.durationMs <= limit,
	);
	if (bucketIndex >= 0)
		cell.durationBuckets[bucketIndex] =
			(cell.durationBuckets[bucketIndex] ?? 0) + 1;
	rollup.operations[name] = cell;
	return nextOperationCount;
};

const summariesFromRollups = (
	rollups: ReadonlyArray<OperationRollup>,
	since?: string,
): ReadonlyArray<OperationSummary> => {
	const sinceMs = since === undefined ? 0 : Date.parse(since);
	const merged = new Map<string, OperationCell>();
	for (const rollup of rollups) {
		if (rollup.bucketStart + ROLLUP_INTERVAL_MS < sinceMs) continue;
		for (const [name, cell] of Object.entries(rollup.operations)) {
			const target = merged.get(name) ?? emptyCell();
			mergeCell(target, cell);
			merged.set(name, target);
		}
	}
	return [...merged.entries()]
		.map(([name, cell]) => {
			const p95Target = Math.ceil(cell.count * 0.95);
			let cumulative = 0;
			let p95DurationMs = cell.maxDurationMs;
			for (let index = 0; index < cell.durationBuckets.length; index += 1) {
				cumulative += cell.durationBuckets[index] ?? 0;
				if (cumulative >= p95Target) {
					p95DurationMs = DURATION_BUCKETS[index] ?? cell.maxDurationMs;
					break;
				}
			}
			return {
				name,
				count: cell.count,
				failureCount: cell.failureCount,
				averageDurationMs:
					cell.count === 0 ? 0 : cell.totalDurationMs / cell.count,
				p95DurationMs,
				maxDurationMs: cell.maxDurationMs,
			};
		})
		.sort(
			(left, right) =>
				right.count - left.count || right.maxDurationMs - left.maxDurationMs,
		)
		.slice(0, 50);
};

export interface TelemetryStoreShape {
	readonly runId: string;
	readonly parseErrorCount: number;
	readonly runtimeKind: DiagnosticRuntimeKind;
	readonly fileIdentity: string;
	readonly record: (event: DiagnosticEvent) => void;
	readonly recordMany: (events: ReadonlyArray<DiagnosticEvent>) => void;
	readonly recordOperation: (operation: TelemetryOperation) => void;
	readonly shouldRecordOperation: (operation: TelemetryOperation) => boolean;
	readonly snapshot: () => ReadonlyArray<DiagnosticEvent>;
	readonly exportEvents: (input: {
		readonly since?: string;
		readonly limit?: number;
	}) => Effect.Effect<{
		readonly events: ReadonlyArray<DiagnosticEvent>;
		readonly truncated: number;
	}>;
	readonly operationSummaries: (
		since?: string,
	) => ReadonlyArray<OperationSummary>;
	readonly exportOperationSummaries: (
		since?: string,
	) => Effect.Effect<ReadonlyArray<OperationSummary>>;
	readonly captureState: () => {
		readonly captureMode: DiagnosticCaptureMode;
		readonly fullCaptureEndsAt: string | null;
	};
	readonly setCapture: (
		input: DiagnosticsCapturePayload,
	) => Effect.Effect<void>;
	readonly droppedEventCount: () => number;
	readonly truncatedEventCount: () => number;
	readonly version: () => number;
	readonly overviewVersion: () => number;
	readonly storageBytes: Effect.Effect<number>;
	readonly flush: Effect.Effect<void>;
}

export class TelemetryStore extends Context.Service<
	TelemetryStore,
	TelemetryStoreShape
>()("zuse/TelemetryStore") {}

export const TelemetryStoreLive = Layer.effect(
	TelemetryStore,
	Effect.gen(function* () {
		const paths = yield* AppPaths;
		const identity = paths.telemetryIdentity ?? {
			kind: "desktop" as const,
			instance: "local",
		};
		const suffix = telemetryFileIdentity(identity.kind, identity.instance);
		const logsDirectory = join(paths.userData, "logs");
		const incidentPath = join(
			logsDirectory,
			`diagnostics.events.${suffix}.ndjson`,
		);
		const fullPath = join(
			logsDirectory,
			`diagnostics.full-trace.${suffix}.ndjson`,
		);
		const rollupPath = join(
			logsDirectory,
			`diagnostics.rollups.${suffix}.ndjson`,
		);
		const runId = `run_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
		const incidents = new EventRingBuffer(INCIDENT_EVENT_LIMIT);
		const fullTrace = new EventRingBuffer(
			FULL_TRACE_EVENT_LIMIT,
			FULL_TRACE_BYTE_LIMIT,
		);
		const rollups: OperationRollup[] = [];
		let parseErrorCount = 0;
		let version = 0;
		let overviewVersion = 0;
		let droppedEventCount = 0;
		let truncatedEventCount = 0;
		let captureMode: DiagnosticCaptureMode = "incident";
		let fullCaptureEndsAtMs: number | null = null;
		let captureTimer: ReturnType<typeof setTimeout> | undefined;
		let rollupTimer: ReturnType<typeof setTimeout> | undefined;
		let currentOperationCount = 0;
		let currentRollup: OperationRollup = {
			bucketStart:
				Math.floor(Date.now() / ROLLUP_INTERVAL_MS) * ROLLUP_INTERVAL_MS,
			operations: {},
		};
		let rollupPersistence = Promise.resolve();
		const boundedRollupText = (): string => {
			const lines: string[] = [];
			let bytes = 0;
			for (let index = rollups.length - 1; index >= 0; index -= 1) {
				const line = `${JSON.stringify(rollups[index])}\n`;
				const lineBytes = Buffer.byteLength(line);
				if (bytes + lineBytes > ROLLUP_FILE_BYTES) break;
				lines.unshift(line);
				bytes += lineBytes;
			}
			return lines.join("");
		};

		const loaded = yield* Effect.tryPromise(async () => {
			const loadedEvents: DiagnosticEvent[] = [];
			const loadedRollups: OperationRollup[] = [];
			let errors = 0;
			const now = Date.now();
			for (const file of [...retainedPaths(incidentPath)].reverse()) {
				try {
					const fileStat = await stat(file);
					if (now - fileStat.mtimeMs > RETENTION_MS) {
						await unlink(file).catch(() => undefined);
						continue;
					}
					for (const line of await readNewestLines(
						file,
						INCIDENT_EVENT_LIMIT,
						INCIDENT_FILE_BYTES,
					)) {
						const parsed = parseEventLine(line);
						if (
							parsed.event !== undefined &&
							isRetainedEvent(parsed.event, now)
						)
							loadedEvents.push(parsed.event);
						if (parsed.parseError) errors += 1;
					}
				} catch {
					// Missing telemetry files are normal on first launch.
				}
			}
			try {
				for (const line of await readNewestLines(
					rollupPath,
					MAX_ROLLUPS,
					ROLLUP_FILE_BYTES,
				)) {
					try {
						const parsed = JSON.parse(line) as OperationRollup;
						if (Date.now() - parsed.bucketStart <= RETENTION_MS)
							loadedRollups.push(parsed);
					} catch {
						errors += 1;
					}
				}
			} catch {
				// An absent rollup file is normal.
			}
			return { events: loadedEvents, rollups: loadedRollups, errors };
		}).pipe(
			Effect.orElseSucceed(() => ({
				events: [] as DiagnosticEvent[],
				rollups: [] as OperationRollup[],
				errors: 0,
			})),
		);
		incidents.pushMany(loaded.events.slice(-INCIDENT_EVENT_LIMIT));
		rollups.push(...loaded.rollups.slice(-MAX_ROLLUPS));
		parseErrorCount += loaded.errors;
		version = incidents.snapshot().length;
		if (existsSync(rollupPath)) {
			rollupPersistence = (async () => {
				await mkdir(logsDirectory, { recursive: true });
				const temporaryPath = `${rollupPath}.${process.pid}.cleanup.tmp`;
				await writeFile(temporaryPath, boundedRollupText(), "utf8");
				await rename(temporaryPath, rollupPath);
			})().catch(() => undefined);
		}
		const fileMaintenance = Promise.all(
			[...retainedPaths(incidentPath), fullPath].map((path) =>
				compactEventFile(path, Date.now() - RETENTION_MS),
			),
		).then(
			() => undefined,
			() => undefined,
		);

		const pendingPersistence: PersistedEvent[] = [];
		let persistenceDrain: Promise<void> | undefined;
		let persistTimer: ReturnType<typeof setTimeout> | undefined;

		const expireCapture = (): void => {
			if (
				captureMode === "full" &&
				fullCaptureEndsAtMs !== null &&
				Date.now() >= fullCaptureEndsAtMs
			) {
				captureMode = "incident";
				fullCaptureEndsAtMs = null;
				captureTimer = undefined;
				version += 1;
			}
		};

		const startPersistenceDrain = (): void => {
			if (persistTimer !== undefined) {
				clearTimeout(persistTimer);
				persistTimer = undefined;
			}
			if (persistenceDrain !== undefined || pendingPersistence.length === 0)
				return;
			persistenceDrain = (async () => {
				await fileMaintenance;
				while (pendingPersistence.length > 0) {
					const batch = pendingPersistence.splice(0, PERSIST_BATCH_SIZE);
					const byPath = new Map<string, DiagnosticEvent[]>();
					for (const item of batch) {
						const events = byPath.get(item.path);
						if (events === undefined) byPath.set(item.path, [item.event]);
						else events.push(item.event);
					}
					for (const [path, events] of byPath) {
						await (path === fullPath
							? appendFullTraceEvents(path, events)
							: appendEvents(path, events)
						).catch(() => undefined);
					}
				}
			})().finally(() => {
				persistenceDrain = undefined;
				if (pendingPersistence.length > 0) startPersistenceDrain();
			});
		};

		const schedulePersistence = (): void => {
			if (pendingPersistence.length >= PERSIST_BATCH_SIZE) {
				startPersistenceDrain();
				return;
			}
			if (persistTimer !== undefined) return;
			persistTimer = setTimeout(startPersistenceDrain, PERSIST_BATCH_MS);
			persistTimer.unref?.();
		};

		const enqueue = (path: string, event: DiagnosticEvent): void => {
			pendingPersistence.push({ path, event });
			if (pendingPersistence.length > MAX_PENDING_PERSISTENCE_EVENTS) {
				const count =
					pendingPersistence.length - MAX_PENDING_PERSISTENCE_EVENTS;
				pendingPersistence.splice(0, count);
				droppedEventCount += count;
			}
			schedulePersistence();
		};

		const recordMany = (incoming: ReadonlyArray<DiagnosticEvent>): void => {
			if (incoming.length === 0) return;
			try {
				expireCapture();
				for (const sourceEvent of incoming) {
					if (!isRetainedEvent(sourceEvent)) continue;
					const mode = isIncidentEvent(sourceEvent) ? "incident" : captureMode;
					const event = sanitizeEvent(sourceEvent, identity.kind, mode);
					if (isIncidentEvent(event)) {
						truncatedEventCount += incidents.pushMany([event]);
						enqueue(incidentPath, event);
					} else if (captureMode === "full") {
						truncatedEventCount += fullTrace.pushMany([event]);
						enqueue(fullPath, event);
					} else {
						continue;
					}
					version += 1;
				}
			} catch {
				// Diagnostics must never interrupt the operation it observes.
			}
		};

		const persistRollup = (rollup: OperationRollup): void => {
			rollups.push(rollup);
			rollups.sort((left, right) => left.bucketStart - right.bucketStart);
			while (rollups.length > MAX_ROLLUPS) rollups.shift();
			const line = `${JSON.stringify(rollup)}\n`;
			rollupPersistence = rollupPersistence
				.then(async () => {
					await mkdir(logsDirectory, { recursive: true });
					const currentSize = await stat(rollupPath)
						.then((value) => value.size)
						.catch(() => 0);
					if (currentSize + Buffer.byteLength(line) <= ROLLUP_FILE_BYTES) {
						await appendFile(rollupPath, line, "utf8");
						return;
					}
					const temporaryPath = `${rollupPath}.${process.pid}.tmp`;
					await writeFile(temporaryPath, boundedRollupText(), "utf8");
					await rename(temporaryPath, rollupPath);
				})
				.catch(() => undefined);
		};

		const closeCurrentRollup = (): void => {
			if (currentOperationCount === 0) return;
			persistRollup(currentRollup);
		};

		const recordOperation = (operation: TelemetryOperation): void => {
			expireCapture();
			overviewVersion += 1;
			const bucketStart =
				Math.floor(Date.now() / ROLLUP_INTERVAL_MS) * ROLLUP_INTERVAL_MS;
			if (bucketStart !== currentRollup.bucketStart) {
				closeCurrentRollup();
				currentRollup = { bucketStart, operations: {} };
				currentOperationCount = 0;
			}
			currentOperationCount = addOperationToRollup(
				currentRollup,
				operation,
				currentOperationCount,
			);
		};

		const scheduleRollupBoundary = (): void => {
			const now = Date.now();
			const nextBoundary =
				(Math.floor(now / ROLLUP_INTERVAL_MS) + 1) * ROLLUP_INTERVAL_MS;
			rollupTimer = setTimeout(
				() => {
					const bucketStart =
						Math.floor(Date.now() / ROLLUP_INTERVAL_MS) * ROLLUP_INTERVAL_MS;
					if (bucketStart !== currentRollup.bucketStart) {
						closeCurrentRollup();
						currentRollup = { bucketStart, operations: {} };
						currentOperationCount = 0;
					}
					scheduleRollupBoundary();
				},
				Math.max(1, nextBoundary - now),
			);
			rollupTimer.unref?.();
		};
		scheduleRollupBoundary();

		const flush = Effect.promise(async () => {
			await fileMaintenance;
			startPersistenceDrain();
			await persistenceDrain;
			await rollupPersistence;
		}).pipe(
			Effect.timeoutOption(Duration.seconds(2)),
			Effect.asVoid,
			Effect.ignore,
		);

		const importOffline = async (): Promise<void> => {
			if (identity.kind !== "desktop") return;
			const offlinePath = join(logsDirectory, "diagnostics.offline.ndjson");
			try {
				for (const line of await readNewestLines(
					offlinePath,
					INCIDENT_EVENT_LIMIT,
					INCIDENT_FILE_BYTES,
				)) {
					const parsed = parseEventLine(line);
					if (parsed.event !== undefined) recordMany([parsed.event]);
					if (parsed.parseError) parseErrorCount += 1;
				}
				startPersistenceDrain();
				await persistenceDrain;
				await unlink(offlinePath).catch(() => undefined);
			} catch {
				// An absent offline crash file is normal.
			}
		};

		const migrateLegacy = async (): Promise<void> => {
			await mkdir(logsDirectory, { recursive: true });
			const lockPath = join(logsDirectory, "diagnostics.legacy-migration.lock");
			let lock: Awaited<ReturnType<typeof open>> | undefined;
			try {
				lock = await open(lockPath, "wx");
				await lock.writeFile(String(process.pid), "utf8");
			} catch {
				const ownerPid = await readFile(lockPath, "utf8")
					.then((value) => Number(value))
					.catch(() => Number.NaN);
				const ownerIsValid = Number.isSafeInteger(ownerPid) && ownerPid > 0;
				let ownerIsAlive = false;
				if (ownerIsValid) {
					try {
						process.kill(ownerPid, 0);
						ownerIsAlive = true;
					} catch (cause) {
						ownerIsAlive =
							cause instanceof Error &&
							"code" in cause &&
							cause.code === "EPERM";
					}
				}
				const stale = await stat(lockPath)
					.then((value) => Date.now() - value.mtimeMs > 5 * 60_000)
					.catch(() => false);
				if (ownerIsAlive) return;
				if (!ownerIsValid && !stale) return;
				await unlink(lockPath).catch(() => undefined);
				try {
					lock = await open(lockPath, "wx");
					await lock.writeFile(String(process.pid), "utf8");
				} catch {
					return;
				}
			}
			try {
				const migratingPaths: string[] = [];
				await fileMaintenance;
				startPersistenceDrain();
				await persistenceDrain;
				const existingEventKeys = await readPersistedEventKeys(
					retainedPaths(incidentPath),
				);
				for (const event of incidents.snapshot())
					existingEventKeys.add(`${event.runId}:${event.id}`);
				const existingMigrationBuckets = new Set(
					rollups.flatMap((rollup) =>
						rollup.migrationSource === undefined
							? []
							: [`${rollup.migrationSource}:${rollup.bucketStart}`],
					),
				);
				const migratedRollups = new Map<
					string,
					{ rollup: OperationRollup; operationCount: number }
				>();
				for (const legacyPath of [
					...retainedPaths(join(logsDirectory, "diagnostics.events.ndjson")),
				].reverse()) {
					const migratingPath = `${legacyPath}.migrating`;
					if (existsSync(legacyPath))
						await rename(legacyPath, migratingPath).catch(() => undefined);
					if (!existsSync(migratingPath)) continue;
					migratingPaths.push(migratingPath);
					const migratingStat = await stat(migratingPath);
					const migrationSource = legacyMigrationSource(
						migratingPath,
						migratingStat.size,
						migratingStat.mtimeMs,
					);
					const reader = createInterface({
						input: createReadStream(migratingPath),
						crlfDelay: Number.POSITIVE_INFINITY,
					});
					for await (const line of reader) {
						if (line.length === 0) continue;
						const parsed = parseEventLine(line);
						if (parsed.event === undefined) {
							parseErrorCount += 1;
							continue;
						}
						const createdAt = Date.parse(parsed.event.createdAt);
						if (
							!Number.isFinite(createdAt) ||
							Date.now() - createdAt > RETENTION_MS
						)
							continue;
						if (isIncidentEvent(parsed.event)) {
							const eventKey = `${parsed.event.runId}:${parsed.event.id}`;
							if (!existingEventKeys.has(eventKey)) {
								recordMany([parsed.event]);
								existingEventKeys.add(eventKey);
							}
						}
						if (parsed.event.durationMs !== undefined) {
							const bucketStart =
								Math.floor(createdAt / ROLLUP_INTERVAL_MS) * ROLLUP_INTERVAL_MS;
							const migrationBucket = `${migrationSource}:${bucketStart}`;
							if (existingMigrationBuckets.has(migrationBucket)) continue;
							const migrated = migratedRollups.get(migrationBucket) ?? {
								rollup: { bucketStart, operations: {}, migrationSource },
								operationCount: 0,
							};
							migrated.operationCount = addOperationToRollup(
								migrated.rollup,
								{
									name: parsed.event.message,
									durationMs: parsed.event.durationMs,
									outcome:
										parsed.event.severity === "error" ||
										parsed.event.severity === "fatal"
											? "failure"
											: "success",
								},
								migrated.operationCount,
							);
							migratedRollups.set(migrationBucket, migrated);
						}
					}
				}
				startPersistenceDrain();
				await persistenceDrain;
				for (const migrated of [...migratedRollups.values()].sort(
					(left, right) => left.rollup.bucketStart - right.rollup.bucketStart,
				)) {
					persistRollup(migrated.rollup);
					existingMigrationBuckets.add(
						`${migrated.rollup.migrationSource}:${migrated.rollup.bucketStart}`,
					);
				}
				await rollupPersistence;
				for (const migratingPath of migratingPaths)
					await unlink(migratingPath).catch(() => undefined);
			} finally {
				await lock.close().catch(() => undefined);
				await unlink(lockPath).catch(() => undefined);
			}
		};

		void importOffline().catch(() => undefined);
		void migrateLegacy().catch(() => undefined);
		yield* Effect.addFinalizer(() =>
			Effect.gen(function* () {
				if (captureTimer !== undefined) clearTimeout(captureTimer);
				if (rollupTimer !== undefined) clearTimeout(rollupTimer);
				closeCurrentRollup();
				yield* flush;
			}),
		);

		const snapshot = (): ReadonlyArray<DiagnosticEvent> => {
			expireCapture();
			return [...incidents.snapshot(), ...fullTrace.snapshot()]
				.filter((event) => isRetainedEvent(event))
				.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
				.slice(-SUPPORT_EVENT_LIMIT);
		};

		return TelemetryStore.of({
			runId,
			get parseErrorCount() {
				return parseErrorCount;
			},
			runtimeKind: identity.kind,
			fileIdentity: suffix,
			record: (event) => recordMany([event]),
			recordMany,
			recordOperation,
			shouldRecordOperation: (operation) => {
				expireCapture();
				const shouldRecord = shouldPersistOperationEvent(
					operation,
					captureMode,
				);
				return shouldRecord;
			},
			snapshot,
			exportEvents: ({ since, limit = SUPPORT_EVENT_LIMIT }) =>
				Effect.tryPromise(async () => {
					const files = await readdir(logsDirectory).catch(() => []);
					const candidates = files.filter(
						(name) =>
							/^diagnostics\.events\.(desktop|serve)-[a-f0-9]{12}\.ndjson(?:\.\d+)?$/.test(
								name,
							) ||
							/^diagnostics\.full-trace\.(desktop|serve)-[a-f0-9]{12}\.ndjson$/.test(
								name,
							),
					);
					const newest = new Map<string, DiagnosticEvent>();
					let relevant = 0;
					const add = (event: DiagnosticEvent): void => {
						if (!isRetainedEvent(event)) return;
						if (since !== undefined && event.createdAt < since) return;
						const key = `${event.runId}:${event.id}`;
						if (!newest.has(key)) relevant += 1;
						newest.set(key, event);
						if (newest.size <= limit + 1_000) return;
						const retained = [...newest.values()]
							.sort((left, right) =>
								left.createdAt.localeCompare(right.createdAt),
							)
							.slice(-limit);
						newest.clear();
						for (const retainedEvent of retained) {
							const retainedKey = `${retainedEvent.runId}:${retainedEvent.id}`;
							newest.set(retainedKey, retainedEvent);
						}
					};
					for (const name of candidates) {
						try {
							const reader = createInterface({
								input: createReadStream(join(logsDirectory, name)),
								crlfDelay: Number.POSITIVE_INFINITY,
							});
							for await (const line of reader) {
								const parsed = parseEventLine(line);
								if (parsed.event !== undefined) add(parsed.event);
							}
						} catch {
							// A runtime may rotate a candidate during export.
						}
					}
					for (const event of snapshot()) add(event);
					const deduplicated = [...newest.values()].sort((left, right) =>
						left.createdAt.localeCompare(right.createdAt),
					);
					const events = deduplicated.slice(-limit);
					return { events, truncated: Math.max(0, relevant - events.length) };
				}),
			operationSummaries: (since) =>
				summariesFromRollups([...rollups, currentRollup], since),
			exportOperationSummaries: (since) =>
				Effect.tryPromise(async () => {
					const files = (await readdir(logsDirectory).catch(() => [])).filter(
						(name) => name.startsWith("diagnostics.rollups."),
					);
					const exportedRollups: OperationRollup[] = [];
					for (const name of files) {
						try {
							const reader = createInterface({
								input: createReadStream(join(logsDirectory, name)),
								crlfDelay: Number.POSITIVE_INFINITY,
							});
							for await (const line of reader) {
								try {
									const rollup = JSON.parse(line) as OperationRollup;
									if (Date.now() - rollup.bucketStart <= RETENTION_MS)
										exportedRollups.push(rollup);
									if (exportedRollups.length > MAX_ROLLUPS * 4)
										exportedRollups.shift();
								} catch {
									// Invalid rollup lines are ignored during export.
								}
							}
						} catch {
							// A runtime may rotate a candidate during export.
						}
					}
					exportedRollups.push(currentRollup);
					return summariesFromRollups(exportedRollups, since);
				}),
			captureState: () => {
				expireCapture();
				return {
					captureMode,
					fullCaptureEndsAt:
						fullCaptureEndsAtMs === null
							? null
							: new Date(fullCaptureEndsAtMs).toISOString(),
				};
			},
			setCapture: (input) =>
				Effect.promise(async () => {
					await fileMaintenance;
					if (captureTimer !== undefined) {
						clearTimeout(captureTimer);
						captureTimer = undefined;
					}
					if (input.mode === "incident") {
						captureMode = "incident";
						fullCaptureEndsAtMs = null;
					} else {
						for (
							let index = pendingPersistence.length - 1;
							index >= 0;
							index -= 1
						) {
							if (pendingPersistence[index]?.path === fullPath)
								pendingPersistence.splice(index, 1);
						}
						await persistenceDrain;
						fullTrace.clear();
						await mkdir(logsDirectory, { recursive: true });
						await writeFile(fullPath, "", "utf8");
						captureMode = "full";
						fullCaptureEndsAtMs = Date.now() + input.durationMinutes * 60_000;
						captureTimer = setTimeout(
							expireCapture,
							input.durationMinutes * 60_000,
						);
						captureTimer.unref?.();
					}
					version += 1;
				}),
			droppedEventCount: () => droppedEventCount,
			truncatedEventCount: () => truncatedEventCount,
			version: () => version,
			overviewVersion: () => version + overviewVersion,
			storageBytes: Effect.sync(() =>
				[...retainedPaths(incidentPath), fullPath, rollupPath]
					.filter(existsSync)
					.reduce((total, file) => total + statSync(file).size, 0),
			).pipe(Effect.orElseSucceed(() => 0)),
			flush,
		});
	}),
);
