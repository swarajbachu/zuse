import { existsSync, statSync } from "node:fs";
import {
	appendFile,
	mkdir,
	readFile,
	rename,
	stat,
	unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import {
	type DiagnosticEvent,
	DiagnosticEvent as DiagnosticEventSchema,
} from "@zuse/contracts";
import { Context, Duration, Effect, Layer, Schema } from "effect";

import { AppPaths } from "../app-paths.ts";
import {
	diagnosticFingerprint,
	sanitizeDiagnosticText,
} from "../diagnostics/diagnostics-model.ts";

const MAX_EVENTS = 100_000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const FILE_COUNT = 5;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const PERSIST_BATCH_MS = 250;
const PERSIST_BATCH_SIZE = 500;
const MAX_PENDING_PERSISTENCE_EVENTS = 5_000;

class EventRingBuffer {
	private readonly values: Array<DiagnosticEvent | undefined>;
	private start = 0;
	private length = 0;

	constructor(
		private readonly capacity: number,
		initial: ReadonlyArray<DiagnosticEvent>,
	) {
		this.values = new Array(capacity);
		this.pushMany(initial);
	}

	pushMany(events: ReadonlyArray<DiagnosticEvent>): void {
		for (const event of events) {
			const index = (this.start + this.length) % this.capacity;
			this.values[index] = event;
			if (this.length < this.capacity) {
				this.length += 1;
			} else {
				this.start = (this.start + 1) % this.capacity;
			}
		}
	}

	snapshot(): ReadonlyArray<DiagnosticEvent> {
		const snapshot: DiagnosticEvent[] = [];
		for (let offset = 0; offset < this.length; offset += 1) {
			const value = this.values[(this.start + offset) % this.capacity];
			if (value !== undefined) snapshot.push(value);
		}
		return snapshot;
	}
}

const retainedPaths = (path: string): ReadonlyArray<string> =>
	Array.from({ length: FILE_COUNT }, (_, index) =>
		index === 0 ? path : `${path}.${index}`,
	);

const loadEvents = async (
	path: string,
): Promise<{ events: DiagnosticEvent[]; parseErrors: number }> => {
	let parseErrors = 0;
	const lines: string[] = [];
	for (const file of [...retainedPaths(path)].reverse()) {
		try {
			const fileStat = await stat(file);
			if (Date.now() - fileStat.mtimeMs > RETENTION_MS) {
				await unlink(file).catch(() => undefined);
				continue;
			}
			lines.push(...(await readFile(file, "utf8")).split(/\r?\n/));
		} catch {
			// Missing or unreadable telemetry files do not affect startup.
		}
	}
	const offlinePath = join(dirname(path), "diagnostics.offline.ndjson");
	try {
		const offline = await readFile(offlinePath, "utf8");
		if (offline.trim().length > 0) {
			await mkdir(dirname(path), { recursive: true });
			await appendFile(path, offline.endsWith("\n") ? offline : `${offline}\n`);
			lines.push(...offline.split(/\r?\n/));
		}
		await unlink(offlinePath).catch(() => undefined);
	} catch {
		// An absent offline crash file is the normal path.
	}
	const events = lines
		.filter(Boolean)
		.slice(-MAX_EVENTS)
		.flatMap((line) => {
			try {
				return [
					Schema.decodeUnknownSync(DiagnosticEventSchema)(JSON.parse(line)),
				];
			} catch {
				parseErrors += 1;
				return [];
			}
		});
	return { events, parseErrors };
};

const sanitizeEvent = (event: DiagnosticEvent): DiagnosticEvent => {
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
	};
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
		currentSize + Buffer.byteLength(chunk) > MAX_FILE_BYTES
	) {
		for (let index = FILE_COUNT - 1; index >= 1; index -= 1) {
			const source = index === 1 ? path : `${path}.${index - 1}`;
			const target = `${path}.${index}`;
			await unlink(target).catch(() => undefined);
			await rename(source, target).catch(() => undefined);
		}
	}
	await appendFile(path, chunk, "utf8");
};

export interface TelemetryStoreShape {
	readonly runId: string;
	readonly parseErrorCount: number;
	readonly record: (event: DiagnosticEvent) => void;
	readonly recordMany: (events: ReadonlyArray<DiagnosticEvent>) => void;
	readonly snapshot: () => ReadonlyArray<DiagnosticEvent>;
	readonly version: () => number;
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
		const path = join(paths.userData, "logs", "diagnostics.events.ndjson");
		const loaded = yield* Effect.tryPromise(() => loadEvents(path)).pipe(
			Effect.orElseSucceed(() => ({
				events: [] as DiagnosticEvent[],
				parseErrors: 0,
			})),
		);
		const runId = `run_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
		const events = new EventRingBuffer(MAX_EVENTS, loaded.events);
		let version = loaded.events.length;
		const pendingPersistence: DiagnosticEvent[] = [];
		let persistenceDrain: Promise<void> | undefined;
		let persistTimer: ReturnType<typeof setTimeout> | undefined;
		let droppedPersistenceEvents = 0;
		let lastDropWarningAt = 0;

		const startPersistenceDrain = (): void => {
			if (persistTimer !== undefined) {
				clearTimeout(persistTimer);
				persistTimer = undefined;
			}
			if (persistenceDrain !== undefined || pendingPersistence.length === 0)
				return;
			persistenceDrain = (async () => {
				while (pendingPersistence.length > 0) {
					const batch = pendingPersistence.splice(0, PERSIST_BATCH_SIZE);
					await appendEvents(path, batch).catch(() => undefined);
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

		const recordMany = (incoming: ReadonlyArray<DiagnosticEvent>): void => {
			if (incoming.length === 0) return;
			try {
				const sanitized = incoming.map(sanitizeEvent);
				events.pushMany(sanitized);
				version += sanitized.length;
				pendingPersistence.push(...sanitized);
				if (pendingPersistence.length > MAX_PENDING_PERSISTENCE_EVENTS) {
					const dropped =
						pendingPersistence.length - MAX_PENDING_PERSISTENCE_EVENTS;
					pendingPersistence.splice(0, dropped);
					droppedPersistenceEvents += dropped;
					const now = Date.now();
					if (now - lastDropWarningAt >= 5_000) {
						events.pushMany([
							sanitizeEvent({
								id: `telemetry_drop_${runId}_${version}`,
								createdAt: new Date(now).toISOString(),
								severity: "warn",
								source: "server.telemetry",
								category: "persistence",
								message: "Telemetry persistence queue dropped events",
								detail: `dropped=${droppedPersistenceEvents}`,
								fingerprint: "telemetry-persistence-drop",
								runId,
								recoveryStatus: "unresolved",
							}),
						]);
						droppedPersistenceEvents = 0;
						lastDropWarningAt = now;
						version += 1;
					}
				}
				schedulePersistence();
			} catch {
				// Telemetry must never interrupt the application path it observes.
			}
		};

		const flush = Effect.promise(async () => {
			startPersistenceDrain();
			await persistenceDrain;
		}).pipe(
			Effect.timeoutOption(Duration.seconds(2)),
			Effect.asVoid,
			Effect.ignore,
		);
		yield* Effect.addFinalizer(() => flush);

		return TelemetryStore.of({
			runId,
			parseErrorCount: loaded.parseErrors,
			record: (event) => recordMany([event]),
			recordMany,
			snapshot: () => events.snapshot(),
			version: () => version,
			storageBytes: Effect.sync(() =>
				retainedPaths(path)
					.filter(existsSync)
					.reduce((total, file) => total + statSync(file).size, 0),
			).pipe(Effect.orElseSucceed(() => 0)),
			flush,
		});
	}),
);
