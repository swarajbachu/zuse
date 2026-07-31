import {
	appendFile,
	mkdir,
	readFile,
	rename,
	stat,
	unlink,
} from "node:fs/promises";
import { dirname } from "node:path";
import {
	type LagSample,
	LagSample as LagSampleSchema,
	type PowerSnapshot,
	PowerSnapshot as PowerSnapshotSchema,
} from "@zuse/contracts";
import { Schema } from "effect";

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_FILE_COUNT = 3;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_HIGH_RES_SAMPLES = 960;
const MAX_MEMORY_ROLLUPS = 7 * 24 * 60;
const MAX_MEMORY_LAG_SAMPLES = 5_000;

type StoredResourceEntry =
	| { readonly kind: "sample"; readonly sample: PowerSnapshot }
	| { readonly kind: "lag"; readonly sample: LagSample };

export interface PerformanceHistoryStoreOptions {
	readonly path: string;
	readonly now?: () => number;
	readonly maxFileBytes?: number;
	readonly fileCount?: number;
	readonly retentionMs?: number;
}

const minuteBucket = (createdAt: string): number =>
	Math.floor(Date.parse(createdAt) / 60_000);

export class PerformanceHistoryStore {
	private readonly snapshots: PowerSnapshot[] = [];
	private readonly rollups: PowerSnapshot[] = [];
	private readonly lagSamples: LagSample[] = [];
	private readonly now: () => number;
	private readonly maxFileBytes: number;
	private readonly fileCount: number;
	private readonly retentionMs: number;
	private pendingRollup: PowerSnapshot | null = null;
	private persistence: Promise<void> = Promise.resolve();

	constructor(private readonly options: PerformanceHistoryStoreOptions) {
		this.now = options.now ?? Date.now;
		this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
		this.fileCount = options.fileCount ?? DEFAULT_FILE_COUNT;
		this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
	}

	async initialize(): Promise<void> {
		const entries: StoredResourceEntry[] = [];
		for (const path of [...this.paths()].reverse()) {
			try {
				const value = await readFile(path, "utf8");
				for (const line of value.split(/\r?\n/)) {
					if (!line) continue;
					const parsed = this.decodeLine(line);
					if (parsed !== null) entries.push(parsed);
				}
			} catch {
				// Missing and corrupted telemetry files must not affect startup.
			}
		}
		const cutoff = this.now() - this.retentionMs;
		for (const entry of entries) {
			const createdAt =
				entry.kind === "sample"
					? entry.sample.capturedAt
					: entry.sample.capturedAt;
			if (Date.parse(createdAt) < cutoff) continue;
			if (entry.kind === "sample") this.rollups.push(entry.sample);
			else this.lagSamples.push(entry.sample);
		}
		this.trimMemory();
	}

	recordSnapshot(snapshot: PowerSnapshot): void {
		this.snapshots.push(snapshot);
		this.trimMemory();
		if (
			this.pendingRollup !== null &&
			minuteBucket(this.pendingRollup.capturedAt) !==
				minuteBucket(snapshot.capturedAt)
		) {
			this.rollups.push(this.pendingRollup);
			this.enqueue({
				kind: "sample",
				sample: this.pendingRollup,
			});
		}
		this.pendingRollup = snapshot;
	}

	recordLag(sample: LagSample): void {
		this.lagSamples.push(sample);
		this.trimMemory();
		this.enqueue({ kind: "lag", sample });
	}

	getHistory(since: number): {
		readonly samples: ReadonlyArray<PowerSnapshot>;
		readonly lagSamples: ReadonlyArray<LagSample>;
	} {
		const highResolution = this.snapshots.filter(
			(item) => Date.parse(item.capturedAt) >= since,
		);
		const oldestHighResolution = highResolution[0]?.capturedAt;
		const rollups = this.rollups.filter(
			(item) =>
				Date.parse(item.capturedAt) >= since &&
				(oldestHighResolution === undefined ||
					item.capturedAt < oldestHighResolution),
		);
		return {
			samples: [...rollups, ...highResolution],
			lagSamples: this.lagSamples.filter(
				(item) => Date.parse(item.capturedAt) >= since,
			),
		};
	}

	async flush(): Promise<void> {
		if (this.pendingRollup !== null) {
			this.enqueue({ kind: "sample", sample: this.pendingRollup });
			this.pendingRollup = null;
		}
		await this.persistence;
	}

	async storageBytes(): Promise<number> {
		const sizes = await Promise.all(
			this.paths().map((path) =>
				stat(path)
					.then((value) => value.size)
					.catch(() => 0),
			),
		);
		return sizes.reduce((total, size) => total + size, 0);
	}

	async clear(): Promise<void> {
		this.pendingRollup = null;
		this.snapshots.length = 0;
		this.rollups.length = 0;
		this.lagSamples.length = 0;
		await this.persistence;
		await Promise.all(
			this.paths().map((path) => unlink(path).catch(() => undefined)),
		);
	}

	private enqueue(entry: StoredResourceEntry): void {
		this.persistence = this.persistence
			.then(() => this.append(entry))
			.catch(() => undefined);
	}

	private async append(entry: StoredResourceEntry): Promise<void> {
		await mkdir(dirname(this.options.path), { recursive: true });
		const line = `${JSON.stringify(entry)}\n`;
		const currentSize = await stat(this.options.path)
			.then((value) => value.size)
			.catch(() => 0);
		if (
			currentSize > 0 &&
			currentSize + Buffer.byteLength(line) > this.maxFileBytes
		) {
			await this.rotate();
		}
		await appendFile(this.options.path, line, "utf8");
	}

	private async rotate(): Promise<void> {
		for (let index = this.fileCount - 1; index >= 1; index -= 1) {
			const source =
				index === 1 ? this.options.path : `${this.options.path}.${index - 1}`;
			const target = `${this.options.path}.${index}`;
			await unlink(target).catch(() => undefined);
			await rename(source, target).catch(() => undefined);
		}
	}

	private paths(): ReadonlyArray<string> {
		return Array.from({ length: this.fileCount }, (_, index) =>
			index === 0 ? this.options.path : `${this.options.path}.${index}`,
		);
	}

	private decodeLine(line: string): StoredResourceEntry | null {
		try {
			const parsed: unknown = JSON.parse(line);
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				!("kind" in parsed) ||
				!("sample" in parsed)
			) {
				return null;
			}
			if (parsed.kind === "sample") {
				return {
					kind: "sample",
					sample: Schema.decodeUnknownSync(PowerSnapshotSchema)(parsed.sample),
				};
			}
			if (parsed.kind === "lag") {
				return {
					kind: "lag",
					sample: Schema.decodeUnknownSync(LagSampleSchema)(parsed.sample),
				};
			}
		} catch {
			// A malformed line is skipped while the remaining history stays useful.
		}
		return null;
	}

	private trimMemory(): void {
		if (this.snapshots.length > MAX_HIGH_RES_SAMPLES) {
			this.snapshots.splice(0, this.snapshots.length - MAX_HIGH_RES_SAMPLES);
		}
		const cutoff = this.now() - this.retentionMs;
		while (
			this.rollups.length > 0 &&
			Date.parse(this.rollups[0]?.capturedAt ?? "") < cutoff
		) {
			this.rollups.shift();
		}
		if (this.rollups.length > MAX_MEMORY_ROLLUPS) {
			this.rollups.splice(0, this.rollups.length - MAX_MEMORY_ROLLUPS);
		}
		if (this.lagSamples.length > MAX_MEMORY_LAG_SAMPLES) {
			this.lagSamples.splice(
				0,
				this.lagSamples.length - MAX_MEMORY_LAG_SAMPLES,
			);
		}
	}
}
